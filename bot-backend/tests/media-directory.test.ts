import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, flushRateLimits, registerUser, truncateAll, uniqueEmail, type RegisteredUser, type TestApp } from './helpers.js'

/**
 * Contract tests for the media model directory: media_models is the single
 * source of generation-model truth (console CRUD, GET /api/media/models
 * listing), with env catalogs and audio defaults seeding an empty table once.
 */

describe('media model directory', () => {
  let testApp: TestApp
  let user: RegisteredUser
  let adminCookie: string

  beforeAll(async () => {
    testApp = await createTestApp({
      OPENAI_API_KEY: 'test-openai-key',
      VOLCENGINE_API_KEY: 'test-volc-key',
      LLM_IMAGE_CATALOG: JSON.stringify([{ id: 'seedream', provider: 'volcengine', model: 'doubao-seedream-5-0' }]),
      BOT_BACKEND_ADMIN_EMAILS: 'admin@example.com',
      MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef',
    })
  })

  afterAll(async () => {
    await testApp.close()
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
    const admin = await registerUser(testApp.app, testApp.database, 'admin@example.com', 'password-123456')
    adminCookie = admin.cookie
  })

  const listModels = (headers: Record<string, string>) =>
    testApp.app.request('/api/media/models', { headers })

  type MediaModelsBody = { models: Array<{ id: string; kind: string; provider?: string }> }

  it('seeds env image catalogs and the audio defaults once, listing only key-holding providers', async () => {
    const response = await listModels({ cookie: user.cookie })
    expect(response.status).toBe(200)
    const body = (await response.json()) as MediaModelsBody
    const byId = new Map(body.models.map((entry) => [entry.id, entry]))
    expect(byId.get('seedream')).toMatchObject({ kind: 'image' })
    expect(byId.get('gpt-4o-mini-tts')).toMatchObject({ kind: 'speech' })
    expect(byId.get('whisper-1')).toMatchObject({ kind: 'transcription' })
    // xai has no key in this app: an xai row would be hidden; none seeded here,
    // so the invariant is that every listed provider is key-holding.
    for (const entry of body.models) expect(['volcengine', 'openai']).toContain(entry.provider ?? 'volcengine')
  })

  it('demands authentication', async () => {
    expect((await listModels({})).status).toBe(401)
  })

  it('console CRUD drives the gateway: create → list → disable → 403', async () => {
    const create = await testApp.app.request('/admin/media', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminCookie, origin: 'http://127.0.0.1:3100' },
      body: new URLSearchParams({
        id: 'seedance', kind: 'video', provider: 'volcengine', model: 'doubao-seedance-2-0-mini', enabled: 'on',
      }).toString(),
    })
    expect(create.status).toBe(303)

    const listed = await listModels({ cookie: user.cookie })
    const afterCreate = new Map(((await listed.json()) as MediaModelsBody).models.map((entry) => [entry.id, entry]))
    expect(afterCreate.get('seedance')).toMatchObject({ kind: 'video' })

    const toggle = await testApp.app.request('/admin/media/seedance/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminCookie, origin: 'http://127.0.0.1:3100' },
    })
    expect(toggle.status).toBe(303)

    // The catalog TTL gives stale reads for ≤15s; the direct store read is immediate.
    const generation = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'seedance', prompt: '一只猫' }),
    })
    expect(generation.status).toBe(403)
    expect(((await generation.json()) as { error: { code: string } }).error.code).toBe('model_disabled')
  })
})
