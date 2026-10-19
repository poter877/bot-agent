import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('prompt_generator video prompt format uses @name references instead of XML tags', () => {
  // hermes 编排后指令源分层：workspace/prompts/prompt_generator.md 为运行时事实来源，
  // src/agents/index.ts 的 DEFAULT_PROMPTS 是文件缺失时的兜底——两处都要守住同一契约
  const promptFile = read('workspace/prompts/prompt_generator.md')
  const defaults = read('src/drama/agents/index.ts')
  const skill = read('workspace/skills/prompt-generator/video-prompt/SKILL.md')

  for (const src of [promptFile, defaults]) {
    // 场景/角色用 @名字 引用（名字必须与场景/角色列表完全一致）
    assert.match(src, /@场景名/)
    assert.match(src, /@角色名/)
    // 生成时 @名字 自动替换为参考图片标记
    assert.match(src, /@小明 → @图片1小明/)
    assert.doesNotMatch(src, /<location>/)
    assert.doesNotMatch(src, /<role>/)
  }

  // SKILL.md 同步（技能全文注入指令，规范以技能文件为准）
  assert.match(skill, /@场景名/)
  assert.match(skill, /@角色名/)
  assert.match(skill, /@小明.*@图片1小明/)
  assert.doesNotMatch(skill, /<location>/)
  assert.doesNotMatch(skill, /<role>/)
})
