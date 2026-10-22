import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, ArrowUp, MessageSquare, Square } from 'lucide-react'
import { creativeChatApi } from '@/entities/creative/chat-api'
import { pipelineQueries } from '@/entities/creative/pipeline'
import { PipelineReviewCards } from './PipelineReviewCards'
import type { CreativeProject } from '@/entities/creative/model'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'
import { cn } from '@/shared/lib/cn'
import { studioHost } from '@/shared/studio/host'
import { studioSessions } from '@/shared/studio/sessions'

const HEIGHT_KEY = 'vf:chat-drawer-h'

const labels = {
  zh: { title: '制作对话', desktopOnly: '制作对话需要桌面 app 中的 AI 会话；浏览器版可查看历史消息。', user: '你', assistant: '制作助手', send: '发送', stop: '停止', placeholder: '描述想法，或修改某个镜头…', loadFailed: '对话暂时无法加载', reload: '重新加载', waiting: '正在整理方案…', failed: '发送失败，未收到回复', openSplit: '在主窗格打开', half: '半屏', collapse: '收起' },
  en: { title: 'Production chat', desktopOnly: 'Production chat needs the desktop app AI session; the browser view is read-only history.', user: 'You', assistant: 'Creative assistant', send: 'Send', stop: 'Stop', placeholder: 'Describe an idea or revise a shot…', loadFailed: 'Could not load the conversation', reload: 'Reload', waiting: 'Working on your request…', failed: 'Failed to send — no reply was generated', openSplit: 'Open in main pane', half: 'Half screen', collapse: 'Collapse' },
  ja: { title: '制作チャット', desktopOnly: '制作チャットにはデスクトップアプリの AI セッションが必要です。ブラウザ版は履歴の閲覧のみです。', user: 'あなた', assistant: '制作アシスタント', send: '送信', stop: '停止', placeholder: 'アイデアやショットの変更を入力…', loadFailed: '会話を読み込めませんでした', reload: '再読み込み', waiting: '内容を整理しています…', failed: '送信に失敗しました（返信なし）', openSplit: 'メインペインで開く', half: '半画面', collapse: '折りたたむ' },
  ko: { title: '제작 대화', desktopOnly: '제작 대화는 데스크톱 앱의 AI 세션이 필요합니다. 브라우저 버전은 기록 조회만 가능합니다.', user: '나', assistant: '제작 도우미', send: '보내기', stop: '중지', placeholder: '아이디어나 장면 수정 내용 입력…', loadFailed: '대화를 불러오지 못했습니다', reload: '새로고침', waiting: '요청을 정리하고 있습니다…', failed: '전송 실패 — 응답을 받지 못했습니다', openSplit: '메인 창에서 열기', half: '반 화면', collapse: '접기' },
}

interface Turn {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'done' | 'failed'
  tools?: string[]
}

/** 桌面宿主车道的项目会话流（建立/恢复/流式/打断）——抽屉内的可对话形态。 */
function useStudioTurns(project: CreativeProject) {
  const lane = studioHost()?.agent
  const client = useQueryClient()
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const sessionRef = useRef<{ sessionId: string; storedSessionId?: string; updatedAt?: number } | null>(null)
  const streamingRef = useRef<string | null>(null)
  const restoredRef = useRef(false)
  const busyRef = useRef(false)
  busyRef.current = busy

  useEffect(() => {
    if (!lane) return
    let cancelled = false
    const projectKey = studioSessions.key('creative', project.id)

    // 持久转录恢复：serve 重启后 runtime id 失效时按 stored id 复活再拉。
    const assoc0 = studioSessions.get(projectKey)
    if (assoc0 && !restoredRef.current) {
      restoredRef.current = true
      const pull = assoc0.storedSessionId
        ? lane.history(assoc0.sessionId).catch(async () => {
            const revived = await lane.resume(assoc0.storedSessionId!)
            sessionRef.current = { sessionId: revived.sessionId, storedSessionId: revived.storedSessionId, updatedAt: Date.now() }
            studioSessions.set(projectKey, { sessionId: revived.sessionId, storedSessionId: revived.storedSessionId })
            return lane.history(revived.sessionId)
          })
        : lane.history(assoc0.sessionId)
      void pull.then(rows => {
        if (cancelled) return
        const visible = rows.filter(r => r.role === 'user' || r.role === 'assistant').slice(-30)
        if (visible.length) setTurns(visible.map((r, i) => ({ id: `h-${i}`, role: r.role as 'user' | 'assistant', content: r.text ?? '', status: 'done' as const })))
      }).catch(() => {})
    }

    const off = lane.onEvent(event => {
      const sid = sessionRef.current?.sessionId ?? studioSessions.get(projectKey)?.sessionId
      if (sid && event.sessionId && event.sessionId !== sid) return
      const payload = (event.payload ?? {}) as Record<string, unknown>
      if (event.type === 'message.start' && streamingRef.current === null) {
        const id = `a-${Date.now()}`
        streamingRef.current = id
        setTurns(prev => [...prev, { id, role: 'assistant', content: '', status: 'streaming', tools: [] }])
      } else if (event.type === 'message.delta') {
        const chunk = String(payload.delta ?? payload.text ?? payload.content ?? '')
        const id = streamingRef.current
        if (id && chunk) setTurns(prev => prev.map(m => (m.id === id ? { ...m, content: m.content + chunk } : m)))
      } else if (event.type === 'message.complete') {
        const id = streamingRef.current
        const text = String(payload.text ?? payload.content ?? '')
        streamingRef.current = null
        if (id) setTurns(prev => prev.map(m => (m.id === id ? { ...m, content: text || m.content, status: 'done' } : m)))
        else setTurns(prev => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: text, status: 'done' }])
        setBusy(false)
        // 方案/管线可能被模型经 MCP 工具改写——刷新右侧看板与审阅卡
        void client.invalidateQueries({ queryKey: ['workspace', 'default', 'creative', 'detail', String(project.id)] })
        void client.invalidateQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
      } else if (event.type === 'tool.start' || event.type === 'tool.complete') {
        const id = streamingRef.current
        const name = String(payload.name ?? payload.tool ?? '')
        if (id && name) setTurns(prev => prev.map(m => (m.id === id ? { ...m, tools: [...(m.tools ?? []), `${event.type === 'tool.start' ? '▶' : '✓'} ${name}`] } : m)))
      }
    })
    return () => { cancelled = true; off() }
  }, [lane, project.id, client])

  const send = useCallback((text: string) => {
    if (!lane || busyRef.current || !text.trim()) return
    setBusy(true)
    setTurns(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: text, status: 'done' as const }])
    const projectKey = studioSessions.key('creative', project.id)
    const go = async () => {
      let assoc = sessionRef.current ?? studioSessions.get(projectKey)
      if (!assoc) {
        const created = await lane.createSession({ title: studioSessions.title(project.title), idempotencyKey: `studio-${projectKey}` })
        assoc = { sessionId: created.sessionId, storedSessionId: created.storedSessionId, updatedAt: Date.now() }
        studioSessions.set(projectKey, assoc)
      }
      sessionRef.current = assoc
      await lane.submit(assoc.sessionId, text)
    }
    void go().catch(() => {
      setBusy(false)
      setTurns(prev => [...prev, { id: `e-${Date.now()}`, role: 'assistant', content: '', status: 'failed' as const }])
    })
  }, [lane, project.id, project.title])

  const stop = useCallback(() => {
    const sid = sessionRef.current?.sessionId
    if (!sid || !lane) return
    void lane.interrupt(sid).finally(() => {
      setBusy(false)
      const id = streamingRef.current
      streamingRef.current = null
      if (id) setTurns(prev => prev.map(m => (m.id === id ? { ...m, status: 'done' } : m)))
    })
  }, [lane])

  return { turns, busy, send, stop }
}

/** 消息流渲染（桌面/独立共用）：精排版纯文本 + 工具活动行。 */
function TurnList({ turns, copy }: { turns: Turn[]; copy: (typeof labels)['zh'] }) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [turns.length, turns[turns.length - 1]?.content])
  return (
    <div ref={listRef} role="log" aria-label={copy.title} aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      {!turns.length && <div className="rounded-xl bg-hover-overlay p-4 text-sm text-content-muted">
        <MessageSquare className="mb-3 size-5 text-brand-content" aria-hidden />
        <p>{copy.placeholder}</p>
      </div>}
      {turns.map(m => <article key={m.id} className={cn('rounded-xl p-3 text-sm', m.role === 'user' ? 'ml-8 bg-brand-soft' : 'mr-4 border border-outline bg-surface')}>
        <div className="mb-1 text-xs font-semibold text-content-subtle">{m.role === 'user' ? copy.user : copy.assistant}</div>
        <p className="whitespace-pre-wrap break-words leading-relaxed text-content">{m.content || (m.status === 'streaming' ? copy.waiting : '')}</p>
        {!!m.tools?.length && <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-content-subtle">{m.tools.map((t, i) => <li key={i}>{t}</li>)}</ul>}
        {m.status === 'failed' && <p className="mt-2 text-xs text-warn-text">{copy.failed}</p>}
      </article>)}
    </div>
  )
}

/** 独立浏览器版内容：只读历史（编排仍在桌面 Agent 车道）。 */
function HistoryTurns({ project }: { project: CreativeProject }) {
  const { i18n } = useTranslation()
  const lang = i18n.language.split('-')[0] as keyof typeof labels
  const copy = labels[lang] ?? labels.en
  const messages = useQuery({ queryKey: ['workspace', 'default', 'creative', project.id, 'messages'],
    queryFn: ({ signal }) => creativeChatApi.messages(project.id, signal) })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
        {messages.isError && <div role="alert" className="text-sm text-danger">{copy.loadFailed}<Button size="sm" onClick={() => void messages.refetch()}>{copy.reload}</Button></div>}
        {messages.data?.map(message => <article key={message.id} className={cn('mb-3 rounded-xl p-3 text-sm', message.role === 'user' ? 'ml-8 bg-brand-soft' : 'mr-4 border border-outline bg-surface')}>
          <div className="mb-1 text-xs font-semibold text-content-subtle">{message.role === 'user' ? copy.user : copy.assistant}</div>
          <p className="whitespace-pre-wrap break-words leading-relaxed text-content">{message.content}</p>
        </article>)}
      </div>
      <div className="border-t border-outline px-4 py-3 text-xs text-content-muted">{copy.desktopOnly}</div>
    </div>
  )
}

/** 底部会话抽屉：折叠条 ↔ 内容区，拖拽调高，半屏/收起预设。 */
export function CreativeChatPanel({ project }: Props) {
  const { i18n } = useTranslation()
  const lang = i18n.language.split('-')[0] as keyof typeof labels
  const copy = labels[lang] ?? labels.en
  const desktopMode = Boolean(studioHost()?.agent)
  const [open, setOpen] = useState(false)
  const pipeline = useQuery(pipelineQueries.detail(project.id))
  const [height, setHeight] = useState(() => {
    // 存储容错（隐私模式/jsdom 无 storage）：降级为默认半屏
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY))
      const half = Math.round(window.innerHeight * 0.5)
      return Number.isFinite(saved) && saved >= 220 ? Math.min(saved, Math.round(window.innerHeight * 0.85)) : half
    } catch {
      return Math.round(window.innerHeight * 0.5)
    }
  })
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const onHandleMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const next = Math.round(drag.startH + (drag.startY - e.clientY))
    setHeight(Math.max(220, Math.min(Math.round(window.innerHeight * 0.85), next)))
  }, [])
  const onHandleUp = useCallback(() => {
    dragRef.current = null
  }, [])
  const beginDrag = (e: React.PointerEvent) => {
    dragRef.current = { startY: e.clientY, startH: height }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const setHalf = () => {
    setOpen(true)
    setHeight(Math.round(window.innerHeight * 0.5))
    try { localStorage.setItem(HEIGHT_KEY, String(Math.round(window.innerHeight * 0.5))) } catch { /* 隐私模式：仅本页生效 */ }
  }

  return (
    <section aria-label={copy.title} className="sticky bottom-0 z-10 -mx-4 mt-4 md:-mx-6">
      {open ? (
        <div style={{ height }} className="flex min-h-0 flex-col rounded-t-panel border border-outline bg-surface shadow-dialog">
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={copy.title}
            className="flex cursor-row-resize touch-none items-center gap-2 border-b border-outline px-4 py-2.5 text-sm font-semibold text-content-secondary hover:bg-hover-overlay"
            onPointerDown={beginDrag}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
          >
            <MessageSquare size={14} className="text-brand" aria-hidden />
            {copy.title}
            <span className="mx-1 h-4 w-px bg-outline" aria-hidden />
            <Button size="sm" variant="ghost" onClick={setHalf}>{copy.half}</Button>
            <Button size="sm" variant="ghost" aria-label={copy.collapse} onClick={() => setOpen(false)}><ArrowDownToLine size={13} aria-hidden />{copy.collapse}</Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {desktopMode ? <SessionTurns project={project} copy={copy} /> : <HistoryTurns project={project} />}
          </div>
          <div className="border-t border-outline px-4 py-3">
            <PipelineReviewCards project={project} state={pipeline.data} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-t-panel border border-outline bg-surface px-4 py-2.5 text-sm font-semibold text-content-secondary hover:bg-hover-overlay focus-visible:outline-none focus-visible:shadow-focus"
        >
          <MessageSquare size={14} className="text-brand" aria-hidden />
          {copy.title}
          <ArrowUp size={13} className="ml-auto text-content-muted" aria-hidden />
        </button>
      )}
    </section>
  )
}

/** 桌面模式抽屉内容：可对话的项目会话流 + 并排入口。 */
function SessionTurns({ project, copy }: { project: CreativeProject; copy: (typeof labels)['zh'] }) {
  const host = studioHost()
  const { turns, busy, send, stop } = useStudioTurns(project)
  const [input, setInput] = useState('')
  const submit = () => {
    if (!input.trim() || busy) return
    send(input.trim())
    setInput('')
  }
  const openSplit = () => {
    const session = studioSessions.get(studioSessions.key('creative', project.id))
    const desktop = host?.desktop
    if (!desktop || !session) return
    desktop.openRouteTile('/drama', 'right')
    desktop.navigate(`/${session.storedSessionId ?? session.sessionId}`)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TurnList turns={turns} copy={copy} />
      <div className="flex items-center gap-2 border-t border-outline px-4 py-2.5">
        <Textarea
          aria-label={copy.placeholder}
          value={input}
          maxLength={8000}
          rows={2}
          disabled={busy}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() } }}
          placeholder={copy.placeholder}
          className="min-h-0 flex-1 resize-none"
        />
        {busy
          ? <Button type="button" size="sm" onClick={stop}><Square size={12} aria-hidden />{copy.stop}</Button>
          : <Button type="button" size="sm" variant="primary" disabled={!input.trim()} onClick={submit}><ArrowUp size={14} aria-hidden />{copy.send}</Button>}
        <Button type="button" size="sm" variant="ghost" onClick={openSplit} aria-label={copy.openSplit} title={copy.openSplit}><ArrowUp size={12} className="rotate-45" aria-hidden /></Button>
      </div>
    </div>
  )
}

interface Props {
  project: CreativeProject
}
