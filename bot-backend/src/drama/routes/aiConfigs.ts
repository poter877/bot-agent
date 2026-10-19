import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { isOfficialProvider, parseConfigTemperature, parseServiceOptions } from '../services/ai.js'
import { companyBackendUrl, companyBaseUrl, companyConfigured, companyServiceToken } from '../services/company-backend.js'
import { fetchCompanyModelCatalog, isCompanyModelKind } from '../services/company-model-catalog.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

import { migrateServiceConfigs, configModels, validateServiceConfig, toolServices } from '../services/ai-registry.js'

const app = new Hono()
app.use('*', async (_c, next) => { migrateServiceConfigs(); await next() })

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写 */
function withParsedFields(r: any) {
  return {
    ...toSnakeCase({ ...r, apiKey: undefined, settings: undefined }),
    has_api_key: !!r.apiKey,
    service_options: parseServiceOptions(r.settings),
    model: configModels(r.model),
    temperature: parseConfigTemperature(r.settings),
  }
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

/** company 连接数据由服务端环境注入：baseUrl 取预设，密钥取内部服务令牌。 */
function companyConnection(serviceType: string) {
  return { baseUrl: companyBaseUrl(serviceType), apiKey: companyServiceToken() }
}

/** company 文本探针：模型列表端点接受同一 Bearer 令牌，可真实验证连通与鉴权。 */
function buildProbe(baseUrl: string, apiKey?: string) {
  return {
    method: 'GET',
    url: `${baseUrl.replace(/\/+$/, '')}/models`,
    headers: bearerHeaders(apiKey),
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const serviceOptions = body.service_options ?? {}
  if (!serviceOptions || typeof serviceOptions !== 'object' || Array.isArray(serviceOptions) || JSON.stringify(serviceOptions).length > 100000)
    return badRequest(c, '服务参数须为不超过100KB的JSON对象')
  if (/"(?:api_key|apiKey|authorization|secret|secret_key|secretKey|client_secret|clientSecret|api_secret|apiSecret|access_token|accessToken|refresh_token|refreshToken|token)"\s*:/i.test(JSON.stringify(serviceOptions))) return badRequest(c, '请将服务密钥填在 API Key，不能放入服务参数')
  let temperature: number | null = null
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }

  // company 的地址与密钥来自服务端环境，前端不提交也不可见
  const connection = body.provider === 'company'
    ? companyConnection(body.service_type)
    : { baseUrl: body.base_url || '', apiKey: body.api_key || '' }
  const validation = validateServiceConfig(body.service_type, body.provider, connection.baseUrl, body.model || [])
  if (validation) return badRequest(c, validation)

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: JSON.stringify({ ...(temperature !== null ? { temperature } : {}), serviceOptions }),
    createdAt: ts,
    updatedAt: ts,
  }).returning()

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))

  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }
  // company 的地址由服务端环境决定（前端不提交），与配置行保持一致后再复用已存密钥
  if (body.provider === 'company') body.base_url = companyBaseUrl(body.service_type)
  if (!body.base_url) {
    return badRequest(c, '需要 base_url')
  }

  if (body.config_id && !body.api_key) {
    const existing = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(body.config_id))))[0]
    if (!existing) return notFound(c)
    // Never forward a stored credential to a changed endpoint or another provider.
    if (existing.provider !== body.provider || existing.baseUrl !== body.base_url || existing.serviceType !== body.service_type)
      return badRequest(c, '测试新的服务商或地址时，请重新填写 API Key')
    body.api_key = existing.apiKey
  }
  // 公司文本路由可真实探测（模型列表端点接受同一 Bearer）；其余服务只查配置形态，
  // 认证在实际任务中验证，不发送生成请求
  const probe = body.provider === 'company' && body.service_type === 'text'
    ? buildProbe(body.base_url, body.api_key)
    : null
  if (!probe) {
    const error = validateServiceConfig(body.service_type, body.provider, body.base_url, body.model)
    return success(c, { ok: false, reachable: false, checked: 'configuration', message: error || '配置格式已检查；此服务的认证将在实际任务中验证，未发送生成请求' })
  }
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      signal: AbortSignal.timeout(30000),
      headers: probe.headers,
    })
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
    const payload = {
      ok: resp.ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message: reachable
        ? (resp.ok ? '端点可访问，认证与路径基本正常' : '端点已响应，请根据状态码判断认证或路径是否正确')
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: body.api_key ? text.split(body.api_key).join('[redacted]').slice(0, 240) : text.slice(0, 240),
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

// GET /ai-configs/company-models?kind=text|image|video|speech|transcription
// 公司模型目录代理（前端模型下拉的唯一数据源；令牌由服务端注入）。
// 返回 { models: [{id, displayName}], defaultModel }：text 转发 /api/llm/models
// （defaultModel 直通），媒体 kind 转发 /api/media/models 并按 kind 过滤（默认取首项）。
app.get('/company-models', async (c) => {
  if (!companyConfigured()) return badRequest(c, '未配置公司后端（COMPANY_BACKEND_URL / COMPANY_SERVICE_TOKEN）')
  const kind = c.req.query('kind') || 'text'
  if (!isCompanyModelKind(kind)) return badRequest(c, 'kind 须为 text/image/video/speech/transcription')
  try {
    return success(c, await fetchCompanyModelCatalog(kind))
  } catch (error: any) {
    return badRequest(c, error.message || '公司模型目录请求失败')
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  if (serviceType !== existing.serviceType || provider !== existing.provider)
    return badRequest(c, '已有配置不能更换服务类型或服务商，请新建配置')
  // company 的地址与密钥由服务端环境持有：忽略前端提交，也永不清空
  if (provider === 'company') {
    delete body.base_url
    delete body.api_key
    body.clear_key = false
  }
  if (body.base_url && body.base_url !== existing.baseUrl && !body.api_key)
    return badRequest(c, '更换服务地址时，请重新填写 API Key')
  const validation = validateServiceConfig(serviceType, provider, body.base_url ?? existing.baseUrl, body.model ?? configModels(existing.model))
  if (validation) return badRequest(c, validation)
  const updates: Record<string, any> = { updatedAt: now() }

  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if (body.clear_key === true) updates.apiKey = ''
  else if (typeof body.api_key === 'string' && body.api_key.trim()) updates.apiKey = body.api_key.trim()
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('service_options' in body) {
    const options = body.service_options
    if (!options || typeof options !== 'object' || Array.isArray(options) || JSON.stringify(options).length > 100000) return badRequest(c, '服务参数须为不超过100KB的JSON对象')
    if (/"(?:api_key|apiKey|authorization|secret|secret_key|secretKey|client_secret|clientSecret|api_secret|apiSecret|access_token|accessToken|refresh_token|refreshToken|token)"\s*:/i.test(JSON.stringify(options))) return badRequest(c, '请将服务密钥填在 API Key，不能放入服务参数')
    let old: Record<string, unknown> = {}
    try { old = JSON.parse(existing.settings || '{}') } catch { /* old config */ }
    updates.settings = JSON.stringify({...old, serviceOptions: options})
  }
  if ('temperature' in body) {
    let temperature: number | null
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
    // 与已有 settings 合并，清空的 temperature 从 JSON 中移除
    let settings: Record<string, any> = {}
    try { settings = updates.settings ? JSON.parse(updates.settings) : existing.settings ? JSON.parse(existing.settings) : {} } catch { settings = {} }
    if (temperature === null) delete settings.temperature
    else settings.temperature = temperature
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
