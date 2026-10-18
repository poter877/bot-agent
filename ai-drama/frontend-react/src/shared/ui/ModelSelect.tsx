/**
 * ModelSelect — AI 模型选择器：默认项=首选项、按模型名显示厂商图标、
 * 同名模型来自不同配置时显示配置名区分（configId:model 键）。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { AppMenu } from './AppMenu'
import { AppMenuItem } from './AppMenuItem'
import { modelIconUrl } from '@/shared/lib/provider-icons'
import { useTheme } from '@/shared/config/theme'
import { cn } from '@/shared/lib/cn'

export interface ModelOption {
  /** 选择值；'' 未用（defaultLabel 项用空串） */
  key: string
  model: string
  provider: string
  configId?: number
  configName?: string
}

interface ModelSelectProps {
  label: string
  value: string
  onChange: (value: string) => void
  options: ModelOption[]
  defaultLabel?: string
  hideDefault?: boolean
  disabled?: boolean
}

/** 同名模型来自不同配置时，显示名带配置名以示区分（文档 §12.2） */
function optionLabelOf(option: ModelOption, options: ModelOption[]): string {
  const duplicated = options.filter((o) => o.model === option.model).length > 1
  return duplicated && option.configName ? `${option.model} · ${option.configName}` : option.model
}

export function ModelSelect({ label, value, onChange, options, defaultLabel, hideDefault, disabled }: ModelSelectProps) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const [isOpen, setIsOpen] = useState(false)

  const effectiveDefaultLabel = defaultLabel || t('common.default')
  const currentOption = options.find((o) => o.key === value) ?? null
  const currentLabel = currentOption ? optionLabelOf(currentOption, options) : effectiveDefaultLabel
  // 默认 = 首个选项；未显式选模型时也展示默认模型的厂商图标（网关 provider=openai
  // 但模型实为 deepseek 等场景，图标按模型名推断优先），回退 provider
  const defaultIcon = modelIconUrl(options[0]?.provider, options[0]?.model, resolvedTheme)
  const triggerIcon = currentOption
    ? modelIconUrl(currentOption.provider, currentOption.model, resolvedTheme)
    : defaultIcon

  function pick(key: string) {
    onChange(key)
    setIsOpen(false)
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-micro font-semibold text-content-subtle">{label}</span>
      <AppMenu open={isOpen} onOpenChange={setIsOpen} minWidth={280}
        trigger={({ open }) => (
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'flex h-[26px] max-w-[210px] cursor-pointer items-center gap-1.5 rounded-full border border-outline-strong bg-input pr-2 pl-2.5 font-ui text-micro text-content-secondary transition-[border-color,box-shadow,background] duration-150 hover:border-outline-hover',
              (open || undefined) && 'border-brand shadow-[0_0_0_3px_var(--hb-focus-ring)]',
            )}
          >
            {triggerIcon && <img src={triggerIcon} className="size-3.5 shrink-0 rounded-[2.5px] object-contain" alt="" />}
            {!triggerIcon && currentOption?.provider && (
              <span className="shrink-0 rounded bg-brand-soft px-[5px] py-px text-[9px] font-semibold tracking-[0.02em] text-brand-content uppercase">
                {currentOption.provider}
              </span>
            )}
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{currentLabel}</span>
            <ChevronDown size={11} className={cn('shrink-0 text-content-subtle transition-transform duration-150 ease-app', open && 'rotate-180')} />
          </button>
        )}
      >
        {!hideDefault && (
          <AppMenuItem selected={value === ''} onClick={() => pick('')}>
            {defaultIcon && <img src={defaultIcon} className="size-3 shrink-0 rounded-[2.5px] object-contain" alt="" />}
            <span className="text-content-subtle">{effectiveDefaultLabel}</span>
          </AppMenuItem>
        )}
        {options.map((o) => (
          <AppMenuItem
            key={o.key}
            selected={value === o.key}
            title={`${o.model}${o.configName ? ` · ${o.configName}` : ''}`}
            onClick={() => pick(o.key)}
            trailing={(() => {
              const icon = modelIconUrl(o.provider, o.model, resolvedTheme)
              return icon ? <img src={icon} className="size-3 shrink-0 rounded-[2.5px] object-contain" alt="" /> : null
            })()}
          >
            <span className="max-w-80 overflow-hidden text-ellipsis whitespace-nowrap">{optionLabelOf(o, options)}</span>
          </AppMenuItem>
        ))}
      </AppMenu>
    </div>
  )
}
