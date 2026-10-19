import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

const root = new URL('../..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

test('MiniMax image and video provider surfaces are removed', () => {
  const ai = read('backend/src/services/ai.ts')
  const route = read('backend/src/routes/aiConfigs.ts')
  const registry = read('backend/src/services/adapters/registry.ts')
  const settings = read('../../../ai-drama/frontend-react/src/features/settings/panels/AiConfigsPanel.tsx')
  const readme = read('README.md')

  assert.doesNotMatch(ai, /minimax/i)
  assert.doesNotMatch(route, /p === 'minimax'/i)
  assert.doesNotMatch(registry, /minimax/i)
  assert.doesNotMatch(settings, /minimax/i)
  assert.doesNotMatch(readme, /minimax/i)
  assert.equal(exists('backend/src/services/adapters/minimax-image.ts'), false)
  assert.equal(exists('backend/src/services/adapters/minimax-video.ts'), false)
})

test('startup migration neutralizes saved MiniMax configurations (legacy direct-vendor rows retarget to company)', async () => {
  // MySQL 时代的启动 DELETE 清理（mysqlDataCleanupStatements）已随 mysql-schema.ts 删除。
  // 现行承接：ai-registry 的 migrateServiceConfigs 把活跃的厂商直连历史行
  // （minimax ∈ legacyDirectVendors）原位归一为 company 后端行——行 id 保留，
  // 集的 image_config_id/video_config_id 引用天然不悬空，minimax 不再是任何合法 provider。
  const registry = read('backend/src/services/ai-registry.ts')
  assert.match(registry, /const legacyDirectVendors = \[[^\]]*'minimax'[^\]]*\]/)
  assert.match(registry, /legacyDirectVendors\.includes\(r\.provider \|\| ''\)/)

  // 行为验证：库中残留的 minimax 配置行经启动迁移后 provider 归一为 company
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-cleanup-'))
  process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  process.env.COMPANY_BACKEND_URL = 'https://company.invalid'
  process.env.COMPANY_SERVICE_TOKEN = 'company-token'
  try {
    const { db, schema, getInsertId } = await import('../../src/drama/db/index.js')
    const { migrateServiceConfigs } = await import('../../src/drama/services/ai-registry.js')
    const ts = new Date().toISOString()
    const configId = getInsertId(db.insert(schema.aiServiceConfigs).values({
      serviceType: 'video', provider: 'minimax', name: '旧 MiniMax 直连', baseUrl: 'https://api.minimax.chat',
      apiKey: 'legacy-secret', model: JSON.stringify(['abab6.5s-chat']), priority: 1, isActive: true,
      createdAt: ts, updatedAt: ts,
    }).run())
    const dramaId = getInsertId(db.insert(schema.dramas).values({ title: '残留配置剧', createdAt: ts, updatedAt: ts }).run())
    const episodeId = getInsertId(db.insert(schema.episodes).values({
      dramaId, episodeNumber: 1, title: '第1集', videoConfigId: configId, createdAt: ts, updatedAt: ts,
    }).run())

    migrateServiceConfigs()

    const row = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).get()
    assert.equal(row.provider, 'company')
    assert.equal(row.apiKey, 'company-token')
    // 行原位更新（不删不换 id）→ 集引用仍然有效；MySQL 时代靠"先 detach 再 delete"达成的效果由 id 保留承接
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
    assert.equal(episode.videoConfigId, configId)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
