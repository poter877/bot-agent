import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { $desktopOnboarding, type DesktopOnboardingState, type OnboardingContext } from '@/store/onboarding'

import { FlowPanel } from './flow'

// Resolved when the catalog mock is first read — the pick's relabel reads the
// provider row from that query, so the test must not pick before it lands.
const catalog = vi.hoisted(() => {
  let resolve!: () => void

  const read = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })

  return { read, resolve: () => resolve() }
})

// Only the catalog fetch is replaced; the model assignment keeps its real path
// down to window.hermesDesktop.api so the test observes the wire body.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getGlobalModelOptions: async () => {
    catalog.resolve()

    return {
      providers: [
        { models: ['gpt-5.6-terra'], name: 'OpenAI OAuth (ChatGPT)', slug: 'openai' },
        { models: ['deepseek/deepseek-v4-flash-0731'], name: 'DeepSeek', slug: 'deepseek' }
      ]
    }
  }
}))

// The real picker is a cmdk/Radix dialog; stand in a button that reports the
// same {provider, model} selection shape the real one emits.
vi.mock('@/components/model-picker', () => ({
  ModelPickerDialog: ({
    onSelect,
    open
  }: {
    onSelect: (selection: { model: string; provider: string }) => void
    open: boolean
  }) =>
    open ? (
      <button onClick={() => onSelect({ model: 'deepseek/deepseek-v4-flash-0731', provider: 'deepseek' })} type="button">
        pick-deepseek-model
      </button>
    ) : null
}))

const ctx: OnboardingContext = { requestGateway: async () => undefined as never }

function confirmingModelState(): DesktopOnboardingState {
  return {
    configured: false,
    flow: {
      status: 'confirming_model',
      currentModel: 'gpt-5.6-terra',
      label: 'OpenAI OAuth (ChatGPT)',
      providerSlug: 'openai',
      saving: false
    },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false,
  }
}

function Harness() {
  const state = $desktopOnboarding.get()

  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FlowPanel ctx={ctx} flow={state.flow} leaving={false} onBegin={() => undefined} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  $desktopOnboarding.set(confirmingModelState())
})

afterEach(() => {
  cleanup()
  $desktopOnboarding.set({ ...confirmingModelState(), configured: null, flow: { status: 'idle' } })
})

describe('ConfirmingModelPanel model pick', () => {
  it('persists a cross-provider pick against the picked model provider, not the sign-in provider', async () => {
    const calls: { body?: unknown; path: string }[] = []

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        api: async ({ body, path }: { body?: unknown; path: string }) => {
          calls.push({ body, path })

          if (path === '/api/model/set') {
            return { ok: true, provider: 'deepseek', model: 'deepseek/deepseek-v4-flash-0731' }
          }

          throw new Error(`unexpected api path: ${path}`)
        }
      }
    })

    render(<Harness />)

    // The catalog must have resolved before the pick — the relabel below
    // reads the picked provider's name from it.
    await catalog.read
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy())

    // The user signed in with OpenAI OAuth; the picker offers a deepseek
    // model the sign-in provider does not serve.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick-deepseek-model' }))

    await waitFor(() => expect(calls.some(c => c.path === '/api/model/set')).toBe(true))

    expect(calls.find(c => c.path === '/api/model/set')?.body).toMatchObject({
      scope: 'main',
      provider: 'deepseek',
      model: 'deepseek/deepseek-v4-flash-0731'
    })

    const flow = $desktopOnboarding.get().flow
    expect(flow.status).toBe('confirming_model')

    if (flow.status === 'confirming_model') {
      expect(flow.providerSlug).toBe('deepseek')
      expect(flow.label).toBe('DeepSeek')
    }
  })
})
