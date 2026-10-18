/**
 * AI 服务配置面板：火宝快捷配置（API Key + 国内/国外节点一键写入）、
 * 手动配置 CRUD、模型标签编辑（首位即默认）、连通性测试。
 * API Key 仅存在于表单输入生命周期内，不进入任何缓存或持久化。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Pencil, Plus, Sparkles, Star, Trash2, X } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { qk } from '@/shared/api/query-keys'
import { aiConfigApi, type AiConfig, type ConfigTestResult, type ServiceType } from '@/entities/ai-config/model'
import { toolboxQueries } from '@/entities/creative/toolbox'
import { toastError } from '@/shared/lib/errors'
import { providerIconUrl } from '@/shared/lib/provider-icons'
import { useTheme } from '@/shared/config/theme'
import { useUiLocale } from '@/shared/config/use-locale'
import { Modal } from '@/shared/ui/Modal'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { Button } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { cardVariants } from '@/shared/ui/card'
import { Input, Textarea } from '@/shared/ui/input'
import { Switch } from '@/shared/ui/switch'
import { cn } from '@/shared/lib/cn'


// settings-scroll 直接子元素限宽居中；card + card 间距 14px
const PANEL_SCROLL = 'h-full overflow-y-auto px-7 pt-5 pb-12 animate-fade-up'
const CONTENT_W = 'mx-auto w-full max-w-[1080px]'
const SETTINGS_HEAD = `${CONTENT_W} mb-5`
const SETTINGS_TITLE = 'text-[22px] font-extrabold tracking-[-0.02em]'
const SETTINGS_DESC = 'mt-1.5 text-[13px] text-content-muted'

// 火宝快捷配置（quick-card 为引导锚点类，保留）
const QUICK_CARD = 'quick-card mb-4 border-[1.5px] border-brand p-5 hover:border-brand'
const QUICK_CARD_HEAD = 'mb-1.5 flex items-center gap-2.5'
const SETUP_TITLE = 'text-[15px] font-bold text-content'
const SETUP_DESC = 'mb-3.5 text-[12.5px] text-content-muted'
const HUOBA_SITE_LINK =
  'ml-1.5 inline-flex items-center gap-[3px] whitespace-nowrap font-semibold text-brand no-underline hover:underline'
const HUOBA_QUICK_ROW = 'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2.5'
const HUOBA_QUICK_MODELS = 'mt-3.5 flex flex-col gap-[7px]'
const HQM_ROW = 'flex items-baseline gap-2.5 text-[11px] leading-[1.6]'
const HQM_LABEL = 'w-7 shrink-0 font-semibold text-content-muted'
const HQM_PROVIDER =
  'inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-brand-soft px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.02em] text-brand'
const HQM_PROVIDER_ICON = 'h-[11px] w-[11px] rounded-[2px] object-contain'
const HQM_MODELS = 'flex flex-wrap gap-x-3 gap-y-1 text-content-subtle'
const HQM_MODEL_DEFAULT = 'font-semibold text-content-secondary'
const DEFAULT_EM = 'ml-1 rounded-[5px] bg-brand-soft px-[5px] text-[10px] font-semibold not-italic text-brand-content'

// 内容语言分段选择器（火宝节点选择同款）
const LANG_PICKER_QUICK = 'flex gap-0.5 rounded-pill bg-track p-[3px]'
const LANG_OPTION_BASE =
  'min-h-[30px] cursor-pointer whitespace-nowrap rounded-pill border-none bg-transparent px-3.5 py-0 text-[12.5px] font-semibold leading-none transition-all duration-[160ms] ease-app focus-visible:outline-none focus-visible:shadow-focus'
const LANG_OPTION_ON = 'bg-seg-active text-content shadow-[0_1px_4px_rgba(0,0,0,0.1)]'
const LANG_OPTION_IDLE = 'text-content-muted hover:text-content'

// 手动配置入口
const SETUP_PANEL = 'mt-3.5 mb-4 px-5 py-[18px]'
const SETUP_PANEL_HEAD = 'mb-3 flex items-start justify-between gap-4'
const TEMPLATE_ROW = 'flex flex-wrap gap-2'
const CHIP =
  'min-h-[30px] cursor-pointer rounded-pill border-none bg-button px-3.5 py-0 text-[12px] font-semibold leading-none text-content-secondary transition-all duration-[160ms] ease-app hover:bg-button-hover hover:text-content focus-visible:outline-none focus-visible:shadow-focus'

// 配置分组卡与配置行
const SECTIONS = `${CONTENT_W} flex flex-col gap-4`
const SVC_GROUP = 'overflow-hidden'
const SVC_GROUP_HEAD = 'flex items-center gap-2.5 border-b border-outline px-5 py-3.5'
const SVC_GROUP_HEADING = 'min-w-0'
const SVC_GROUP_TITLE = 'text-body font-bold text-content'
const SVC_GROUP_SUB = 'mt-0.5 text-[11.5px] text-content-subtle'
const CONFIG_ROW = 'flex items-center gap-3 px-5 py-3'
const PROVIDER_BADGE_BASE =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[14px] font-bold text-on-action shadow-[0_1px_4px_rgba(0,0,0,0.12)]'
// 厂商专属底色（原 [data-provider] 规则）；有图标时用中性底
const PROVIDER_BG: Record<string, string> = {
  openai: 'bg-[#10a37f]',
  gemini: 'bg-[#4285f4]',
  volcengine: 'bg-[#ff5c39]',
}
const PROVIDER_BADGE_ICON = 'h-5 w-5 object-contain'
const CONFIG_MAIN = 'flex min-w-0 flex-1 flex-col gap-[3px]'
const CONFIG_LINE = 'flex min-w-0 items-center gap-2'
const CONFIG_NAME = 'text-form font-[650] text-content'
const CONFIG_SUB = 'text-[11.5px] text-content-subtle'
const CONFIG_MODELS = 'my-[3px] flex flex-wrap gap-1'
const CFG_MODEL_CHIP_COMMON =
  'inline-flex items-center gap-[3px] rounded-[999px] border px-[7px] py-px text-[10.5px] transition-[border-color,color,background-color] duration-[120ms] ease-[ease]'
const CFG_MODEL_CHIP_IDLE =
  'cursor-pointer border-outline bg-transparent text-content-muted hover:border-brand hover:text-brand'
const CFG_MODEL_CHIP_DEFAULT = 'cursor-default border-brand bg-brand-soft font-semibold text-brand'
const CFG_MODEL_STAR = 'fill-current'
const CONFIG_EMPTY = 'px-5 py-3.5 text-[12px] text-content-subtle'
const CONFIG_SWITCH = 'inline-flex shrink-0 cursor-pointer'

// 配置弹窗
const CONFIG_DIALOG = 'w-[min(720px,calc(100vw-40px))]'
const CONFIG_DIALOG_BODY = 'flex flex-col gap-3.5'
const DIALOG_SUB = 'mt-1 text-[12px] text-content-muted'
const PRESET_PICKER = 'flex flex-wrap gap-2'
const MODEL_CHIPS = 'mb-2 flex flex-wrap gap-1.5'
const MODEL_CHIP_COMMON =
  'inline-flex cursor-pointer select-none items-center gap-1 rounded-[7px] border px-2 py-1 text-[12px] transition-[border-color,color] duration-[150ms] ease-[ease]'
const MODEL_CHIP_IDLE = 'border-outline bg-elevated text-content-muted hover:border-brand hover:text-content-secondary'
const MODEL_CHIP_DEFAULT = 'border-brand bg-elevated font-semibold text-content-secondary'
const MODEL_EM = 'rounded-[5px] bg-brand-soft px-[5px] text-[10px] font-semibold not-italic text-brand-content'
const MODEL_CHIP_X =
  'inline-flex cursor-pointer items-center rounded-[4px] border-none bg-transparent p-px text-content-subtle hover:bg-sunken hover:text-danger'
const MODEL_ADD_ROW = 'flex gap-2'
const TEST_RESULT_BASE = 'flex flex-col gap-2 rounded-panel border px-3.5 py-3'
const TEST_RESULT_OK = 'border-success bg-success-soft'
const TEST_RESULT_BAD = 'border-danger bg-danger-soft'
const TEST_RESULT_HEAD = 'flex items-center gap-2 text-[12px] text-content-secondary'
const TEST_RESULT_META = 'font-code text-[11px] text-content-muted break-all'

// 原全局 .btn-icon.btn-sm 尺寸收窄（30px）
const ICON_BTN_SM = 'h-[30px] min-h-[30px] w-[30px] min-w-[30px]'

/** 厂商预设模板（配置名持久化进 DB：provider 英文 + 服务类型英文，不随界面语言漂移） */
const PROVIDER_PRESETS: Record<ServiceType, Record<string, { label: string; baseUrl: string; models: string[]; requiresApiKey?: boolean }>> = {
  speech: { openai: { label: 'OpenAI 语音合成', baseUrl: 'https://api.openai.com', models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] } },
  transcription: { openai: { label: 'OpenAI 时码识别', baseUrl: 'https://api.openai.com', models: ['whisper-1'] } },
  lipsync: { sync: { label: 'Sync 口型同步', baseUrl: 'https://api.sync.so', models: ['lipsync-2', 'lipsync-2-pro', 'sync-3'] } },
  rigging: { meshy: { label: 'Meshy 骨骼绑定', baseUrl: 'https://api.meshy.ai', models: ['rigging'] } },
  research: { tavily: { label: 'Tavily 联网资料', baseUrl: 'https://api.tavily.com', models: ['search'] } },
  stock: { pexels: { label: 'Pexels 联网素材', baseUrl: 'https://api.pexels.com', models: ['search'] } },
  text: {
    gemini: { label: 'Gemini 官方', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'] },
    openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com', models: ['deepseek-v4-pro', 'gpt-5.6-terra'] },
  },
  image: {
    gemini: { label: 'Gemini 官方', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-3-pro-image', 'gemini-3.1-flash-image'] },
    openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com', models: ['gpt-image-2'] },
  },
  video: {
    aliyun: { label: '阿里云百炼 Wan 3.0', baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com', models: ['wan3.0-video', 'wan3.0-video-prime'] },
    volcengine: { label: 'Seedance 2.0 官方', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-260128'] },
    minimax: { label: 'MiniMax H3 官方', baseUrl: 'https://api.minimaxi.com', models: ['MiniMax-H3'] },
  },
}

const CFG_FORM_SCHEMA = z.object({
  name: z.string(),
  provider: z.string().min(1),
  priority: z.coerce.number().min(0).max(999),
  api_key: z.string(),
  base_url: z.string(),
  temperature: z.string(),
})
type CfgFormInput = z.input<typeof CFG_FORM_SCHEMA>
type CfgFormOutput = z.output<typeof CFG_FORM_SCHEMA>

export function AiConfigsPanel() {
  const { t } = useTranslation()
  const locale = useUiLocale()
  const { resolvedTheme } = useTheme()
  const queryClient = useQueryClient()
  const toolCatalog = useQuery(toolboxQueries.catalog())
  const providerPresets = Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([type, presets]) => [type, { ...presets }]))
  for (const preset of toolCatalog.data?.providers ?? []) {
    providerPresets[preset.serviceType] ??= {}
    const existing = providerPresets[preset.serviceType][preset.provider]
    providerPresets[preset.serviceType][preset.provider] = {
      label: existing?.label ?? preset.name,
      baseUrl: existing?.baseUrl ?? preset.baseUrl,
      models: [...new Set([...(existing?.models ?? []), ...preset.models])],
      requiresApiKey: existing?.requiresApiKey ?? preset.requiresApiKey,
    }
  }

  const configsQuery = useQuery({
    queryKey: qk.aiConfigs(),
    queryFn: ({ signal }) => aiConfigApi.list(undefined, signal),
    staleTime: 30_000,
  })
  const cfgs = configsQuery.data ?? []
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: qk.aiConfigs() })
    void queryClient.invalidateQueries({ predicate: query => query.queryKey.some(key => typeof key === 'string' && key.startsWith('creative')) })
  }

  const serviceTypes: { type: string; label: string }[] = [
    { type: 'text' as const, label: t('common.serviceType.text') },
    { type: 'image' as const, label: t('common.serviceType.image') },
    { type: 'video' as const, label: t('common.serviceType.video') },
    { type: 'speech' as const, label: '语音合成' },
    { type: 'transcription' as const, label: '语音识别' },
    { type: 'lipsync' as const, label: '口型同步' },
    { type: 'rigging' as const, label: '骨骼绑定' },
    { type: 'research' as const, label: '联网资料' },
    { type: 'stock' as const, label: '联网素材' },
  ]
  const serviceMeta: Record<string, { label: string; desc: string }> = {
    speech: { label: '语音合成', desc: '旁白与角色配音；共用模型配置、地址和密钥管理' },
    transcription: { label: '语音识别', desc: '原声转写与字幕时码' },
    lipsync: { label: '口型同步', desc: '人物视频或图片与配音对齐；静态图片请选择 sync-3' },
    rigging: { label: '骨骼绑定', desc: '三维人形模型绑定与动作输出' },
    research: { label: '联网资料', desc: '搜索主题资料，保留来源链接' },
    stock: { label: '联网素材', desc: '搜索图片与视频，保留作者和来源' },
    text: { label: t('common.serviceType.text'), desc: t('settings.ai.meta.text') },
    image: { label: t('common.serviceType.image'), desc: t('settings.ai.meta.image') },
    video: { label: t('common.serviceType.video'), desc: t('settings.ai.meta.video') },
  }
  const capabilityLabels: Record<string, string> = { music: '音乐与音效', audio: '音频处理', image_edit: '图像编辑', image_editing: '图像编辑', video_edit: '视频处理', video_editing: '视频处理', model: '三维模型生成', model3d: '三维模型生成', model_3d: '三维模型生成', animation: '动画生成', vision: '视觉分析', enhancement: '画质增强', avatar: '数字人', search: '联网搜索', browser: '浏览器与录制', voice: '声音制作', sound: '音效生成', sound_effects: '音效生成', segmentation: '分割与抠图', rendering: '三维渲染' }
  for (const type of new Set([...(toolCatalog.data?.providers.map(preset => preset.serviceType) ?? []), ...cfgs.map(config => config.serviceType)])) {
    if (serviceTypes.some(item => item.type === type)) continue
    const label = capabilityLabels[type] ?? type
    serviceTypes.push({ type, label })
    serviceMeta[type] = { label, desc: '短剧、创意视频与制作工具箱共用此能力的服务配置' }
  }

  // ===== 火宝快捷配置 =====
  // 节点选择：默认跟随界面语言（中文→国内 .cn，其他→国外 .com），一键配置与取 Key 链接共用
  const [huobaoApiKey, setHuobaoApiKey] = useState('')
  const [huobaoRegion, setHuobaoRegion] = useState<'cn' | 'com'>(locale.startsWith('zh') ? 'cn' : 'com')
  const huobaoSiteUrl = `https://api.firemux.${huobaoRegion}`
  const huobaoQuickConfigs = [
    { service_type: 'text', provider: 'gemini', name: '火宝文本服务 · Gemini', base_url: huobaoSiteUrl, model: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'], priority: 101 },
    { service_type: 'text', provider: 'openai', name: '火宝文本服务 · OpenAI', base_url: huobaoSiteUrl, model: ['deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-5.6-terra'], priority: 100 },
    { service_type: 'image', provider: 'openai', name: '火宝图片服务 · OpenAI', base_url: huobaoSiteUrl, model: ['gpt-image-2'], priority: 99 },
    { service_type: 'image', provider: 'gemini', name: '火宝图片服务 · Gemini', base_url: huobaoSiteUrl, model: ['gemini-3-pro-image', 'gemini-3.1-flash-image'], priority: 97 },
    { service_type: 'video', provider: 'aliyun', name: '火宝视频服务 · Wan 3.0', base_url: `${huobaoSiteUrl}/qwen`, model: ['wan3.0-video', 'wan3.0-video-prime'], priority: 97 },
    { service_type: 'video', provider: 'volcengine', name: '火宝视频服务 · Seedance', base_url: `${huobaoSiteUrl}/volcengine`, model: ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-260128'], priority: 96 },
    { service_type: 'video', provider: 'minimax', name: '火宝视频服务 · MiniMax', base_url: `${huobaoSiteUrl}/minimax`, model: ['MiniMax-H3'], priority: 98 },
  ]

  const quickApplyMutation = useMutation({
    mutationFn: async () => {
      const apiKey = huobaoApiKey.trim()
      if (!apiKey) throw new Error('skip')
      for (const preset of huobaoQuickConfigs) {
        const payload = { ...preset, api_key: apiKey }
        const existing = cfgs.find(
          (c) => c.name === preset.name || (c.serviceType === preset.service_type && c.provider === preset.provider && c.baseUrl === preset.base_url),
        )
        if (existing) await aiConfigApi.update(existing.id, payload)
        else await aiConfigApi.create(payload)
      }
    },
    onSuccess: () => {
      toast.success(t('settings.ai.quickApplied'))
      setHuobaoApiKey('')
      invalidate()
    },
    onError: (err) => {
      if (!(err instanceof Error && err.message === 'skip')) toastError(err)
    },
  })

  function applyHuobaoQuickConfig() {
    if (!huobaoApiKey.trim()) {
      toast.warning(t('settings.ai.apiKeyRequired'))
      return
    }
    quickApplyMutation.mutate()
  }

  // ===== 配置 CRUD =====
  const byType = (type: ServiceType) => cfgs.filter((c) => c.serviceType === type)
  const countActive = (type: ServiceType) => byType(type).filter((c) => c.isActive).length

  // 默认模型解析：启用配置中优先级最高者的模型列表首位（与工作台/后端一致）
  function defaultModelOf(type: ServiceType): { configId: number; model: string } | null {
    const active = cfgs.filter((c) => c.serviceType === type && c.isActive)
    if (!active.length) return null
    const top = [...active].sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]!
    const first = top.models[0]
    return first ? { configId: top.id, model: first } : null
  }
  const isDefaultModel = (type: ServiceType, c: AiConfig, m: string) => {
    const d = defaultModelOf(type)
    return !!d && d.configId === c.id && d.model === m
  }

  const setDefaultModelMutation = useMutation({
    mutationFn: ({ c, m }: { c: AiConfig; m: string; type: ServiceType }) => {
      const models = [m, ...c.models.filter((x) => x !== m)]
      const maxPriority = Math.max(0, ...cfgs.filter((x) => x.serviceType === c.serviceType).map((x) => x.priority || 0))
      const payload: Record<string, unknown> = { model: models }
      if (defaultModelOf(c.serviceType)?.configId !== c.id) payload.priority = maxPriority + 1
      if (!c.isActive) payload.is_active = true // 停用配置无法成为默认,选择即启用
      return aiConfigApi.update(c.id, payload)
    },
    onSuccess: (_data, { m, type }) => {
      toast.success(t('settings.ai.defaultModelSwitched', { type: serviceMeta[type].label, model: m }))
      invalidate()
    },
    onError: (err) => toastError(err),
  })

  const toggleMutation = useMutation({
    mutationFn: (c: AiConfig) => aiConfigApi.update(c.id, { is_active: !c.isActive }),
    onSuccess: invalidate,
  })
  const delMutation = useMutation({
    mutationFn: (id: number) => aiConfigApi.del(id),
    onSuccess: () => {
      toast.success(t('index.deleted'))
      invalidate()
    },
    onError: (err) => toastError(err),
  })

  // ===== 配置弹窗（RHF + Zod；模型标签为受控数组） =====
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [dialogType, setDialogType] = useState<ServiceType>('text')
  const [models, setModels] = useState<string[]>([])
  const [modelInput, setModelInput] = useState('')
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [serviceOptions, setServiceOptions] = useState('')
  const [serviceOptionsError, setServiceOptionsError] = useState<string | null>(null)

  const form = useForm<CfgFormInput, unknown, CfgFormOutput>({
    resolver: zodResolver(CFG_FORM_SCHEMA),
    defaultValues: { name: '', provider: '', priority: 0, api_key: '', base_url: '', temperature: '' },
  })

  function presetsByType(type: ServiceType) {
    const group = providerPresets[type] || {}
    return Object.entries(group).map(([provider, preset]) => ({ provider, ...preset }))
  }

  function applyProviderPreset(type: ServiceType, provider: string) {
    const preset = providerPresets[type]?.[provider]
    if (!preset) return
    form.setValue('provider', provider)
    form.setValue('base_url', preset.baseUrl)
    form.setValue('name', `${preset.label}-${type}`)
    setModels([...preset.models])
  }

  function startAddCfg(type: ServiceType) {
    setEditId(null)
    setClearKey(false)
    setTestResult(null)
    setServiceOptions('')
    setServiceOptionsError(null)
    setDialogType(type)
    form.reset({ name: '', provider: '', priority: 0, api_key: '', base_url: '', temperature: '' })
    setModels([])
    const firstPreset = presetsByType(type)[0]
    if (firstPreset) applyProviderPreset(type, firstPreset.provider)
    setDialogOpen(true)
  }

  function startEditCfg(c: AiConfig) {
    setEditId(c.id)
    setClearKey(false)
    setTestResult(null)
    setServiceOptions(c.serviceOptions && Object.keys(c.serviceOptions).length ? JSON.stringify(c.serviceOptions, null, 2) : '')
    setServiceOptionsError(null)
    setDialogType(c.serviceType)
    form.reset({
      name: c.name || '',
      provider: c.provider,
      priority: c.priority ?? 0,
      api_key: '',
      base_url: c.baseUrl || '',
      temperature: c.temperature == null ? '' : String(c.temperature),
    })
    setModels([...c.models])
    setDialogOpen(true)
  }

  function addModel() {
    const names = modelInput.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
    setModels((prev) => {
      const next = [...prev]
      for (const n of names) if (!next.includes(n)) next.push(n)
      return next
    })
    setModelInput('')
  }

  function onModelPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData?.getData('text') || ''
    if (!/[,，\n]/.test(text)) return // 单模型走默认粘贴
    e.preventDefault()
    setModels((prev) => {
      const next = [...prev]
      for (const n of text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)) {
        if (!next.includes(n)) next.push(n)
      }
      return next
    })
  }

  function pinModelTop(i: number) {
    if (i <= 0) return
    setModels((prev) => {
      const next = [...prev]
      const [m] = next.splice(i, 1)
      if (m) next.unshift(m)
      return next
    })
  }

  async function testPayload(payload: Record<string, unknown>) {
    setTesting(true)
    try {
      const result = await aiConfigApi.test(payload)
      setTestResult(result)
      if (result.checked === 'configuration') toast.info(result.message)
      else if (result.reachable) toast.success(t('settings.cfg.reachable'))
      else toast.warning(t('settings.cfg.unreachable'))
    } catch (err) {
      toastError(err)
    } finally {
      setTesting(false)
    }
  }

  function onTestDraft() {
    const v = form.getValues()
    let parsedOptions: unknown = {}
    try {
      parsedOptions = serviceOptions.trim() ? JSON.parse(serviceOptions) : {}
      if (!parsedOptions || typeof parsedOptions !== 'object' || Array.isArray(parsedOptions)) throw new Error()
      setServiceOptionsError(null)
    } catch {
      setServiceOptionsError('服务参数的 JSON 格式不正确，请检查后保存。')
      return
    }
    void testPayload({
      config_id: editId,
      service_type: dialogType,
      provider: v.provider,
      api_key: v.api_key,
      ...(clearKey ? { clear_key: true, is_active: false } : {}),
      base_url: v.base_url,
      model: [...models],
      service_options: parsedOptions,
    })
  }

  function onSave(v: CfgFormOutput) {
    let parsedOptions: Record<string, unknown> = {}
    try {
      const value: unknown = serviceOptions.trim() ? JSON.parse(serviceOptions) : {}
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务参数需要填写 JSON 对象')
      parsedOptions = value as Record<string, unknown>
      setServiceOptionsError(null)
    } catch {
      setServiceOptionsError('服务参数的 JSON 格式不正确，请检查后保存。')
      return
    }
    const temperature = v.temperature === '' || v.temperature === null ? null : Number(v.temperature)
    if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      toast.warning(t('settings.cfg.tempInvalid'))
      return
    }
    const payload = {
      name: v.name,
      provider: v.provider,
      api_key: v.api_key,
      ...(clearKey ? { clear_key: true, is_active: false } : {}),
      base_url: v.base_url,
      model: models,
      priority: v.priority,
      temperature,
      service_options: parsedOptions,
    }
    void (async () => {
      try {
        if (editId) await aiConfigApi.update(editId, payload)
        else
          await aiConfigApi.create({
            service_type: dialogType,
            ...payload,
            name: payload.name || `${payload.provider}-${dialogType}`,
          })
        setDialogOpen(false)
        toast.success(t('common.saved'))
        invalidate()
      } catch (err) {
        toastError(err)
      }
    })()
  }

  return (
    <div className={PANEL_SCROLL}>
      <div className={SETTINGS_HEAD}>
        <h2 className={SETTINGS_TITLE}>{t('settings.ai.title')}</h2>
        <p className={SETTINGS_DESC}>短剧与创意视频共用这些模型和服务。每类服务按优先级选用默认配置，也可在制作时指定模型。</p>
      </div>

      {/* 火宝快捷配置 */}
      <section className={cn(cardVariants(), CONTENT_W, QUICK_CARD)}>
        <div className={QUICK_CARD_HEAD}>
          <div className={SETUP_TITLE}>{t('settings.ai.quickTitle')}</div>
          <Badge tone="brand">{t('settings.ai.recommended')}</Badge>
        </div>
        <p className={SETUP_DESC}>
          {t('settings.ai.quickDesc')}
          <a className={HUOBA_SITE_LINK} href={huobaoSiteUrl} target="_blank" rel="noopener noreferrer">
            {t('settings.ai.getKey')}
            <ExternalLink size={12} strokeWidth={1.8} />
          </a>
        </p>
        <div className={HUOBA_QUICK_ROW}>
          <Input
            value={huobaoApiKey}
            onChange={(e) => setHuobaoApiKey(e.target.value)}
            type="password"
            placeholder="Huobao API Key"
            autoComplete="off"
          />
          <div className={LANG_PICKER_QUICK}>
            <button
              type="button"
              className={cn(LANG_OPTION_BASE, huobaoRegion === 'cn' ? LANG_OPTION_ON : LANG_OPTION_IDLE)}
              onClick={() => setHuobaoRegion('cn')}
            >
              {t('settings.ai.regionCn')}
            </button>
            <button
              type="button"
              className={cn(LANG_OPTION_BASE, huobaoRegion === 'com' ? LANG_OPTION_ON : LANG_OPTION_IDLE)}
              onClick={() => setHuobaoRegion('com')}
            >
              {t('settings.ai.regionCom')}
            </button>
          </div>
          <Button variant="primary" disabled={quickApplyMutation.isPending} onClick={applyHuobaoQuickConfig}>
            {quickApplyMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {t('settings.ai.applyQuick')}
          </Button>
        </div>
        <div className={HUOBA_QUICK_MODELS}>
          {huobaoQuickConfigs.map((q) => (
            <div key={q.name} className={HQM_ROW}>
              <span className={HQM_LABEL}>{serviceMeta[q.service_type as ServiceType].label}</span>
              <span className={HQM_PROVIDER}>
                {providerIconUrl(q.provider, resolvedTheme) && (
                  <img src={providerIconUrl(q.provider, resolvedTheme)} className={HQM_PROVIDER_ICON} alt="" />
                )}
                {q.provider}
              </span>
              <span className={`font-code ${HQM_MODELS}`}>
                {q.model.map((m, i) => (
                  <span key={m} className={i === 0 ? HQM_MODEL_DEFAULT : undefined}>
                    {m}
                    {i === 0 && <em className={DEFAULT_EM}>{t('common.default')}</em>}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 手动配置入口 */}
      <section className={cn(cardVariants(), CONTENT_W, SETUP_PANEL)}>
        <div className={SETUP_PANEL_HEAD}>
          <div>
            <div className={SETUP_TITLE}>{t('settings.ai.manualTitle')}</div>
            <div className={SETUP_DESC}>{t('settings.ai.manualDesc')}</div>
          </div>
        </div>
        <div className={TEMPLATE_ROW}>
          {serviceTypes.map((st) => (
            <button key={st.type} type="button" className={CHIP} onClick={() => startAddCfg(st.type)}>
              {st.label}
            </button>
          ))}
        </div>
      </section>

      <div className={SECTIONS}>
        {serviceTypes.map((st) => (
          <section key={st.type} className={cn(cardVariants(), SVC_GROUP)}>
            <div className={SVC_GROUP_HEAD}>
              <div className={SVC_GROUP_HEADING}>
                <span className={SVC_GROUP_TITLE}>{st.label}</span>
                <div className={SVC_GROUP_SUB}>{serviceMeta[st.type].desc}</div>
              </div>
              {countActive(st.type) > 0 && (
                <Badge tone="brand">{t('settings.ai.activeCount', { n: countActive(st.type) })}</Badge>
              )}
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => startAddCfg(st.type)}>
                <Plus size={13} /> {t('common.add')}
              </Button>
            </div>
            {byType(st.type).map((c, i) => (
              <div key={c.id} className={cn(CONFIG_ROW, i > 0 && 'border-t border-outline')}>
                <div
                  className={cn(
                    PROVIDER_BADGE_BASE,
                    providerIconUrl(c.provider, resolvedTheme) ? 'bg-elevated' : (PROVIDER_BG[c.provider] ?? 'bg-brand'),
                  )}
                  data-provider={c.provider}
                >
                  {providerIconUrl(c.provider, resolvedTheme) ? (
                    <img className={PROVIDER_BADGE_ICON} src={providerIconUrl(c.provider, resolvedTheme)} alt="" />
                  ) : (
                    c.provider.slice(0, 1).toUpperCase()
                  )}
                </div>
                <div className={CONFIG_MAIN}>
                  <div className={CONFIG_LINE}>
                    <span className={CONFIG_NAME}>{c.name || `${c.provider}-${c.serviceType}`}</span>
                    <Badge tone={providerPresets[c.serviceType]?.[c.provider]?.requiresApiKey === false ? 'default' : c.hasApiKey ? 'success' : 'error'}>
                      {providerPresets[c.serviceType]?.[c.provider]?.requiresApiKey === false ? '无需密钥' : c.hasApiKey ? t('settings.ai.hasKey') : t('settings.ai.noKey')}
                    </Badge>
                    {!c.isActive && <Badge>{t('settings.common.disabled')}</Badge>}
                  </div>
                  <div className={CONFIG_MODELS}>
                    {c.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={cn(
                          'font-code',
                          CFG_MODEL_CHIP_COMMON,
                          isDefaultModel(st.type, c, m) ? CFG_MODEL_CHIP_DEFAULT : CFG_MODEL_CHIP_IDLE,
                        )}
                        title={isDefaultModel(st.type, c, m) ? t('settings.ai.currentDefault') : t('settings.ai.setDefault')}
                        onClick={() => setDefaultModelMutation.mutate({ c, m, type: st.type })}
                      >
                        {isDefaultModel(st.type, c, m) && <Star size={9} className={CFG_MODEL_STAR} />}
                        {m}
                      </button>
                    ))}
                  </div>
                  <div className={`font-code truncate ${CONFIG_SUB}`}>{c.baseUrl || t('settings.ai.noBaseUrl')}</div>
                </div>
                {st.type === 'text' && (
                  <Button variant="ghost" size="sm" onClick={() => { startEditCfg(c); void testPayload({ config_id: c.id, service_type: c.serviceType, provider: c.provider, api_key: '', base_url: c.baseUrl || '', model: c.models }) }}>
                    {t('settings.ai.test')}
                  </Button>
                )}
                <label className={CONFIG_SWITCH}>
                  <input type="checkbox" aria-label={`启用 ${c.name}`} className="sr-only peer" checked={c.isActive} onChange={() => toggleMutation.mutate(c)} />
                  <Switch checked={c.isActive} className="peer-focus-visible:shadow-focus" />
                </label>
                <Button variant="ghost" size="icon" className={ICON_BTN_SM} aria-label={`编辑 ${c.name}`} onClick={() => startEditCfg(c)}>
                  <Pencil size={13} />
                </Button>
                <Button variant="danger" size="icon" className={ICON_BTN_SM} aria-label={`删除 ${c.name}`} onClick={() => delMutation.mutate(c.id)}>
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
            {!byType(st.type).length && <p className={CONFIG_EMPTY}>{t('settings.common.empty')}</p>}
          </section>
        ))}
      </div>

      {/* AI Config Dialog */}
      <Modal
        open={dialogOpen}
        onOpenChange={(v) => !v && setDialogOpen(false)}
        width={520}
        contentClassName={CONFIG_DIALOG}
        title={
          <span>
            <span>{editId ? t('settings.cfg.editTitle') : t('settings.cfg.addTitle', { type: serviceMeta[dialogType].label })}</span>
            <span className={DIALOG_SUB}>{t('settings.cfg.sub')}</span>
          </span>
        }
        showClose={false}
        footer={
          <>
            <Button variant="ghost" disabled={testing || clearKey} onClick={onTestDraft}>
              {testing ? <Loader2 size={12} className="animate-spin" /> : <span>{t('settings.cfg.test')}</span>}
            </Button>
            <Button onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" form="ai-config-form" variant="primary">{t('common.save')}</Button>
          </>
        }
      >
        <form id="ai-config-form" className={CONFIG_DIALOG_BODY} onSubmit={form.handleSubmit(onSave)}>
          <div className={PRESET_PICKER}>
            {presetsByType(dialogType).filter(preset => !editId || preset.provider === form.getValues('provider')).map((preset) => (
              <button
                key={`${dialogType}-${preset.provider}`}
                type="button"
                className={CHIP}
                onClick={() => applyProviderPreset(dialogType, preset.provider)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.cfg.name')}</span>
            <Input {...form.register('name')} placeholder={t('settings.cfg.namePlaceholder')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.cfg.provider')}</span>
            <BaseSelect
              value={form.watch('provider')}
              onChange={(v) => form.setValue('provider', v)}
              options={[...new Set([...Object.keys(providerPresets[dialogType] ?? {}), ...(editId ? [form.getValues('provider')] : [])])].map((p) => ({ label: p, value: p }))}
              disabled={!!editId}
              placeholder={t('settings.cfg.providerPlaceholder')}
              searchable
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.cfg.priority')}</span>
            <Input {...form.register('priority')} type="number" min={0} max={999} />
            <span className="text-micro leading-[1.5] text-content-subtle">{t('settings.cfg.priorityHint')}</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">API Key</span>
            <Input {...form.register('api_key')} type="password" disabled={clearKey} placeholder={providerPresets[dialogType]?.[form.watch('provider')]?.requiresApiKey === false ? '可选，此服务无需密钥' : editId ? '留空保留已保存密钥' : '请输入 API Key'} autoComplete="off" />
            {providerPresets[dialogType]?.[form.watch('provider')]?.requiresApiKey === false && <span className="text-xs text-content-muted">此服务无需密钥，仍需保存服务地址{form.watch('provider') === 'comfyui' ? '和 API 工作流' : ''}配置。</span>}
          </label>
          {editId && <label className="flex items-center gap-2 text-xs text-content-muted">
            <input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />
            清除已保存密钥并停用此配置
          </label>}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">Base URL</span>
            <Input {...form.register('base_url')} placeholder="https://..." readOnly={['lipsync', 'rigging', 'research', 'stock'].includes(dialogType)} />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">{t('settings.cfg.models')}</span>
            {models.length > 0 && (
              <div className={MODEL_CHIPS}>
                {models.map((m, i) => (
                  <span
                    key={`${m}-${i}`}
                    className={cn(MODEL_CHIP_COMMON, i === 0 ? MODEL_CHIP_DEFAULT : MODEL_CHIP_IDLE)}
                    title={t('settings.cfg.modelChipHint')}
                    onClick={() => pinModelTop(i)}
                  >
                    {m}
                    {i === 0 && <em className={MODEL_EM}>{t('common.default')}</em>}
                    <button
                      type="button"
                      className={MODEL_CHIP_X}
                      title={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setModels((prev) => prev.filter((_, idx) => idx !== i))
                      }}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className={MODEL_ADD_ROW}>
              <Input
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                className="flex-1"
                placeholder={t('settings.cfg.modelPlaceholder')}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addModel()
                  }
                }}
                onPaste={onModelPaste}
              />
              <Button size="sm" disabled={!modelInput.trim()} onClick={addModel}>
                {t('common.add')}
              </Button>
            </div>
            <span className="text-micro leading-[1.5] text-content-subtle">{t('settings.cfg.modelsHint')}</span>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">服务参数（JSON）</span>
            <Textarea aria-label="服务参数（JSON）" value={serviceOptions} onChange={event => { setServiceOptions(event.target.value); setServiceOptionsError(null) }} rows={form.watch('provider') === 'comfyui' ? 8 : 3} resize="vertical" className="font-mono text-xs" placeholder={form.watch('provider') === 'comfyui' ? '{"workflow_json": {}, "prompt_node": "6", "image_node": "10"}' : '{}'} spellCheck={false} />
            <span className="text-micro leading-relaxed text-content-subtle">{form.watch('provider') === 'comfyui' ? '填入 ComfyUI 的 API 格式工作流 workflow_json，并指定需要替换输入的 prompt_node、image_node 等节点编号。制作时使用此工作流，已有配置会保留并恢复这些参数。' : '可选。填写服务所需的专用参数；留空表示使用默认参数。'}</span>
          </label>
          {serviceOptionsError && <p role="alert" className="text-xs text-danger">{serviceOptionsError}</p>}
          {dialogType === 'text' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-[550] text-content-secondary">
                Temperature <span className="text-content-subtle">({t('settings.cfg.tempHint')})</span>
              </span>
              <Input {...form.register('temperature')} type="number" step="0.1" min={0} max={2} placeholder={t('settings.cfg.tempPlaceholder')} />
              <span className="text-micro leading-[1.5] text-content-subtle">{t('settings.cfg.tempNote')}</span>
            </label>
          )}
          {testResult && (
            <div className={cn(TEST_RESULT_BASE, testResult.checked === 'configuration' ? 'border-outline bg-elevated' : testResult.reachable ? TEST_RESULT_OK : TEST_RESULT_BAD)}>
              <div className={TEST_RESULT_HEAD}>
                <Badge tone={testResult.checked === 'configuration' ? 'brand' : testResult.reachable ? 'success' : 'error'}>{testResult.checked === 'configuration' ? '配置检查' : testResult.status || 'ERROR'}</Badge>
                <span>{testResult.message}</span>
              </div>
              <div className={TEST_RESULT_META}>{testResult.method} {testResult.url}</div>
              {testResult.responsePreview && (
                <div className={TEST_RESULT_META}>{testResult.responsePreview}</div>
              )}
            </div>
          )}
        </form>
      </Modal>
    </div>
  )
}
