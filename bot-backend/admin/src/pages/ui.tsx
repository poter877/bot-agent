import { useState, type ReactNode } from 'react'

/** 极简暗色组件集（Tailwind 4）— 后台页面的统一视觉语言。 */

export const btn =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-[13px] text-content transition hover:border-brand/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-40'
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-brand-strong bg-brand-strong px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40'
export const btnDanger =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-900/70 bg-transparent px-3 py-1.5 text-[13px] text-red-300 transition hover:bg-red-950/40 disabled:opacity-40'
export const input =
  'w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-[13px] text-content outline-none transition placeholder:text-content-subtle focus:border-brand'
export const card = 'rounded-xl border border-line bg-ink-900/70 p-5'
export const th = 'px-3 py-2 text-left text-[12px] font-semibold text-content-muted whitespace-nowrap'
export const td = 'px-3 py-2.5 text-[13px] align-top'

export function Card(props: { title?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-ink-900/70 ${props.className ?? ''}`}>
      {(props.title || props.actions) && (
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-content">{props.title}</h2>
          {props.actions}
        </header>
      )}
      <div className="p-5">{props.children}</div>
    </section>
  )
}

export function Badge(props: { tone: 'ok' | 'bad' | 'off' | 'warn'; children: ReactNode }) {
  const tones = {
    ok: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    bad: 'bg-red-500/10 text-red-300 border-red-500/30',
    off: 'bg-white/5 text-content-muted border-line',
    warn: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  } as const
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 ${tones[props.tone]}`}>
      {props.children}
    </span>
  )
}

export function Banner(props: { kind: 'ok' | 'err'; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={
        props.kind === 'ok'
          ? 'rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-[13px] text-emerald-300'
          : 'rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300'
      }
    >
      {props.children}
    </div>
  )
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-content-muted">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-[11px] text-content-subtle">{props.hint}</span>}
    </label>
  )
}

export function Stat(props: { label: string; value: ReactNode; sub?: string; ok?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-ink-900/70 px-5 py-4">
      <div className="text-[12px] text-content-muted">{props.label}</div>
      <div className="mt-1 text-[24px] font-semibold leading-7">{props.value}</div>
      {props.sub && <div className={`mt-0.5 text-[11.5px] ${props.ok === false ? 'text-red-300' : 'text-content-subtle'}`}>{props.sub}</div>}
    </div>
  )
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16 text-content-subtle">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand" />
    </div>
  )
}

/** 可搜索的下拉选择：输入即过滤，点击候选项回填；也允许直接使用手输值。 */
export function Combobox(props: {
  value: string
  onChange: (value: string) => void
  onPick?: (value: string) => void
  options: Array<{ value: string; label: string }>
  placeholder?: string
  required?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const query = (draft ?? props.value ?? '').toLowerCase()
  const filtered = query
    ? props.options.filter((o) => o.value.toLowerCase().includes(query) || o.label.toLowerCase().includes(query))
    : props.options
  return (
    <div className="relative">
      <input
        className={input}
        autoComplete="off"
        required={props.required}
        value={draft ?? props.value}
        placeholder={props.placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setDraft(e.target.value)
          props.onChange(e.target.value)
        }}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => { setOpen(false); setDraft(null) }} />
          <div className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-ink-850 py-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
            {filtered.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] transition hover:bg-brand/10 ${o.value === props.value ? 'text-brand' : 'text-content'}`}
                onClick={() => {
                  props.onChange(o.value)
                  props.onPick?.(o.value)
                  setOpen(false)
                  setDraft(null)
                }}
              >
                <span className="truncate">{o.label}</span>
                <span className="text-[11px] text-content-subtle">{o.value}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-content-subtle">无匹配项 — 可直接使用手输值</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
