/** film build 阶段的工程工具 — 经 MCP 暴露给 hermes 编排（build-agent.ts 只剩编排壳）。
 *
 * 从原本地工具循环的内联工具原样提取，行为保持：相对路径沙箱（safeJoin，越界即拒）、
 * 过程事件追加 <工程>/agent.log、film-core still.mjs 渲帧出 JPEG、Blender 无头探测执行。
 * MCP 没有上下文注入链：projectId 等全部显式入参。渲帧/Blender 结果携带
 * ImageContent（base64 + mime），hermes 的 MCP 客户端原生把图片回喂模型，
 * 「写 → 渲 → 看图 → 修」的自检闭环由此成立。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { detectBlenderPath, runBlenderHeadless } from './blender.js'
import { generateTextureImage } from './textures.js'
import { filmProjectDir } from './render.js'

const execFileAsync = promisify(execFile)

const FILM_CORE = process.env.FILM_CORE_PATH
  ? path.resolve(process.env.FILM_CORE_PATH)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../film-core')
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** MCP 工具结果内容部件：JSON 文本或内联图片（对齐 SDK 的 text/image content） */
export type BuildToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** type 别名而非 interface：SDK 的 CallToolResult 带索引签名，字面量类型才能结构兼容 */
export type BuildToolResult = { content: BuildToolContent[] }

function textResult(output: unknown): BuildToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(output) }] }
}

/** projectId 守卫：MCP 入参没有注入链，缺省/非法直接 error 结果（SDK 不在调用期强制 schema） */
function validProjectId(projectId: unknown): projectId is number {
  return typeof projectId === 'number' && Number.isInteger(projectId)
}

const PROJECT_ID_ERROR = '缺少有效 projectId（film 工程上下文）：每次调用都必须显式传入'

function imageResult(text: string, bytes: Buffer, mimeType: string): BuildToolResult {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: bytes.toString('base64'), mimeType },
    ],
  }
}

/** 追加一行到 <工程>/agent.log（时间戳前缀；编排壳与工具写同一份日志） */
function log(projectId: number, line: string) {
  const dir = filmProjectDir(projectId)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'agent.log'), `${new Date().toISOString()} ${line}\n`)
}

/** 路径沙箱：解析后必须仍在影片工程目录内 */
export function safeJoin(dir: string, rel: string): string {
  const target = path.resolve(dir, rel)
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`路径越界：${rel}`)
  return target
}

/** 画幅 → still.mjs --size（短边 1080） */
export function frameSize(aspectRatio: string): string {
  const m = /^(\d+)\s*[:/]\s*(\d+)$/.exec(aspectRatio)
  if (!m || !Number(m[1]) || !Number(m[2])) return '1920x1080'
  const [w, h] = [Number(m[1]), Number(m[2])]
  return h >= w ? `1080x${Math.round((1080 * h) / w)}` : `${Math.round((1080 * w) / h)}x1080`
}

export interface WriteProjectFileInput {
  projectId: number
  path: string
  content: string
}

/** 在影片工程目录内写一个文件（相对路径，禁止 ../）。 */
export async function writeProjectFile(input: WriteProjectFileInput): Promise<BuildToolResult> {
  try {
    if (!validProjectId(input.projectId)) return textResult({ error: PROJECT_ID_ERROR })
    const target = safeJoin(filmProjectDir(input.projectId), input.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, input.content)
    log(input.projectId, `write_file ${input.path} (${input.content.length} chars)`)
    return textResult({ ok: true, path: input.path })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

export interface RenderFrameInput {
  projectId: number
  t: number
  note?: string
  /** 画幅（如 16:9 / 9:16），决定渲帧尺寸；缺省按 16:9 */
  aspectRatio?: string
}

/** 用 film-core 渲染工程在时间 t 秒的一帧（JPEG），结果携带 ImageContent 供模型自检。 */
export async function renderProjectFrame(input: RenderFrameInput): Promise<BuildToolResult> {
  const { projectId, t, note, aspectRatio = '16:9' } = input
  if (!validProjectId(projectId)) return textResult({ error: PROJECT_ID_ERROR })
  log(projectId, `render_frame t=${t}${note ? ` (${note})` : ''}`)
  const dir = filmProjectDir(projectId)
  const outDir = path.join(dir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const prefix = `agent_${String(Date.now()).slice(-6)}_`
  try {
    await execFileAsync(
      'node',
      [path.join(FILM_CORE, 'render', 'still.mjs'), dir, String(t), '--out', outDir, '--prefix', prefix, '--size', frameSize(aspectRatio)],
      { cwd: BACKEND_ROOT, timeout: 120_000 },
    )
  } catch (e) {
    const msg = `render 失败：${(e as Error).message.slice(0, 500)}`
    log(projectId, msg)
    return textResult({ error: msg })
  }
  const file = fs.readdirSync(outDir).find((f) => f.startsWith(prefix))
  if (!file) return textResult({ error: 'render 未产出图片' })
  const jpeg = fs.readFileSync(path.join(outDir, file))
  log(projectId, `render_frame ok → ${file} (${Math.round(jpeg.length / 1024)}KB)`)
  return imageResult(
    JSON.stringify({
      t,
      file,
      message: `已渲染 t=${t}s 的帧（${file}）。请自检：是否符合 STYLE.md？需要修改就继续修改，否则进入收尾。`,
    }),
    jpeg,
    'image/jpeg',
  )
}

export interface RunBlenderInput {
  projectId: number
  script: string
  output_image: string
  args?: string[]
}

/** 无头运行工程内的 bpy 脚本（先用 write_file 写好），渲染结果 PNG/JPG 以图片回传自检。 */
export async function runProjectBlender(input: RunBlenderInput): Promise<BuildToolResult> {
  if (!validProjectId(input.projectId)) return textResult({ error: PROJECT_ID_ERROR })
  const dir = filmProjectDir(input.projectId)
  try {
    const blenderPath = detectBlenderPath()
    if (!blenderPath) {
      return textResult({ error: '未检测到 Blender：run_blender 不可用，请用纯 three.js/Canvas 完成' })
    }
    const scriptAbs = safeJoin(dir, input.script)
    if (!fs.existsSync(scriptAbs)) return textResult({ error: `脚本不存在：${input.script}（先用 write_file 写好）` })
    const outAbs = safeJoin(dir, input.output_image)
    fs.mkdirSync(path.dirname(outAbs), { recursive: true })
    log(input.projectId, `run_blender ${input.script}${input.args?.length ? ` ${input.args.join(' ')}` : ''}`)
    const r = await runBlenderHeadless({ exe: blenderPath, scriptPath: scriptAbs, cwd: dir, args: [outAbs, ...(input.args ?? [])], timeoutMs: 300_000 })
    log(input.projectId, `run_blender ok (${Math.round(r.durationMs / 1000)}s)`)
    const tail = r.stdout.trim().split('\n').slice(-15).join('\n').slice(-1500)
    if (!fs.existsSync(outAbs)) {
      return textResult({ error: `脚本执行成功但没有产出 ${input.output_image}。输出尾部：\n${tail}` })
    }
    const img = fs.readFileSync(outAbs)
    return imageResult(
      JSON.stringify({
        output_image: input.output_image,
        durationSec: Math.round(r.durationMs / 1000),
        message: `Blender 渲染完成（${input.output_image}，${Math.round(img.length / 1024)}KB）。请自检视觉效果。\n输出尾部：\n${tail}`,
      }),
      img,
      /\.(jpe?g)$/i.test(outAbs) ? 'image/jpeg' : 'image/png',
    )
  } catch (e) {
    const msg = `run_blender 失败：${(e as Error).message.slice(0, 800)}`
    log(input.projectId, msg)
    return textResult({ error: msg })
  }
}

export interface GenerateTextureInput {
  projectId: number
  prompt: string
  filename: string
}

/** 用图片模型生成一张贴图落到工程目录（提示词须含 flat lighting / seamless 等约束）。 */
export async function generateProjectTexture(input: GenerateTextureInput): Promise<BuildToolResult> {
  try {
    if (!validProjectId(input.projectId)) return textResult({ error: PROJECT_ID_ERROR })
    const target = safeJoin(filmProjectDir(input.projectId), input.filename)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    log(input.projectId, `generate_texture ${input.filename}`)
    const { bytes, mimeType } = await generateTextureImage({ prompt: input.prompt })
    fs.writeFileSync(target, bytes)
    const ext = mimeType.includes('jpeg') ? 'jpg' : 'png'
    log(input.projectId, `generate_texture ok → ${input.filename} (${Math.round(bytes.length / 1024)}KB ${mimeType})`)
    return textResult({
      ok: true,
      path: input.filename,
      mimeType,
      message: `贴图已保存：${input.filename}（${mimeType}，${Math.round(bytes.length / 1024)}KB${ext === 'jpg' ? '，若需 PNG 请在提示词注明' : ''}）`,
    })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}
