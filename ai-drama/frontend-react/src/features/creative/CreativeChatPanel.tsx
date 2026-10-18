import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowUp, MessageSquare, RotateCcw } from 'lucide-react'
import { creativeChatApi, type CreativeChatAction } from '@/entities/creative/chat-api'
import type { CreativeProject } from '@/entities/creative/model'
import { creativeQueries } from '@/entities/creative/queries'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'
import { cn } from '@/shared/lib/cn'

const labels = {
  zh: { title: '制作对话', intro: '说说你想做的视频，或告诉我需要怎样修改方案。', hint: '例如：制作一支 60 秒的黑洞科普视频，先提出问题，再用三个画面解释。', placeholder: '描述想法，或修改某个镜头…', send: '发送', user: '你', assistant: '制作助手', waiting: '正在整理方案…', failed: '未完成', retry: '重试这条消息', loadFailed: '对话暂时无法加载', reload: '重新加载', locked: '请先保存当前修改，或等待当前操作完成。', note: '对话修改会保存到方案；确认、生成和导出可在右侧操作。', error: '未能完成，请检查文本模型设置后重试。', plan: '打开创作要求', review: '查看并确认方案', generate: '打开素材制作', audio: '编辑声音字幕', render: '打开成片导出' },
  en: { title: 'Production chat', intro: 'Describe your video or tell me how to revise the plan.', hint: 'For example: a 60-second explainer about black holes, opening with a question and three visual explanations.', placeholder: 'Describe an idea or revise a shot…', send: 'Send', user: 'You', assistant: 'Creative assistant', waiting: 'Working on your request…', failed: 'Not completed', retry: 'Retry message', loadFailed: 'Could not load the conversation', reload: 'Reload', locked: 'Save your edits or wait for the current operation to finish.', note: 'Chat edits are saved to the plan. Review, generate and export using the workflow.', error: 'Could not finish. Check your text model settings and retry.', plan: 'Open creative brief', review: 'Review the plan', generate: 'Open media production', audio: 'Edit audio and captions', render: 'Open export' },
  ja: { title: '制作チャット', intro: '作りたい動画や、構成の変更内容を教えてください。', hint: '例：ブラックホールを60秒で解説。問いかけから始め、3つの映像で説明する。', placeholder: 'アイデアやショットの変更を入力…', send: '送信', user: 'あなた', assistant: '制作アシスタント', waiting: '内容を整理しています…', failed: '未完了', retry: '再試行', loadFailed: '会話を読み込めませんでした', reload: '再読み込み', locked: '変更を保存するか、現在の処理が終わるまでお待ちください。', note: 'チャットの変更は構成に保存されます。確認・生成・書き出しは制作フローで操作できます。', error: '完了できませんでした。テキストモデル設定を確認して再試行してください。', plan: '制作要件を開く', review: '構成を確認', generate: '素材制作を開く', audio: '音声・字幕を編集', render: '書き出しを開く' },
  ko: { title: '제작 대화', intro: '만들고 싶은 영상이나 기획안의 수정 내용을 알려주세요.', hint: '예: 블랙홀을 설명하는 60초 영상. 질문으로 시작하고 세 장면으로 설명하기.', placeholder: '아이디어나 장면 수정 내용 입력…', send: '전송', user: '나', assistant: '제작 도우미', waiting: '요청을 정리하고 있습니다…', failed: '미완료', retry: '다시 시도', loadFailed: '대화를 불러오지 못했습니다', reload: '새로고침', locked: '수정 사항을 저장하거나 현재 작업이 끝날 때까지 기다려 주세요.', note: '대화에서 수정한 내용은 기획안에 저장됩니다. 확인, 생성, 내보내기는 제작 흐름에서 진행하세요.', error: '완료하지 못했습니다. 텍스트 모델 설정을 확인하고 다시 시도하세요.', plan: '제작 요구사항 열기', review: '기획안 검토', generate: '소재 제작 열기', audio: '오디오 및 자막 편집', render: '내보내기 열기' },
}
const actionStages = { plan: 'brief', review: 'shots', generate: 'shots', audio: 'audio', render: 'export' } as const
interface Props {
  project: CreativeProject
  disabled: boolean
  onProjectUpdated: (project: CreativeProject) => void
  onGoToStage: (stage: 'brief' | 'shots' | 'audio' | 'export') => void
  onBusyChange?: (busy: boolean) => void
}
export function CreativeChatPanel({ project, disabled, onProjectUpdated, onGoToStage, onBusyChange }: Props) {
  const { i18n } = useTranslation()
  const lang = i18n.language.split('-')[0] as keyof typeof labels
  const copy = labels[lang] ?? labels.en
  const [input, setInput] = useState('')
  const client = useQueryClient()
  const listRef = useRef<HTMLDivElement>(null)
  const wasProcessing = useRef(false)
  const queryKey = ['workspace', 'default', 'creative', project.id, 'messages']
  const messages = useQuery({ queryKey, queryFn: ({ signal }) => creativeChatApi.messages(project.id, signal),
    refetchInterval: query => query.state.data?.some(row => row.status === 'pending') ? 2500 : false })
  const mutation = useMutation({
    mutationFn: (message: string) => creativeChatApi.send(project.id, project.revision, message),
    onSuccess: result => { client.setQueryData(queryKey, result.messages); onProjectUpdated(result.project); setInput('') },
    onSettled: () => { onBusyChange?.(false); void client.invalidateQueries({ queryKey }) },
  })
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages.data?.length, mutation.isPending])
  const processing = mutation.isPending || !!messages.data?.some(row => row.status === 'pending')
  useEffect(() => {
    onBusyChange?.(processing)
    if (wasProcessing.current && !processing) {
      void client.invalidateQueries({ queryKey: creativeQueries.detail(project.id).queryKey, exact: true })
    }
    wasProcessing.current = processing
  }, [processing, onBusyChange, client, project.id])
  const busy = disabled || processing || messages.isPending
  function send(message: string) {
    if (busy || !message.trim()) return
    onBusyChange?.(true)
    mutation.mutate(message.trim())
  }
  return (
    <section className="flex min-h-[360px] flex-col gap-3 p-4" aria-label={copy.title}>
      <div ref={listRef} role="log" aria-label={copy.title} aria-live="polite" className="flex max-h-[52vh] min-h-40 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {!messages.data?.length && !messages.isError && <div className="rounded-xl bg-hover-overlay p-4 text-sm text-content-muted">
          <MessageSquare className="mb-3 size-5 text-brand-content" aria-hidden />
          <p>{copy.intro}</p><p className="mt-3 text-xs leading-relaxed text-content-subtle">{copy.hint}</p>
        </div>}
        {messages.isError && <div role="alert" className="text-sm text-danger">{copy.loadFailed}<Button size="sm" onClick={() => void messages.refetch()}>{copy.reload}</Button></div>}
        {messages.data?.map(message => <article key={message.id} className={cn('rounded-xl p-3 text-sm', message.role === 'user' ? 'ml-5 bg-brand-soft' : 'mr-2 border border-outline bg-surface')}>
          <div className="mb-1 text-xs font-semibold text-content-subtle">{message.role === 'user' ? copy.user : copy.assistant}</div>
          <p className="whitespace-pre-wrap break-words leading-relaxed text-content">{message.content}</p>
          {message.status === 'failed' && <div className="mt-2 flex items-center gap-2 text-xs text-danger"><span>{copy.failed}</span><Button size="sm" disabled={!!busy} onClick={() => send(message.content)}><RotateCcw size={12} />{copy.retry}</Button></div>}
          {message.status === 'pending' && <p className="mt-2 text-xs text-content-muted">{copy.waiting}</p>}
          {message.actions?.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{message.actions.map((action: CreativeChatAction) => <Button key={action} size="sm" onClick={() => onGoToStage(actionStages[action])}>{copy[action]}</Button>)}</div>}
        </article>)}
        {mutation.isPending && <p role="status" className="text-xs text-content-muted">{copy.waiting}</p>}
      </div>
      {mutation.isError && <p role="alert" className="text-xs text-danger">{mutation.error instanceof Error ? mutation.error.message : copy.error}</p>}
      <form onSubmit={event => { event.preventDefault(); send(input) }} className="space-y-2">
        <Textarea aria-label={copy.placeholder} value={input} maxLength={8000} rows={3}
          disabled={!!busy} onChange={event => setInput(event.target.value)} placeholder={copy.placeholder} />
        <div className="flex items-center justify-between gap-2"><span className="text-[11px] leading-relaxed text-content-subtle">{busy && !mutation.isPending ? copy.locked : copy.note}</span>
          <Button type="submit" variant="primary" size="sm" disabled={!!busy || !input.trim()} loading={mutation.isPending}><ArrowUp size={14} />{copy.send}</Button></div>
      </form>
    </section>
  )
}
