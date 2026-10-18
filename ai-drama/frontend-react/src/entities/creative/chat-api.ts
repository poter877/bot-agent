import { api, TIMEOUT } from '@/shared/api/client'
import type { CreativeProject } from './model'

export type CreativeChatAction = 'plan' | 'review' | 'generate' | 'audio' | 'render'
export interface CreativeMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  actions: CreativeChatAction[]
  status: string
  createdAt: string
}
export const creativeChatApi = {
  messages: (id: number, signal?: AbortSignal) => api.get<CreativeMessage[]>(`/creative/${id}/messages`, { signal }),
  send: (id: number, revision: number, message: string) =>
    api.post<{ message: CreativeMessage; messages: CreativeMessage[]; project: CreativeProject }>(
      `/creative/${id}/chat`, { revision, message }, { timeoutMs: TIMEOUT.agent }),
}
