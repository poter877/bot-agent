import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $desktopOnboarding, type OnboardingContext } from '@/store/onboarding'
import { markOnboardingDecided } from '@/store/onboarding-presence'

import { DesktopOnboardingOverlay } from '.'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

it.each(['catalog error', 'runtime timeout'])('offers only company retry after %s and recovers', async failure => {
  let recovered = false
  const requestGateway: OnboardingContext['requestGateway'] = vi.fn(async method => {
    if (method === 'setup.status') {
      return { managed: true, provider_configured: true, ready: true, inference_provider: 'hono' } as never
    }
    if (method === 'setup.runtime_check') {
      if (recovered) {
        return { managed: true, ok: true, provider: 'hono', model: 'company-default' } as never
      }
      if (failure === 'runtime timeout') {
        throw new Error('readiness check still in progress; retrying next tick')
      }
      return {
        managed: true,
        ok: false,
        provider: 'hono',
        error: 'The company model directory is unavailable.'
      } as never
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  const api = vi.fn(async () => {
    throw new Error('No vendor or free-tier setup is allowed')
  })
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })
  markOnboardingDecided()
  $desktopOnboarding.set({
    configured: null,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: true,
    manual: false,
    localEndpoint: false,
    freeTierReady: false
  })
  const onCompleted = vi.fn()
  render(<DesktopOnboardingOverlay enabled onCompleted={onCompleted} profile="" requestGateway={requestGateway} />)

  expect((await screen.findByRole('alert')).textContent).toContain('Company service is temporarily unavailable')
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByText('Nous Portal')).toBeNull()
  expect(screen.queryByText('Fireworks AI')).toBeNull()
  expect(screen.queryByText('Use an API key')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(api).not.toHaveBeenCalled()

  recovered = true
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect($desktopOnboarding.get().configured).toBe(true))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(onCompleted).toHaveBeenCalledOnce()
  expect(api).not.toHaveBeenCalled()
})
