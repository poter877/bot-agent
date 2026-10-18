/** film build 阶段的 AI SDK Agent 循环。
 *
 * 用 AI SDK 7 内置的 Agent 类（ToolLoopAgent）跑「写工程 → film-core 渲帧 →
 * 读图自检 → 修」的迭代闭环。模型复用设置页已配置的文本模型（getTextModel）。
 * 过程事件实时追加到 <工程>/agent.log；最终以 index.html 存在与否校验收尾。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'
import { z } from 'zod'
import { getTextModel } from '../ai-text.js'
import { FilmError } from './contracts.js'
import { filmProjectDir } from './render.js'
import { detectBlenderPath, runBlenderHeadless } from './blender.js'
import { generateTextureImage, hasImageModel } from './textures.js'

const execFileAsync = promisify(execFile)

const FILM_CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../film-core')
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 画幅 → still.mjs --size（短边 1080） */
function frameSize(aspectRatio: string): string {
  const m = /^(\d+)\s*[:/]\s*(\d+)$/.exec(aspectRatio)
  if (!m || !Number(m[1]) || !Number(m[2])) return '1920x1080'
  const [w, h] = [Number(m[1]), Number(m[2])]
  return h >= w ? `1080x${Math.round((1080 * h) / w)}` : `${Math.round((1080 * w) / h)}x1080`
}

export interface BuildAgentInput {
  projectId: number
  styleSlug: string
  styleMd: string
  systemExtra: string
  topic: string
  language: string
  durationSec: number
  aspectRatio: string
  acceptedContent: string
}

/** 路径沙箱：解析后必须仍在影片工程目录内 */
function safeJoin(dir: string, rel: string): string {
  const target = path.resolve(dir, rel)
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`路径越界：${rel}`)
  return target
}

export async function runBuildAgent(input: BuildAgentInput): Promise<{ summary: string; files: string[] }> {
  const dir = filmProjectDir(input.projectId)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'agent.log')
  fs.writeFileSync(logPath, '')

  const log = (line: string) => {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  }

  log(`build agent 启动：style=${input.styleSlug} 时长=${input.durationSec}s 画幅=${input.aspectRatio}`)

  const model = await getTextModel()
  const written = new Set<string>()
  const blenderPath = detectBlenderPath()
  const textureReady = await hasImageModel()
  if (blenderPath) log(`检测到 Blender：${blenderPath}`)
  if (textureReady) log('图片模型可用：generate_texture 已启用')

  let instructions = [
    `你是影片工程搭建师。用纯代码（Canvas/WebGL/three.js + 采样音频）制作一支 ${input.durationSec} 秒、画幅 ${input.aspectRatio} 的短片工程。语言：${input.language}（代码/标识符用英文）。`,
    `=== 风格不变量（逐条遵守）===\n${input.styleMd}`,
    input.systemExtra,
    `\n=== 工程契约（必须满足）===`,
    `- 在当前目录写 index.html，暴露：window.DUR（秒）、window.render(t)（确定性逐帧绘制）、window.READY=true；`,
    `- 库文件用绝对路径引用（/core/lib.js、/node_modules/three/build/three.module.js）；`,
    `- 确定性：无 Date.now()、无未播种随机（可用 /core/lib.js 的 mulberry/hash）、不跨帧保存状态；`,
    `- 完成后调用 done 工具声明结束。只允许改动当前工作目录内的文件。`,
    `\n=== 导演阐述（已确认）===\n${input.acceptedContent.slice(0, 20000)}`,
  ].join('\n')

  const tools: ToolSet = {
      write_file: {
        description: '在影片工程目录内写入一个文件（相对路径，禁止 ../）',
        inputSchema: z.object({ path: z.string().describe('相对路径，如 index.html、ink.js'), content: z.string() }),
        execute: async ({ path: rel, content }: { path: string; content: string }) => {
          const target = safeJoin(dir, rel)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, content)
          written.add(path.normalize(rel))
          log(`write_file ${rel} (${content.length} chars)`)
          return `written: ${rel}`
        },
      },
      read_file: {
        description: '读取影片工程目录内的一个文件',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path: rel }: { path: string }) => {
          const target = safeJoin(dir, rel)
          log(`read_file ${rel}`)
          return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : `(文件不存在: ${rel})`
        },
      },
      list_files: {
        description: '列出影片工程目录内已写入的文件',
        inputSchema: z.object({}),
        execute: async () => {
          const walk = (base: string, prefix = ''): string[] =>
            fs.existsSync(base)
              ? fs.readdirSync(base, { withFileTypes: true }).flatMap((e) => {
                  const rel = prefix ? `${prefix}/${e.name}` : e.name
                  return e.isDirectory() ? walk(path.join(base, e.name), rel) : [rel]
                })
              : []
          const files = walk(dir)
          log(`list_files → ${files.length} files`)
          return files.join('\n') || '(空)'
        },
      },
      render_frame: {
        description: '用 film-core 渲染当前工程在时间 t 秒的一帧（JPEG），并返回图片供你自检视觉效果',
        inputSchema: z.object({ t: z.number().describe('时间点（秒）'), note: z.string().describe('这一帧想检验什么') }),
        execute: async ({ t, note }: { t: number; note: string }) => {
          log(`render_frame t=${t} (${note})`)
          const outDir = path.join(dir, 'out')
          fs.mkdirSync(outDir, { recursive: true })
          const prefix = `agent_${String(Date.now()).slice(-6)}_`
          try {
            await execFileAsync('node', [path.join(FILM_CORE, 'render', 'still.mjs'), dir, String(t), '--out', outDir, '--prefix', prefix, '--size', frameSize(input.aspectRatio)], {
              cwd: BACKEND_ROOT,
              timeout: 120_000,
            })
          } catch (e) {
            const msg = `render 失败：${(e as Error).message.slice(0, 500)}`
            log(msg)
            return { type: 'text' as const, value: msg }
          }
          const file = fs.readdirSync(outDir).find((f) => f.startsWith(prefix))
          if (!file) return { type: 'text' as const, value: 'render 未产出图片' }
          const jpeg = fs.readFileSync(path.join(outDir, file))
          log(`render_frame ok → ${file} (${Math.round(jpeg.length / 1024)}KB)`)
          return {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text: `已渲染 t=${t}s 的帧（${file}）。请自检：是否符合 STYLE.md？需要修改就说并继续，否则调用 done。` },
              { type: 'image' as const, image: jpeg, mimeType: 'image/jpeg' },
            ],
          }
        },
      },
      done: {
        description: '声明影片工程完成（index.html 已满足契约且自检通过）',
        inputSchema: z.object({ summary: z.string().describe('一段话：工程包含哪些文件、实现了什么、如何自检的') }),
        execute: async ({ summary }: { summary: string }) => {
          log(`done: ${summary.slice(0, 200)}`)
          return summary
        },
      },
  }

  // 可选高级资产链路：本机装了 Blender → 无头 bpy 建模/导出；配了图片模型 → 生成贴图
  if (blenderPath) {
    tools['run_blender'] = {
      description: '无头运行一个 bpy 脚本（先用 write_file 写好 .py 再调用）。用于建模、导出 GLB 资产、渲染 PNG 自检。固定相机与种子，禁止随机。脚本内用 sys.argv[sys.argv.index("--")+1:] 取业务参数（[0]=输出图绝对路径）。',
      inputSchema: z.object({
        script: z.string().describe('工程内 .py 脚本的相对路径'),
        output_image: z.string().describe('脚本将渲染结果 PNG/JPG 写到的相对路径（自检用；脚本从 sys.argv[1] 拿到它的绝对路径）'),
        args: z.array(z.string()).describe('追加传给脚本的参数（sys.argv[2:]）').optional(),
      }),
      execute: async ({ script: rel, output_image: outRel, args }: { script: string; output_image: string; args?: string[] }) => {
        const scriptAbs = safeJoin(dir, rel)
        if (!fs.existsSync(scriptAbs)) return `脚本不存在：${rel}（先用 write_file 写好）`
        const outAbs = safeJoin(dir, outRel)
        fs.mkdirSync(path.dirname(outAbs), { recursive: true })
        log(`run_blender ${rel}${args?.length ? ` ${args.join(' ')}` : ''}`)
        try {
          const r = await runBlenderHeadless({ exe: blenderPath, scriptPath: scriptAbs, cwd: dir, args: [outAbs, ...(args ?? [])], timeoutMs: 300_000 })
          log(`run_blender ok (${Math.round(r.durationMs / 1000)}s)`)
          const tail = r.stdout.trim().split('\n').slice(-15).join('\n').slice(-1500)
          if (!fs.existsSync(outAbs)) {
            return { type: 'text' as const, value: `脚本执行成功但没有产出 ${outRel}。输出尾部：\n${tail}` }
          }
          const img = fs.readFileSync(outAbs)
          return {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text: `Blender 渲染完成（${outRel}，${Math.round(img.length / 1024)}KB，${Math.round(r.durationMs / 1000)}s）。请自检视觉效果。\n输出尾部：\n${tail}` },
              { type: 'image' as const, image: img, mimeType: outAbs.endsWith('.jpg') || outAbs.endsWith('.jpeg') ? 'image/jpeg' : 'image/png' },
            ],
          }
        } catch (e) {
          const msg = `run_blender 失败：${(e as Error).message.slice(0, 800)}`
          log(msg)
          return { type: 'text' as const, value: msg }
        }
      },
    }
  }
  if (textureReady) {
    tools['generate_texture'] = {
      description: '用图片模型生成一张贴图 PNG 落到工程目录。提示词必须写明：flat lighting、no shadows/highlights、seamless tileable texture、纯外观无光照；供 Blender/three.js 当 albedo 用。',
      inputSchema: z.object({
        prompt: z.string().describe('贴图内容描述（记得加 flat lighting / seamless / texture only 约束）'),
        filename: z.string().describe('保存的相对路径，如 assets/rust_metal.png'),
      }),
      execute: async ({ prompt, filename }: { prompt: string; filename: string }) => {
        const target = safeJoin(dir, filename)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        log(`generate_texture ${filename}`)
        const { bytes, mimeType } = await generateTextureImage({ prompt })
        fs.writeFileSync(target, bytes)
        written.add(path.normalize(filename))
        const ext = mimeType.includes('jpeg') ? 'jpg' : 'png'
        log(`generate_texture ok → ${filename} (${Math.round(bytes.length / 1024)}KB ${mimeType})`)
        return `贴图已保存：${filename}（${mimeType}，${Math.round(bytes.length / 1024)}KB${ext === 'jpg' ? '，若需 PNG 请在提示词注明' : ''}）`
      },
    }
  }

  if (blenderPath) {
    instructions += [
      `\n\n=== 可选：Blender 资产链路（本机已检测到 Blender）===`,
      `- 需要精细硬表面模型（机械、建筑、道具）时：先用 write_file 写 bpy 脚本，再调用 run_blender 无头执行；`,
      `- 脚本契约：业务参数从 "--" 之后的 sys.argv 取（args = sys.argv[sys.argv.index('--')+1:]，args[0]=输出图绝对路径，args[1:]=追加参数；注意 Blender 的 sys.argv 含完整命令行，sys.argv[1] 是 --background 不是业务参数）；固定相机/种子，禁用随机与帧间状态；`,
      `- 建 GLB 资产用 bpy.ops.export_scene.gltf(filepath=…) 导出，index.html 用 /node_modules/three/examples/jsm/loaders/GLTFLoader.js 加载，全部加载完成后再置 window.READY=true；`,
      `- 用 render_frame 或 run_blender 的输出图自检视觉；最终契约不变（index.html 暴露 DUR/render/READY）。`,
    ].join('\n')
  }
  if (textureReady) {
    instructions += `\n\n可选：generate_texture 可用图片模型生成贴图（提示词须含 flat lighting / seamless / texture only，无光影），供材质 albedo 使用。`
  }

  const agent = new ToolLoopAgent({
    id: `film-build-${input.styleSlug}`,
    model,
    instructions,
    tools,
    stopWhen: [stepCountIs(60)],
    onStepStart: ({ stepNumber }) => log(`— step ${stepNumber} —`),
    onStepFinish: ({ content }) => {
      const parts = Array.isArray(content) ? content : []
      for (const p of parts) {
        if (p.type === 'tool-call') log(`tool: ${p.toolName}`)
      }
    },
    onToolExecutionStart: (event) => log(`▸ ${String((event as { toolName?: string }).toolName ?? 'tool')}`),
    onToolExecutionEnd: (event) => log(`▸ ${String((event as { toolName?: string }).toolName ?? 'tool')} 完成`),
  })

  log('开始生成…')
  const result = await agent.generate({
    prompt: [
      `主题/故事素材：${input.topic || '（自由命题，围绕风格擅长的题材）'}`,
      `先列出文件计划，然后逐个 write_file 实现；过程中用 render_frame 渲染关键帧自检视觉，按 STYLE.md 修正；`,
      `全部完成后自查：index.html 存在且暴露 DUR/render/READY 契约，再调用 done 声明完成。`,
    ].join('\n'),
    abortSignal: AbortSignal.timeout(30 * 60_000),
  })

  log(`agent 结束：finishReason=${result.finishReason}, steps=${result.steps.length}`)

  // 兜底：模型没调用 write_file 时，从最终文本中提取 ```文件名 代码块落盘
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    const re = /```(?:html|js|javascript|css|py|python)?\s*\n([\s\S]*?)```/g
    let m: RegExpExecArray | null
    let idx = 0
    while ((m = re.exec(result.text))) {
      idx++
      const guess = idx === 1 ? 'index.html' : `module_${idx}.js`
      fs.writeFileSync(path.join(dir, guess), m[1]!)
      written.add(guess)
    }
    if (!fs.existsSync(path.join(dir, 'index.html'))) {
      throw new FilmError('build 结束但工程缺少 index.html（模型未产出可落盘文件）', 502)
    }
    for (const f of written) log(`fallback 落盘: ${f}`)
  }

  const files = [...written]
  return {
    summary: result.text.slice(0, 4000) || `影片工程已完成（${files.length} 个文件）`,
    files,
  }
}

export function readFilmAgentLog(projectId: number, sinceBytes: number): { content: string; nextOffset: number; size: number } {
  const logPath = path.join(filmProjectDir(projectId), 'agent.log')
  if (!fs.existsSync(logPath)) return { content: '', nextOffset: sinceBytes, size: 0 }
  const stat = fs.statSync(logPath)
  const start = Math.min(sinceBytes, stat.size)
  const fd = fs.openSync(logPath, 'r')
  const buf = Buffer.alloc(stat.size - start)
  fs.readSync(fd, buf, 0, buf.length, start)
  fs.closeSync(fd)
  return { content: buf.toString('utf8'), nextOffset: stat.size, size: stat.size }
}
