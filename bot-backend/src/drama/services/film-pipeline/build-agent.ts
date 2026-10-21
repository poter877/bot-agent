/** film build 阶段编排壳 — 工具循环外移到 hermes gateway（编排归一的最后一块）。
 *
 * （《重构》清理：工具循环外移桌面端后本模块的编排壳已下线，仅保留日志读取。）
 * write_file/render_frame/run_blender/generate_texture 由 src/mcp/server.ts 注册，
 * hermes 侧调用并把渲帧 ImageContent 原生回喂模型，「写 → 渲 → 看图 → 修」闭环
 * 全程在 hermes。本侧只收最终文本：产出文件清单从 <工程>/agent.log 的工具日志行
 * 收集（write_file/generate_texture），index.html 缺失时兜底解析代码块落盘。
 * 过程事件实时追加到 <工程>/agent.log；最终以 index.html 存在与否校验收尾。
 */
import fs from 'node:fs'
import path from 'node:path'
import { FilmError } from './contracts.js'
import { filmProjectDir } from './render.js'

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
  /** 贯穿链路关联 id（X-Correlation-Id）：调用方（film run 驱动）传 run id */
  correlationId?: string
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
  // 《重构》清理：build 阶段是真正的工具循环编排（写→渲→看图→修），归桌面
  // Hermes 客户端执行；HERMES_AGENT_* 网关已退役，服务端不再代调。接入客户端
  // 车道前该阶段明确不可用。
  const dir = filmProjectDir(input.projectId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.log'), `${new Date().toISOString()} build 阶段暂不可用：编排已外移桌面端\n`)
  throw new FilmError('影片 build 阶段的工程编排需桌面端 AI 执行（服务端不再代调模型编排），暂未接入客户端车道', 503)
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
