import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('extraction service runs single-shot model calls and reuses dedup save tools', () => {
  const svc = read('src/drama/services/extraction.ts')

  // 同集同类型运行中不重复启动；按「集 × 类型」内存态跟踪
  assert.match(svc, /tasks\.get\(key\)\?\.status === 'running'\) return false/)
  // 编排外移后为单发模型调用（《重构》清理：不再经 hermes gateway 工具循环）
  assert.match(svc, /await runTextModel\(\{/)
  assert.doesNotMatch(svc, /runHermesAgent|getAgent/)
  // 剧本与已有资产入参；每类资产限定只提取该类型
  assert.match(svc, /不要提取场景和道具/)
  assert.match(svc, /不要提取角色和道具/)
  assert.match(svc, /不要提取角色和场景/)
  assert.match(svc, /只依据提供的剧本提取信息/)
  // 落库复用 save_dedup_* 工具（去重合并逻辑的唯一实现）
  assert.match(svc, /saveDedupCharactersTool/)
  assert.match(svc, /saveDedupScenesTool/)
  assert.match(svc, /saveDedupPropsTool/)
})
