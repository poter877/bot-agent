import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

test('backend removes the voice assignment agent and tools', () => {
  const agents = read('src/agents/index.ts')
  const skills = read('src/agents/skills.ts')

  assert.doesNotMatch(agents, /voice_assigner/)
  assert.doesNotMatch(agents, /createVoiceTools/)
  assert.doesNotMatch(skills, /voice_assigner/)
  assert.equal(exists('src/agents/tools/voice-tools.ts'), false)
  assert.equal(exists('workspace/skills/voice_assigner/SKILL.md'), false)
})

test('backend removes audio service providers, TTS adapters, and voice routes', () => {
  const index = read('src/index.ts')
  const ai = read('src/services/ai.ts')
  const registry = read('src/services/adapters/registry.ts')
  const types = read('src/services/adapters/types.ts')

  assert.doesNotMatch(index, /aiVoices/)
  assert.doesNotMatch(ai, /audio/)
  assert.doesNotMatch(ai, /getAudioConfig/)
  assert.doesNotMatch(registry, /TTS/)
  assert.doesNotMatch(registry, /minimax-tts/)
  assert.doesNotMatch(types, /TTSProviderAdapter/)
  assert.equal(exists('src/routes/aiVoices.ts'), false)
  assert.equal(exists('src/services/tts-generation.ts'), false)
  assert.equal(exists('src/services/adapters/minimax-tts.ts'), false)
  assert.match(read('src/services/adapters/company-video.ts'), /generateAudio = Number\(record\.generateAudio\)/)
})

test('backend removes TTS endpoints and audio-specific schema fields', () => {
  const episodes = read('src/routes/episodes.ts')
  const storyboards = read('src/routes/storyboards.ts')
  const characters = read('src/routes/characters.ts')
  const schema = read('src/db/schema.ts')
  const sqliteSchema = read('src/db/sqlite-schema.ts')
  const mysqlImport = read('src/db/mysql-import.ts')

  assert.doesNotMatch(episodes, /audio_config_id/)
  assert.doesNotMatch(episodes, /assign_voices/)
  assert.doesNotMatch(episodes, /generate_voice_samples/)
  assert.doesNotMatch(storyboards, /generate-tts/)
  assert.doesNotMatch(storyboards, /ttsAudioUrl/)
  assert.doesNotMatch(characters, /generate-voice-sample/)
  assert.doesNotMatch(characters, /voiceStyle/)
  assert.doesNotMatch(schema, /audioConfigId/)
  assert.doesNotMatch(schema, /voiceStyle/)
  assert.doesNotMatch(schema, /voiceSampleUrl/)
  assert.doesNotMatch(schema, /voiceProvider/)
  assert.doesNotMatch(schema, /ttsAudioUrl/)
  assert.doesNotMatch(schema, /aiVoices/)
  // SQLite DDL：音频专用列不进入建表语句（MySQL 时代的 mysql-schema 断言由 sqlite-schema 承接）
  assert.doesNotMatch(sqliteSchema, /audio_config_id/)
  assert.doesNotMatch(sqliteSchema, /voice_style/)
  assert.doesNotMatch(sqliteSchema, /voice_sample_url/)
  assert.doesNotMatch(sqliteSchema, /voice_provider/)
  assert.doesNotMatch(sqliteSchema, /tts_audio_url/)
  // 无 ai_voices 表定义；MySQL 一次性导入的白名单也不含 ai_voices（旧表数据随 MySQL 留在原地，
  // 等价于 MySQL 时代启动 DROP 的"孤儿表清理"语义）
  assert.doesNotMatch(sqliteSchema, /ai_voices/)
  assert.doesNotMatch(mysqlImport, /ai_voices/)
})
