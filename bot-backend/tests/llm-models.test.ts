import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseModelCatalog, publicModelCatalog } from '../src/modules/llm/catalog.js'
import { createTestApp, flushRateLimits, jsonRequest, registerUser, truncateAll, uniqueEmail, type TestApp } from './helpers.js'

const CATALOG = parseModelCatalog(JSON.stringify([
  { id: 'fast', displayName: '日常助手', provider: 'openai', model: 'private-upstream-fast', enabled: true },
  { id: 'deep', displayName: '深度思考', provider: 'openai', model: 'private-upstream-deep', default: true,
    contextLength: 100000, capabilities: { reasoning: true, video: false }, maxOutputTokens: 4000 },
  { id: 'disabled', provider: 'openai', model: 'private-disabled', enabled: false },
  { id: 'unconfigured', provider: 'google', model: 'private-google' },
]))

describe('authenticated company model directory', () => {
  let testApp: TestApp
  beforeAll(async () => {
    testApp = await createTestApp({ OPENAI_API_KEY: 'secret-provider-key' }, { catalog: CATALOG })
  })
  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
  })
  afterAll(async () => testApp.close())

  it('returns only usable aliases and public metadata after real Better Auth login', async () => {
    expect((await jsonRequest(testApp.app, 'GET', '/api/llm/models')).status).toBe(401)
    const user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    const response = await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, { cookie: user.cookie })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.json() as ReturnType<typeof publicModelCatalog>
    expect(body.defaultModel).toBe('deep')
    expect(body.models.map((row: { id: string }) => row.id)).toEqual(['fast', 'deep'])
    expect(body.models[1]).toMatchObject({ displayName: '深度思考', contextLength: 100000,
      maxOutputTokens: 4000, capabilities: { reasoning: true, video: false, vision: true, tools: true } })
    for (const row of body.models) {
      expect(row).not.toHaveProperty('provider')
      expect(row).not.toHaveProperty('model')
    }
    expect(JSON.stringify(body)).not.toContain('private-upstream')
    expect(JSON.stringify(body)).not.toContain('secret-provider-key')
    await testApp.database.pool.query('DELETE FROM session WHERE user_id = $1', [user.userId])
    expect((await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, { cookie: user.cookie })).status).toBe(401)
  })

  it('keeps the default inside the usable directory and reports an empty unconfigured catalog', () => {
    expect(publicModelCatalog(CATALOG, {}).defaultModel).toBeNull()
    expect(publicModelCatalog(CATALOG, {}).models).toEqual([])
    const withoutDefault = CATALOG.map(entry => ({ ...entry, enabled: entry.id === 'fast' }))
    expect(publicModelCatalog(withoutDefault, { openai: 'k' }).defaultModel).toBe('fast')
    expect(() => parseModelCatalog(JSON.stringify(CATALOG.map(entry => ({ ...entry, default: true }))))).toThrow('at most one')
  })
})
