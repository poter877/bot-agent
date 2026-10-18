import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('drama creation no longer pre-creates episodes from total_episodes', () => {
  const dramas = read('src/routes/dramas.ts')

  assert.doesNotMatch(dramas, /total_episodes \|\| 1/)
  assert.doesNotMatch(dramas, /第\$\{i\}集/)
  assert.doesNotMatch(dramas, /Create default episodes/)
})

// 行为测试经真实路由 + 临时 SQLite 库（env 先于动态导入设置）
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aspect-ratio-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.MYSQL_AUTO_IMPORT = 'false'
const dramasRoute = (await import('../src/routes/dramas.js')).default
after(async () => { await fs.rm(directory, { recursive: true, force: true }) })

async function request(url, method = 'GET', body) {
  const response = await dramasRoute.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}

test('drama creation records a fixed aspect ratio for video generation', async () => {
  // 创建时固定：缺省 16:9（zod aspectRatioSchema 白名单 16:9/9:16/1:1，旧的手写默认值已收敛为 schema 校验）
  const created = await request('/', 'POST', { title: '锁比例' })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.aspect_ratio, '16:9')
  // 白名单之外的取值在创建时被拒
  const rejected = await request('/', 'POST', { title: '非法比例', aspect_ratio: '4:3' })
  assert.equal(rejected.status, 400)
  const vertical = await request('/', 'POST', { title: '竖屏', aspect_ratio: '9:16' })
  assert.equal(vertical.body.data.aspect_ratio, '9:16')

  // PUT 可修改
  const id = vertical.body.data.id
  assert.equal((await request(`/${id}`, 'PUT', { aspect_ratio: '1:1' })).status, 200)
  assert.equal((await request(`/${id}`, 'GET')).body.data.aspect_ratio, '1:1')
})

test('style presets route is mounted and implements CRUD', () => {
  const entry = read('src/index.ts')
  const route = read('src/routes/stylePresets.ts')

  assert.match(entry, /api\.route\('\/style-presets', stylePresets\)/)
  assert.match(route, /app\.get\('\/'/)
  assert.match(route, /app\.post\('\/'/)
  assert.match(route, /app\.put\('\/:id'/)
  assert.match(route, /app\.delete\('\/:id'/)
  // value 唯一约束 + 格式校验 + 查重
  assert.match(route, /VALUE_PATTERN/)
  assert.match(route, /风格 key 已存在/)
  // GET 支持 ?all=1 且默认过滤停用项
  assert.match(route, /query\('all'\)/)
  assert.match(route, /r\.isActive/)
})

test('drama style prompt is injected into image prompt composition', () => {
  const service = read('src/services/style-preset.ts')
  const gridTools = read('src/agents/tools/image-prompt-tools.ts')
  const characters = read('src/routes/characters.ts')
  const scenes = read('src/routes/scenes.ts')

  assert.match(service, /getDramaStylePrompt/)
  assert.match(service, /stylePresets\.value, drama\.style/)
  assert.match(gridTools, /getDramaStylePrompt\(dramaId\)/)
  // 保存最终提示词时由工具拼接项目视觉风格（风格片段置于最前方）
  assert.match(gridTools, /stylePrompt \? `\$\{stylePrompt\}, \$\{prompt\}` : prompt/)
  assert.match(characters, /getDramaStylePrompt/)
  assert.match(characters, /characterImagePrompt\(char, stylePrompt\)/)
  assert.match(scenes, /getDramaStylePrompt\(scene\.dramaId\)/)
})

test('agent default prompts no longer hardcode consistent art style', () => {
  const agents = read('src/agents/index.ts')

  assert.doesNotMatch(agents, /必须包含 "consistent art style"/)
  assert.match(agents, /视觉风格描述会由工具/)
})
