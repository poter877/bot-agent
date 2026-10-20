/**
 * 视频工厂子应用（挂载于 bot-backend 根）：
 * - /api/v1/* 业务路由（原 ai-drama backend 全量迁入）
 * - /mcp 工具服务（hermes 经 streamable HTTP，Bearer AI_DRAMA_MCP_TOKEN）
 * - /static/* 生成媒体（DATA_ROOT = AI_DRAMA_DATA_ROOT，缺省仓库 ai-drama/data）
 *
 * 认证：与宿主同一 Better Auth 会话——sessionGate 用进程内 auth.api 校验
 * （无 HTTP 往返）；Bearer AI_DRAMA_API_TOKEN 仍是服务调用方旁路。
 * 生产恢复钩子（管线/渲染断点续跑）由宿主启动时调用 recoverDrama()。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type MiddlewareHandler } from 'hono'
import type { Auth } from '../modules/auth/auth.js'
import { DATA_ROOT } from './utils/paths.js'

import dramas from './routes/dramas.js'
import creative from './routes/creative.js'
import film from './routes/film.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import serverUpdate from './routes/serverUpdate.js'
import { createMcpApp } from './mcp/route.js'
import { recoverCreativeRenders } from './services/creative-projects.js'
import { recoverCreativePipelines } from './services/creative-pipeline/runner.js'
import { recoverFilmRuns } from './services/film-pipeline/runs.js'
import { recoverFilmRenderJobs } from './services/film-pipeline/render.js'
import { toolboxService } from './services/production-tools/jobs.js'
import { creativeToolService } from './services/creative-tools/jobs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/drama → 上三级为仓库根；媒体根缺省指向 ai-drama/data（前端/工具箱产物落点不变）
const repoRoot = path.resolve(__dirname, '../../..')
// 静态服务与上传落盘共用同一数据锚点（utils/paths 的 DATA_ROOT）——迁移早期
// 两者各算各的 repoRoot 相对路径，上传写进 data/static 而 /static 找
// ai-drama/data，媒体永远 404。AI_DRAMA_DATA_ROOT 仍可整体覆盖（trio 容器
// 用它指向数据卷）。
export const DRAMA_DATA_ROOT = process.env.AI_DRAMA_DATA_ROOT || DATA_ROOT

/** 会话门：Better Auth 会话（进程内校验）或 Bearer 服务令牌；豁免 health。 */
function sessionGate(auth: Auth | null): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/api/v1/health') return next()
    const expected = process.env.AI_DRAMA_API_TOKEN?.trim()
    const header = c.req.header('authorization')
    if (expected && header === `Bearer ${expected}`) return next()
    if (!auth) return c.json({ code: 401, message: '未登录或会话已过期，请先登录', login: true }, 401)
    try {
      const session = (await auth.api.getSession({ headers: c.req.raw.headers })) as unknown as { user?: { id?: string } } | null
      if (session?.user?.id) return next()
    } catch {
      /* 校验异常按未登录处理 */
    }
    return c.json({ code: 401, message: '未登录或会话已过期，请先登录', login: true }, 401)
  }
}

export function createDramaApp(auth: Auth | null): Hono {
  const app = new Hono()

  app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

  const api = new Hono()
  api.use('*', sessionGate(auth))
  api.route('/dramas', dramas)
  api.route('/creative', creative)
  api.route('/film', film)
  api.route('/episodes', episodes)
  api.route('/storyboards', storyboards)
  api.route('/scenes', scenes)
  api.route('/characters', characters)
  api.route('/tasks', tasks)
  api.route('/upload', upload)
  api.route('/ai-configs', aiConfigs)
  api.route('/ai-providers', aiProviders)
  api.route('/style-presets', stylePresets)
  api.route('/prompts', prompts)
  api.route('/agent', agent)
  api.route('/merge', merge)
  api.route('/skills', skills)
  api.route('/props', props)
  api.route('/storage', storage)
  api.route('/settings', settings)
  api.route('/server-update', serverUpdate)
  app.route('/api/v1', api)

  app.route('/mcp', createMcpApp(auth))

  // 生成媒体：uuid 命名不可变 → 长缓存；工具箱产物下载面加沙箱头
  app.use('/static/*', async (c, next) => {
    await next()
    if (c.res.ok) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
      c.header('X-Content-Type-Options', 'nosniff')
      if (c.req.path.includes('/toolbox/') && /\.(?:html?|js|svg|json|srt|vtt|txt|zip|blend)$/i.test(c.req.path)) {
        c.header('Content-Disposition', 'attachment')
        c.header('Content-Security-Policy', "sandbox; default-src 'none'")
      }
    }
  })
  app.use('/static/*', serveStatic({ root: DRAMA_DATA_ROOT }))

  // 前端静态托管（生产/单容器部署）：FRONTEND_DIST 注入（桌面版主进程），
  // 缺省锚定仓库 ai-drama/frontend-react/dist —— SPA 回退到 index.html。
  const frontendDist = process.env.FRONTEND_DIST || path.join(repoRoot, 'ai-drama', 'frontend-react', 'dist')
  app.use('*', serveStatic({ root: frontendDist }))
  // SPA 回退仅服务浏览器导航（Accept: text/html）；JSON/API 探测保持 404 语义。
  app.get('*', async (c, next) => {
    if (!(c.req.header('accept') ?? '').includes('text/html')) return next()
    return serveStatic({ root: frontendDist, path: 'index.html' })(c, next)
  })

  return app
}

/** 启动恢复：断点续跑 Creative 渲染/管线与 Film 运行/渲染任务（原 index.ts 启动序）。 */
export async function recoverDrama(): Promise<void> {
  await recoverCreativeRenders();
  await recoverCreativePipelines();
  await recoverFilmRuns();
  await recoverFilmRenderJobs();
  await toolboxService.recover();
  await creativeToolService.recover()
}
