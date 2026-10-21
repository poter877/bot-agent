/**
 * 创意项目对话消息 — 历史只读（《重构》清理：制作对话的编排已外移桌面 Agent 车道）。
 *
 * 桌面 app 里制作对话经宿主会话（StudioChatPanel + MCP 工具改方案）执行；
 * 独立浏览器版只读历史。写入路径与 HERMES_AGENT_* 代调已一并退役。
 */
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { getCreativeProject } from './creative-projects.js'

export const chatActions = ['plan', 'review', 'generate', 'audio', 'render'] as const
const actionSchema = z.enum(chatActions)

export type CreativeMessage = {
  id: number; role: 'user' | 'assistant'; content: string;
  actions: (typeof chatActions[number])[]; status: string; createdAt: string
}

export async function listCreativeMessages(id: number): Promise<CreativeMessage[]> {
  await getCreativeProject(id)
  return (await db.select().from(schema.creativeMessages).where(eq(schema.creativeMessages.projectId, id))
    .orderBy(desc(schema.creativeMessages.id)).limit(100)).reverse().map(row => ({
      id: row.id, role: row.role as 'user' | 'assistant', content: row.content,
      actions: z.array(actionSchema).catch([]).parse(JSON.parse(row.actions)), status: row.status, createdAt: row.createdAt,
    }))
}
