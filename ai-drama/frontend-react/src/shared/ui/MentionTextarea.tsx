/**
 * MentionTextarea — @引用文本域。
 *
 * 样式已迁移 Tailwind（MentionTextarea.module.css 已删除）。
 * - 镜像层与输入框共享外部 inputClassName（field 等 utility 串），经 cn() 合并
 *   保证排版一致；镜像层自身只做透明背景/边框 + 事件穿透，不再有独立盒模型样式
 * - 高亮 token 直接在渲染节点上使用静态 Tailwind 类（无哈希失配问题）：
 *   role=品牌橙、scene=绿色（道具走 role 色，与旧 :deep 规则一致）
 * - 键盘导航含 IME 组合保护；整体删除 @引用；滚动同步；上下翻转
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { MapPin, Package, User } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

export interface MentionOption {
  /** 插入的 @引用名 */
  value: string
  /** 显示名 */
  label: string
  /** 'character' | 'scene' | 'prop' */
  kind?: string
  /** 下拉分组文案 */
  group?: string
  image?: string
}

interface MentionTextareaProps {
  value: string
  onChange: (value: string) => void
  /** 输入稳定后回调（失焦/插入引用），供外部自动保存语义使用 */
  onCommit?: (value: string) => void
  options: MentionOption[]
  rows?: number
  placeholder?: string
  inputClassName?: string
  name?: string
  'aria-label'?: string
}

interface MentionState {
  open: boolean
  start: number
  query: string
  top: number
  left: number
  above: boolean
}

const CLOSED: MentionState = { open: false, start: 0, query: '', top: 0, left: 0, above: false }
const DROPDOWN_WIDTH = 240
const DROPDOWN_MAX_HEIGHT = 220

/** 高亮 token 静态类（完整字符串供 Tailwind 扫描）；道具沿用 role 色，与旧规则一致 */
const TOKEN_CLASS = {
  role: 'rounded-[4px] bg-brand-soft font-semibold text-brand-content',
  scene: 'rounded-[4px] bg-success-soft font-semibold text-tag-success',
} as const

/** 无图资产在下拉中显示分组图标兜底（场景=定位、道具=包裹、角色=人物） */
function groupIcon(kind: string | undefined) {
  return kind === 'scene' ? MapPin : kind === 'prop' ? Package : User
}

function groupClass(kind: string | undefined): keyof typeof TOKEN_CLASS {
  return kind === 'scene' ? 'scene' : 'role'
}

/** 可引用名（按长度降序，最长匹配优先）及其分组（kind code 判断） */
function mentionNamesOf(options: MentionOption[]): [string, string][] {
  const seen = new Map<string, string>()
  for (const o of options) {
    if (o.value && !seen.has(o.value)) seen.set(o.value, o.kind === 'scene' ? 'scene' : 'role')
  }
  return [...seen.entries()].sort((a, b) => b[0].length - a[0].length)
}

/** 镜像层渲染节点：@引用 包上分组色彩 span，其余文本原样（React 节点，无 HTML 注入） */
export function renderHighlight(text: string, names: [string, string][]): ReactNode {
  if (!names.length || !text) return text
  const alt = names.map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`@(${alt})`, 'g')
  const nodes: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const name = m[1]!
    const group = (names.find(([n]) => n === name)?.[1] ?? 'role') as keyof typeof TOKEN_CLASS
    nodes.push(
      <span key={`${m.index}-${name}`} className={TOKEN_CLASS[group]}>
        @{name}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** 镜像 div 测量 textarea 光标坐标 */
function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number) {
  const div = document.createElement('div')
  const style = getComputedStyle(textarea)
  const propsToCopy = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textIndent',
  ] as const
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.top = '0'
  div.style.left = '-9999px'
  for (const p of propsToCopy) div.style[p] = style[p]
  div.textContent = textarea.value.substring(0, position)
  const span = document.createElement('span')
  span.textContent = textarea.value.substring(position) || '.'
  div.appendChild(span)
  document.body.appendChild(div)
  const rect = { top: span.offsetTop, left: span.offsetLeft }
  document.body.removeChild(div)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.7 || 20
  return { ...rect, lineHeight }
}

export function MentionTextarea({
  value,
  onChange,
  onCommit,
  options,
  rows = 4,
  placeholder,
  inputClassName,
  name,
  'aria-label': ariaLabel,
}: MentionTextareaProps) {
  const { t } = useTranslation()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const [mention, setMention] = useState<MentionState>(CLOSED)
  const [highlightIdx, setHighlightIdx] = useState(0)

  const names = useMemo(() => mentionNamesOf(options), [options])

  // 键盘上下移动高亮时，让高亮项自动滚动进下拉可视区
  useEffect(() => {
    dropdownRef.current
      ?.querySelector('[data-mention-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx])

  // 下拉 Portal 到 body 后用 fixed 定位，任何外层滚动/窗口变化都会使其错位 → 直接关闭
  useEffect(() => {
    const closeOnOuterScroll = (e: Event) => {
      // 候选列表自身的滚动（含键盘导航的 scrollIntoView）不改变锚点位置。
      if (e.target === taRef.current || (e.target instanceof Node && dropdownRef.current?.contains(e.target))) return
      setMention((s) => (s.open ? CLOSED : s))
    }
    window.addEventListener('scroll', closeOnOuterScroll, true)
    window.addEventListener('resize', closeOnOuterScroll)
    return () => {
      window.removeEventListener('scroll', closeOnOuterScroll, true)
      window.removeEventListener('resize', closeOnOuterScroll)
    }
  }, [])

  const closeMention = useCallback(() => setMention((s) => (s.open ? CLOSED : s)), [])

  // 下拉候选（按 group 分组；过滤 value/label）
  const filtered = useMemo(() => {
    const q = mention.query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.value.toLowerCase().includes(q) || (o.label || '').toLowerCase().includes(q),
    )
  }, [options, mention.query])

  const grouped = useMemo(() => {
    const groups: { group: string; options: MentionOption[] }[] = []
    for (const opt of filtered) {
      const name = opt.group || t('components.mention.fallbackGroup')
      const g = groups.find((item) => item.group === name)
      if (g) g.options.push(opt)
      else groups.push({ group: name, options: [opt] })
    }
    return groups
  }, [filtered, t])

  const flatList = useMemo(() => grouped.flatMap((g) => g.options), [grouped])

  const mentionStyle: CSSProperties = mention.above
    ? { left: `${mention.left}px`, bottom: `${window.innerHeight - mention.top}px` }
    : { left: `${mention.left}px`, top: `${mention.top}px` }

  const updateMentionState = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const pos = ta.selectionStart
    const before = ta.value.slice(0, pos)
    const m = before.match(/@([^\s@]{0,20})$/)
    if (!m) {
      setMention(CLOSED)
      return
    }
    const query = m[1]!
    // @后文本已精确等于某个完整引用名时不再弹列表（如删除引用尾部空格后）
    if (names.some(([name]) => name === query)) {
      setMention(CLOSED)
      return
    }
    const caret = getCaretCoordinates(ta, pos)
    const rect = ta.getBoundingClientRect()
    const maxLeft = Math.max(0, (wrapRef.current?.clientWidth || DROPDOWN_WIDTH) - DROPDOWN_WIDTH)
    const belowTop = rect.top + caret.top + caret.lineHeight - ta.scrollTop + 4
    const above = belowTop + DROPDOWN_MAX_HEIGHT > window.innerHeight - 8 && caret.top > DROPDOWN_MAX_HEIGHT
    setMention({
      open: true,
      start: pos - m[0].length,
      query,
      top: above ? rect.top + caret.top - ta.scrollTop - 4 : belowTop,
      left: rect.left + Math.min(caret.left, maxLeft),
      above,
    })
    setHighlightIdx(0)
  }, [names])

  const setText = useCallback(
    (next: string, caret?: number) => {
      const ta = taRef.current
      if (ta) {
        ta.value = next
        ta.focus()
        if (caret != null) ta.setSelectionRange(caret, caret)
      }
      closeMention()
      onChange(next)
      onCommit?.(next)
    },
    [closeMention, onChange, onCommit],
  )

  function pick(opt: MentionOption) {
    const ta = taRef.current
    if (!ta) return
    const pos = ta.selectionStart
    const before = ta.value.slice(0, mention.start)
    const after = ta.value.slice(pos)
    const insert = `@${opt.value} `
    setText(before + insert + after, before.length + insert.length)
  }

  // @引用整体删除：光标在完整引用后按退格 / 在完整引用前按 Delete
  const mentionAdjacent = useCallback(
    (dir: 'before' | 'after') => {
      const ta = taRef.current
      if (!ta) return null
      const pos = ta.selectionStart
      const text = ta.value
      if (dir === 'before') {
        const before = text.slice(0, pos)
        for (const [name] of names) {
          if (before.endsWith(`@${name}`)) return { start: pos - name.length - 1, end: pos }
        }
      } else {
        const after = text.slice(pos)
        for (const [name] of names) {
          if (after.startsWith(`@${name}`)) return { start: pos, end: pos + name.length + 1 }
        }
      }
      return null
    },
    [names],
  )

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value)
    updateMentionState()
  }

  function onScroll() {
    if (backdropRef.current && taRef.current) {
      backdropRef.current.scrollTop = taRef.current.scrollTop
      backdropRef.current.scrollLeft = taRef.current.scrollLeft
    }
    closeMention()
  }

  function onBlur(e: React.FocusEvent<HTMLTextAreaElement>) {
    closeMention()
    onCommit?.(e.target.value)
  }

  function onKeydown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = taRef.current
    // IME 组合输入中不拦截任何键（中文输入法的 Enter=确认候选）
    if (e.nativeEvent.isComposing) return
    if (ta && (e.key === 'Backspace' || e.key === 'Delete') && ta.selectionStart === ta.selectionEnd) {
      const hit = mentionAdjacent(e.key === 'Backspace' ? 'before' : 'after')
      if (hit) {
        e.preventDefault()
        const next = ta.value.slice(0, hit.start) + ta.value.slice(hit.end)
        setText(next, hit.start)
        return
      }
    }
    if (!mention.open) return
    const total = flatList.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (total) setHighlightIdx((h) => (h + 1) % total)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (total) setHighlightIdx((h) => (h - 1 + total) % total)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (total) {
        e.preventDefault()
        pick(flatList[highlightIdx] ?? flatList[0]!)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeMention()
    }
  }

  const highlightNodes = renderHighlight(value, names)

  return (
    <div ref={wrapRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={backdropRef}
        aria-hidden="true"
        className={cn(inputClassName, 'pointer-events-none absolute inset-0 z-0 overflow-hidden border-transparent bg-transparent shadow-none')}
      >
        <div className="whitespace-pre-wrap [overflow-wrap:break-word] [word-wrap:break-word]">
          {highlightNodes}
          {typeof highlightNodes === 'string' && highlightNodes.endsWith('\n') ? '\u200b' : null}
        </div>
      </div>
      <textarea
        ref={taRef}
        name={name}
        aria-label={ariaLabel}
        className={cn(inputClassName, 'relative z-[1] min-h-0 w-full flex-1 resize-none bg-transparent text-transparent caret-content placeholder:text-content-subtle')}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={onInput}
        onKeyDown={onKeydown}
        onBlur={onBlur}
        onClick={closeMention}
        onScroll={onScroll}
      />
      {createPortal(
        mention.open ? (
          <div
            ref={dropdownRef}
            className="fixed z-[var(--hb-z-menu)] max-h-[220px] w-60 overflow-y-auto rounded-panel border border-outline bg-surface p-[5px] shadow-raised"
            style={mentionStyle}
          >
            {grouped.length > 0 ? (
              grouped.map((group, gi) => {
                let before = 0
                for (let i = 0; i < gi; i++) before += grouped[i]!.options.length
                return (
                  <div key={group.group}>
                    <div className="px-2 pt-1.5 pb-[3px] text-tiny font-semibold tracking-[0.02em] text-content-subtle">
                      {group.group}
                    </div>
                    {group.options.map((opt, oi) => {
                      const Icon = groupIcon(opt.kind)
                      const highlighted = before + oi === highlightIdx
                      return (
                        <button
                          key={`${group.group}-${opt.value}`}
                          type="button"
                          data-mention-highlighted={highlighted || undefined}
                          className={`flex w-full cursor-pointer items-center gap-2 rounded-item border-none bg-transparent px-2 py-[5px] text-left${
                            highlighted ? ' bg-brand-soft' : ''
                          }`}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            pick(opt)
                          }}
                          onMouseMove={() => setHighlightIdx(before + oi)}
                        >
                          <span
                            className={`flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-bold ${
                              groupClass(opt.kind) === 'scene'
                                ? 'bg-success-soft text-tag-success'
                                : 'bg-brand-soft text-brand-content'
                            }`}
                          >
                            {opt.image ? (
                              <img
                                src={opt.image}
                                alt=""
                                className="block size-full object-cover"
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none'
                                }}
                              />
                            ) : (
                              <Icon size={12} strokeWidth={2} />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-[550] text-content">
                            @{opt.label}
                          </span>
                          <span className="shrink-0 text-tiny text-content-subtle">{opt.group}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })
            ) : (
              <div className="p-2.5 text-center text-xs text-content-subtle">{t('components.mention.noMatch')}</div>
            )}
          </div>
        ) : null,
        document.body,
      )}
    </div>
  )
}
