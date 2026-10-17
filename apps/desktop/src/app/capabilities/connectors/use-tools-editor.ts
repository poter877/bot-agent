import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  editorCounts,
  expandQuickAction,
  facetTools,
  isUntouchedByQuickActions,
  matchingQuickAction,
  quickActionById,
  sameSet
} from './derive-tools'
import type { QuickAction, QuickActionId, ToolRowModel, ToolsEditorCounts, ToolsEditorPhase, ToolsEditorStatus } from './types'

export type SaveResult = 'failed' | 'saved'

export interface UseToolsEditorOptions {
  editorKey?: string
  onSave: (disabled: string[]) => Promise<SaveResult>
  savedDisabled: readonly string[]
  status?: ToolsEditorStatus | null
  tools: readonly ToolRowModel[]
}

export interface ToolsEditor {
  applyQuickAction: (id: QuickActionId) => void
  counts: ToolsEditorCounts
  currentAction: QuickAction | null
  dirty: boolean
  discard: () => void
  isOn: (slug: string) => boolean
  local: string[]
  phase: ToolsEditorPhase
  save: () => Promise<SaveResult>
  toggle: (slug: string) => void
  toggleFacet: (facet: string, on: boolean) => void
}

export function useToolsEditor({ editorKey, onSave, savedDisabled, status, tools }: UseToolsEditorOptions): ToolsEditor {
  const [local, setLocal] = useState<string[]>([...savedDisabled])
  const [baseline, setBaseline] = useState<string[]>([...savedDisabled])
  const [editing, setEditing] = useState<'ready' | 'saving'>('ready')
  const [pressed, setPressed] = useState<QuickActionId | null>(null)

  const savedKey = `${editorKey ?? ''}\u0000${[...savedDisabled].sort().join('\u0000')}`

  useEffect(() => {
    setLocal([...savedDisabled])
    setBaseline([...savedDisabled])
    setEditing('ready')
    setPressed(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])

  const byslug = useMemo(() => new Map(tools.map(tool => [tool.slug, tool])), [tools])
  const disabledSet = useMemo(() => new Set(local), [local])
  const dirty = !sameSet(local, baseline)
  const counts = useMemo(() => editorCounts(local, baseline), [local, baseline])
  const currentAction = useMemo(() => matchingQuickAction(local, tools, pressed), [local, tools, pressed])

  const toggle = useCallback(
    (slug: string) => {
      setPressed(null)
      setLocal(previous => (previous.includes(slug) ? previous.filter(s => s !== slug) : [...previous, slug]))
    },
    []
  )

  const toggleFacet = useCallback(
    (facet: string, on: boolean) => {
      const slugs = facetTools(tools, facet)

      setPressed(null)
      setLocal(previous => {
        const without = previous.filter(slug => !slugs.includes(slug))

        return on ? without : [...without, ...slugs]
      })
    },
    [tools]
  )

  const applyQuickAction = useCallback(
    (id: QuickActionId) => {
      const action = quickActionById(id)

      setPressed(id)
      setLocal(previous => {
        const kept = previous.filter(slug => {
          const tool = byslug.get(slug)

          return tool !== undefined && isUntouchedByQuickActions(tool)
        })

        return [...new Set([...kept, ...expandQuickAction(action, tools)])]
      })
    },
    [byslug, tools]
  )

  const discard = useCallback(() => {
    setLocal(baseline)
    setEditing('ready')
    setPressed(null)
  }, [baseline])

  const save = useCallback(async () => {
    setEditing('saving')

    const result = await onSave(local)

    if (result === 'saved') {
      setBaseline(local)
    }

    setEditing('ready')

    return result
  }, [local, onSave])

  const isOn = useCallback((slug: string) => !disabledSet.has(slug), [disabledSet])

  return {
    applyQuickAction,
    counts,
    currentAction,
    dirty,
    discard,
    isOn,
    local,
    phase: status ?? editing,
    save,
    toggle,
    toggleFacet
  }
}
