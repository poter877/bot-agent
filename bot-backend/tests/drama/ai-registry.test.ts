import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-ai-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.MYSQL_AUTO_IMPORT = 'false'
// env 在动态导入前注入：company-backend 惰性读取，但迁移与校验需要它们已就位
process.env.COMPANY_BACKEND_URL = 'https://company.invalid'
process.env.COMPANY_SERVICE_TOKEN = 'company-token'
const { db, schema, getInsertId } = await import('../../src/drama/db/index.js')
const { migrateServiceConfigs, resolveServiceRow } = await import('../../src/drama/services/ai-registry.js')
const { companyBaseUrl } = await import('../../src/drama/services/company-backend.js')
const { getActiveConfig, getConfigById } = await import('../../src/drama/services/ai.js')
const { requireToolConfig, saveToolSettings, publicToolSettings } = await import('../../src/drama/services/creative-tools/settings.js')
const { default: app } = await import('../../src/drama/routes/aiConfigs.js')
const now = new Date().toISOString()
function insert(type: string, provider: string, key = 'secret', priority = 0, baseUrl?: string) {
  return getInsertId(db.insert(schema.aiServiceConfigs).values({ serviceType: type, provider, name: type,
    baseUrl: baseUrl ?? (provider === 'sync' ? 'https://api.sync.so' : 'https://legacy.example'), apiKey: key,
    model: JSON.stringify([provider === 'sync' ? 'sync-3' : 'legacy-model']), priority, isActive: true,
    createdAt: now, updatedAt: now }).run())
}
async function request(url: string, method = 'GET', body?: unknown) {
  const response = await app.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}
after(async () => { await fs.rm(directory, { recursive: true, force: true }) })

test('migration switches active direct-vendor rows to the company backend exactly once', async () => {
  const textId = insert('text', 'openai', 'legacy-text-secret')
  db.insert(schema.appSettings).values({ key: 'creative_tool_sync', value: JSON.stringify({ enabled: true, apiKey: 'old-sync-secret', model: 'sync-3' }), updatedAt: now }).run()
  const projectId = getInsertId(db.insert(schema.dramas).values({ title: 'Legacy task', createdAt: now, updatedAt: now }).run())
  const data = { shotId: 'speaker', model: 'sync-3' }
  const jobId = getInsertId(db.insert(schema.creativeToolJobs).values({ projectId, kind: 'lipsync', revision: 1,
    fingerprint: 'legacy-fingerprint', input: JSON.stringify(data), remoteId: 'existing-task', createdAt: now, updatedAt: now }).run())
  migrateServiceConfigs()
  const migratedJob = db.select().from(schema.creativeToolJobs).where(eq(schema.creativeToolJobs.id, jobId)).get()!
  const migratedInput = { ...data, configId: resolveServiceRow('lipsync')!.id }
  assert.deepEqual(JSON.parse(migratedJob.input), migratedInput)
  assert.equal(migratedJob.remoteId, 'existing-task')
  assert.equal(migratedJob.fingerprint, createHash('sha256').update(JSON.stringify({ kind: 'lipsync', data: migratedInput })).digest('hex'))
  assert.equal(resolveServiceRow('lipsync')!.apiKey, 'old-sync-secret')
  assert.equal(resolveServiceRow('lipsync')!.model, '["sync-3"]')
  assert.equal(db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'creative_tool_sync')).get(), undefined)
  // 直连厂商的活跃行归一为 company：地址/密钥来自环境，模型置空待选
  const text = await getActiveConfig('text')
  assert.equal(text?.provider, 'company')
  assert.equal(text?.baseUrl, companyBaseUrl('text'))
  assert.equal(text?.apiKey, 'company-token')
  assert.equal(text?.model, '')
  // 缺失的能力类型播种 company 行
  for (const type of ['image', 'video', 'speech', 'transcription']) {
    assert.equal((await getActiveConfig(type))?.provider, 'company')
  }
  assert.equal((await getConfigById(textId, 'text'))?.id, text!.id)
  const count = db.select().from(schema.aiServiceConfigs).all().length
  migrateServiceConfigs(); migrateServiceConfigs()
  assert.equal(db.select().from(schema.aiServiceConfigs).all().length, count)
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, 'speech')).run()
  // 标记位保证迁移一次性：删除后不会重复播种
  migrateServiceConfigs()
  assert.equal(await getActiveConfig('speech'), null)
})

test('both engines share priorities; pinned IDs cannot switch accounts or capabilities', async () => {
  const old = resolveServiceRow('lipsync')!
  const selected = insert('lipsync', 'sync', 'other-account-secret', 9)
  assert.equal((await getActiveConfig('lipsync'))?.id, selected)
  assert.equal(requireToolConfig('sync').id, selected)
  assert.equal(requireToolConfig('sync', old.id).apiKey, 'old-sync-secret')
  assert.equal(await getConfigById(selected, 'image'), null)
  assert.equal((await getConfigById(selected, 'lipsync'))?.apiKey, 'other-account-secret')
  db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, old.id)).run()
  assert.throws(() => requireToolConfig('sync', old.id), /配置/)
})

test('compatibility tool API writes only the shared registry', async () => {
  saveToolSettings('tavily', { enabled: true, apiKey: 'tavily-secret' })
  assert.equal((await getActiveConfig('research'))?.apiKey, 'tavily-secret')
  assert.equal((await getActiveConfig('research'))?.model, 'search')
  assert.equal(db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'creative_tool_tavily')).get(), undefined)
  assert.ok(!JSON.stringify(publicToolSettings()).includes('tavily-secret'))
})

test('CRUD redacts credentials; blank edits preserve and explicit clearing removes secrets', async () => {
  const create = await request('/', 'POST', { service_type: 'rigging', provider: 'meshy', base_url: 'https://api.meshy.ai', model: ['rigging'], api_key: 'meshy-private' })
  assert.equal(create.status, 201)
  assert.ok(!JSON.stringify(create.body).includes('meshy-private'))
  const row = resolveServiceRow('rigging')!
  assert.ok(!JSON.stringify((await request('/')).body).includes('secret'))
  const detail = await request(`/${row.id}`)
  assert.equal(detail.body.data.has_api_key, true)
  assert.equal(detail.body.data.api_key, undefined)
  assert.equal((await request(`/${row.id}`, 'PUT', { name: 'updated', api_key: '' })).status, 200)
  assert.equal(resolveServiceRow('rigging')!.apiKey, 'meshy-private')
  assert.equal((await request(`/${row.id}`, 'PUT', { clear_key: true, is_active: false })).status, 200)
  assert.equal((await request(`/${row.id}`)).body.data.has_api_key, false)
})

test('company rows keep the env-injected address and reject other providers on core types', async () => {
  assert.equal((await request('/', 'POST', { service_type: 'transcription', provider: 'openai', base_url: 'https://legacy.example', model: ['whisper-1'] })).status, 400)
  assert.equal((await request('/', 'POST', { service_type: 'lipsync', provider: 'sync', base_url: 'https://other.example', model: ['sync-3'] })).status, 400)
  const row = resolveServiceRow('text')!
  // company 地址由环境持有：客户端提交的地址被忽略，密钥不可清除
  assert.equal((await request('/', 'POST', { service_type: 'text', provider: 'company', base_url: 'https://other.example', model: ['m1'], api_key: 'client-key', priority: 100 })).status, 201)
  const created = resolveServiceRow('text')!
  assert.equal(created.baseUrl, companyBaseUrl('text'))
  assert.equal(created.apiKey, 'company-token')
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, created.id)).run()
  assert.equal((await request(`/${row.id}`, 'PUT', { service_type: 'image', provider: 'company' })).status, 400)
  assert.equal((await request(`/${row.id}`, 'PUT', { base_url: 'https://other.example', clear_key: true })).status, 200)
  assert.equal(resolveServiceRow('text')!.baseUrl, companyBaseUrl('text'))
  assert.equal(resolveServiceRow('text')!.apiKey, 'company-token')
})

test('probes resolve saved keys server-side and reject forwarding them to another endpoint', async () => {
  const row = resolveServiceRow('text')!
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer company-token')
    return Response.json({ data: [] })
  }
  try {
    const body = { config_id: row.id, service_type: 'text', provider: 'company', base_url: row.baseUrl, model: ['m1'] }
    assert.equal((await request('/test', 'POST', body)).body.data.ok, true)
    // company 地址由服务端钉死：客户端改地址只会被忽略并继续探测环境端点
    assert.equal((await request('/test', 'POST', { ...body, base_url: 'https://other.example' })).body.data.ok, true)
    assert.equal(calls, 2)
  } finally { globalThis.fetch = original }
})

test('company models endpoint routes by kind and forwards the catalog with the server-side token', async () => {
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = async (url, init) => {
    seen.push(String(url))
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer company-token')
    if (String(url) === 'https://company.invalid/api/llm/models')
      return Response.json({ models: [{ id: 'llm-a', displayName: '模型甲' }, { id: 'llm-b' }], defaultModel: 'llm-b' })
    return Response.json({ models: [
      { id: 'img-1', kind: 'image', displayName: '图片甲' },
      { id: 'img-2', kind: 'image' },
      { id: 'vid-1', kind: 'video' },
      { id: 'tts-1', kind: 'speech' },
      { id: 'whisper-1', kind: 'transcription' },
    ] })
  }
  try {
    // 缺省 kind=text：转发 /api/llm/models，defaultModel 直通，displayName 缺省回落 id
    const text = await request('/company-models')
    assert.deepEqual(text.body.data, {
      models: [{ id: 'llm-a', displayName: '模型甲' }, { id: 'llm-b', displayName: 'llm-b' }],
      defaultModel: 'llm-b',
    })
    // 媒体 kind：转发 /api/media/models 并按 kind 过滤；默认取该 kind 首项
    const image = await request('/company-models?kind=image')
    assert.deepEqual(image.body.data, {
      models: [{ id: 'img-1', displayName: '图片甲' }, { id: 'img-2', displayName: 'img-2' }],
      defaultModel: 'img-1',
    })
    const speech = await request('/company-models?kind=speech')
    assert.deepEqual(speech.body.data, { models: [{ id: 'tts-1', displayName: 'tts-1' }], defaultModel: 'tts-1' })
    assert.equal((await request('/company-models?kind=bogus')).status, 400)
    assert.deepEqual(seen, [
      'https://company.invalid/api/llm/models',
      'https://company.invalid/api/media/models',
      'https://company.invalid/api/media/models',
    ])
  } finally { globalThis.fetch = original }
})

test('company rows no longer require a model; tool rows still validate theirs', async () => {
  const created = await request('/', 'POST', { service_type: 'image', provider: 'company', model: [] })
  assert.equal(created.status, 201)
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, created.body.data.id)).run()
  assert.equal((await request('/', 'POST', { service_type: 'lipsync', provider: 'sync', base_url: 'https://api.sync.so', model: [] })).status, 400)
})

test('service options round-trip with temperature while credential fields remain forbidden',async()=>{
 const row=resolveServiceRow('text')!
 const options={workflow_json:{'1':{class_type:'SaveImage',inputs:{}}},prompt_node:'2'}
 assert.equal((await request(`/${row.id}`,'PUT',{service_options:options,temperature:0.4,api_key:''})).status,200)
 const selected=await getActiveConfig('text');assert.deepEqual(selected?.serviceOptions,options);assert.equal(selected?.temperature,0.4)
 const detail=await request(`/${row.id}`);assert.deepEqual(detail.body.data.service_options,options);assert.equal(detail.body.data.api_key,undefined)
 assert.equal((await request(`/${row.id}`,'PUT',{service_options:{client_secret:'not-allowed'}})).status,400)
})
