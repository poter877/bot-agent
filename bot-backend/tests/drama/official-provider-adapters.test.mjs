import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const routeBlock = (source, route) => {
  const start = source.indexOf(route)
  assert.notEqual(start, -1, `Missing route: ${route}`)
  const next = source.indexOf('\n// ', start + route.length)
  return source.slice(start, next === -1 ? source.length : next)
}

test('direct vendor adapters are removed; the company backend is the only adapter path', () => {
  const registry = read('src/services/adapters/registry.ts')
  const ai = read('src/services/ai.ts')

  for (const vendor of ['openai-image', 'gemini-image', 'volcengine-image', 'volcengine-video', 'minimax-video', 'aliyun-wan-video']) {
    assert.doesNotMatch(registry, new RegExp(vendor, 'i'))
  }
  assert.doesNotMatch(ai, /gemini/i)
  // ai-text.ts / company-llm-model.ts 已随编排外移删除（见下方 orchestration 测试）
})

test('core service types collapse to the company provider with tool rows exempt', () => {
  const registrySource = read('src/services/ai-registry.ts')

  assert.match(registrySource, /text:\s*\[\s*'company'\s*\]/)
  assert.match(registrySource, /image:\s*\[\s*'company'\s*\]/)
  assert.match(registrySource, /video:\s*\[\s*'company'\s*\]/)
  assert.match(registrySource, /speech:\s*\[\s*'company'\s*\],\s*transcription:\s*\[\s*'company'\s*\]/)
  assert.doesNotMatch(registrySource, /text:\s*\[\s*'openai'/)
  // 工具行（fal/sync 等逻辑名）只换连接数据，仍经预设并集进入白名单
  assert.match(registrySource, /providerPresets\(\)/)
  assert.match(read('src/services/ai.ts'), /isOfficialProvider/)
  assert.match(read('src/services/ai.ts'), /resolveServiceRow\(serviceType\)/)
  assert.match(read('src/services/ai.ts'), /isOfficialProvider\(row\.serviceType as ServiceType,\s*row\.provider\)/)
})

test('company migration switches active rows and keeps the one-time marker', () => {
  const registrySource = read('src/services/ai-registry.ts')

  // v2：fal 队列在公司后端内化，标记更名让已迁移部署把 fal 行再迁一次
  assert.match(registrySource, /company_backend_registry_v2/)
  assert.match(registrySource, /legacyDirectVendors/)
  assert.match(registrySource, /只改活跃行/)
  assert.match(registrySource, /工具行只换连接数据/)
})

test('AI config routes reject unsupported service/provider pairs in create, test, and update paths', () => {
  const route = read('src/routes/aiConfigs.ts')
  const createRoute = routeBlock(route, "app.post('/',")
  const testRoute = routeBlock(route, "app.post('/test',")
  const updateRoute = routeBlock(route, "app.put('/:id',")

  assert.match(createRoute, /if \(!body\.service_type \|\| !body\.provider\)/)
  assert.match(createRoute, /isOfficialProvider\(body\.service_type,\s*body\.provider\)/)
  assert.match(createRoute, /badRequest\(c,\s*'不支持的 service_type\/provider'\)/)

  assert.match(testRoute, /if \(!body\.service_type \|\| !body\.provider\)/)
  assert.match(testRoute, /isOfficialProvider\(body\.service_type,\s*body\.provider\)/)
  assert.match(testRoute, /badRequest\(c,\s*'不支持的 service_type\/provider'\)/)

  assert.match(updateRoute, /const serviceType = 'service_type' in body \? body\.service_type : existing\.serviceType/)
  assert.match(updateRoute, /const provider = 'provider' in body \? body\.provider : existing\.provider/)
  assert.doesNotMatch(updateRoute, /body\.service_type \|\| existing\.serviceType/)
  assert.doesNotMatch(updateRoute, /body\.provider \|\| existing\.provider/)
  assert.match(updateRoute, /isOfficialProvider\(serviceType,\s*provider\)/)
  assert.match(updateRoute, /badRequest\(c,\s*'不支持的 service_type\/provider'\)/)
})

test('AI config update route rejects changing an existing capability or provider', () => {
  const route = read('src/routes/aiConfigs.ts')
  const updateRoute = routeBlock(route, "app.put('/:id',")

  assert.match(updateRoute, /const updates: Record<string, any> = \{ updatedAt: now\(\) \}/)
  assert.match(updateRoute, /serviceType !== existing\.serviceType \|\| provider !== existing\.provider/)
})

test('company connection data is server-owned: probe hits the model catalog, client values are ignored', () => {
  const route = read('src/routes/aiConfigs.ts')

  assert.match(route, /function companyConnection/)
  assert.match(route, /companyBaseUrl\(body\.service_type\)/)
  assert.match(route, /\/models`/)
  assert.match(route, /app\.get\('\/company-models'/)
  assert.doesNotMatch(route, /x-goog-api-key/)
  assert.doesNotMatch(route, /X-DashScope-Async/)
  assert.doesNotMatch(route, /\/chat\/completions'/)
})

test('adapter registry fails closed for unsupported providers', () => {
  const registry = read('src/services/adapters/registry.ts')

  assert.match(registry, /Unsupported image provider/)
  assert.match(registry, /Unsupported video provider/)
  assert.match(registry, /company: new CompanyImageAdapter\(\)/)
  assert.match(registry, /company: new CompanyVideoAdapter\(\)/)
  assert.doesNotMatch(registry, /ttsAdapters/)
})

test('agent orchestration moved to the hermes gateway; zero local tool loops remain', () => {
  for (const file of [
    'src/agents/index.ts',
    'src/services/creative-planner.ts',
    'src/services/creative-chat.ts',
    'src/services/creative-pipeline/text.ts',
    'src/services/film-pipeline/text.ts',
    'src/services/film-pipeline/build-agent.ts',
    'src/services/production-tools/auxiliary.ts',
  ]) {
    const source = read(file)
    assert.match(source, /runHermesAgent/, `${file} 应经 hermes gateway 编排`)
    assert.doesNotMatch(source, /ToolLoopAgent|getTextModel|createOpenAI|createGoogleGenerativeAI/)
  }
  // 编排归一：全后端源码零本地 ToolLoopAgent / 本地文本模型工厂（含 film build 循环）
  const walk = (rel) => readdirSync(new URL(rel, root), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]))
    .filter((f) => f.endsWith('.ts'))
  for (const file of walk('src')) {
    assert.doesNotMatch(read(file), /ToolLoopAgent|getTextModel/, `${file} 不应再持有本地工具循环/本地模型`)
  }
  assert.ok(!existsSync(new URL('src/services/ai-text.ts', root)), 'ai-text.ts 已删除')
  assert.ok(!existsSync(new URL('src/services/company-llm-model.ts', root)), 'company-llm-model.ts 已删除')
  // build 预算对齐原本地循环的 30 分钟超时，且超时确实下发到 gateway 请求
  const build = read('src/services/film-pipeline/build-agent.ts')
  assert.match(build, /export const BUILD_AGENT_TIMEOUT_MS = 30 \* 60_000/)
  assert.match(build, /timeoutMs: BUILD_AGENT_TIMEOUT_MS/)
})
