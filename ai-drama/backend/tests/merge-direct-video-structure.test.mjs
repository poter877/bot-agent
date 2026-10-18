import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const mergeService = readFileSync(new URL('../src/services/ffmpeg-merge.ts', import.meta.url), 'utf8')
const episodesRoute = readFileSync(new URL('../src/routes/episodes.ts', import.meta.url), 'utf8')
const backendIndex = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const useApi = readFileSync(new URL('../../frontend-react/src/entities/generation-task/api.ts', import.meta.url), 'utf8')
const composeRoutePath = new URL('../src/routes/compose.ts', import.meta.url)
const composeServicePath = new URL('../src/services/ffmpeg-compose.ts', import.meta.url)

test('episode merge uses generated videos directly without requiring compose output', () => {
  assert.doesNotMatch(mergeService, /Only composed storyboards can be merged/)
  // 优先使用视频生成产物，兼容历史的 composedVideoUrl 数据
  assert.match(mergeService, /sb\.videoUrl\s*\|\|\s*sb\.composedVideoUrl/)
  // 重构后的现行语义：允许部分拼接——按镜号顺序拼接已生成的镜头，未生成的跳过，
  // 仅当零个可用镜头时报错（旧的"所有分镜必须就绪"计数检查已废除）
  assert.match(mergeService, /\.filter\(c => Boolean\(c\.url\)\)/)
  assert.match(mergeService, /clips\.length === 0/)
  assert.match(mergeService, /所选镜头还没有可拼接的视频/)
})

test('compose workflow is no longer exposed through API surfaces', () => {
  assert.doesNotMatch(episodesRoute, /compose_shots/)
  assert.doesNotMatch(backendIndex, /api\.route\('\/compose'/)
  assert.doesNotMatch(useApi, /export const composeAPI/)
  assert.equal(existsSync(composeRoutePath), false)
  assert.equal(existsSync(composeServicePath), false)
})
