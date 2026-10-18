/**
 * Agent 配置面板：左侧 4 个 agent 列表；右侧 System Prompt / Skills 子面板。
 * prompt/skill 编辑语言只读跟随内容语言（qk.contentLanguage）。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, FileText, Loader2, Plus, Trash2 } from 'lucide-react'
import { qk } from '@/shared/api/query-keys'
import { settingsApi } from '@/entities/settings/api'
import { promptApi, skillsApi, type PromptDetail, type PromptSummary, type SkillSummary } from '@/entities/ai-config/workspace-api'
import { toastError } from '@/shared/lib/errors'
import { Button } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { cardVariants } from '@/shared/ui/card'
import { Input, Textarea } from '@/shared/ui/input'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { Modal } from '@/shared/ui/Modal'
import { cn } from '@/shared/lib/cn'

const AGENT_DEFS = [
  { type: 'script_rewriter', labelKey: 'settings.agents.scriptRewriter', icon: '📝' },
  { type: 'extractor', labelKey: 'settings.agents.extractor', icon: '🔍' },
  { type: 'storyboard_breaker', labelKey: 'settings.agents.storyboardBreaker', icon: '🎬' },
  { type: 'prompt_generator', labelKey: 'settings.agents.promptGenerator', icon: '🖼' },
] as const

type AgentType = (typeof AGENT_DEFS)[number]['type']
type PromptDraft = { value: string; remote: string | null }
type PromptSave = { agent: AgentType; lang: string; name: string; value: string }
const promptKeyOf = (agent: string, lang: string) => `${agent}:${lang}`

// settings-scroll 直接子元素限宽居中
const CONTENT_W = 'mx-auto w-full max-w-[1080px]'
const SETTINGS_HEAD = `${CONTENT_W} mb-5`
const SETTINGS_TITLE = 'text-[22px] font-extrabold tracking-[-0.02em]'
const SETTINGS_DESC = `mt-1.5 text-[13px] text-content-muted ${CONTENT_W}`

// Skills 布局
const SKILLS_LAYOUT = 'flex h-full overflow-hidden'
const SKILLS_AGENT_LIST = 'flex w-[210px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-outline px-2.5 pb-4 pt-5'
const SKILLS_AGENT_TITLE = 'px-2.5 pb-1 pt-2 text-[11px] font-[650] tracking-[0.06em] text-content-subtle'
const SKILLS_AGENT_ITEM =
  'flex w-full cursor-pointer items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-[7px] text-left text-[13px] transition-all duration-[160ms] ease-app focus-visible:outline-none focus-visible:shadow-focus'
const SKILLS_AGENT_ITEM_ACTIVE = 'font-[650] bg-brand-soft text-brand-content'
const SKILLS_AGENT_ITEM_IDLE = 'font-[550] text-content-secondary hover:bg-hover-overlay hover:text-content'
// 列表内 agent-type-badge 收窄为 26px（原 .skills-agent-item .agent-type-badge）
const AGENT_TYPE_BADGE_SM =
  'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-item bg-brand-soft text-[13px] text-brand-content'
const SKILLS_AGENT_LABEL = 'min-w-0 flex-1'
const SKILL_COUNT_BADGE = 'rounded-[99px] px-1.5 py-px font-code text-[10px] font-bold'
const SKILL_COUNT_BADGE_IDLE = 'bg-active-overlay text-content-muted'
const SKILL_COUNT_BADGE_ACTIVE = 'bg-brand-soft text-brand-content'
const SKILLS_MAIN = 'min-w-0 flex-1 h-full overflow-y-auto px-7 pt-5 pb-12 animate-fade-up'
const SKILLS_HEAD = 'flex items-start gap-3'
// 卡片头右侧徽章（32px）
const SKILLS_HEAD_BADGE =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-brand-soft text-[16px] text-brand-content'
const SKILLS_HEAD_COPY = 'min-w-0'
const SKILLS_EMPTY = 'px-6 py-12 text-center'
const SKILLS_EMPTY_ICON =
  'mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-[16px] bg-brand-soft text-brand-content'
const SKILLS_EMPTY_TITLE = 'text-body font-[650] text-content'
const SKILLS_EMPTY_DESC = 'mt-1 text-[12px] text-content-subtle'
const SKILL_LIST = 'flex flex-col gap-2.5'

// 子 tab 头（卡片头，与卡片同宽对齐）
const AGENT_PANE_TABS = 'flex items-center justify-between gap-3 border-b border-outline px-4 py-2.5'
const AGENT_PANE_TABS_NAV = 'grid grid-flow-col auto-cols-fr rounded-[10px] border border-outline bg-surface p-[3px]'
const AGENT_PANE_TAB =
  'cursor-pointer whitespace-nowrap rounded-[7px] border-none bg-transparent px-[18px] py-[5px] text-center font-ui text-[12px] font-semibold leading-[normal] transition-[background-color,color] duration-[150ms] ease-[ease]'
const AGENT_PANE_TAB_ACTIVE = 'bg-brand-soft text-brand-content'
const AGENT_PANE_TAB_IDLE = 'text-content-muted hover:text-content'
const AGENT_LANG_FOLLOW = 'text-[11px]'
const AGENT_CARD_BODY = 'flex flex-col gap-3 px-[18px] pb-[18px] pt-4'
const AGENT_FALLBACK_TAG = 'ml-1.5 bg-elevated text-[10px] font-medium text-content-subtle'
const AGENT_PROMPT_INPUT = 'min-h-[max(320px,calc(100vh-340px))] resize-y'
const AGENT_CARD_FOOT = 'flex items-center gap-2 pt-1'

// Skill 卡片
const SKILL_CARD = 'overflow-hidden'
const SKILL_CARD_HEAD =
  'flex cursor-pointer items-center gap-2.5 px-4 py-3 transition-[background-color] duration-[150ms] ease-[ease] hover:bg-hover-overlay'
const SKILL_CARD_BODY = 'flex flex-col gap-2.5 border-t border-outline px-4 pb-4 pt-3.5'
const SKILL_CARD_FOOT = 'flex items-center gap-2'
const SKILL_CONTENT_INPUT = 'min-h-[max(300px,calc(100vh-420px))] resize-y'
const SKILL_DIALOG_BODY = 'flex flex-col gap-3'

// 原全局 .btn-icon.btn-sm 尺寸收窄（30px）
const ICON_BTN_SM = 'h-[30px] min-h-[30px] w-[30px] min-w-[30px]'

// agent type 用下划线（script_rewriter），skill 目录按 Mastra 规范用连字符（script-rewriter）
const skillDirOf = (type: string) => type.replace(/_/g, '-')
const skillBelongsTo = (skillId: string, type: string) => {
  const dir = skillDirOf(type)
  return skillId === dir || skillId.startsWith(dir + '/')
}

/** 编辑语言（只读镜像内容语言）：zh 走基础版请求（无 query），其余带 ?lang= */
function editLangOf(lang: string | undefined): string {
  return lang || 'zh'
}
function langQuery(lang: string): string {
  return lang !== 'zh' ? lang : 'zh'
}

export function AgentsPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const langQueryState = useQuery({
    queryKey: qk.contentLanguage(),
    queryFn: ({ signal }) => settingsApi.contentLanguage(signal),
    staleTime: 30_000,
  })
  const contentLanguage = langQueryState.data?.language || 'zh'
  const editLang = editLangOf(contentLanguage)
  const qLang = langQuery(editLang)

  const [selectedAgent, setSelectedAgent] = useState<AgentType>('script_rewriter')
  const [agentPane, setAgentPane] = useState<'prompt' | 'skills'>('prompt')

  const agentDefs = AGENT_DEFS.map((a) => ({ ...a, label: t(a.labelKey) }))
  const selectedDef = agentDefs.find((a) => a.type === selectedAgent) ?? agentDefs[0]!

  // ===== System Prompt =====
  const promptsQuery = useQuery({
    queryKey: qk.prompts(qLang),
    queryFn: ({ signal }) => promptApi.list(signal),
    staleTime: 30_000,
  })
  const agentCfgs: PromptSummary[] = promptsQuery.data ?? []

  const promptDetailQuery = useQuery({
    queryKey: qk.promptDetail(selectedAgent, qLang),
    queryFn: ({ signal }) => promptApi.get(selectedAgent, editLang !== 'zh' ? editLang : undefined, signal),
    staleTime: 0,
    // 服务端失败不阻塞面板
    retry: false,
  })
  // 每个 Agent / 语言持有独立草稿，切换与异步响应不会把提示词串到另一个配置。
  const promptKey = promptKeyOf(selectedAgent, qLang)
  const [promptDrafts, setPromptDrafts] = useState<Record<string, PromptDraft>>({})
  const promptDraft = promptDrafts[promptKey]?.value ?? promptDetailQuery.data?.system_prompt ?? ''
  useEffect(() => {
    if (!promptDetailQuery.data) return
    const remote = promptDetailQuery.data.system_prompt
    setPromptDrafts((previous) => {
      const draft = previous[promptKey]
      if (draft?.remote === remote) return previous
      return {
        ...previous,
        [promptKey]: { value: !draft || draft.value === draft.remote ? remote : draft.value, remote },
      }
    })
  }, [promptKey, promptDetailQuery.data])

  function setPromptDraft(value: string) {
    setPromptDrafts((previous) => ({
      ...previous,
      [promptKey]: { value, remote: previous[promptKey]?.remote ?? promptDetailQuery.data?.system_prompt ?? null },
    }))
  }

  const agentPromptFallback = editLang !== 'zh' && !!promptDetailQuery.data?.is_default

  const savePromptMutation = useMutation({
    mutationFn: ({ agent, name, value, lang }: PromptSave) =>
      promptApi.update(
        agent,
        { name, system_prompt: value },
        lang !== 'zh' ? lang : undefined,
      ),
    onSuccess: (_result, saved) => {
      const key = promptKeyOf(saved.agent, saved.lang)
      setPromptDrafts((previous) => ({
        ...previous,
        [key]: { value: previous[key]?.value ?? saved.value, remote: saved.value },
      }))
      queryClient.setQueryData<PromptDetail>(qk.promptDetail(saved.agent, saved.lang), (previous) =>
        previous ? { ...previous, system_prompt: saved.value, is_default: false } : previous,
      )
      toast.success(t('settings.agents.saved', { agent: saved.name }))
      void queryClient.invalidateQueries({ queryKey: qk.prompts(saved.lang) })
      void queryClient.invalidateQueries({ queryKey: qk.promptDetail(saved.agent, saved.lang) })
    },
    onError: (err) => toastError(err),
  })

  async function resetAgentPrompt() {
    try {
      await promptApi.reset(selectedAgent, editLang !== 'zh' ? editLang : undefined)
      const resetPrompt = await promptApi.get(selectedAgent, editLang !== 'zh' ? editLang : undefined)
      setPromptDrafts((previous) => ({
        ...previous,
        [promptKey]: { value: resetPrompt.system_prompt, remote: resetPrompt.system_prompt },
      }))
      queryClient.setQueryData(qk.promptDetail(selectedAgent, qLang), resetPrompt)
      await queryClient.invalidateQueries({ queryKey: qk.prompts(qLang) })
      toast.success(t('settings.agents.promptReset'))
    } catch (err) {
      toastError(err)
    }
  }

  // ===== Skills =====
  const skillsQuery = useQuery({
    queryKey: qk.skills(qLang),
    queryFn: ({ signal }) => skillsApi.list(editLang !== 'zh' ? editLang : undefined, signal),
    staleTime: 30_000,
  })
  const allSkills: SkillSummary[] = skillsQuery.data ?? []
  const currentSkills = allSkills.filter((s) => skillBelongsTo(s.id, selectedAgent))

  const [editingSkill, setEditingSkill] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState('')
  const [skillFallback, setSkillFallback] = useState(false)
  const [skillSavedId, setSkillSavedId] = useState<string | null>(null)
  const [skillSaving, setSkillSaving] = useState(false)
  const [addSkillDialog, setAddSkillDialog] = useState(false)
  const [newSkill, setNewSkill] = useState({ id: '', name: '', description: '' })
  const [skillToDelete, setSkillToDelete] = useState<string | null>(null)

  async function toggleSkillEdit(id: string) {
    if (editingSkill === id) {
      setEditingSkill(null)
      return
    }
    try {
      const res = await skillsApi.get(id, editLang !== 'zh' ? editLang : undefined)
      setSkillContent(res.content)
      setSkillFallback(editLang !== 'zh' && !!res.is_default)
      setEditingSkill(id)
    } catch (err) {
      toastError(err)
    }
  }

  async function saveSkill(id: string) {
    setSkillSaving(true)
    try {
      await skillsApi.update(id, skillContent, editLang !== 'zh' ? editLang : undefined)
      await queryClient.invalidateQueries({ queryKey: qk.skills(qLang) })
      setSkillFallback(false)
      setSkillSavedId(id)
      toast.success(t('common.saved'))
      setTimeout(() => setSkillSavedId((cur) => (cur === id ? null : cur)), 3000)
    } catch (err) {
      toastError(err)
    } finally {
      setSkillSaving(false)
    }
  }

  async function confirmAddSkill() {
    if (!newSkill.id) return
    const skillId = `${skillDirOf(selectedAgent)}/${newSkill.id}`
    try {
      await skillsApi.create({ id: skillId, name: newSkill.name, description: newSkill.description })
      setAddSkillDialog(false)
      await queryClient.invalidateQueries({ queryKey: qk.skills(qLang) })
      toast.success(t('settings.skills.created'))
    } catch (err) {
      toastError(err)
    }
  }

  async function confirmDelSkill() {
    const id = skillToDelete
    if (!id) return
    try {
      await skillsApi.del(id)
      if (editingSkill === id) setEditingSkill(null)
      await queryClient.invalidateQueries({ queryKey: qk.skills(qLang) })
      setSkillToDelete(null)
      toast.success(t('index.deleted'))
    } catch (err) {
      toastError(err)
    }
  }

  const agentSkillCount = (type: string) => allSkills.filter((s) => skillBelongsTo(s.id, type)).length
  const selectedCfg = agentCfgs.find((a) => a.agent_type === selectedAgent)

  return (
    <div className={SKILLS_LAYOUT}>
      {/* Agent 左侧 tab 列表 */}
      <aside className={SKILLS_AGENT_LIST}>
        <div className={SKILLS_AGENT_TITLE}>{t('settings.skills.agentList')}</div>
        {agentDefs.map((a) => {
          const isActive = selectedAgent === a.type
          return (
            <button
              key={a.type}
              type="button"
              className={cn(SKILLS_AGENT_ITEM, isActive ? SKILLS_AGENT_ITEM_ACTIVE : SKILLS_AGENT_ITEM_IDLE)}
              onClick={() => {
                if (selectedAgent !== a.type) {
                  setSelectedAgent(a.type)
                  setEditingSkill(null)
                }
              }}
            >
              <span className={AGENT_TYPE_BADGE_SM}>{a.icon}</span>
              <span className={SKILLS_AGENT_LABEL}>{a.label}</span>
              {agentSkillCount(a.type) > 0 && (
                <span className={cn(SKILL_COUNT_BADGE, isActive ? SKILL_COUNT_BADGE_ACTIVE : SKILL_COUNT_BADGE_IDLE)}>
                  {agentSkillCount(a.type)}
                </span>
              )}
            </button>
          )
        })}
      </aside>

      {/* 右侧主区域 */}
      <div className={SKILLS_MAIN}>
        <div className={`${SETTINGS_HEAD} ${SKILLS_HEAD}`}>
          <span className={SKILLS_HEAD_BADGE}>{selectedDef.icon}</span>
          <div className={SKILLS_HEAD_COPY}>
            <h2 className={`${SETTINGS_TITLE} leading-[26px]`}>{selectedDef.label}</h2>
            <div className="text-content-subtle" style={{ fontSize: 12, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
              {selectedAgent}
              {selectedCfg && !selectedCfg.is_default ? (
                <Badge tone="success">{t('settings.common.custom')}</Badge>
              ) : (
                <Badge>{t('common.default')}</Badge>
              )}
            </div>
          </div>
          {agentPane === 'skills' && (
            <Button variant="primary" size="sm" className="ml-auto -mt-0.5" onClick={() => { setNewSkill({ id: '', name: '', description: '' }); setAddSkillDialog(true) }}>
              <Plus size={13} /> {t('settings.skills.add')}
            </Button>
          )}
        </div>

        {/* 子 tab 头（卡片头，与卡片同宽对齐） */}
        <div className={cn(cardVariants(), CONTENT_W, agentPane === 'prompt' ? 'overflow-hidden' : 'mb-3.5 overflow-hidden')}>
          <div className={AGENT_PANE_TABS}>
            <div className={AGENT_PANE_TABS_NAV}>
              <button
                type="button"
                className={cn(AGENT_PANE_TAB, agentPane === 'prompt' ? AGENT_PANE_TAB_ACTIVE : AGENT_PANE_TAB_IDLE)}
                onClick={() => setAgentPane('prompt')}
              >
                System Prompt
              </button>
              <button
                type="button"
                className={cn(AGENT_PANE_TAB, agentPane === 'skills' ? AGENT_PANE_TAB_ACTIVE : AGENT_PANE_TAB_IDLE)}
                onClick={() => setAgentPane('skills')}
              >
                Skills{agentSkillCount(selectedAgent) > 0 ? ` (${agentSkillCount(selectedAgent)})` : ''}
              </button>
            </div>
            <span className={`text-content-subtle ${AGENT_LANG_FOLLOW}`}>
              {t('settings.agents.followContentLang', { lang: CONTENT_LANG_LABELS[contentLanguage] ?? contentLanguage })}
            </span>
          </div>

          {agentPane === 'prompt' && (
            <div className={AGENT_CARD_BODY}>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-[550] text-content-secondary">
                  System Prompt <span className="text-content-subtle">({t('settings.agents.promptHint', { file: `workspace/prompts/${selectedAgent}${editLang !== 'zh' ? `.${editLang}` : ''}.md` })})</span>
                  {agentPromptFallback && <Badge className={AGENT_FALLBACK_TAG}>{t('settings.agents.langFallback')}</Badge>}
                </span>
                <Textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  className={AGENT_PROMPT_INPUT}
                  rows={16}
                  placeholder={t('settings.agents.promptPlaceholder')}
                />
              </label>
              <div className={AGENT_CARD_FOOT}>
                <Button variant="ghost" size="sm" onClick={() => void resetAgentPrompt()}>
                  {t('settings.agents.reset')}
                </Button>
                <Badge tone="success" style={{ marginLeft: 8, visibility: 'hidden' }}>
                  <Check size={10} /> {t('common.saved')}
                </Badge>
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  disabled={savePromptMutation.isPending || !promptDetailQuery.data}
                  onClick={() => savePromptMutation.mutate({ agent: selectedAgent, lang: qLang, name: selectedDef.label, value: promptDraft })}
                >
                  {savePromptMutation.isPending && <Loader2 size={12} className="animate-spin" />}
                  {t('common.save')}
                </Button>
              </div>
            </div>
          )}
        </div>

        {agentPane === 'skills' && (
          <>
            <p className={SETTINGS_DESC} style={{ marginTop: 0 }}>{t('settings.skills.desc')}</p>

            {!currentSkills.length ? (
              <div className={cn(cardVariants(), CONTENT_W, SKILLS_EMPTY)}>
                <div className={SKILLS_EMPTY_ICON}>
                  <FileText size={24} />
                </div>
                <div className={SKILLS_EMPTY_TITLE}>{t('settings.skills.emptyTitle')}</div>
                <div className={SKILLS_EMPTY_DESC}>{t('settings.skills.emptyDesc')}</div>
              </div>
            ) : (
              <div className={`${SKILL_LIST} ${CONTENT_W}`}>
                {currentSkills.map((s) => (
                  <div key={s.id} className={cn(cardVariants(), SKILL_CARD)}>
                    <div className={SKILL_CARD_HEAD} onClick={() => void toggleSkillEdit(s.id)}>
                      <FileText size={14} style={{ color: 'var(--hb-brand)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                        <div className="text-content-subtle" style={{ fontSize: 11 }}>{s.description}</div>
                      </div>
                      <Button
                        variant="danger"
                        size="icon"
                        className={ICON_BTN_SM}
                        style={{ marginRight: 4 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSkillToDelete(s.id)
                        }}
                      >
                        <Trash2 size={13} />
                      </Button>
                      <ChevronDown size={14} style={{ transform: editingSkill === s.id ? 'rotate(180deg)' : '', transition: '0.2s' }} />
                    </div>
                    {editingSkill === s.id && (
                      <div className={SKILL_CARD_BODY}>
                        <Textarea
                          value={skillContent}
                          onChange={(e) => setSkillContent(e.target.value)}
                          className={`font-code ${SKILL_CONTENT_INPUT}`}
                          rows={20}
                          style={{ fontSize: 12, lineHeight: 1.6 }}
                          placeholder={t('settings.skills.contentPlaceholder')}
                        />
                        <div className={SKILL_CARD_FOOT}>
                          <span className="text-content-subtle" style={{ fontSize: 11 }}>
                            skills/{s.id}/SKILL{editLang !== 'zh' ? `.${editLang}` : ''}.md
                          </span>
                          {skillFallback && <Badge className={AGENT_FALLBACK_TAG}>{t('settings.agents.langFallback')}</Badge>}
                          {skillSavedId === s.id && (
                            <Badge tone="success" style={{ marginLeft: 8 }}>
                              <Check size={10} /> {t('common.saved')}
                            </Badge>
                          )}
                          <Button variant="primary" size="sm" className="ml-auto" disabled={skillSaving} onClick={() => void saveSkill(s.id)}>
                            {skillSaving && <Loader2 size={12} className="animate-spin" />}
                            {t('common.save')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Add Skill Dialog */}
      <Modal
        open={addSkillDialog}
        onOpenChange={(v) => !v && setAddSkillDialog(false)}
        width={440}
        title={t('settings.skills.addTitle', { agent: selectedDef.label })}
        footer={
          <>
            <Button onClick={() => setAddSkillDialog(false)}>{t('common.cancel')}</Button>
            <Button type="submit" form="add-skill-form" variant="primary" disabled={!newSkill.id}>
              {t('settings.skills.create')}
            </Button>
          </>
        }
      >
        <form id="add-skill-form" className={SKILL_DIALOG_BODY} onSubmit={(e) => { e.preventDefault(); void confirmAddSkill() }}>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">
              {t('settings.skills.dirName')} <span className="text-content-subtle">({t('settings.skills.dirNameHint')})</span>
            </span>
            <Input value={newSkill.id} onChange={(e) => setNewSkill((f) => ({ ...f, id: e.target.value }))} placeholder={t('settings.skills.dirNamePlaceholder')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.skills.name')}</span>
            <Input value={newSkill.name} onChange={(e) => setNewSkill((f) => ({ ...f, name: e.target.value }))} placeholder={t('settings.skills.namePlaceholder')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.skills.description')}</span>
            <Input value={newSkill.description} onChange={(e) => setNewSkill((f) => ({ ...f, description: e.target.value }))} placeholder={t('settings.skills.descPlaceholder')} />
          </label>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!skillToDelete}
        title={t('settings.skillDelete.title')}
        message={t('settings.skillDelete.message', { id: skillToDelete })}
        onConfirm={() => void confirmDelSkill()}
        onCancel={() => setSkillToDelete(null)}
      />
    </div>
  )
}

const CONTENT_LANG_LABELS: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}
