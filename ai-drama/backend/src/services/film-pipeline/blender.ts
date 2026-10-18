/** Blender 检测与无头执行。
 *
 * 检测顺序：BLENDER_PATH 环境变量 → PATH 中的 blender → 平台常见安装位置。
 * run_blender 工具只在检测到可执行文件时注册给 build agent；没有就静默降级为纯 three.js。
 * 无头执行：`blender --background --python <script> -- <args...>`，`--` 之后的参数经
 * sys.argv 传给脚本（脚本里 sys.argv[0] 是 blender，业务参数从 sys.argv[1:] 取）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'

const execFileAsync = promisify(execFile)

const CANDIDATES: string[] =
  process.platform === 'darwin'
    ? ['/Applications/Blender.app/Contents/MacOS/Blender', `${process.env.HOME ?? ''}/Applications/Blender.app/Contents/MacOS/Blender`]
    : process.platform === 'win32'
      ? [
          `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Blender Foundation\\Blender 4.2\\blender.exe`,
          `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Blender Foundation\\Blender 4.3\\blender.exe`,
          `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Blender Foundation\\Blender 4.4\\blender.exe`,
        ]
      : ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/opt/blender/blender', `${process.env.HOME ?? ''}/.local/bin/blender`]

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 探测本机 Blender；override 非空时只认 override。返回可执行文件绝对路径或 null。 */
export function detectBlenderPath(override?: string | null): string | null {
  const env = process.env.BLENDER_PATH
  for (const p of [override?.trim(), env?.trim()]) {
    if (p) return isExecutable(p) ? p : null
  }
  for (const p of CANDIDATES) {
    if (p && isExecutable(p)) return p
  }
  return null
}

/** 版本串（如 '4.2.1'）；探测失败返回 null。 */
export async function blenderVersion(exe: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(exe, ['--version'], { timeout: 30_000 })
    const m = /Blender\s+([\d.]+)/.exec(stdout)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

export interface BlenderRunResult {
  code: number
  stdout: string
  durationMs: number
}

/** 无头跑一段 bpy 脚本。args 会以 `--` 之后的 sys.argv 传给脚本。 */
export async function runBlenderHeadless(opts: {
  exe: string
  scriptPath: string
  cwd: string
  args?: string[]
  timeoutMs?: number
}): Promise<BlenderRunResult> {
  const started = Date.now()
  const { stdout } = await execFileAsync(
    opts.exe,
    ['--background', '--python', opts.scriptPath, '--', ...(opts.args ?? [])],
    { cwd: opts.cwd, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 8 * 1024 * 1024 },
  )
  return { code: 0, stdout, durationMs: Date.now() - started }
}
