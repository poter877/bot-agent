import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { ffmpegPath } from '../../utils/ffmpeg.js'
import { z } from 'zod'
import { CreativeError } from '../creative-model.js'
const exec = promisify(execFile)
export async function toolFolder(id: number) {
  const root = await fs.realpath(STORAGE_ROOT),
    dir = path.join(root, 'creative', String(id))
  await fs.mkdir(dir, { recursive: true })
  const real = await fs.realpath(dir)
  if (!real.startsWith(root + path.sep)) throw new CreativeError('项目输出目录无效')
  return real
}
export function mediaPath(url: string) {
  return path.join(STORAGE_ROOT, url.replace(/^\/?static\//, ''))
}
export async function readModelFile(id: number, url: string) {
  const folder = await toolFolder(id),
    file = await fs.realpath(mediaPath(url))
  if (!file.startsWith(folder + path.sep) || !file.endsWith('.glb'))
    throw new CreativeError('模型路径无效', 422)
  return fs.readFile(file)
}
export async function writeToolFile(id: number, bytes: Buffer, extension: string) {
  const name = `tool-${randomUUID()}.${extension}`,
    dir = await toolFolder(id)
  await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' })
  return `/static/creative/${id}/${name}`
}
export function inspectGlb(bytes: Buffer, requireRig = false) {
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new CreativeError('文件不是有效的 GLB 2.0 模型', 422)
  const size = bytes.readUInt32LE(12)
  if (size > 8 * 1024 * 1024 || size + 20 > bytes.length) throw new CreativeError('GLB 模型头无效或过大', 422)
  const index = z.number().int().nonnegative()
  const uri = z
    .string()
    .max(50 * 1024 * 1024)
    .optional()
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8', 20, 20 + size).trim())
  } catch {
    throw new CreativeError('GLB 模型内容无效', 422)
  }
  const parsed = z
    .object({
      asset: z.object({ version: z.literal('2.0') }),
      meshes: z
        .array(
          z.object({
            primitives: z
              .array(
                z.object({
                  attributes: z.record(z.string(), index),
                  extensions: z.record(z.string(), z.unknown()).optional(),
                }),
              )
              .min(1),
          }),
        )
        .min(1),
      nodes: z.array(z.object({ mesh: index.optional(), skin: index.optional() })).default([]),
      skins: z.array(z.object({ joints: z.array(index).min(1) })).default([]),
      buffers: z.array(z.object({ uri, byteLength: index })).default([]),
      bufferViews: z
        .array(z.object({ buffer: index, byteOffset: index.default(0), byteLength: index }))
        .default([]),
      accessors: z
        .array(
          z.object({ bufferView: index.optional(), count: index, type: z.string(), componentType: index }),
        )
        .default([]),
      images: z.array(z.object({ uri, bufferView: index.optional() })).default([]),
      animations: z.array(z.unknown()).default([]),
    })
    .safeParse(raw)
  if (!parsed.success) throw new CreativeError('GLB 网格或资源结构无效', 422)
  const model = parsed.data
  for (const item of [...model.buffers, ...model.images])
    if (item.uri && !/^data:(image\/(png|jpeg|webp)|application\/octet-stream);base64,/.test(item.uri))
      throw new CreativeError('请将纹理和缓冲区嵌入 GLB 文件，不支持外部资源', 422)
  let binarySize = 0,
    offset = 20 + size
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new CreativeError('GLB 数据块不完整', 422)
    const length = bytes.readUInt32LE(offset),
      type = bytes.readUInt32LE(offset + 4)
    if (length % 4 || offset + 8 + length > bytes.length) throw new CreativeError('GLB 数据块长度无效', 422)
    if (type === 0x004e4942) binarySize += length
    offset += 8 + length
  }
  if (model.buffers.some((buffer, i) => !buffer.uri && (i !== 0 || buffer.byteLength > binarySize)))
    throw new CreativeError('GLB 缺少嵌入网格数据', 422)
  for (const view of model.bufferViews)
    if (
      !model.buffers[view.buffer] ||
      view.byteOffset + view.byteLength > model.buffers[view.buffer].byteLength
    )
      throw new CreativeError('GLB 缓冲区超出范围', 422)
  for (const accessor of model.accessors)
    if (accessor.bufferView !== undefined && !model.bufferViews[accessor.bufferView])
      throw new CreativeError('GLB 顶点数据引用无效', 422)
  for (const mesh of model.meshes)
    for (const primitive of mesh.primitives)
      if (!model.accessors[primitive.attributes.POSITION]?.count)
        throw new CreativeError('GLB 不包含有效顶点', 422)
  const joints = model.skins.reduce((sum, skin) => sum + skin.joints.length, 0)
  if (model.skins.some((skin) => skin.joints.some((j) => !model.nodes[j])))
    throw new CreativeError('GLB 骨骼引用无效', 422)
  const bound = model.nodes.some(
    (node) =>
      node.skin !== undefined &&
      node.mesh !== undefined &&
      model.skins[node.skin] &&
      model.meshes[node.mesh]?.primitives.some(
        (p) =>
          model.accessors[p.attributes.JOINTS_0]?.count && model.accessors[p.attributes.WEIGHTS_0]?.count,
      ),
  )
  if (requireRig && (!joints || !bound)) throw new CreativeError('服务返回的模型没有有效骨骼或蒙皮权重', 422)
  return { meshes: model.meshes.length, joints, animations: (model.animations ?? []).length }
}
export async function trimToolMedia(id: number, url: string, start: number, duration: number, audio = false) {
  const dir = await toolFolder(id),
    file = path.join(dir, `input-${randomUUID()}.${audio ? 'wav' : 'mp4'}`)
  try {
    await exec(
      ffmpegPath || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-ss',
        String(start),
        '-i',
        mediaPath(url),
        '-t',
        String(duration),
        ...(audio
          ? ['-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le']
          : ['-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-threads', '2']),
        file,
      ],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
    )
    return file
  } catch {
    await fs.rm(file, { force: true })
    throw new CreativeError('口型输入裁剪失败，请检查画面、配音和选段时长', 422)
  }
}
