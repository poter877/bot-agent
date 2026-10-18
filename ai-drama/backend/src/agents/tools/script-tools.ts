/**
 * 剧本改写 Agent 工具
 * 模块级单例 — episodeId 经工具循环的 toolsContext 按请求注入（options.context）
 */
import { tool } from 'ai'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { agentContextSchema, getEpisodeId, type AgentToolSet } from '../context.js'

const readEpisodeScript = tool({
  description: 'Read the script content of the current episode.',
  inputSchema: z.object({}),
  contextSchema: agentContextSchema,
  execute: async (_input, { context }) => {
    const episodeId = getEpisodeId(context)
    if (!episodeId) return { error: 'Missing episodeId in request context' }
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: `Episode not found (id=${episodeId})` }
    const content = ep.content || ep.scriptContent
    if (!content) return { error: `Episode has no content (id=${episodeId})` }
    return { content, word_count: content.length, episode_id: episodeId }
  },
})

const rewriteToScreenplay = tool({
  description: 'Read the original content for AI rewriting. Returns the source text with formatting instructions.',
  inputSchema: z.object({
    instructions: z.string().optional().describe('Additional rewrite instructions'),
  }),
  contextSchema: agentContextSchema,
  execute: async ({ instructions }, { context }) => {
    const episodeId = getEpisodeId(context)
    if (!episodeId) return { error: 'Missing episodeId in request context' }
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: `Episode not found` }
    const source = ep.content || ep.scriptContent
    if (!source) return { error: `Episode has no content to rewrite` }

    return {
      source_content: source,
      instruction: `请将以下内容改写为格式化剧本。

格式规范：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容

${instructions || ''}

【原始内容】
${source}`,
    }
  },
})

const saveScript = tool({
  description: 'Save the rewritten screenplay content to the current episode.',
  inputSchema: z.object({
    content: z.string().describe('The formatted screenplay content to save'),
  }),
  contextSchema: agentContextSchema,
  execute: async ({ content }, { context }) => {
    const episodeId = getEpisodeId(context)
    if (!episodeId) return { error: 'Missing episodeId in request context' }
    await db.update(schema.episodes)
      .set({ scriptContent: content, updatedAt: now() })
      .where(eq(schema.episodes.id, episodeId))

    return { message: `Script saved`, word_count: content.length }
  },
})

/** 键 = 模型可见的工具名（ai 以注册表键为工具名） */
export const scriptTools: AgentToolSet = { read_episode_script: readEpisodeScript, rewrite_to_screenplay: rewriteToScreenplay, save_script: saveScript }
