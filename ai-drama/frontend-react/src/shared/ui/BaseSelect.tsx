/**
 * BaseSelect — 可搜索下拉（支持扁平/分组选项）。
 * 简单下拉（searchable=false）与搜索型下拉共用本组件，受控 value/onChange。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Search } from 'lucide-react'
import { AppMenu } from './AppMenu'
import { cn } from '@/shared/lib/cn'

export interface SelectOption {
  label: string
  value: string | number
  group?: string
}

export interface SelectGroup {
  label: string
  options: SelectOption[]
}

export type SelectOptions = SelectOption[] | SelectGroup[]

interface BaseSelectProps {
  value: string | number
  onChange: (value: string) => void
  options: SelectOptions
  placeholder?: string
  searchable?: boolean
  disabled?: boolean
}

function isGrouped(options: SelectOptions): options is SelectGroup[] {
  return options.length > 0 && 'options' in options[0]
}

function normalize(options: SelectOptions): SelectGroup[] {
  if (!options.length) return []
  if (isGrouped(options)) {
    return options.map((g) => ({ label: g.label || '', options: g.options }))
  }
  const map = new Map<string, SelectOption[]>()
  for (const o of options) {
    const label = o.group || ''
    if (!map.has(label)) map.set(label, [])
    map.get(label)!.push(o)
  }
  return Array.from(map.entries()).map(([label, opts]) => ({ label, options: opts }))
}

export function BaseSelect({ value, onChange, options, placeholder, searchable = true, disabled }: BaseSelectProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(-1)

  const groups = useMemo(() => normalize(options), [options])

  const filteredGroups = useMemo(() => {
    if (!query) return groups
    const q = query.toLowerCase()
    return groups
      .map((g) => ({ label: g.label, options: g.options.filter((o) => o.label.toLowerCase().includes(q)) }))
      .filter((g) => g.options.length > 0)
  }, [groups, query])

  const flatOptions = useMemo(() => filteredGroups.flatMap((g) => g.options), [filteredGroups])

  const selectedLabel = useMemo(() => {
    for (const g of groups) {
      const found = g.options.find((o) => o.value === value)
      if (found) return found.label
    }
    return ''
  }, [groups, value])

  function onOpenChange(open: boolean) {
    if (open) {
      setHighlighted(groups.flatMap((group) => group.options).findIndex((option) => option.value === value))
      setQuery('')
    }
    setIsOpen(open)
  }

  function pick(opt: SelectOption) {
    onChange(String(opt.value))
    setIsOpen(false)
  }

  function onSearchKeydown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, flatOptions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = flatOptions[highlighted]
      if (opt) pick(opt)
    }
  }

  return (
    <div className="flex w-full min-w-0">
      <AppMenu open={isOpen} onOpenChange={onOpenChange} block matchWidth minWidth={132} maxHeight={380}
        trigger={({ open }) => (
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex min-h-9 w-full min-w-0 shrink-0 cursor-pointer items-center justify-between gap-1.5 rounded-pill border border-transparent bg-button py-0 pr-[30px] pl-3 font-ui text-xs font-semibold whitespace-nowrap text-button-content shadow-item transition-all duration-150 ease-app hover:bg-button-hover hover:text-button-content hover:shadow-item focus-visible:border-brand focus-visible:shadow-[0_0_0_3px_var(--hb-focus-ring)] focus-visible:outline-none',
              open && 'border-brand bg-button-hover shadow-[0_0_0_3px_var(--hb-focus-ring)]',
            )}
          >
            <span className={cn('min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left', !selectedLabel && 'font-light text-content-subtle')}>
              {selectedLabel || placeholder || t('components.baseSelect.placeholder')}
            </span>
            <ChevronDown size={13} className={cn('ml-auto shrink-0 text-content-muted transition-transform duration-200 ease-app', open && 'rotate-180')} />
          </button>
        )}
      >
        {searchable && (
          <div className="mt-[-5px] mb-0 flex items-center gap-2 rounded-t-panel border-b border-outline px-3 py-2 text-content-muted">
            <Search size={12} />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlighted(0) }}
              onKeyDown={onSearchKeydown}
              className="min-w-0 flex-1 border-none bg-transparent font-ui text-[13px] text-content outline-none placeholder:text-content-subtle"
              placeholder={t('components.baseSelect.search')}
            />
          </div>
        )}
        <div className="max-h-[260px] overflow-y-auto">
          {flatOptions.length > 0 ? (
            filteredGroups.map((group, gi) => {
              let before = 0
              for (let i = 0; i < gi; i++) before += filteredGroups[i]!.options.length
              return (
                <div key={`${group.label}-${gi}`}>
                  {group.label && <div className="px-2.5 pt-1.5 pb-[3px] text-tiny font-bold uppercase tracking-[0.08em] text-content-subtle">{group.label}</div>}
                  {group.options.map((opt, oi) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="menuitem"
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-1.5 rounded-item border-none bg-transparent px-2.5 py-[7px] text-left font-ui text-[12.5px] font-medium leading-[1.5] text-content-secondary transition-[background,color] duration-100 ease-app hover:bg-hover-overlay hover:text-content',
                        opt.value === value && 'font-semibold text-content',
                        before + oi === highlighted && 'bg-hover-overlay text-content',
                      )}
                      onClick={() => pick(opt)}
                      onMouseMove={() => setHighlighted(before + oi)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )
            })
          ) : (
            <div className="px-3 py-4 text-center text-[13px] text-content-subtle">{t('components.baseSelect.noMatch')}</div>
          )}
        </div>
      </AppMenu>
    </div>
  )
}
