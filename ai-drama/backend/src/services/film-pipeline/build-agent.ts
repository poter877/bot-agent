/** film build 阶段编排壳 — 工具循环外移到 hermes gateway（编排归一的最后一块）。
 *
 * runHermesAgent 下发系统指令（工程规范/风格约束/工具使用说明）+ 任务消息；
 * write_file/render_frame/run_blender/generate_texture 由 src/mcp/server.ts 注册，
 * hermes 侧调用并把渲帧 ImageContent 原生回喂模型，「写 → 渲 → 看图 → 修」闭环
 * 全程在 hermes。本侧只收最终文本：产出文件清单从 <工程>/agent.log 的工具日志行
 * 收集（write_file/generate_texture），index.html 缺失时兜底解析代码块落盘。
 * 过程事件实时追加到 <工程>/agent.log；最终以 index.html 存在与否校验收尾。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runHermesAgent } from '../hermes-agent.js'
import { FilmError } from './contracts.js'
import { filmProjectDir } from './render.js'
import { detectBlenderPath } from './blender.js'
import { hasImageModel } from './textures.js'

/** build 阶段整体预算：对齐原本地循环的 AbortSignal.timeout(30 分钟)，分钟级长任务 */
export const BUILD_AGENT_TIMEOUT_MS = 30 * 60_000

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

/** 从 agent.log 收集工程产物文件清单：write_file / generate_texture 的工具日志行，
 *  保留首现顺序并去重（等价于原本地循环里 written 集合的累积语义）。 */
export function collectWrittenFiles(logContent: string): string[] {
  const files: string[] = []
  const re = / write_file (\S+) \(\d+ chars\)| generate_texture ok → (\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(logContent))) files.push(path.normalize(m[1] ?? m[2]!))
  return [...new Set(files)]
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

  const blenderPath = detectBlenderPath()
  const textureReady = await hasImageModel()
  if (blenderPath) log(`检测到 Blender：${blenderPath}`)
  if (textureReady) log('图片模型可用：generate_texture 已启用')

  let instructions = [
    `你是影片工程搭建师。用纯代码（Canvas/WebGL/three.js + 采样音频）制作一支 ${input.durationSec} 秒、画幅 ${input.aspectRatio} 的短片工程。语言：${input.language}（代码/标识符用英文）。`,
    `=== 风格不变量（逐条遵守）===\n${input.styleMd}`,
    input.systemExtra,
    `\n=== 工程契约（必须满足）===`,
    `- 用 write_file 在影片工程目录写 index.html，暴露：window.DUR（秒）、window.render(t)（确定性逐帧绘制）、window.READY=true；`,
    `- 库文件用绝对路径引用（/core/lib.js、/node_modules/three/build/three.module.js）；`,
    `- 确定性：无 Date.now()、无未播种随机（可用 /core/lib.js 的 mulberry/hash）、不跨帧保存状态；`,
    `- 完成后自查契约，再输出一段完成总结（工程包含哪些文件、实现了什么、如何自检的）。只允许改动该工程目录内的文件。`,
    `\n=== 导演阐述（已确认）===\n${input.acceptedContent.slice(0, 20000)}`,
  ].join('\n')

  // 可选高级资产链路：本机装了 Blender → 无头 bpy 建模/导出；配了图片模型 → 生成贴图
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

  log('开始生成…')
  const result = await runHermesAgent({
    instructions,
    messages: [
      {
        role: 'user',
        content: [
          `主题/故事素材：${input.topic || '（自由命题，围绕风格擅长的题材）'}`,
          `本次影片工程 project_id=${input.projectId}：write_file / render_frame / run_blender / generate_texture 每次调用都要带这个 project_id（render_frame 同时传 aspect_ratio="${input.aspectRatio}"）。`,
          `先列出文件计划，然后逐个 write_file 实现；过程中用 render_frame 渲染关键帧自检视觉，按 STYLE.md 修正；`,
          `全部完成后自查：index.html 存在且暴露 DUR/render/READY 契约，最后输出完成总结（工程包含哪些文件、实现了什么、如何自检的）。`,
        ].join('\n'),
      },
    ],
    timeoutMs: BUILD_AGENT_TIMEOUT_MS,
  })

  log('agent 结束')

  // 产出清单：hermes 侧工具调用都落在 agent.log（本进程的 MCP 服务写同一份日志）
  const written = new Set(collectWrittenFiles(fs.readFileSync(logPath, 'utf8')))

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
