/**
 * Agent 请求上下文 — 按请求构建的普通对象，经工具循环的 toolsContext 注入工具
 * 路由层 build → getAgent(...) → 工具 execute 内读取（ai tool() 的 options.context）
 */
import { z } from 'zod'
import type { Tool } from 'ai'
import { getContentLanguage, type ContentLanguage } from '../services/app-settings.js'

export interface AgentRequestContextValues {
  episodeId: number
  dramaId: number
  modelOverride?: string
  textConfigId?: number
  /** AI 内容语言；缺省时读全局设置（app_settings.content_language） */
  language?: ContentLanguage
}

/** 解析后的请求上下文：language 在构建处统一落定 */
export interface AgentRequestContext extends AgentRequestContextValues {
  language: ContentLanguage
}

export async function buildAgentRequestContext(values: AgentRequestContextValues): Promise<AgentRequestContext> {
  return {
    episodeId: values.episodeId,
    dramaId: values.dramaId,
    ...(values.modelOverride ? { modelOverride: values.modelOverride } : {}),
    ...(values.textConfigId ? { textConfigId: values.textConfigId } : {}),
    // 语言在构建处统一解析：4 条链路（chat/提取/图片提示词/视频提示词）都经过这里，
    // 全局设置一处生效；显式传入 values.language 可按请求覆盖
    language: values.language ?? (await getContentLanguage()),
  }
}

/** 工具的 contextSchema：声明工具经 options.context 拿到的请求上下文形状（toolsContext 注入） */
export const agentContextSchema = z.object({
  episodeId: z.number(),
  dramaId: z.number(),
  modelOverride: z.string().optional(),
  textConfigId: z.number().optional(),
  language: z.string().optional(),
})

/** 工具 execute 收到的上下文形状（contextSchema 校验后的值） */
export type AgentToolContext = z.infer<typeof agentContextSchema>

/** Agent 工具注册表形状：键 = 模型可见的工具名，工具共享同一 contextSchema */
export type AgentToolSet = Record<string, Tool<any, any, AgentToolContext>>

export function getEpisodeId(context: AgentToolContext | undefined): number | null {
  return typeof context?.episodeId === 'number' ? context.episodeId : null
}

export function getDramaId(context: AgentToolContext | undefined): number | null {
  return typeof context?.dramaId === 'number' ? context.dramaId : null
}

/** 读取请求上下文中的内容语言；未设置返回 null（调用方按 zh 处理） */
export function getContentLanguageFromRC(context: AgentToolContext | undefined): ContentLanguage | null {
  const v = context?.language
  return typeof v === 'string' && v ? (v as ContentLanguage) : null
}
