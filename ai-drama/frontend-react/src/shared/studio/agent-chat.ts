/**
 * 宿主 Agent 会话上的创作对话控制器（嵌入模式）。
 *
 * 《重构》方案 §4/§5：创意对话改接宿主的 session/prompt/event——流式文本、
 * 工具活动与停止都来自事件流；方案修改由模型经 MCP 工具（read/save
 * creative plan）落库，完成后由调用方刷新业务快照。独立浏览器版不走这里
 * （保留原 HTTP 轮询通道，仅业务浏览）。
 */
import { useEffect, useRef, useState } from 'react'

import { studioHost } from './host'
import { studioSessions } from './sessions'

export interface StudioChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'streaming' | 'done' | 'failed'
  toolActivity?: string[]
}

export interface StudioAgentChat {
  messages: StudioChatMessage[]
  busy: boolean
  send: (text: string) => void
  stop: () => void
}

export function useStudioAgentChat(projectKey: string, projectTitle: string, opts?: { onSettled?: () => void }): StudioAgentChat | null {
  const host = studioHost()
  const agent = host?.agent
  const [messages, setMessages] = useState<StudioChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  // 事件到消息行的映射状态：当前流式中的 assistant 行 id
  const streamingRef = useRef<string | null>(null)
  const restoredRef = useRef(false)
  const sessionRef = useRef<{ sessionId: string } | null>(null)

  // 历史恢复：有关联会话且本地为空（页面重开）时拉一次持久转录。
  useEffect(() => {
    const lane = host?.agent
    const assoc = studioSessions.get(projectKey)
    if (!lane || !assoc || restoredRef.current) return
    restoredRef.current = true
    const pull = assoc.storedSessionId
      ? lane.history(assoc.sessionId).catch(async () => {
          // serve 重启后 runtime id 失效——按 stored id 复活后重拉
          const revived = await lane.resume(assoc.storedSessionId!)
          sessionRef.current = { sessionId: revived.sessionId }
          studioSessions.set(projectKey, { sessionId: revived.sessionId, storedSessionId: revived.storedSessionId })
          return lane.history(revived.sessionId)
        })
      : lane.history(assoc.sessionId)
    void pull.then(rows => {
      const visible = rows.filter(r => r.role === 'user' || r.role === 'assistant')
      if (visible.length) setMessages(visible.map((r, i) => ({ id: `h-${i}`, role: r.role as 'user' | 'assistant', content: r.text ?? '', status: 'done' as const })))
    }).catch(() => {})
  }, [host, projectKey])

  useEffect(() => {
    if (!host?.agent) return
    const off = host.agent.onEvent(event => {
      const sid = sessionRef.current?.sessionId
      if (sid && event.sessionId && event.sessionId !== sid) return
      const payload = (event.payload ?? {}) as Record<string, unknown>

      if (event.type === 'message.start' && streamingRef.current === null) {
        const id = `a-${Date.now()}`
        streamingRef.current = id
        setMessages(prev => [...prev, { id, role: 'assistant', content: '', status: 'streaming', toolActivity: [] }])
      } else if (event.type === 'message.delta') {
        const chunk = String(payload.delta ?? payload.text ?? payload.content ?? '')
        const id = streamingRef.current
        if (id && chunk) {
          setMessages(prev => prev.map(m => (m.id === id ? { ...m, content: m.content + chunk } : m)))
        }
      } else if (event.type === 'message.complete') {
        const id = streamingRef.current
        const text = String(payload.text ?? payload.content ?? '')
        streamingRef.current = null
        if (id) {
          setMessages(prev => prev.map(m => (m.id === id ? { ...m, content: text || m.content, status: 'done' } : m)))
        } else {
          setMessages(prev => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: text, status: 'done' }])
        }
        setBusy(false)
        opts?.onSettled?.()
      } else if (event.type === 'tool.start' || event.type === 'tool.complete') {
        const id = streamingRef.current
        const name = String(payload.name ?? payload.tool ?? '')
        if (id && name) {
          setMessages(prev => prev.map(m => (m.id === id ? { ...m, toolActivity: [...(m.toolActivity ?? []), `${event.type === 'tool.start' ? '▶' : '✓'} ${name}`] } : m)))
        }
      }
    })
    return off
  }, [host, opts])

  if (!agent) return null
  const lane = agent

  async function ensureSession(): Promise<string> {
    if (sessionRef.current) return sessionRef.current.sessionId
    const assoc = studioSessions.get(projectKey)
    // 复用关联会话；无关联或宿主已忘记（interrupt/close 后新开）则新建并记关联。
    if (assoc) {
      sessionRef.current = { sessionId: assoc.sessionId }
      return assoc.sessionId
    }
    const created = await lane.createSession({ title: studioSessions.title(projectTitle), idempotencyKey: `studio-${projectKey}` })
    sessionRef.current = { sessionId: created.sessionId }
    studioSessions.set(projectKey, { sessionId: created.sessionId, storedSessionId: created.storedSessionId })
    return created.sessionId
  }

  function send(text: string): void {
    if (busy || !text.trim()) return
    setBusy(true)
    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: text }])
    void ensureSession()
      .then(sid => lane.submit(sid, text))
      .catch(() => {
        setBusy(false)
        setMessages(prev => [...prev, { id: `e-${Date.now()}`, role: 'assistant', content: '', status: 'failed' }])
        opts?.onSettled?.()
      })
  }

  function stop(): void {
    const sid = sessionRef.current?.sessionId
    if (sid) void lane.interrupt(sid).finally(() => {
      setBusy(false)
      const id = streamingRef.current
      streamingRef.current = null
      if (id) setMessages(prev => prev.map(m => (m.id === id ? { ...m, status: 'done' } : m)))
    })
  }

  return { messages, busy, send, stop }
}
