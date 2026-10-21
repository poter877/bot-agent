import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowUp, MessageSquare } from 'lucide-react'
import { creativeChatApi } from '@/entities/creative/chat-api'
import { pipelineQueries } from '@/entities/creative/pipeline'
import { PipelineReviewCards } from './PipelineReviewCards'
import type { CreativeProject } from '@/entities/creative/model'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'
import { cn } from '@/shared/lib/cn'
import { useStudioAgentChat } from '@/shared/studio/agent-chat'
import { studioSessions } from '@/shared/studio/sessions'
import { studioHost } from '@/shared/studio/host'

const labels = {
  zh: { title: '制作对话', desktopOnly: '制作对话需要桌面 app 中的 AI 会话；浏览器版可查看历史消息。', intro: '说说你想做的视频，或告诉我需要怎样修改方案。', hint: '例如：制作一支 60 秒的黑洞科普视频，先提出问题，再用三个画面解释。', placeholder: '描述想法，或修改某个镜头…', send: '发送', user: '你', assistant: '制作助手', waiting: '正在整理方案…', failed: '发送失败，未收到回复', loadFailed: '对话暂时无法加载', reload: '重新加载', note: '对话修改会保存到方案；各阶段产物在对话卡片中审阅确认。' },
  en: { title: 'Production chat', desktopOnly: 'Production chat needs the desktop app AI session; the browser view is read-only history.', intro: 'Describe your video or tell me how to revise the plan.', hint: 'For example: a 60-second explainer about black holes, opening with a question and three visual explanations.', placeholder: 'Describe an idea or revise a shot…', send: 'Send', user: 'You', assistant: 'Creative assistant', waiting: 'Working on your request…', failed: 'Failed to send — no reply was generated', loadFailed: 'Could not load the conversation', reload: 'Reload', note: 'Chat edits are saved to the plan; stage artifacts are reviewed and approved in the conversation cards.' },
  ja: { title: '制作チャット', desktopOnly: '制作チャットにはデスクトップアプリの AI セッションが必要です。ブラウザ版は履歴の閲覧のみです。', intro: '作りたい動画や、構成の変更内容を教えてください。', hint: '例：ブラックホールを60秒で解説。問いかけから始め、3つの映像で説明する。', placeholder: 'アイデアやショットの変更を入力…', send: '送信', user: 'あなた', assistant: '制作アシスタント', waiting: '内容を整理しています…', failed: '送信に失敗しました（返信なし）', loadFailed: '会話を読み込めませんでした', reload: '再読み込み', note: 'チャットの変更は構成に保存されます。各段階の成果物は会話カードで確認・承認します。' },
  ko: { title: '제작 대화', desktopOnly: '제작 대화는 데스크톱 앱의 AI 세션이 필요합니다. 브라우저 버전은 기록 조회만 가능합니다.', intro: '만들고 싶은 영상이나 기획안의 수정 내용을 알려주세요.', hint: '예: 블랙홀을 설명하는 60초 영상. 질문으로 시작하고 세 장면으로 설명하기.', placeholder: '아이디어나 장면 수정 내용 입력…', send: '전송', user: '나', assistant: '제작 도우미', waiting: '요청을 정리하고 있습니다…', failed: '전송 실패 — 응답을 받지 못했습니다', loadFailed: '대화를 불러오지 못했습니다', reload: '새로고침', note: '대화에서 수정한 내용은 기획안에 저장됩니다. 단계 산출물은 대화 카드에서 검토·승인합니다.' },
}
interface Props {
  project: CreativeProject
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
}
/** 嵌入模式的宿主车道面板：流式渲染 + 工具活动 + 停止。 */
function StudioChatPanel({ project, disabled, onBusyChange }: { project: CreativeProject; disabled: boolean; onBusyChange?: (b: boolean) => void }) {
  const { i18n } = useTranslation()
  const lang = i18n.language.split('-')[0] as keyof typeof labels
  const copy = labels[lang] ?? labels.en
  const client = useQueryClient()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const pipeline = useQuery(pipelineQueries.detail(project.id))
  const chat = useStudioAgentChat(studioSessions.key('creative', project.id), project.title, {
    onSettled: () => {
      // 方案可能被模型经 MCP 工具改写、流程可能被 pipeline_start 建立——
      // 刷新业务快照与管线状态（不串改本地编辑态，由外层 detail 查询自然合并）。
      void client.invalidateQueries({ queryKey: ['workspace', 'default', 'creative', 'detail', String(project.id)] })
      void client.invalidateQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
    }
  })
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [chat?.messages.length])
  useEffect(() => { onBusyChange?.(Boolean(chat?.busy)) }, [chat?.busy, onBusyChange])
  const busy = disabled || (chat?.busy ?? false)
  if (!chat) return null
  function send(message: string) {
    if (busy || !message.trim()) return
    chat?.send(message.trim())
    setInput('')
  }
  return (
    <section className="flex min-h-[360px] flex-col gap-3 p-4" aria-label={copy.title}>
      <div ref={listRef} role="log" aria-live="polite" className="flex max-h-[52vh] min-h-40 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {!chat.messages.length && <div className="rounded-xl bg-hover-overlay p-4 text-sm text-content-muted">
          <MessageSquare className="mb-3 size-5 text-brand-content" aria-hidden />
          <p>{copy.intro}</p><p className="mt-3 text-xs leading-relaxed text-content-subtle">{copy.hint}</p>
        </div>}
        {chat.messages.map(m => <article key={m.id} className={cn('rounded-xl p-3 text-sm', m.role === 'user' ? 'ml-5 bg-brand-soft' : 'mr-2 border border-outline bg-surface')}>
          <div className="mb-1 text-xs font-semibold text-content-subtle">{m.role === 'user' ? copy.user : copy.assistant}</div>
          <p className="whitespace-pre-wrap break-words leading-relaxed text-content">{m.content || (m.status === 'streaming' ? copy.waiting : '')}</p>
          {!!m.toolActivity?.length && <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-content-subtle">{m.toolActivity.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          {m.status === 'failed' && <p className="mt-2 text-xs text-warn-text">{copy.failed}</p>}
        </article>)}
        <PipelineReviewCards project={project} state={pipeline.data} />
      </div>
      <form onSubmit={event => { event.preventDefault(); send(input) }} className="space-y-2">
        <Textarea aria-label={copy.placeholder} value={input} maxLength={8000} rows={3}
          disabled={busy} onChange={event => setInput(event.target.value)} placeholder={copy.placeholder} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] leading-relaxed text-content-subtle">{copy.note}</span>
          {chat.busy
            ? <Button type="button" size="sm" onClick={() => chat.stop()}>■ 停止</Button>
            : <Button type="submit" variant="primary" size="sm" disabled={busy || !input.trim()}><ArrowUp size={14} />{copy.send}</Button>}
        </div>
      </form>
    </section>
  )
}

/** 分发层：嵌入走宿主车道，独立浏览器走 HTTP 轮询——两个组件各自持有
 *  完整且无条件的 Hook 链（Rules of Hooks：不得在分支间切换 Hook 结构）。 */
export function CreativeChatPanel({ project, disabled, onBusyChange }: Props) {
  if (studioHost()?.agent) {
    return <StudioChatPanel disabled={!!disabled} onBusyChange={onBusyChange} project={project} />
  }
  return <HttpChatPanel project={project} />
}

/** 独立浏览器版：制作对话的编排在桌面 Agent 车道（服务端代调已随
 *  HERMES_AGENT_* 退役删除）——这里只读历史并给出指引。 */
function HttpChatPanel({ project }: { project: CreativeProject }) {
  const { i18n } = useTranslation()
  const lang = i18n.language.split('-')[0] as keyof typeof labels
  const copy = labels[lang] ?? labels.en
  const listRef = useRef<HTMLDivElement>(null)
  const messages = useQuery({ queryKey: ['workspace', 'default', 'creative', project.id, 'messages'],
    queryFn: ({ signal }) => creativeChatApi.messages(project.id, signal) })
  const pipeline = useQuery(pipelineQueries.detail(project.id))
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages.data?.length])
  return (
    <section className="flex min-h-[360px] flex-col gap-3 p-4" aria-label={copy.title}>
      <div ref={listRef} role="log" aria-label={copy.title} aria-live="polite" className="flex max-h-[52vh] min-h-40 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {messages.isError && <div role="alert" className="text-sm text-danger">{copy.loadFailed}<Button size="sm" onClick={() => void messages.refetch()}>{copy.reload}</Button></div>}
        {messages.data?.map(message => <article key={message.id} className={cn('rounded-xl p-3 text-sm', message.role === 'user' ? cn('ml-5', message.status === 'failed' ? 'border border-warning bg-warning-soft' : 'bg-brand-soft') : 'mr-2 border border-outline bg-surface')}>
          <div className="mb-1 text-xs font-semibold text-content-subtle">{message.role === 'user' ? copy.user : copy.assistant}</div>
          <p className="whitespace-pre-wrap break-words leading-relaxed text-content">{message.content}</p>
        </article>)}
        <PipelineReviewCards project={project} state={pipeline.data} />
      </div>
      <div className="rounded-xl bg-hover-overlay p-4 text-sm text-content-muted">
        <MessageSquare className="mb-3 size-5 text-brand-content" aria-hidden />
        <p>{copy.desktopOnly}</p>
      </div>
    </section>
  )
}
