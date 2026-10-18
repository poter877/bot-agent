/** /api/v1/film — 影片风格流水线路由（独立于 creative 体系）。
 *
 * 风格：GET /styles、GET /styles/:slug
 * 项目：创建走 POST /api/v1/dramas（project_type='film' + film_style）
 * 流水线：POST /projects/:id/run、GET /projects/:id（含轮询推进）、approve、retry
 * 工程：GET /projects/:id/files（工程文件清单）
 */
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { success, badRequest } from '../utils/response.js'
import { filmStyleGroups, filmStyles, getFilmStyle, filmStyleMarkdown } from '../services/film-styles.js'
import {
  getFilmProject,
  startFilmRun,
  approveFilmStage,
  retryFilmStage,
  pollFilmRun,
  filmWorkdirListing,
} from '../services/film-pipeline/runs.js'
import { readFilmAgentLog } from '../services/film-pipeline/build-agent.js'
import { detectBlenderPath, blenderVersion } from '../services/film-pipeline/blender.js'
import { filmProjectDir, filmStaticUrl } from '../services/film-pipeline/render.js'

const film = new Hono()

film.get('/styles', (c) => {
  const flat = c.req.query('flat') === '1'
  return success(c, flat ? filmStyles() : filmStyleGroups())
})

// 本机 Blender 可用性（build agent 的 run_blender 工具按此注册）
film.get('/blender/status', async (c) => {
  const exe = detectBlenderPath()
  return success(c, { available: Boolean(exe), path: exe, version: exe ? await blenderVersion(exe) : null })
})

film.get('/styles/:slug', (c) => {
  const slug = c.req.param('slug')
  const style = getFilmStyle(slug)
  if (!style) return badRequest(c, `未知影片风格：${slug}`)
  return success(c, { ...style, markdown: filmStyleMarkdown(slug) })
})

film.get('/projects/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '无效项目 id')
  pollFilmRun(id) // waiting 态顺带驱动（渲染完成续跑 / 进度回写）
  return success(c, getFilmProject(id))
})

film.post('/projects/:id/run', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '无效项目 id')
  return success(c, startFilmRun(id))
})

film.post('/projects/:id/approve', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '无效项目 id')
  return success(c, approveFilmStage(id))
})

film.post('/projects/:id/retry', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '无效项目 id')
  return success(c, retryFilmStage(id))
})

film.get('/projects/:id/files', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '无效项目 id')
  getFilmProject(id) // 404 校验
  return success(c, { files: filmWorkdirListing(id) })
})

// build 阶段 agent 日志增量拉取（?since=字节偏移），顺带返回最新自检帧
film.get('/projects/:id/build/log', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '无效项目 id')
  getFilmProject(id) // 404 校验
  const sinceRaw = Number(c.req.query('since'))
  const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : 0
  const log = readFilmAgentLog(id, since)
  const outDir = path.join(filmProjectDir(id), 'out')
  const frames = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => f.startsWith('agent_') && f.endsWith('.jpg'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    : []
  return success(c, {
    content: log.content,
    nextOffset: log.nextOffset,
    size: log.size,
    latestFrame: frames[0] ? filmStaticUrl(`films/${id}/out/${frames[0]!.name}`) : null,
  })
})

export default film
