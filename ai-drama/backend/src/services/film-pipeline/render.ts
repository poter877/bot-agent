/** film 渲染作业：把影片工程交给 film-core 工具链逐帧渲染并合成。
 *
 * 工程目录：STORAGE_ROOT/films/<projectId>/（index.html 等 build 阶段落盘）。
 * 步骤：events 导出 →（可选 mix.wav 若工程提供并依赖可用）→ 逐帧渲染 → mux → poster。
 * 进度：解析 video.mjs 的 stdout（w0 123/1152）换算百分比回写 film_render_jobs。
 * 恢复：启动时把 processing 置 failed（子进程已不在），可重试。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { now } from './runs.js'

const FILM_CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../film-core')
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export function filmProjectDir(projectId: number) {
  return path.join(STORAGE_ROOT, 'films', String(projectId))
}

/** 静态 URL（STORAGE_ROOT 由 /static 服务） */
export function filmStaticUrl(relPath: string) {
  return `/static/${relPath.split(path.sep).join('/')}`
}

interface StepSpec {
  name: string
  cmd: string
  args: string[]
  cwd?: string
  optional?: boolean
}

function runStep(spec: StepSpec, onLog: (line: string) => void, onProgress?: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd ?? BACKEND_ROOT, env: process.env })
    let lastErr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      onLog(text)
      // video.mjs 进度行形如：w0 123/1152  45s
      const m = /w\d+\s+(\d+)\/(\d+)/.exec(text)
      if (m && onProgress) onProgress(Number(m[1]) / Math.max(1, Number(m[2])))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      lastErr += chunk.toString()
      if (lastErr.length > 8000) lastErr = lastErr.slice(-8000)
    })
    child.on('error', (e) => reject(new Error(`${spec.name} 启动失败：${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else if (spec.optional) {
        onLog(`[film-render] 可选步骤 ${spec.name} 失败（退出码 ${code}），跳过`)
        resolve()
      } else reject(new Error(`${spec.name} 失败（退出码 ${code}）：${lastErr.slice(-2000)}`))
    })
  })
}

function updateJob(id: number, patch: Partial<typeof schema.filmRenderJobs.$inferInsert>) {
  db.update(schema.filmRenderJobs)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.filmRenderJobs.id, id))
    .run()
}

/** 启动渲染作业（异步执行，立即返回 job 行）。要求工程 index.html 已存在。 */
export function startFilmRender(projectId: number, runId: number | null) {
  const dir = filmProjectDir(projectId)
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error('影片工程尚未构建（缺少 index.html），请先完成「影片工程」阶段')
  }
  const ts = now()
  const res = db
    .insert(schema.filmRenderJobs)
    .values({ projectId, runId, status: 'processing', progress: 0, phase: 'events', createdAt: ts, updatedAt: ts })
    .run()
  const jobId = Number(res.lastInsertRowid)
  void (async () => {
    try {
      await executeFilmRender(jobId, projectId, dir)
    } catch (e) {
      updateJob(jobId, { status: 'failed', errorMsg: (e as Error).message })
    }
  })()
  return jobId
}

async function executeFilmRender(jobId: number, projectId: number, dir: string) {
  const outDir = path.join(dir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const log = (line: string) => {
    const trimmed = line.trim()
    if (trimmed) console.log(`[film-render #${jobId}] ${trimmed.slice(0, 300)}`)
  }
  const progressTo = (base: number, span: number) => (ratio: number) =>
    updateJob(jobId, { progress: Math.min(99, Math.round((base + span * ratio) * 100)) })

  // 1) 事件导出（页面契约 DUR/EV）
  updateJob(jobId, { phase: 'events' })
  await runStep({ name: 'events.mjs', cmd: 'node', args: ['film-core/render/events.mjs', dir] }, log)

  // 2) 混音（工程提供 mix.py 且 venv 可用；可选）
  updateJob(jobId, { phase: 'mix' })
  const venvPy = path.join(BACKEND_ROOT, '.venv-film', 'bin', 'python')
  if (fs.existsSync(path.join(dir, 'mix.py')) && fs.existsSync(venvPy)) {
    await runStep({ name: 'mix.py', cmd: venvPy, args: [path.join(dir, 'mix.py')], optional: true }, log)
  } else {
    log('mix.py 或音频环境不可用，跳过混音（无声渲染）')
  }

  // 3) 逐帧渲染
  updateJob(jobId, { phase: 'video' })
  await runStep(
    { name: 'video.mjs', cmd: 'node', args: ['film-core/render/video.mjs', dir, '--fps', '24', '--workers', '2', '--out', path.join(outDir, 'video.mp4')] },
    log,
    progressTo(0.1, 0.8),
  )

  // 4) mux 合成（有 mix.wav 时做 −14 LUFS；否则直接用 video.mp4）
  let finalRel = `films/${projectId}/out/video.mp4`
  if (fs.existsSync(path.join(dir, 'mix.wav'))) {
    updateJob(jobId, { phase: 'mux' })
    await runStep(
      { name: 'mux.sh', cmd: 'sh', args: ['film-core/render/mux.sh', path.join(outDir, 'video.mp4'), path.join(dir, 'mix.wav'), path.join(outDir, 'final.mp4'), '24'] },
      log,
    )
    finalRel = `films/${projectId}/out/final.mp4`
  }

  // 5) 海报帧（DUR 的 40% 处；失败可选）
  updateJob(jobId, { phase: 'poster' })
  let events: { dur?: number } = {}
  try {
    events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'))
  } catch { /* 无 events 时用默认时长 */ }
  const posterT = Math.max(0.5, (events.dur ?? 10) * 0.4).toFixed(2)
  await runStep(
    { name: 'still.mjs', cmd: 'node', args: ['film-core/render/still.mjs', dir, posterT, '--out', outDir, '--prefix', 'poster_'], optional: true },
    log,
  )

  const posterFile = fs.readdirSync(outDir).find((f) => f.startsWith('poster_'))
  updateJob(jobId, {
    status: 'completed',
    progress: 100,
    phase: 'done',
    videoUrl: filmStaticUrl(finalRel),
    posterUrl: posterFile ? filmStaticUrl(`films/${projectId}/out/${posterFile}`) : null,
    errorMsg: null,
  })
}

/** 服务重启恢复：processing 的作业子进程已丢失 → 标记 failed 允许重试 */
export function recoverFilmRenderJobs() {
  db.update(schema.filmRenderJobs)
    .set({ status: 'failed', errorMsg: '服务重启，渲染作业中断，请重试', updatedAt: now() })
    .where(eq(schema.filmRenderJobs.status, 'processing'))
    .run()
}

export function latestFilmRender(projectId: number) {
  const rows = db
    .select()
    .from(schema.filmRenderJobs)
    .where(eq(schema.filmRenderJobs.projectId, projectId))
    .orderBy(schema.filmRenderJobs.id)
    .all()
  return rows.length ? rows[rows.length - 1]! : null
}
