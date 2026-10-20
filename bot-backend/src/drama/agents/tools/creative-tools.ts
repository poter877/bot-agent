/**
 * 创意视频方案工具面（MCP）——宿主 Agent 会话里读写创意项目方案。
 *
 * 《重构》方案 §6：多阶段流程由本地 Hermes 按产品 skill 调工具推进——
 * 创意对话/方案修改不再走"bot-backend 代调 agent + 服务端保存"，而是
 * 模型在会话里 read_creative_project 了解现状、save_creative_plan 整体
 * 提交（revision 乐观锁，冲突时报错由模型重读后重试），UI 靠业务快照刷新。
 */
import { tool } from 'ai'
import { z } from 'zod'

import { getCreativeProject, requireCreativeRevision, saveCreativeProject } from '../../services/creative-projects.js'
import { creativeDocumentSchema } from '../../services/creative-model.js'
import { type AgentToolSet } from '../context.js'

const documentJson = z.string().describe('完整的 creativeDocument JSON（read_creative_project 返回的结构，整体回写）')

export const creativeTools: AgentToolSet = {
  read_creative_project: tool({
    description: '读取创意视频项目的完整方案（brief/plan/production/shots/audio + revision）。',
    inputSchema: z.object({ projectId: z.number().int().positive() }),
    execute: async ({ projectId }) => {
      const project = await getCreativeProject(projectId)
      if (!project) return { error: `Creative project not found (id=${projectId})` }
      const document = creativeDocumentSchema.parse(project)

      return { result: JSON.stringify({ ...document, revision: project.revision }) }
    },
  }),
  save_creative_plan: tool({
    description: '整体保存创意视频方案（document 为 read_creative_project 的结构经修改后整体回写；revision 必须与读取时一致，冲突则报错由调用方重读）。返回新的 revision。',
    inputSchema: z.object({
      projectId: z.number().int().positive(),
      revision: z.number().int().nonnegative().describe('读取时拿到的 revision（乐观锁）'),
      document: documentJson,
      title: z.string().trim().min(1).max(200).optional(),
    }),
    execute: async ({ projectId, revision, document, title }) => {
      let parsed: unknown

      try {
        parsed = JSON.parse(document)
      } catch {
        return { error: 'document 不是合法 JSON' }
      }
      const input = creativeDocumentSchema.safeParse(parsed)
      if (!input.success) {
        return { error: `方案结构校验失败：${input.error.issues[0]?.message ?? String(input.error)}` }
      }
      await requireCreativeRevision(projectId, revision)
      const saved = await saveCreativeProject(projectId, { ...input.data, revision, ...(title ? { title } : {}) })

      return { result: JSON.stringify({ revision: saved.revision }) }
    },
  }),
}
