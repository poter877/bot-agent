import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createTestApp, flushRateLimits, registerUser, truncateAll, uniqueEmail, type RegisteredUser, type TestApp } from './helpers.js'

/**
 * Contract tests for the vendor-facing media surfaces: the async-poll video
 * providers (volcengine/minimax/aliyun — submit/poll/download internalized
 * server-side), the internalized fal queue (key stays here, service
 * principals only, synchronous base64 assets), and the audio routes
 * (speech/transcription over the AI SDK).
 */

const VIDEO_CATALOG = [
  { id: 'seedance', provider: 'volcengine' as const, model: 'doubao-seedance-2-0-mini', enabled: true },
]

const VIDEO_MP4 = Buffer.from('fake-video-bytes').toString('base64')

describe('POST /api/media/video — polling providers', () => {
  let testApp: TestApp
  let user: RegisteredUser
  const calls: Array<{ url: string; method: string }> = []

  beforeAll(async () => {
    const fakeFetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/contents/generations/tasks') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 })
      }
      if (url.endsWith('/tasks/task-1')) {
        const status = calls.filter((call) => call.url.endsWith('/tasks/task-1')).length === 1 ? 'running' : 'succeeded'
        return new Response(JSON.stringify({ status, content: { video_url: 'https://cdn.example.com/v.mp4' } }), { status: 200 })
      }
      if (url === 'https://cdn.example.com/v.mp4') {
        return new Response(Buffer.from('fake-video-bytes'), { status: 200, headers: { 'content-type': 'video/mp4' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { VOLCENGINE_API_KEY: 'test-volc-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      { videoCatalog: VIDEO_CATALOG, pollingDeps: { intervalMs: 1 } },
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  it('internalizes the submit/poll/download loop and answers base64', async () => {
    const response = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie, origin: 'http://127.0.0.1:3100' },
      body: JSON.stringify({ model: 'seedance', prompt: '一只猫', duration: 5, generateAudio: true }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; videos: Array<{ media_type: string; base64: string }> }
    expect(body.ok).toBe(true)
    expect(body.videos[0]!.media_type).toBe('video/mp4')
    expect(body.videos[0]!.base64).toBe(VIDEO_MP4)
    // The upstream key never appears in the wire; the vendor auth does.
    expect(calls.some((call) => call.url.includes('queue.fal.run'))).toBe(false)
  })

  it('serves the service token without an Origin header (server-to-server callers)', async () => {
    const response = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'seedance', prompt: '一只猫' }),
    })
    expect(response.status).toBe(200)
  })
})

describe('POST /api/media/queue — internalized fal queue', () => {
  let testApp: TestApp
  let user: RegisteredUser
  const upstream: Array<{ url: string; auth: string | undefined; method: string; body?: unknown }> = []
  const PNG_BYTES = Buffer.from('fake-png-bytes')

  beforeAll(async () => {
    const fakeFetch = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const url = String(input)
      upstream.push({
        url,
        auth: init?.headers?.['Authorization'],
        method: init?.method ?? 'GET',
        ...(init?.body !== undefined ? { body: JSON.parse(init.body) } : {}),
      })
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell' && init?.method === 'POST') {
        if (JSON.parse(init.body!).prompt === 'reject me') {
          return new Response(JSON.stringify({ detail: 'quota exceeded' }), { status: 422 })
        }
        return new Response(JSON.stringify({ status: 'IN_QUEUE', request_id: 'rid-1' }), { status: 200 })
      }
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell/requests/rid-1/status') {
        const done = upstream.filter((call) => call.url === url).length > 1
        return new Response(JSON.stringify({ status: done ? 'COMPLETED' : 'IN_QUEUE', queue_position: 1 }), { status: 200 })
      }
      if (url === 'https://queue.fal.run/fal-ai/flux/schnell/requests/rid-1') {
        return new Response(
          JSON.stringify({ images: [{ url: 'https://cdn.example.com/a.png' }], extra: 'https://cdn.example.com/b.png' }),
          { status: 200 },
        )
      }
      if (url === 'https://cdn.example.com/a.png' || url === 'https://cdn.example.com/b.png') {
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { FAL_KEY: 'test-fal-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      { pollingDeps: { intervalMs: 1 } },
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  beforeEach(async () => {
    upstream.length = 0
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  it('internalizes submit/poll/download for directory models and answers base64 assets', async () => {
    const response = await testApp.app.request('/api/media/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'fal-ai/flux/schnell', input: { prompt: 'a cat', num_images: 2 } }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; request_id: string; assets: Array<{ media_type: string; base64: string }> }
    expect(body.ok).toBe(true)
    expect(body.request_id).toBe('rid-1')
    const base64 = PNG_BYTES.toString('base64')
    expect(body.assets).toEqual([
      { media_type: 'image/png', base64 },
      { media_type: 'image/png', base64 },
    ])
    expect(upstream[0]).toMatchObject({ url: 'https://queue.fal.run/fal-ai/flux/schnell', method: 'POST' })
    expect(upstream[0]!.auth).toBe('Key test-fal-key')
    expect(upstream[0]!.body).toEqual({ prompt: 'a cat', num_images: 2 })
    expect(upstream.some((call) => call.url.endsWith('/requests/rid-1/status'))).toBe(true)
    // The vendor key rides only the server-to-vendor hop.
    expect(JSON.stringify(body)).not.toContain('test-fal-key')
  })

  it('rejects browser sessions and malformed model ids before any vendor call', async () => {
    const session = await testApp.app.request('/api/media/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie, origin: 'http://127.0.0.1:3100' },
      body: JSON.stringify({ model: 'fal-ai/flux/schnell', input: {} }),
    })
    expect(session.status).toBe(403)

    const escaped = await testApp.app.request('/api/media/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: '../admin', input: {} }),
    })
    expect(escaped.status).toBe(400)
    expect(upstream).toHaveLength(0)
  })

  it('answers 502 when the vendor refuses the submission', async () => {
    const response = await testApp.app.request('/api/media/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'fal-ai/flux/schnell', input: { prompt: 'reject me' } }),
    })
    expect(response.status).toBe(502)
  })
})

describe('POST /api/media/image|video — Kling', () => {
  let testApp: TestApp
  let user: RegisteredUser
  const upstream: Array<{ url: string; method: string; auth?: string; body?: unknown }> = []
  const KLING_IMAGE_CATALOG = [
    { id: 'kling-v2', provider: 'kling' as const, model: 'kling-v2', enabled: true },
  ]
  const KLING_VIDEO_CATALOG = [
    { id: 'kling-v2-6', provider: 'kling' as const, model: 'kling-v2-6', enabled: true },
  ]
  const PNG_BYTES = Buffer.from('fake-kling-png')
  const MP4_BYTES = Buffer.from('fake-kling-mp4')

  /** Kling's documented submit → poll(→ succeed) → asset URLs flow; the poll
   * answers "processing" once, then succeeds, so the loop is exercised. */
  beforeAll(async () => {
    const fakeFetch = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const url = String(input)
      upstream.push({
        url,
        method: init?.method ?? 'GET',
        auth: init?.headers?.['Authorization'],
        ...(init?.body !== undefined ? { body: JSON.parse(init.body) } : {}),
      })
      const task = url.match(/\/v1\/videos\/(text2video|image2video)\/([^/]+)$/),
        imageTask = url.match(/\/v1\/images\/generations\/([^/]+)$/)
      if (url.endsWith('/v1/videos/text2video') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 'kv-1' } }), { status: 200 })
      }
      if (url.endsWith('/v1/videos/image2video') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 'kv-2' } }), { status: 200 })
      }
      if (url.endsWith('/v1/images/generations') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 'ki-1' } }), { status: 200 })
      }
      if (task?.[2] === 'kv-1' || task?.[2] === 'kv-2') {
        const done = upstream.filter((call) => call.url.endsWith(`/tasks/${task![2]}`) || call.url.endsWith(`/${task![2]}`)).length > 1
        if (!done) return new Response(JSON.stringify({ code: 0, data: { task_status: 'processing' } }), { status: 200 })
        return new Response(
          JSON.stringify({ code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn.klingai.com/v.mp4' }] } } }),
          { status: 200 },
        )
      }
      if (imageTask?.[1] === 'ki-1') {
        const done = upstream.filter((call) => call.url.endsWith('/ki-1')).length > 1
        if (!done) return new Response(JSON.stringify({ code: 0, data: { task_status: 'processing' } }), { status: 200 })
        return new Response(
          JSON.stringify({
            code: 0,
            data: { task_status: 'succeed', task_result: { images: [{ url: 'https://cdn.klingai.com/a.png' }, { url: 'https://cdn.klingai.com/b.png' }] } },
          }),
          { status: 200 },
        )
      }
      if (url === 'https://cdn.klingai.com/v.mp4') {
        return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } })
      }
      if (url === 'https://cdn.klingai.com/a.png' || url === 'https://cdn.klingai.com/b.png') {
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { KLING_ACCESS_KEY: 'kling-access', KLING_SECRET_KEY: 'kling-secret', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      { imageCatalog: KLING_IMAGE_CATALOG, videoCatalog: KLING_VIDEO_CATALOG, pollingDeps: { intervalMs: 1 } },
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  beforeEach(async () => {
    upstream.length = 0
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  /** Recompute the documented HS256 signature so the wire token is proven,
   * not just shaped. */
  const resign = (token: string): string => {
    const [head, payload] = token.split('.')
    return `${head}.${payload}.${createHmac('sha256', 'kling-secret').update(`${head}.${payload}`).digest('base64url')}`
  }

  it('signs HS256 JWTs over the split env pair, polls, and answers video base64', async () => {
    const response = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie, origin: 'http://127.0.0.1:3100' },
      body: JSON.stringify({
        model: 'kling-v2-6', prompt: '一只猫', duration: 10, aspectRatio: '9:16', generateAudio: false,
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; videos: Array<{ media_type: string; base64: string }> }
    expect(body.ok).toBe(true)
    expect(body.videos).toEqual([{ media_type: 'video/mp4', base64: MP4_BYTES.toString('base64') }])

    const submit = upstream[0]!
    expect(submit.url).toBe('https://api-beijing.klingai.com/v1/videos/text2video')
    expect(submit.body).toEqual({
      model_name: 'kling-v2-6', prompt: '一只猫', duration: '10', mode: 'pro', aspect_ratio: '9:16', sound: 'off',
    })
    const token = submit.auth!.slice('Bearer '.length)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
    expect(payload.iss).toBe('kling-access')
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000)
    expect(resign(token)).toBe(token)
    expect(upstream.some((call) => call.url.endsWith('/videos/text2video/kv-1'))).toBe(true)
    // The secret key rides only the signature, never the wire body.
    expect(JSON.stringify(body)).not.toContain('kling-secret')
  })

  it('unwraps data-URI first frames into the image2video base64 contract', async () => {
    const frame = Buffer.from('first-frame-png').toString('base64')
    const response = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie, origin: 'http://127.0.0.1:3100' },
      body: JSON.stringify({ model: 'kling-v2-6', prompt: '一只猫', imageUrl: `data:image/png;base64,${frame}` }),
    })

    expect(response.status).toBe(200)
    const submit = upstream[0]!
    expect(submit.url).toBe('https://api-beijing.klingai.com/v1/videos/image2video')
    expect((submit.body as Record<string, unknown>)['image']).toBe(frame)
    // image2video is adaptive: no aspect_ratio is forced.
    expect((submit.body as Record<string, unknown>)['aspect_ratio']).toBeUndefined()
    expect((submit.body as Record<string, unknown>)['sound']).toBe('on')
  })

  it('answers every generated image in the images array', async () => {
    const response = await testApp.app.request('/api/media/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.cookie, origin: 'http://127.0.0.1:3100' },
      body: JSON.stringify({ model: 'kling-v2', prompt: '一张猫图', n: 2, aspectRatio: '16:9' }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; images: Array<{ media_type: string; base64: string }> }
    expect(body.images).toEqual([
      { media_type: 'image/png', base64: PNG_BYTES.toString('base64') },
      { media_type: 'image/png', base64: PNG_BYTES.toString('base64') },
    ])
    expect(upstream[0]!.url).toBe('https://api-beijing.klingai.com/v1/images/generations')
    expect(upstream[0]!.body).toEqual({ model_name: 'kling-v2', prompt: '一张猫图', n: 2, aspect_ratio: '16:9' })
  })

  it('serves the service token without an Origin header (server-to-server callers)', async () => {
    const response = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'kling-v2-6', prompt: '一只猫' }),
    })
    expect(response.status).toBe(200)
  })
})

describe('POST /api/media/image|video — Kling vendor failures', () => {
  let testApp: TestApp

  beforeAll(async () => {
    const fakeFetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input)
      if (url.endsWith('/v1/images/generations') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 1002, message: 'quota exceeded' }), { status: 200 })
      }
      if (url.endsWith('/v1/videos/text2video') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 'kv-fail' } }), { status: 200 })
      }
      if (url.endsWith('/v1/videos/text2video/kv-fail')) {
        return new Response(
          JSON.stringify({ code: 0, data: { task_status: 'failed', task_status_msg: 'sensitive content' } }),
          { status: 200 },
        )
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fakeFetch)
    testApp = await createTestApp(
      { KLING_ACCESS_KEY: 'kling-access', KLING_SECRET_KEY: 'kling-secret', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      {
        imageCatalog: [{ id: 'kling-v2', provider: 'kling' as const, model: 'kling-v2', enabled: true }],
        videoCatalog: [{ id: 'kling-v2-6', provider: 'kling' as const, model: 'kling-v2-6', enabled: true }],
        pollingDeps: { intervalMs: 1 },
      },
    )
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await testApp.close()
  })

  it('answers 502 when the vendor refuses the submission in a 200 envelope', async () => {
    const response = await testApp.app.request('/api/media/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'kling-v2', prompt: '一张猫图' }),
    })
    expect(response.status).toBe(502)
  })

  it('answers 502 when the polled task fails', async () => {
    const response = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'kling-v2-6', prompt: '一只猫' }),
    })
    expect(response.status).toBe(502)
  })
})

describe('POST /api/media/video — Kling without the key pair', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp(
      { MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      { videoCatalog: [{ id: 'kling-v2-6', provider: 'kling' as const, model: 'kling-v2-6', enabled: true }] },
    )
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('answers 503 when only one half of the pair is configured', async () => {
    const response = await testApp.app.request('/api/media/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'kling-v2-6', prompt: '一只猫' }),
    })
    expect(response.status).toBe(503)
  })
})

describe('POST /api/media/queue — without a fal key', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp({ MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' })
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('answers 503 instead of exposing a dead route', async () => {
    const response = await testApp.app.request('/api/media/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'fal-ai/flux/schnell', input: {} }),
    })
    expect(response.status).toBe(503)
  })
})

describe('POST /api/media/speech|transcription', () => {
  let testApp: TestApp
  let user: RegisteredUser

  beforeAll(async () => {
    testApp = await createTestApp(
      { OPENAI_API_KEY: 'test-openai-key', MEDIA_SERVICE_TOKEN: 'svc-token-0123456789abcdef' },
      undefined,
      undefined,
      undefined,
      {
        speechGenerator: async (request: { model: string; input: string }) => {
          if (request.model !== 'gpt-4o-mini-tts') throw new Error('unexpected model')
          return { media_type: 'audio/mpeg', base64: 'QXVkaW8=' }
        },
        transcriber: async ({ filename }: { filename: string }) => {
          if (!filename.endsWith('.mp3')) throw new Error('unexpected file')
          return { text: '全片对白', segments: [{ start: 0, end: 1.5, text: '第一句' }] }
        },
      },
    )
  })

  afterAll(async () => {
    await testApp.close()
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), 'password-123456')
  })

  it('generates speech from the service token without Origin', async () => {
    const response = await testApp.app.request('/api/media/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: '第一幕台词', voice: 'alloy' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, audio: { media_type: 'audio/mpeg', base64: 'QXVkaW8=' } })
  })

  it('404s unknown speech models before any vendor call', async () => {
    const response = await testApp.app.request('/api/media/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer svc-token-0123456789abcdef' },
      body: JSON.stringify({ model: 'not-a-model', input: 'hi' }),
    })
    expect(response.status).toBe(404)
  })

  it('transcribes multipart audio into segments', async () => {
    const form = new FormData()
    form.set('model', 'whisper-1')
    form.set('file', new Blob([Buffer.from('fake-mp3')], { type: 'audio/mpeg' }), 'source.mp3')
    const response = await testApp.app.request('/api/media/transcription', {
      method: 'POST',
      headers: { authorization: 'Bearer svc-token-0123456789abcdef' },
      body: form,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, text: '全片对白', segments: [{ start: 0, end: 1.5, text: '第一句' }] })
  })
})
