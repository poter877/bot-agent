import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'
import { creativeChatApi } from '@/entities/creative/chat-api'
import { pipelineQueries } from '@/entities/creative/pipeline'
import { PipelineReviewCards } from './PipelineReviewCards'
import type { CreativeProject } from '@/entities/creative/model'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'
import { studioHost } from '@/shared/studio/host'
import { studioSessions } from '@/shared/studio/sessions'

const labels = {
  zh: { title: '制作对话', desktopOnly: '制作对话需要桌面 app 中的 AI 会话；浏览器版可查看历史消息。', user: '你', assistant: '制作助手', loadFailed: '对话暂时无法加载', reload: '重新加载', sessionReady: '会话已就绪——完整对话在主窗格显示：流式回复、工具活动与文件预览都在那里；本瓦片保留看板与审阅卡。', sessionPreparing: '正在准备项目会话…', openSplit: '会话并排显示' },
  en: { title: 'Production chat', desktopOnly: 'Production chat needs the desktop app AI session; the browser view is read-only history.', user: 'You', assistant: 'Creative assistant', loadFailed: 'Could not load the conversation', reload: 'Reload', sessionReady: 'Session ready — the full conversation lives in the main pane: streaming replies, tool activity and file previews all render there; this tile keeps the board and review cards.', sessionPreparing: 'Preparing the project session…', openSplit: 'Open session side-by-side' },
  ja: { title: '制作チャット', desktopOnly: '制作チャットにはデスクトップアプリの AI セッションが必要です。ブラウザ版は履歴の閲覧のみです。', user: 'あなた', assistant: '制作アシスタント', loadFailed: '会話を読み込めませんでした', reload: '再読み込み', sessionReady: 'セッション準備完了——完全な会話はメインペインに表示されます。ストリーミング応答・ツール活動・ファイルプレビューはすべてそこにあり、このタイルにはボードと審査カードを保持します。', sessionPreparing: 'プロジェクトセッションを準備中…', openSplit: 'セッションを並べて表示' },
  ko: { title: '제작 대화', desktopOnly: '제작 대화는 데스크톱 앱의 AI 세션이 필요합니다. 브라우저 버전은 기록 조회만 가능합니다.', user: '나', assistant: '제작 도우미', loadFailed: '대화를 불러오지 못했습니다', reload: '새로고침', sessionReady: '세션 준비 완료 — 전체 대화는 메인 창에 표시됩니다. 스트리밍 응답, 도구 활동, 파일 미리보기가 모두 거기에 있고 이 타일에는 보드와 검토 카드가 유지됩니다.', sessionPreparing: '프로젝트 세션 준비 중…', openSplit: '세션 나란히 열기' },
}
interface Props {
  project: CreativeProject
  disabled?: boolean
}

/** 嵌入模式（桌面宿主）：项目会话在主窗格以宿主原生聊天 UI 打开（流式、
 *  工具活动、文件预览全套），本面板只负责会话建立与「并排显示」入口；
 *  审阅卡从管线状态派生，保留在工作台。 */
function StudioSessionPanel({ project }: { project: CreativeProject }) {
  const { i18n } = useTranslation()
  const lang = i18n.language.split('-')[0] as keyof typeof labels
  const copy = labels[lang] ?? labels.en
  const client = useQueryClient()
  const lane = studioHost()?.agent
  const desktop = studioHost()?.desktop
  const [session, setSession] = useState(() => studioSessions.get(studioSessions.key('creative', project.id)))
  const [failed, setFailed] = useState(false)
  const pipeline = useQuery(pipelineQueries.detail(project.id))

  // 建立项目会话（幂等键防重复）；订阅事件流——主窗格里每完成一轮对话
  // 就刷新业务快照与管线状态，右侧瓦片的看板/审阅卡与对话保持同频。
  useEffect(() => {
    if (!lane) return
    let cancelled = false
    const projectKey = studioSessions.key('creative', project.id)
    void (async () => {
      let assoc = studioSessions.get(projectKey)
      if (!assoc) {
        const created = await lane.createSession({ title: studioSessions.title(project.title), idempotencyKey: `studio-${projectKey}` })
        assoc = { sessionId: created.sessionId, storedSessionId: created.storedSessionId, updatedAt: Date.now() }
        studioSessions.set(projectKey, assoc)
      }
      if (!cancelled) setSession(assoc)
    })().catch(() => { if (!cancelled) setFailed(true) })
    const off = lane.onEvent(event => {
      const sid = studioSessions.get(projectKey)?.sessionId
      if (event.type !== 'message.complete' || !event.sessionId || event.sessionId !== sid) return
      void client.invalidateQueries({ queryKey: ['workspace', 'default', 'creative', 'detail', String(project.id)] })
      void client.invalidateQueries({ queryKey: pipelineQueries.detail(project.id).queryKey })
    })
    return () => { cancelled = true; off() }
  }, [lane, project.id, project.title, client])

  const openSplit = () => {
    if (!desktop || !session) return
    desktop.openRouteTile('/drama', 'right')
    // 会话路由按持久 id 解析；runtime id 会落到新会话
    desktop.navigate(`/${session.storedSessionId ?? session.sessionId}`)
  }

  return (
    <section className="flex min-h-[160px] flex-col gap-3 p-4" aria-label={copy.title}>
      <div className="rounded-xl bg-hover-overlay p-4 text-sm text-content-muted">
        <MessageSquare className="mb-3 size-5 text-brand-content" aria-hidden />
        <p>{failed ? copy.desktopOnly : session ? copy.sessionReady : copy.sessionPreparing}</p>
        <Button className="mt-3" size="sm" variant="primary" disabled={!session || failed} onClick={openSplit}>
          {copy.openSplit}
        </Button>
      </div>
      <PipelineReviewCards project={project} state={pipeline.data} />
    </section>
  )
}

/** 分发层：桌面嵌入走项目会话并排（宿主原生聊天 UI）；独立浏览器走 HTTP
 *  只读历史——两个组件各自持有完整且无条件的 Hook 链（Rules of Hooks：
 *  不得在分支间切换结构）。 */
export function CreativeChatPanel({ project, disabled }: Props) {
  if (studioHost()?.agent && studioHost()?.desktop) {
    return <StudioSessionPanel project={project} />
  }
  return <HttpChatPanel project={project} disabled={disabled} />
}

/** 独立浏览器版：制作对话的编排在桌面 Agent 车道（服务端代调已随
 *  HERMES_AGENT_* 退役删除）——这里只读历史并给出指引。 */
function HttpChatPanel({ project, disabled }: { project: CreativeProject; disabled?: boolean }) {
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
    <section className={cn('flex min-h-[360px] flex-col gap-3 p-4', disabled && 'opacity-60')} aria-label={copy.title}>
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
