
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestApp,
  flushRateLimits,
  jsonRequest,
  registerUser,
  truncateAll,
  uniqueEmail,
  type RegisteredUser,
  type TestApp,
} from './helpers.js'

/**
 * Contract tests for POST /api/media/image|video (company-mode media generation
 * served from server-held provider keys): the same admission ladder as the
 * model stream — auth, Origin, catalog, per-user budget — settled before any
 * vendor call, results as base64 with the bytes never persisted server-side.
 */

const IMAGE_CATALOG = [{ id: 'company-image', provider: 'fal' as const, model: 'fal-image-test', enabled: true }]
const VIDEO_CATALOG = [{ id: 'company-video', provider: 'fal' as const, model: 'fal-video-test', enabled: true }]

interface FakeImageFile {
  type: 'file'
  media_type: string
  base64: string
}

function mediaSetup() {
  const holders: { image?: unknown; video?: unknown } = {}
  return { holder: holders }
}

describe('POST /api/media/*', () => {
  let testApp: TestApp
  let user: RegisteredUser
  const seam: { image?: (req: unknown, entry: unknown) => Promise<Array<{ media_type: string; base64: string }>>; video?: (req: unknown, entry: unknown) => Promise<Array<{ media_type: string; base64: string }>>; failImage?: boolean } = {}

  beforeAll(async () => {
    testApp = await createTestApp(
      { FAL_KEY: 'test-fal-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      {
        imageCatalog: IMAGE_CATALOG,
        videoCatalog: VIDEO_CATALOG,
        imageGenerator: async () => {
          if (seam.failImage) throw new Error('quota exhausted upstream')
          return seam.image ? await seam.image({}, {}) : [{ media_type: 'image/png', base64: 'AQID' }]
        },
        videoGenerator: async () => seam.video ? await seam.video({}, {}) : [{ media_type: 'video/mp4', base64: 'ZA==' }],
      },
    )
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  afterAll(async () => {
    await testApp.close()
  })

  async function mediaPost(path: string, body: unknown, cookie = user.cookie): Promise<Response> {
    return testApp.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3100', cookie },
      body: JSON.stringify(body),
    })
  }

  it('demands a Better Auth session and a matching Origin', async () => {
    const noAuth = await jsonRequest(testApp.app, 'POST', '/api/media/image', { model: 'company-image', prompt: 'x' })
    expect(noAuth.status).toBe(401)
    const noOrigin = await testApp.app.request('/api/media/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify({ model: 'company-image', prompt: 'x' }),
    })
    expect(noOrigin.status).toBe(403)
  })

  it('404s unknown catalog ids and 403s disabled ones before any vendor call', async () => {
    const unknown = await mediaPost('/api/media/image', { model: 'nope', prompt: 'x' })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('model_not_found')
  })

  it('validates the request body', async () => {
    const emptyPrompt = await mediaPost('/api/media/image', { model: 'company-image', prompt: '' })
    expect(emptyPrompt.status).toBe(400)
    const badN = await mediaPost('/api/media/image', { model: 'company-image', prompt: 'x', n: 9 })
    expect(badN.status).toBe(400)
  })

  it('generates an image and counts usage per user/day', async () => {
    const response = await mediaPost('/api/media/image', { model: 'company-image', prompt: '一只猫' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; images: Array<{ media_type: string; base64: string }> }
    expect(body.ok).toBe(true)
    expect(body.images).toEqual([{ media_type: 'image/png', base64: 'AQID' }])

    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const usage = await testApp.redis.commands.hGetAll(`media:usage:${user.userId}:${day}`)
    expect(usage.requests).toBe('1')
    expect(usage['model:company-image']).toBe('1')
  })

  it('generates a video through the video catalog', async () => {
    const response = await mediaPost('/api/media/video', { model: 'company-video', prompt: '海浪' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; videos: Array<{ media_type: string; base64: string }> }
    expect(body.videos).toEqual([{ media_type: 'video/mp4', base64: 'ZA==' }])
  })

  it('accepts the internal service token as a media principal', async () => {
    const service = await testApp.app.request('/api/media/image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3100',
        authorization: 'Bearer svc-token-0123456789abcdef',
      },
      body: JSON.stringify({ model: 'company-image', prompt: 'x' }),
    })
    expect(service.status).toBe(200)
  })

  it('reports provider failures as 502 with a clean message', async () => {
    seam.failImage = true
    const response = await mediaPost('/api/media/image', { model: 'company-image', prompt: 'x' })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toBe('Media generation failed.')
    expect(JSON.stringify(body)).not.toContain('quota exhausted upstream')
  })
})
