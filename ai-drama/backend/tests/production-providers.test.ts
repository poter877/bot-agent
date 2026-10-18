import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { ffmpegPath } from '../src/utils/ffmpeg.js'
const fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-provider-fixtures-'))
const png = await sharp({
  create: { width: 8, height: 8, channels: 3, background: 'blue' },
})
  .png()
  .toBuffer()
const audioFile = path.join(fixturesDir, 'audio.wav'),
  videoFile = path.join(fixturesDir, 'video.mp4')
execFileSync(ffmpegPath!, [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440',
  '-t',
  '0.2',
  audioFile,
])
execFileSync(ffmpegPath!, [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=16x16:r=10',
  '-t',
  '0.2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  videoFile,
])
const audio = await fs.readFile(audioFile),
  video = await fs.readFile(videoFile)
test.after(() => fs.rm(fixturesDir, { recursive: true, force: true }))
import {
  runProviderTool,
  providerPresets,
  providerToolSpecs,
  type ProviderContext,
  type ProviderDependencies,
} from '../src/services/production-tools/providers.js'
import { responseBytes, serviceUrl, outputBytes } from '../src/services/production-tools/provider-runtime.js'
import { klingToken } from '../src/services/production-tools/provider-kling.js'
import { tencentHeaders } from '../src/services/production-tools/provider-regional.js'
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  })
async function fixture(id: string, args: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-provider-'))
  const spec = providerToolSpecs[id],
    preset = providerPresets[spec.serviceType][spec.provider]
  const ctx: ProviderContext = {
    projectId: 1,
    toolId: id,
    args,
    outputDir: dir,
    signal: new AbortController().signal,
    progress: () => {},
    config: {
      id: 42,
      provider: spec.provider,
      baseUrl: preset.baseUrl,
      apiKey: 'test-secret',
      model: spec.model,
    },
    state: {},
    checkpoint: () => {},
  }
  const calls: { url: string; init: RequestInit }[] = [],
    queue: Response[] = []
  const deps: Partial<ProviderDependencies> = {
    fetch: (async (url, init = {}) => {
      calls.push({ url: String(url), init })
      const response = queue.shift()
      if (!response) throw new Error('unexpected call')
      return response
    }) as typeof fetch,
    sleep: async () => {},
    download: async (url) =>
      /\.(mp4|webm)(?:\?|$)/.test(url) ? video : /\.(mp3|wav|ogg)(?:\?|$)/.test(url) ? audio : png,
    readMedia: async () => ({
      name: 'upload.png',
      mime: 'image/png',
      bytes: Buffer.from('owned-input'),
    }),
  }
  return {
    ctx,
    deps,
    calls,
    queue,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}
async function withFixture(
  id: string,
  args: Record<string, unknown>,
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture(id, args)
  try {
    await run(f)
  } finally {
    await f.cleanup()
  }
}

test('Fal persists authoritative queue URLs and downloads completed output', async () =>
  withFixture('gemini_fal_image', { prompt: 'rainy street' }, async (f) => {
    f.queue.push(
      json({
        request_id: 'r1',
        status_url: 'https://queue.fal.run/fal-ai/nano-banana/requests/r1/status',
        response_url: 'https://queue.fal.run/fal-ai/nano-banana/requests/r1',
      }),
      json({ status: 'COMPLETED' }),
      json({ images: [{ url: 'https://v3.fal.media/a.png' }] }),
    )
    const result = await runProviderTool(f.ctx, f.deps)
    assert.equal(result.files[0].kind, 'image')
    assert.equal(f.ctx.state.remoteId, 'r1')
    assert.equal(f.calls.length, 3)
    assert.match(f.calls[0].url, /nano-banana$/)
    assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'), 'Key test-secret')
    assert.deepEqual(await fs.readFile(result.files[0].path), png)
  }))
test('a shared Fal config does not run the wrong tool model', async () =>
  withFixture('gemini_fal_image', { prompt: 'street' }, async (f) => {
    f.ctx.config!.model = 'fal-ai/flux/schnell'
    f.queue.push(
      json({ request_id: 'r2' }),
      json({ status: 'COMPLETED' }),
      json({ images: [{ url: 'https://fal.media/file.png' }] }),
    )
    await runProviderTool(f.ctx, f.deps)
    assert.match(f.calls[0].url, /nano-banana$/)
  }))
test('Fal resume polls stored request without submitting again', async () =>
  withFixture('flux_image', {}, async (f) => {
    Object.assign(f.ctx.state, { remoteId: 'saved', submissionStarted: true })
    f.queue.push(json({ status: 'COMPLETED' }), json({ images: [{ url: 'https://fal.media/file.png' }] }))
    await runProviderTool(f.ctx, f.deps)
    assert.ok(f.calls.every((v) => !v.init.method || v.init.method === 'GET'))
  }))
test('an uncertain async submission never gets silently resubmitted', async () =>
  withFixture('flux_image', { prompt: 'street' }, async (f) => {
    f.ctx.state.submissionStarted = true
    await assert.rejects(runProviderTool(f.ctx, f.deps), /提交.*不确定/)
    assert.equal(f.calls.length, 0)
  }))
test('provider mismatches and changed configuration IDs are rejected', async () =>
  withFixture('flux_image', { prompt: 'street' }, async (f) => {
    f.ctx.config!.provider = 'replicate'
    await assert.rejects(runProviderTool(f.ctx, f.deps), /需要 fal/)
    f.ctx.config!.provider = 'fal'
    f.ctx.state.configId = 43
    await assert.rejects(runProviderTool(f.ctx, f.deps), /原模型配置/)
  }))
test('Fal status URL cannot leak authorization to another host', async () =>
  withFixture('flux_image', { prompt: 'street' }, async (f) => {
    f.queue.push(json({ request_id: 'id', status_url: 'https://evil.example/status' }))
    await assert.rejects(runProviderTool(f.ctx, f.deps), /不受信任/)
    assert.equal(f.calls.length, 1)
    assert.equal(f.ctx.state.remoteId, 'id')
  }))
test('Fal 3D reference is read through project media ownership boundary', async () =>
  withFixture('fal_3d', { image: '/static/creative/2/stolen.png' }, async (f) => {
    f.deps.readMedia = async () => {
      throw new Error('只能使用当前项目素材')
    }
    await assert.rejects(runProviderTool(f.ctx, f.deps), /当前项目/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.ctx.state.submissionStarted, undefined)
  }))
test('Replicate submits to model predictions and restores durable prediction', async () =>
  withFixture('seedance_replicate', { prompt: 'walk' }, async (f) => {
    f.queue.push(
      json({ id: 'p1' }),
      json({ status: 'succeeded', output: 'https://replicate.delivery/a.mp4' }),
    )
    const result = await runProviderTool(f.ctx, f.deps)
    assert.match(f.calls[0].url, /v1\/models\/bytedance\/seedance-1-pro\/predictions$/)
    assert.equal(f.ctx.state.remoteId, 'p1')
    assert.equal(result.files[0].kind, 'video')
  }))
test('ComfyUI validates API workflow and installed nodes before submission', async () =>
  withFixture(
    'comfyui_image',
    { workflow_json: { '1': { class_type: 'MissingModelNode', inputs: {} } } },
    async (f) => {
      f.queue.push(json({ SaveImage: {} }))
      await assert.rejects(runProviderTool(f.ctx, f.deps), /缺少 MissingModelNode/)
      assert.equal(f.calls.length, 1)
      assert.equal(f.ctx.state.submissionStarted, undefined)
    },
  ))
test('ComfyUI downloads only matching saved media after completion', async () =>
  withFixture(
    'comfyui_image',
    { workflow_json: { '1': { class_type: 'SaveImage', inputs: {} } } },
    async (f) => {
      f.queue.push(
        json({ SaveImage: {} }),
        json({ prompt_id: 'pc' }),
        json({
          pc: {
            status: { completed: true },
            outputs: {
              '1': {
                images: [{ filename: 'result.png', type: 'output', subfolder: '' }],
              },
            },
          },
        }),
        new Response(new Uint8Array(png), {
          headers: { 'content-type': 'image/png' },
        }),
      )
      const result = await runProviderTool(f.ctx, f.deps)
      assert.equal(result.files.length, 1)
      assert.equal(f.ctx.state.remoteId, 'pc')
      assert.match(f.calls.at(-1)!.url, /\/view\?/)
    },
  ))
test('ComfyUI UI workflow format is rejected with actionable guidance', async () =>
  withFixture('comfyui_video', { workflow_json: { nodes: [] } }, async (f) => {
    await assert.rejects(runProviderTool(f.ctx, f.deps), /API 格式/)
    assert.equal(f.calls.length, 0)
  }))
test('speech providers use provider-specific authentication and payloads', async () =>
  withFixture('elevenlabs_tts', { text: 'hello', voice_id: 'voice-123' }, async (f) => {
    f.queue.push(
      new Response(new Uint8Array(audio), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps)
    assert.equal(new Headers(f.calls[0].init.headers).get('xi-api-key'), 'test-secret')
    assert.match(f.calls[0].url, /v1\/text-to-speech\/voice-123$/)
    assert.equal(JSON.parse(String(f.calls[0].init.body)).model_id, 'eleven_multilingual_v2')
    assert.equal(result.files[0].kind, 'audio')
  }))
test('Inworld decodes documented base64 JSON response', async () =>
  withFixture('inworld_tts', { text: 'hello' }, async (f) => {
    f.queue.push(json({ audioContent: audio.toString('base64') }))
    const result = await runProviderTool(f.ctx, f.deps)
    assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'), 'Basic test-secret')
    assert.deepEqual(await fs.readFile(result.files[0].path), audio)
  }))
test('Gemini TTS wraps PCM in a playable WAV container', async () =>
  withFixture('gemini_tts', { text: 'hello' }, async (f) => {
    f.queue.push(
      json({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;rate=24000',
                    data: Buffer.alloc(480).toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps),
      bytes = await fs.readFile(result.files[0].path)
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
    assert.equal(bytes.readUInt32LE(24), 24000)
    assert.equal(bytes.length, 524)
  }))
test('binary speech response cannot treat a provider JSON error as audio', async () =>
  withFixture('openai_tts', { text: 'hello' }, async (f) => {
    f.queue.push(json({ error: 'quota error' }))
    await assert.rejects(runProviderTool(f.ctx, f.deps), /未返回媒体/)
  }))
test('music generation passes milliseconds and instrumental preference', async () =>
  withFixture('music_gen', { prompt: 'jazz', duration: 35, instrumental: true }, async (f) => {
    f.queue.push(
      new Response(new Uint8Array(audio), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    )
    await runProviderTool(f.ctx, f.deps)
    const body = JSON.parse(String(f.calls[0].init.body))
    assert.equal(body.music_length_ms, 35000)
    assert.equal(body.force_instrumental, true)
  }))
test('Runway sends documented API version and polls task output', async () =>
  withFixture('runway_video', { prompt: 'street' }, async (f) => {
    f.queue.push(
      json({ id: 'run1' }),
      json({ status: 'SUCCEEDED', output: ['https://cdn.runwayml.com/v.mp4'] }),
    )
    await runProviderTool(f.ctx, f.deps)
    assert.equal(new Headers(f.calls[0].init.headers).get('X-Runway-Version'), '2024-11-06')
    assert.match(f.calls[1].url, /v1\/tasks\/run1$/)
  }))
test('LTX resumes image endpoint selected at submission', async () =>
  withFixture('ltx_api_video', {}, async (f) => {
    Object.assign(f.ctx.state, {
      remoteId: 'ltx1',
      endpoint: 'image-to-video',
      submissionStarted: true,
    })
    f.queue.push(
      json({
        status: 'completed',
        result: { video_url: 'https://storage.googleapis.com/a.mp4' },
      }),
    )
    await runProviderTool(f.ctx, f.deps)
    assert.match(f.calls[0].url, /v2\/image-to-video\/ltx1$/)
  }))
test('HeyGen uses v3 avatar contract and asset-safe local image input', async () =>
  withFixture(
    'heygen_avatar',
    { script: 'hello', voice_id: 'voice', image: '/static/uploads/person.png' },
    async (f) => {
      f.queue.push(
        json({ data: { video_id: 'hg1' } }),
        json({
          data: {
            status: 'completed',
            video_url: 'https://files.heygen.com/result.mp4',
          },
        }),
      )
      await runProviderTool(f.ctx, f.deps)
      const body = JSON.parse(String(f.calls[0].init.body))
      assert.equal(body.type, 'image')
      assert.equal(body.image.type, 'base64')
      assert.equal(body.voice_id, 'voice')
      assert.match(f.calls[1].url, /v3\/videos\/hg1$/)
    },
  ))
test('Ideogram async failures are terminal and not success results', async () =>
  withFixture('ideogram_image', { prompt: 'street' }, async (f) => {
    f.queue.push(json({ generation_id: 'ig1' }), json({ status: 'failed', failure_reason: 'policy' }))
    await assert.rejects(runProviderTool(f.ctx, f.deps), /任务失败/)
    assert.equal(f.ctx.state.remoteId, 'ig1')
  }))
test('Atlas Suno uses generateAudio and preserves both returned tracks', async () =>
  withFixture('suno_music', { prompt: 'jazz' }, async (f) => {
    f.queue.push(
      json({ data: { id: 'a1' } }),
      json({
        data: {
          status: 'completed',
          outputs: ['https://cdn.atlascloud.ai/a.mp3', 'https://cdn.atlascloud.ai/b.mp3'],
        },
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps)
    assert.match(f.calls[0].url, /api\/v1\/model\/generateAudio$/)
    assert.equal(JSON.parse(String(f.calls[0].init.body)).model, 'suno/chirp-v5')
    assert.equal(result.files.length, 2)
  }))
test('Imagen legacy tool transparently records migration to supported Nano Banana API', async () =>
  withFixture('google_imagen', { prompt: 'mountain' }, async (f) => {
    f.queue.push(
      json({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: png.toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps)
    assert.match(f.calls[0].url, /gemini-2.5-flash-image:generateContent$/)
    assert.equal(result.data?.migratedFrom, 'Imagen')
  }))
test('DashScope ASR returns text without inventing timestamps', async () =>
  withFixture('dashscope_asr', { audio: '/static/uploads/audio.wav' }, async (f) => {
    f.queue.push(
      json({
        output: { choices: [{ message: { content: [{ text: '你好' }] } }] },
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps)
    assert.equal(result.data?.text, '你好')
    assert.equal(result.files[0].kind, 'data')
    assert.equal(
      result.files.some((v) => v.kind === 'subtitle'),
      false,
    )
  }))
test('Lyria requires Google Cloud project before a billable submission', async () =>
  withFixture('google_music', { prompt: 'jazz' }, async (f) => {
    await assert.rejects(runProviderTool(f.ctx, f.deps), /Google Cloud 项目/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.ctx.state.submissionStarted, undefined)
  }))
test('stock search preserves source credit and downloads only selected item', async () =>
  withFixture('pexels_image', { query: 'forest', download: true, selected_id: '17' }, async (f) => {
    f.queue.push(
      json({
        photos: [
          {
            id: 17,
            url: 'https://pexels.com/photo/17',
            photographer: 'Alice',
            src: { original: 'https://images.pexels.com/a.jpg' },
          },
        ],
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps),
      sidecar = JSON.parse(await fs.readFile(result.files[1].path, 'utf8'))
    assert.equal(sidecar.source.author, 'Alice')
    assert.equal(sidecar.source.license, 'Pexels License')
    assert.equal(result.files[0].kind, 'image')
    assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'), 'test-secret')
  }))
test('Pixabay API key is query authenticated and absent from saved search results', async () =>
  withFixture('pixabay_image', { query: 'forest' }, async (f) => {
    f.queue.push(
      json({
        hits: [
          {
            id: 1,
            tags: 'forest',
            pageURL: 'https://pixabay.com/1',
            largeImageURL: 'https://pixabay.com/1.jpg',
            user: 'Alice',
          },
        ],
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps)
    assert.equal(new URL(f.calls[0].url).searchParams.get('key'), 'test-secret')
    assert.equal((await fs.readFile(result.files[0].path, 'utf8')).includes('test-secret'), false)
  }))
test('bounded response reader cancels oversized provider responses', async () => {
  const response = new Response(Buffer.alloc(128))
  await assert.rejects(responseBytes(response, 64), /大小限制/)
})
test('service URL validation rejects credential URLs and non-local insecure HTTP', () => {
  assert.throws(
    () =>
      serviceUrl(
        {
          provider: 'openai',
          baseUrl: 'https://user:pass@example.com',
          apiKey: 'x',
          model: 'x',
        },
        '/v1',
      ),
    /地址无效/,
  )
  assert.throws(
    () =>
      serviceUrl(
        {
          provider: 'openai',
          baseUrl: 'http://example.com',
          apiKey: 'x',
          model: 'x',
        },
        '/v1',
      ),
    /HTTPS/,
  )
  assert.equal(
    serviceUrl(
      {
        provider: 'comfyui',
        baseUrl: 'http://127.0.0.1:8188',
        apiKey: '',
        model: 'api-workflow',
      },
      '/prompt',
    ),
    'http://127.0.0.1:8188/prompt',
  )
})

test('definitive HTTP 403 records rejection rather than uncertain billing', async () =>
  withFixture('flux_image', { prompt: 'street' }, async (f) => {
    f.queue.push(new Response('', { status: 403 }))
    await assert.rejects(runProviderTool(f.ctx, f.deps), /HTTP 403/)
    assert.equal(f.ctx.state.rejected, true)
  }))
test('HTML pretending to be a generated PNG is rejected', async () =>
  withFixture('flux_image', { prompt: 'street' }, async (f) => {
    f.queue.push(
      json({ request_id: 'fake' }),
      json({ status: 'COMPLETED' }),
      json({ images: [{ url: 'https://fal.media/fake.png' }] }),
    )
    f.deps.download = async () => Buffer.from('<html>Error</html>')
    await assert.rejects(runProviderTool(f.ctx, f.deps), /图片服务返回/)
  }))
test('Kling signs expiring JWT on server and uses documented image/video task contract', async () =>
  withFixture('kling_official_video', { prompt: 'street', duration: 5 }, async (f) => {
    f.ctx.config!.apiKey = 'access-id:secret-value'
    f.queue.push(
      json({ code: 0, data: { task_id: 'kl1' } }),
      json({
        code: 0,
        data: {
          task_status: 'succeed',
          task_result: { videos: [{ url: 'https://cdn.klingai.com/a.mp4' }] },
        },
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps),
      token = new Headers(f.calls[0].init.headers).get('Authorization')!.slice(7),
      payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    assert.equal(payload.iss, 'access-id')
    assert.ok(payload.exp > Date.now() / 1000)
    assert.match(f.calls[0].url, /\/v1\/videos\/text2video$/)
    assert.equal(result.files[0].kind, 'video')
    assert.equal(JSON.stringify(f.ctx.state).includes('secret-value'), false)
  }))
test('Kling validates credential shape before a billable submission', async () =>
  withFixture('kling_official_image', { prompt: 'street' }, async (f) => {
    await assert.rejects(runProviderTool(f.ctx, f.deps), /AccessKey:SecretKey/)
    assert.equal(f.ctx.state.submissionStarted, undefined)
    assert.equal(f.calls.length, 0)
  }))
test('Kling records a definitive business rejection in HTTP 200', async () =>
  withFixture('kling_official_image', { prompt: 'street' }, async (f) => {
    f.ctx.config!.apiKey = 'access:secret'
    f.queue.push(json({ code: 1002, message: 'invalid' }))
    await assert.rejects(runProviderTool(f.ctx, f.deps), /服务拒绝/)
    assert.equal(f.ctx.state.rejected, true)
  }))
test('Doubao reads HTTP JSON audio chunks and uses unified API key resource headers', async () =>
  withFixture('doubao_tts', { text: '你好' }, async (f) => {
    f.queue.push(
      new Response(
        JSON.stringify({
          code: 0,
          data: audio.subarray(0, 100).toString('base64'),
        }) +
          '\n' +
          JSON.stringify({
            code: 0,
            data: audio.subarray(100).toString('base64'),
          }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    const result = await runProviderTool(f.ctx, f.deps),
      headers = new Headers(f.calls[0].init.headers)
    assert.equal(headers.get('X-Api-Key'), 'test-secret')
    assert.equal(headers.get('X-Api-Resource-Id'), 'seed-tts-2.0')
    assert.deepEqual(await fs.readFile(result.files[0].path), audio)
  }))
test('Tencent Hunyuan signs native image job requests and respects numeric status codes', async () =>
  withFixture('hunyuan_image', { prompt: '雨中竹林' }, async (f) => {
    f.ctx.config!.apiKey = 'AKIDEXAMPLE:secret-value'
    f.queue.push(
      json({ Response: { JobId: 'hy1' } }),
      json({
        Response: {
          JobStatusCode: '5',
          ResultImage: ['https://example.cos.ap-guangzhou.myqcloud.com/a.png'],
        },
      }),
    )
    const result = await runProviderTool(f.ctx, f.deps),
      headers = new Headers(f.calls[0].init.headers)
    assert.equal(headers.get('X-TC-Action'), 'SubmitHunyuanImageJob')
    assert.equal(headers.get('X-TC-Version'), '2023-09-01')
    assert.equal(headers.get('X-TC-Region'), 'ap-guangzhou')
    assert.match(headers.get('Authorization')!, /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
    assert.equal(headers.get('Authorization')!.includes('secret-value'), false)
    assert.equal(new Headers(f.calls[1].init.headers).get('X-TC-Action'), 'QueryHunyuanImageJob')
    assert.equal(result.files[0].kind, 'image')
  }))
test('Tencent video uses its dedicated vclm service and DONE video output contract', async () =>
  withFixture('hunyuan_cloud_video', { prompt: '雨中竹林', duration: 5 }, async (f) => {
    f.ctx.config!.apiKey = 'AKID:secret'
    f.queue.push(
      json({ Response: { JobId: 'hv1' } }),
      json({
        Response: {
          Status: 'DONE',
          ResultVideoUrl: 'https://example.myqcloud.com/a.mp4',
        },
      }),
    )
    await runProviderTool(f.ctx, f.deps)
    assert.equal(new URL(f.calls[0].url).hostname, 'vclm.tencentcloudapi.com')
    assert.equal(new Headers(f.calls[0].init.headers).get('X-TC-Version'), '2024-05-23')
    assert.equal(new Headers(f.calls[1].init.headers).get('X-TC-Action'), 'DescribeHunyuanToVideoJob')
  }))

test('Kling JWT matches a fixed HS256 credential and clock vector', () => {
  // Expected value independently computed with Python's standard hmac implementation.
  assert.equal(
    klingToken('access-id:secret-value', 1700000000000),
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhY2Nlc3MtaWQiLCJleHAiOjE3MDAwMDE4MDAsIm5iZiI6MTY5OTk5OTk5NX0.D_RRLFPvOaYhA7_dWndkoxeJAIMnnTgzFOkskjy1VRk',
  )
})

test('Tencent TC3 signature matches a fixed canonical request vector', () => {
  const headers = tencentHeaders(
    'AKIDEXAMPLE:test-secret',
    'hunyuan.tencentcloudapi.com',
    'hunyuan',
    'SubmitHunyuanImageJob',
    '2023-09-01',
    'ap-guangzhou',
    '{"Prompt":"rainy street"}',
    1700000000000,
  )
  assert.equal(headers['X-TC-Timestamp'], '1700000000')
  assert.equal(
    headers.Authorization,
    'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2023-11-14/hunyuan/tc3_request, SignedHeaders=content-type;host, Signature=aa0fd8bc9b1bb8db9e796d30a9410529b198711997224436e19859898a2f10ca',
  )
})

test('TIFF provider images normalize to project-importable PNG', async () =>
  withFixture('flux_image', {}, async (f) => {
    const tiff = await sharp(png).tiff().toBuffer()
    const result = await outputBytes(f.ctx, tiff, 'image', 'tiff')
    assert.equal(path.extname(result.path), '.png')
    assert.equal((await sharp(result.path).metadata()).format, 'png')
  }))

test('uncertain ComfyUI submission does not repeat uploads or server requests', async () =>
  withFixture('comfyui_image', {}, async (f) => {
    f.ctx.state.submissionStarted = true
    await assert.rejects(runProviderTool(f.ctx, f.deps), /尚不确定/)
    assert.equal(f.calls.length, 0)
  }))
