import { useId, useRef, type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/cn'

export const panelClass = 'min-w-0 rounded-panel border border-outline bg-surface p-5 max-sm:p-4'
export const headingClass = 'font-display text-[16px] font-bold text-content'
export const hintClass = 'text-xs leading-relaxed text-content-muted'

export function CreativeField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex min-w-0 flex-col gap-1.5">
    <span className="text-xs font-semibold text-content-secondary">{label}</span>
    {children}
    {hint && <span className={hintClass}>{hint}</span>}
  </label>
}

export function CreativeSection({ title, hint, action, children, className }: { title: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn(panelClass, className)}>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><h2 className={headingClass}>{title}</h2>{hint && <p className={cn(hintClass, 'mt-1.5')}>{hint}</p>}</div>
      {action}
    </div>
    {children}
  </section>
}

export function MediaUpload({ accept, label, disabled, loading, onFile }: { accept: string; label: string; disabled?: boolean; loading?: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  return <>
    <input ref={inputRef} id={id} aria-label={label} className="sr-only" tabIndex={-1} type="file" accept={accept} disabled={disabled || loading} onChange={(event) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file) onFile(file)
    }} />
    <Button size="sm" disabled={disabled} loading={loading} onClick={() => inputRef.current?.click()}>
      <Upload size={13} aria-hidden />{label}
    </Button>
  </>
}
