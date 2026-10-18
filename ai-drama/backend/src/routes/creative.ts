import { createProductionToolRoutes } from './production-tools.js'
import { createToolRoutes } from './creative-tools.js'
import { createPipelineRoutes } from './creative-pipeline.js'
import { creativeSourceRoutes } from './creative-sources.js'
import { publicCreativeCatalog, getCreativeRecipe } from '../services/creative-catalog.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { success } from '../utils/response.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { generateCreativeShot, startCreativeRender } from '../services/creative-production.js'
import { generateCreativePlan, translateCreativeCaptions } from '../services/creative-planner.js'
import { renderCreativeVideo } from '../services/creative-renderer.js'
import { CreativeError, revisionSchema } from '../services/creative-model.js'
import { creativeChatRoutes } from './creative-chat.js'
import {
  getCreativeProject, requireCreativeRevision, saveCreativeProject, approveCreativeProject,
  withCreativeMutation, hasRunningCreativeTask,
} from '../services/creative-projects.js'

const revisionBody = z.object({ revision: revisionSchema })
const generateBody = revisionBody.extend({ kind: z.enum(['image', 'video']), configId: z.number().int().positive().optional() })
const planning = new Set<number>()
const translating = new Set<number>()
const defaultDependencies = { generateImage, generateVideo, generateCreativePlan, renderCreativeVideo, translateCreativeCaptions }

export function createCreativeRoutes(dependencies: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...dependencies }
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ code: 400, message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；').slice(0, 1000) }, 400)
    if (error instanceof CreativeError) return c.json({ code: error.status, message: error.message }, error.status)
    if (error instanceof SyntaxError) return c.json({ code: 400, message: '请求不是有效的 JSON' }, 400)
    // Provider request headers/bodies are never returned to the browser.
    const safeMessage = /^(未配置|文本配置|模型未返回|模型返回的|模型方案的|仅支持)/.test(error.message) ? error.message.slice(0, 300) : '操作失败，请检查模型设置和素材后重试'
    return c.json({ code: 503, message: safeMessage }, 503)
  })
  app.route('/', createProductionToolRoutes())
  app.route('/', createToolRoutes())
  app.route('/', creativeChatRoutes)
  app.route('/', createPipelineRoutes())

  app.get('/catalog', c => success(c, publicCreativeCatalog()))
  app.route('/', creativeSourceRoutes)
  app.post('/:id/translate', async c => {
    const id = Number(c.req.param('id'))
    const { revision } = revisionBody.parse(await c.req.json())
    const project = requireCreativeRevision(id, revision)
    if (!project.shots.some(shot => shot.caption.trim() || shot.narration.trim())) throw new CreativeError('请先导入字幕或填写字幕文字')
    if (translating.has(id)) throw new CreativeError('字幕正在翻译，请稍候', 409)
    translating.add(id)
    try {
      const translated = await deps.translateCreativeCaptions(project)
      return success(c, await withCreativeMutation(id, () => saveCreativeProject(id, { ...translated, revision })))
    } finally { translating.delete(id) }
  })
  app.get('/:id', c => success(c, getCreativeProject(Number(c.req.param('id')))))

  app.put('/:id', async c => {
    const id = Number(c.req.param('id'))
    const input = await c.req.json()
    return success(c, await withCreativeMutation(id, () => saveCreativeProject(id, input)))
  })

  app.post('/:id/plan', async c => {
    const id = Number(c.req.param('id'))
    const { revision } = revisionBody.parse(await c.req.json())
    const project = requireCreativeRevision(id, revision)
    const recipe = getCreativeRecipe(project.category)
    if (recipe.source !== 'optional' && !project.production.sources.some(source => recipe.source === 'video' ? source.kind === 'video' : source.kind !== 'image')) throw new CreativeError('此视频类型需要先上传原始素材，请在创作需求中导入')
    if (!project.brief.idea.trim()) throw new CreativeError('请先填写并保存创作主题或需求')
    if (hasRunningCreativeTask(id)) throw new CreativeError('素材仍在生成，请完成后再重新规划', 409)
    if (planning.has(id)) throw new CreativeError('该项目正在生成方案，请稍候', 409)
    planning.add(id)
    try {
      const document = await deps.generateCreativePlan({ ...project, document: project })
      const result = await withCreativeMutation(id, () => saveCreativeProject(id, { ...document, revision }))
      return success(c, result)
    } finally { planning.delete(id) }
  })

  app.post('/:id/approve', async c => {
    const id = Number(c.req.param('id'))
    const { revision } = revisionBody.parse(await c.req.json())
    return success(c, await withCreativeMutation(id, () => approveCreativeProject(id, revision)))
  })

  app.post('/:id/shots/:shotId/generate', async c => {
    const id = Number(c.req.param('id'))
    const input = generateBody.parse(await c.req.json())
    const result = await generateCreativeShot(id, c.req.param('shotId'), input, deps)
    return success(c, result)
  })

  app.post('/:id/render', async c => {
    const id = Number(c.req.param('id'))
    const { revision, shotIds, individual } = revisionBody.extend({ shotIds: z.array(z.string()).min(1).max(200).optional(), individual: z.boolean().default(false) }).parse(await c.req.json())
    return success(c, await startCreativeRender(id, {revision, shotIds, individual}, deps))
  })
  return app
}

export default createCreativeRoutes()
