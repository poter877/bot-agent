import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorCard, ConnectorRow, type ConnectorRowProps } from './connector-card'
import { connectorLogoSource } from './connector-logo'

afterEach(cleanup)

const LINEAR = { homepage: 'https://linear.app', name: 'linear', title: 'Linear' }

function renderRow(overrides: Partial<ConnectorRowProps> = {}) {
  render(
    <ConnectorCard title="Connect your apps">
      <ConnectorRow connector={LINEAR} mark="idle" markLabel="Not connected" {...overrides} />
    </ConnectorCard>
  )
}

describe('a row in the card', () => {
  it('says how it stands through the mark, so the verb never has to', () => {
    renderRow({
      action: { label: 'Connect', onClick: vi.fn() },
      cue: 'Waiting for your browser…',
      mark: 'waiting',
      markLabel: 'Waiting for your browser…'
    })

    const announced = screen.getByRole('status')

    // A row that flips while the user reads the card has to be heard, not just seen.
    expect(announced.getAttribute('aria-live')).toBe('polite')
    // The cue repeats the mark's own word here; it is announced once.
    expect(announced.textContent).toBe('Waiting for your browser…')
    expect(screen.getByRole('button', { name: 'Connect' }).hasAttribute('disabled')).toBe(false)
  })

  it('holds its verb while it runs', () => {
    renderRow({ action: { busy: true, label: 'Try again', onClick: vi.fn() } })

    const button = screen.getByRole('button')

    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('has nothing to press once it is done', () => {
    renderRow({ mark: 'connected', markLabel: 'Connected' })

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('Connected')
  })
})

describe('where a mark is read from', () => {
  it('prefers the product site over the endpoint it talks to', () => {
    expect(
      connectorLogoSource({ homepage: 'https://linear.app', name: 'linear', url: 'https://mcp.linear.app/sse' })
    ).toBe('https://linear.app')
  })

  it('falls back to the endpoint, then to the docs', () => {
    expect(connectorLogoSource({ name: 'linear', url: 'https://mcp.linear.app/sse' })).toBe('https://mcp.linear.app')
    expect(connectorLogoSource({ docs: 'https://docs.stripe.com/x', name: 'stripe' })).toBe('https://docs.stripe.com')
  })

  it('reads the origin, never the path, so an endpoint is not fetched just to draw a logo', () => {
    expect(connectorLogoSource({ name: 'acme', url: 'https://acme.test/deep/mcp?token=1' })).toBe('https://acme.test')
  })

  it('refuses a code host, because a bridge published on GitHub is not GitHub', () => {
    expect(connectorLogoSource({ name: 'n8n-bridge', url: 'https://github.com/someone/n8n-mcp' })).toBe('')
  })

  it('refuses a private host, which has no logo to find and should not be named aloud', () => {
    expect(connectorLogoSource({ name: 'unreal-engine', url: 'http://127.0.0.1:8000/mcp' })).toBe('')
  })

  it('shrugs at something that is not a URL at all', () => {
    expect(connectorLogoSource({ docs: 'see the README', name: 'local' })).toBe('')
  })
})
