/**
 * 工作台纯函数库：模型选项收集、分辨率档位、参考图序号映射、视频任务状态机等。
 * 工作台纯函数，配契约测试（模型/配置归属、参考上限与 @名字→@图片N 映射）。
 */
import type { Character, Prop, Scene } from '@/entities/asset/model'
import type { Storyboard } from '@/entities/storyboard/model'
import type { AiConfig } from '@/entities/ai-config/model'

// ===== 资产视图（Character/Scene/Prop 的统一只读访问器，供详情弹窗等使用） =====

export interface AssetView {
  kind: 'character' | 'scene' | 'prop'
  id: number
  /** 显示名：角色/道具名或场景地点 */
  name: string
  /** 副标签：角色 role / 场景 time / 道具 type */
  subLabel: string
  imageUrl: string
  finalPrompt: string
  updatedAt: string
  appearance: string
  styling: string
  /** 场景描述（scenes.prompt）或道具/角色描述 */
  description: string
  lighting: string
}

export function assetViewOf(kind: 'character' | 'scene' | 'prop', item: Character | Scene | Prop): AssetView {
  const base = { kind, id: item.id, imageUrl: item.imageUrl, finalPrompt: item.finalPrompt, updatedAt: item.updatedAt }
  if (kind === 'character') {
    const c = item as Character
    return {
      ...base,
      name: c.name,
      subLabel: c.role,
      appearance: c.appearance,
      styling: c.styling,
      description: c.description,
      lighting: '',
    }
  }
  if (kind === 'scene') {
    const s = item as Scene
    return {
      ...base,
      name: s.location,
      subLabel: s.time,
      appearance: '',
      styling: '',
      description: s.prompt,
      lighting: s.lighting,
    }
  }
  const p = item as Prop
  return {
    ...base,
    name: p.name,
    subLabel: p.type,
    appearance: '',
    styling: '',
    description: p.description,
    lighting: '',
  }
}

// ===== 媒体 =====

/** DB 存相对路径（static/...）；展示补前导斜杠，远程/绝对地址原样 */
export function assetImageSrcOf(imageUrl: string | null | undefined): string {
  const raw = imageUrl || ''
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

/** 分镜视频地址（snake/camel/composed 兼容；模型已归一为 camelCase） */
export function getVideoUrl(s: Storyboard | null | undefined): string | null {
  return s?.videoUrl || s?.composedVideoUrl || null
}

export function hasVid(s: Storyboard | null | undefined): boolean {
  return !!getVideoUrl(s)
}

// ===== 模型选项 =====

/** 配置的模型列表：API 可能返回数组或 JSON 字符串（历史形态在边界处理） */
export function configModels(cfg: Pick<AiConfig, 'models'> | null | undefined): string[] {
  return cfg?.models ?? []
}

export interface ModelOption {
  /**
   * 选择键：configId:model —— 旧版按 provider/model 去重会合并同厂商同模型的不同
   * 配置，迁移后改为可区分配置（文档 §12.2）；提交后端仍发裸 model + config_id。
   */
  key: string
  /** 旧版 'provider/model' 复合键，仅用于偏好迁移匹配 */
  legacyKey: string
  model: string
  provider: string
  configId: number
  configName: string
}

/** 汇总该类型全部启用配置的模型（按优先级排序；不同配置的同名模型分别保留） */
export function collectModelOptions(cfgs: AiConfig[]): ModelOption[] {
  const out: ModelOption[] = []
  const sorted = [...cfgs].filter((c) => c.isActive).sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const c of sorted) {
    for (const m of configModels(c)) {
      out.push({
        key: `${c.id}:${m}`,
        legacyKey: `${c.provider}/${m}`,
        model: m,
        provider: c.provider,
        configId: c.id,
        configName: c.name || c.provider,
      })
    }
  }
  return out
}

/** 复合键 → 裸模型名（后端适配器按厂商校验模型名，不能带 provider 前缀） */
export function bareModelName(key: string | undefined | null): string {
  if (!key) return ''
  const i = key.indexOf('/')
  return i >= 0 ? key.slice(i + 1) : key
}

export function ownerConfigId(options: ModelOption[], key: string | undefined | null): number | undefined {
  return key ? options.find((o) => o.key === key)?.configId || undefined : undefined
}

export function hasMultiConfigs(options: ModelOption[]): boolean {
  return new Set(options.map((o) => o.configId)).size > 1
}

/** 配置变化后校验持久化的模型是否仍存在：失效则升级旧键或回退默认。
 * 兼容三代存储形态：新 configId:model 键 → 旧 provider/model 复合键 → 裸模型名。 */
export function pruneStaleModel(stored: string, options: ModelOption[]): string {
  if (!stored || !options.length) return stored
  if (options.some((o) => o.key === stored)) return stored
  const legacy = options.find((o) => o.legacyKey === stored || o.model === stored)
  return legacy ? legacy.key : ''
}

// ===== 分辨率档位 =====

export const RESOLUTION_TIERS: Record<string, string[]> = {
  volcengine: ['480p', '720p'],
  minimax: ['720p', '1080p'],
  aliyun: ['480p', '720p', '1080p'],
}

export const RESOLUTION_DISPLAY: Record<string, Record<string, string>> = {
  volcengine: { '480p': '480p', '720p': '720p', '1080p': '720p' },
  minimax: { '480p': '768P', '720p': '768P', '1080p': '2K' },
  aliyun: { '480p': '480P', '720p': '720P', '1080p': '1080P' },
}

export function resolutionProviderOf(provider: string | undefined): string {
  return provider && RESOLUTION_TIERS[provider] ? provider : 'volcengine'
}

export function resolutionKeysFor(provider: string | undefined): string[] {
  return RESOLUTION_TIERS[resolutionProviderOf(provider)] ?? RESOLUTION_TIERS.volcengine!
}

export function resolutionShort(provider: string | undefined, key: string): string {
  const p = resolutionProviderOf(provider)
  return RESOLUTION_DISPLAY[p]?.[key] || key
}

// ===== 旁白角色 =====

/** 旁白角色识别：按内容语言的关键词匹配（旁白角色不参与画面生成） */
export function isNarratorCharacter(char: Pick<Character, 'name' | 'role'> | null | undefined): boolean {
  const text = `${char?.name || ''} ${char?.role || ''}`.toLowerCase()
  return ['旁白', '画外音', 'narrator', 'ナレーター', 'ナレーション', '내레이션', '해설'].some((k) => text.includes(k))
}

// ===== 分镜关联 =====

export function storyboardCharacterIds(sb: Storyboard | null | undefined): number[] {
  return sb?.characterIds ?? []
}

export function storyboardPropIds(sb: Storyboard | null | undefined): number[] {
  return sb?.propIds ?? []
}

export function storyboardScene(sb: Storyboard | null | undefined, scenes: Scene[]): Scene | null {
  const sceneId = sb?.sceneId
  if (!sceneId) return null
  return scenes.find((s) => s.id === sceneId) ?? null
}

// ===== 参考图（上限内按 场景→角色→道具 顺序收集，去重） =====

function imageUrlOf(a: Character | Scene | Prop): string {
  return a.imageUrl || ''
}

/** 分镜生成时提交的参考图列表（受 refImageLimit 上限约束） */
export function getShotReferenceImages(
  sb: Storyboard,
  chars: Character[],
  scenes: Scene[],
  props: Prop[],
  limit: number,
): string[] {
  const refs: string[] = []
  const pushRef = (value: string | null | undefined) => {
    if (!value || refs.includes(value) || refs.length >= limit) return
    refs.push(value)
  }
  const scene = storyboardScene(sb, scenes)
  if (scene) pushRef(imageUrlOf(scene))
  for (const char of chars) {
    if (storyboardCharacterIds(sb).includes(char.id)) pushRef(imageUrlOf(char))
  }
  for (const prop of props) {
    if (storyboardPropIds(sb).includes(prop.id)) pushRef(imageUrlOf(prop))
  }
  return refs
}

/**
 * 按参考图顺序（场景图在前、角色居中、道具在后）为 @名字 建立序号映射（1 起）。
 * 同名取首个；无图素材不占序号。
 */
export function getShotReferenceIndexMap(
  sb: Storyboard,
  chars: Character[],
  scenes: Scene[],
  props: Prop[],
  limit: number,
): Record<string, number> {
  const ordered: { name: string; imageUrl: string }[] = []
  const seen = new Set<string>()
  const push = (name: string, url: string | null | undefined) => {
    if (!url || seen.has(url) || ordered.length >= limit) return
    seen.add(url)
    ordered.push({ name, imageUrl: url })
  }
  const scene = storyboardScene(sb, scenes)
  if (scene) push(scene.location || '', imageUrlOf(scene))
  for (const char of chars) {
    if (storyboardCharacterIds(sb).includes(char.id)) push(char.name || '', imageUrlOf(char))
  }
  for (const prop of props) {
    if (storyboardPropIds(sb).includes(prop.id)) push(prop.name || '', imageUrlOf(prop))
  }
  const nameToIndex: Record<string, number> = {}
  ordered.forEach((a, i) => {
    if (a.name && !(a.name in nameToIndex)) nameToIndex[a.name] = i + 1
  })
  return nameToIndex
}

/** 将视频提示词里的 @名字 替换为 @图片N名字（N 为参考图序号），生成时使用 */
export function resolveVideoPromptRefs(
  sb: Storyboard,
  chars: Character[],
  scenes: Scene[],
  props: Prop[],
  limit: number,
): string {
  const prompt = sb.videoPrompt || ''
  const map = getShotReferenceIndexMap(sb, chars, scenes, props, limit)
  const names = Object.keys(map).sort((a, b) => b.length - a.length)
  if (!names.length) return prompt
  return prompt.replace(/@([^\s@]+)/g, (m, raw: string) => {
    for (const name of names) {
      if (raw.startsWith(name)) {
        return `@图片${map[name]}${name}${raw.slice(name.length)}`
      }
    }
    return m
  })
}

// ===== 视频任务状态机（派生自聚合任务数据） =====

export type VideoTaskState = 'done' | 'pending' | 'failed' | 'ready'

export function videoTaskStateOf(
  sb: Storyboard | null | undefined,
  isPending: (id: number) => boolean,
  failMessage: (id: number) => string,
): VideoTaskState {
  if (hasVid(sb)) return 'done'
  if (sb && isPending(sb.id)) return 'pending'
  if (sb && failMessage(sb.id)) return 'failed'
  return 'ready'
}

// ===== 任务历史 =====

/** /tasks 返回 camelCase；/episodes/:id/generation-tasks 返回 snake_case（已统一映射为 camel） */
export function taskVideoPath(t: { localPath?: string; resultUrl?: string } | null | undefined): string {
  return t?.localPath || t?.resultUrl || ''
}

export function taskCreatedAt(t: { createdAt?: string } | null | undefined): string {
  return t?.createdAt || ''
}

export function formatHistoryTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 站内相对路径补 '/'，远端 URL 原样 */
export function mediaSrcOf(url: string): string {
  if (!url) return ''
  return /^https?:\/\//.test(url) ? url : `/${url}`
}

/** 三栏拖拽宽度钳制 */
export const VIDEO_COL_DEFAULTS = { left: 236, right: 340 }
export const VIDEO_COL_LIMITS = { left: [180, 420] as const, right: [260, 560] as const }

export function clampVideoCol(which: 'left' | 'right', w: number): number {
  const [min, max] = VIDEO_COL_LIMITS[which]
  return Math.min(max, Math.max(min, Math.round(w)))
}

/** 提交受理与 Agent 提交的中文功能性提示词（后端按内容语言指令控制产出语言，不随 UI 语言变化） */
export function breakdownMessage(ctx: {
  chars: Character[]
  scenes: Scene[]
  props: Prop[]
  videoModelLabel: string
}): string {
  const charList = ctx.chars.length ? ctx.chars.map((c) => `${c.name}(ID:${c.id})`).join('、') : '（当前集还没有角色）'
  const sceneList = ctx.scenes.length
    ? ctx.scenes.map((s) => `${s.location} · ${s.time || '未设时间'}(ID:${s.id})`).join('、')
    : '（当前集还没有场景）'
  const propList = ctx.props.length ? ctx.props.map((p) => `${p.name}(ID:${p.id})`).join('、') : '（当前集还没有道具）'
  return `请基于当前集剧本拆分分镜，并为每个分镜段落同时生成 video_prompt（视频生成提示词）。
本次视频模型：${ctx.videoModelLabel}，请按该模型的特性与时长限制生成 video_prompt。

当前集已有角色：${charList}
当前集已有场景：${sceneList}
当前集已有道具：${propList}

绑定要求：
- 每个镜头必须根据剧本内容，从上述当前集已有角色中选出出场的角色绑定 character_ids（ID 必须来自上述列表；有角色出场就必须绑定，不要遗漏）
- 每个镜头尽量匹配上述已有场景填写 scene_id（ID 必须来自上述列表），不要凭空创造新场景
- 每个镜头出现关键道具（被使用、交接、特写或在画面中明显可见）时，从上述当前集已有道具中绑定 prop_ids（ID 必须来自上述列表）；没有道具出现可传空数组
- 只有纯环境空镜头才可以不绑定角色`
}

export function videoPromptMessage(ctx: {
  idx: number
  sbId: number
  duration: number
  sceneName: string
  charNames: string
  propNames: string
  videoModelLabel: string
}): string {
  return `请为分镜 #${ctx.idx}(ID:${ctx.sbId})生成视频提示词(video_prompt)。视频模型:${ctx.videoModelLabel},请根据该模型的特性和时长限制生成。

该分镜信息:时长 ${ctx.duration}s;场景:${ctx.sceneName || '未绑定'};角色:${ctx.charNames};道具:${ctx.propNames}。

请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长,据此生成 video_prompt(按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；段落内允许多镜头切镜,但不跨场景,切镜点对齐 description 的【镜头N】结构),然后调用 update_storyboard 保存到分镜 ID:${ctx.sbId}。只更新 video_prompt 字段,不要改动其他字段,不要重新拆分整集。`
}
