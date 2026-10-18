import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-browser-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { runLocalTool } = await import('../src/services/production-tools/local.js')
const { productionBrowser } = await import('../src/services/production-tools/browser-render.js')
const { ffprobePath } = await import('../src/utils/ffmpeg.js')
const root = process.env.STORAGE_PATH!
let counter = 0
const camera = [{ x: 0, y: 1.6, z: 6, targetX: 0, targetY: 1.4, targetZ: 0 }]
function animatedGlb(uri?: string) {
  const binary = Buffer.alloc(68)
  const positions = [-0.6, 0, 0, 0.6, 0, 0, 0, 1.5, 0]
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4))
  binary.writeFloatLE(0, 36)
  binary.writeFloatLE(1, 40)
  const translation = [-1, 0, 0, 1, 0, 0]
  translation.forEach((value, index) => binary.writeFloatLE(value, 44 + index * 4))
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'AnimatedTriangle', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          doubleSided: true,
          pbrMetallicRoughness: {
            baseColorFactor: [1, 0.1, 0.05, 1],
            metallicFactor: 0,
            roughnessFactor: 0.8,
          },
          emissiveFactor: [0.4, 0.01, 0],
        },
      ],
      buffers: [{ byteLength: binary.length, ...(uri ? { uri } : {}) }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 8 },
        { buffer: 0, byteOffset: 44, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [-0.6, 0, 0], max: [0.6, 1.5, 0] },
        { bufferView: 1, componentType: 5126, type: 'SCALAR', count: 2, min: [0], max: [1] },
        { bufferView: 2, componentType: 5126, type: 'VEC3', count: 2 },
      ],
      animations: [
        {
          samplers: [{ input: 1, output: 2, interpolation: 'LINEAR' }],
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
        },
      ],
    }),
  )
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20)
  json.copy(padded)
  const header = Buffer.alloc(20)
  header.write('glTF')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + padded.length + binary.length, 8)
  header.writeUInt32LE(padded.length, 12)
  header.writeUInt32LE(0x4e4f534a, 16)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binary.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, padded, binHeader, binary])
}
async function invoke(
  args: Record<string, unknown>,
  options: { toolId?: string; signal?: AbortSignal; progress?: (value: number) => void } = {},
) {
  return runLocalTool({
    projectId: 1,
    toolId: options.toolId ?? 'threejs_world',
    args,
    outputDir: path.join(root, 'creative', '1', 'toolbox', String(++counter)),
    signal: options.signal ?? new AbortController().signal,
    progress: options.progress ?? (() => {}),
  })
}
before(async () => {
  await fs.mkdir(path.join(root, 'creative', '1'), { recursive: true })
  await fs.writeFile(path.join(root, 'creative', '1', 'actor.glb'), animatedGlb())
})
after(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

test('Three.js renders a real H.264 video and image using the installed browser', async (t) => {
  const installed = await productionBrowser().then(
    () => true,
    () => false,
  )
  if (!installed) {
    t.skip('Chrome / Chromium is not installed')
    return
  }
  const result = await invoke({
    world_spec: { objects: [{ type: 'box', size: 2, color: '#de5b39' }] },
    render_video: true,
    duration_seconds: 0.5,
    fps: 4,
    width: 320,
    height: 180,
  })
  const file = result.files.find((file) => file.kind === 'video')!
  assert.ok(file)
  const info = JSON.parse(
    execFileSync(
      ffprobePath || 'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file.path],
      { encoding: 'utf8' },
    ),
  )
  assert.equal(info.streams[0].codec_name, 'h264')
  assert.equal(info.streams[0].width, 320)
  assert.equal(info.streams[0].height, 180)
  assert.ok(Number(info.format.duration) >= 0.5)
  assert.equal((await sharp(result.files.find((file) => file.kind === 'image')!.path).metadata()).width, 320)
  await assert.rejects(fs.stat(path.join(path.dirname(file.path), 'browser-profile')), /ENOENT/)
})

test('embedded GLB animations are loaded offline and sampled at deterministic frame times', async (t) => {
  const installed = await productionBrowser().then(
    () => true,
    () => false,
  )
  if (!installed) {
    t.skip('Chrome / Chromium is not installed')
    return
  }
  const result = await invoke({
    model_urls: ['/static/creative/1/actor.glb'],
    world_spec: { objects: [], camera_path: camera },
    render_video: true,
    duration_seconds: 0.75,
    fps: 4,
    width: 320,
    height: 180,
  })
  const folder = path.dirname(result.files[0].path)
  const world = JSON.parse(await fs.readFile(path.join(folder, 'world.json'), 'utf8'))
  assert.equal(world.models[0].animations, 1)
  assert.equal(world.objects.length, 0)
  const first = await sharp(path.join(folder, 'three-frame-00000.png')).raw().toBuffer()
  const last = await sharp(path.join(folder, 'three-frame-00002.png')).raw().toBuffer()
  let differences = 0
  for (let index = 0; index < first.length; index++)
    if (Math.abs(first[index] - last[index]) > 20) differences++
  assert.ok(differences > 500, `Expected animated model movement, got ${differences} changed channels`)
  for (const name of ['GLTFLoader', 'BufferGeometryUtils', 'SkeletonUtils']) {
    const module = await fs.readFile(path.join(folder, `${name}.js`), 'utf8')
    assert.ok(module.includes("from './three.module.js'"))
    assert.ok(!/from ['"]three['"]/.test(module))
    assert.ok(!/from ['"]\.\.\//.test(module))
  }
})

test('models cannot reference another project, symlink across projects, or external resources', async () => {
  await assert.rejects(
    invoke({ model_urls: ['/static/creative/2/actor.glb'], world_spec: { objects: [] } }),
    /当前项目/,
  )
  await fs.mkdir(path.join(root, 'creative', '2'), { recursive: true })
  await fs.writeFile(path.join(root, 'creative', '2', 'actor.glb'), animatedGlb())
  await fs.symlink(
    path.join(root, 'creative', '2', 'actor.glb'),
    path.join(root, 'creative', '1', 'linked.glb'),
  )
  await assert.rejects(
    invoke({ model_urls: ['/static/creative/1/linked.glb'], world_spec: { objects: [] } }),
    /模型路径/,
  )
  await fs.writeFile(
    path.join(root, 'creative', '1', 'external.glb'),
    animatedGlb('https://example.com/actor.bin'),
  )
  await assert.rejects(
    invoke({ model_urls: ['/static/creative/1/external.glb'], world_spec: { objects: [] } }),
    /外部资源/,
  )
})

test('a browser spawn error rejects promptly instead of waiting forever for an exit event', async () => {
  const original = process.env.PRODUCTION_CHROME_BIN
  const invalid = path.join(directory, 'not-executable')
  await fs.writeFile(invalid, 'not a browser', { mode: 0o600 })
  process.env.PRODUCTION_CHROME_BIN = invalid
  try {
    const start = Date.now()
    await assert.rejects(
      invoke({
        world_spec: { objects: [{ type: 'sphere' }] },
        render_video: true,
        duration_seconds: 0.1,
        fps: 1,
        width: 160,
        height: 90,
      }),
      /浏览器启动失败/,
    )
    assert.ok(Date.now() - start < 5000)
  } finally {
    if (original) process.env.PRODUCTION_CHROME_BIN = original
    else delete process.env.PRODUCTION_CHROME_BIN
  }
})

test('cancelling a real browser render aborts the task and closes its private profile', async (t) => {
  const installed = await productionBrowser().then(
    () => true,
    () => false,
  )
  if (!installed) {
    t.skip('Chrome / Chromium is not installed')
    return
  }
  const controller = new AbortController()
  const folder = path.join(root, 'creative', '1', 'toolbox', String(counter + 1))
  await assert.rejects(
    invoke(
      {
        world_spec: { objects: [{ type: 'sphere' }] },
        render_video: true,
        duration_seconds: 3,
        fps: 4,
        width: 160,
        height: 90,
      },
      {
        signal: controller.signal,
        progress: (value) => {
          if (value > 0.2 && value < 1) controller.abort(new Error('test cancellation'))
        },
      },
    ),
    /test cancellation|取消/,
  )
  await assert.rejects(fs.stat(path.join(folder, 'browser-profile')), /ENOENT/)
})
