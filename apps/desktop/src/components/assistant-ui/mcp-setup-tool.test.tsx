import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpSetupTool } from '@/components/assistant-ui/mcp-setup-tool'
import { I18nProvider } from '@/i18n'

const ARGS = {
  action: 'install',
  connectors: [
    { mcp: true, name: 'linear' },
    { mcp: true, name: 'postgres' }
  ]
}

function props(result?: ToolCallMessagePartProps['result']): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args: ARGS,
    argsText: JSON.stringify(ARGS),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: result === undefined ? { type: 'running' } : { type: 'complete' },
    toolCallId: 'mcp-call-1',
    toolName: 'manage_connections',
    type: 'tool-call'
  }
}

function renderTool(result?: ToolCallMessagePartProps['result']) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <McpSetupTool {...props(result)} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the MCP setup row', () => {
  it('lists every target once settled, in the same three words as the connector card', () => {
    renderTool({
      settled_by: 'continue',
      status: 'settled',
      targets: [
        { action: 'install', kind: 'mcp', name: 'linear', state: 'connected', tools: ['a', 'b'] },
        { action: 'install', detail: 'catalog write failed', kind: 'mcp', name: 'postgres', state: 'not_connected' }
      ]
    })

    expect(screen.getByText('Installed Linear · 2 tools')).toBeTruthy()
    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(screen.queryByText(/catalog write failed/)).toBeNull()
    expect(screen.queryAllByRole('button').filter(button => !button.hasAttribute('disabled'))).toHaveLength(0)
  })
})
