/** Agent 提示词与技能（workspace 文件域）：按内容语言版本读写 */
import { api, qs } from '@/shared/api/client'

export interface PromptSummary {
  agent_type: string
  name: string
  model: string
  is_default: boolean
}

export interface PromptDetail {
  agent_type: string
  lang: string
  name: string
  model: string
  system_prompt: string
  is_default: boolean
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptApi = {
  list: (signal?: AbortSignal) => api.get<PromptSummary[]>('/prompts', { signal }),
  get: (type: string, lang?: string, signal?: AbortSignal) => api.get<PromptDetail>(`/prompts/${type}${langQ(lang)}`, { signal }),
  update: (type: string, data: { system_prompt: string; name?: string; model?: string }, lang?: string) =>
    api.put(`/prompts/${type}${langQ(lang)}`, data),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export interface SkillSummary {
  id: string
  name: string
  description: string
}

export interface SkillDetail {
  id: string
  lang: string
  content: string
  is_default: boolean
}

export const skillsApi = {
  list: (lang?: string, signal?: AbortSignal) => api.get<SkillSummary[]>(`/skills${langQ(lang)}`, { signal }),
  get: (id: string, lang?: string, signal?: AbortSignal) => api.get<SkillDetail>(`/skills/${id}${langQ(lang)}`, { signal }),
  create: (data: { id: string; name?: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

/** Agent chat（请求式长流程）：结果经工具落库，调用方负责刷新对应资源 */
export interface AgentChatResult {
  type: 'done'
  text: string
  toolCalls: { toolName: string; args: unknown }[]
  toolResults: { toolName: string; result: string }[]
}

export function agentChat(
  type: string,
  body: { message: string; drama_id: number; episode_id: number; model?: string; config_id?: number },
  signal?: AbortSignal,
): Promise<AgentChatResult> {
  return api.post(`/agent/${type}/chat`, body, { signal, timeoutMs: 600_000 })
}

/** 内容 lang 的 query key 值（无配置时回退 zh） */
export function langQueryValue(lang: string | undefined | null): string {
  return lang && lang !== 'zh' ? lang : 'zh'
}

export { qs }
