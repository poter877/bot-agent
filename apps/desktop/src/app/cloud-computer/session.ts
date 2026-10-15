import { atom } from 'nanostores'

import type { CloudAction, CloudComputerCaptureResult, CloudComputerSnapshot, CloudRequest } from './protocol'
import { createCloudRequestQueue } from './request-queue'

export interface CloudComputerViewState {
  snapshot: CloudComputerSnapshot | null
  frame: CloudComputerCaptureResult | null
  busy: boolean
  controlling: boolean
  error: string | null
}

const emptyState: CloudComputerViewState = { snapshot: null, frame: null, busy: false, controlling: false, error: null }

function isConflict(error: unknown): boolean {
  const value = error as { code?: number; data?: { httpStatus?: number } } | null

  return value?.code === 409 || value?.data?.httpStatus === 409
}

/** One mounted viewer; no credential or frame survives its account/route authority. */
export function createCloudComputerSession(transport: CloudRequest, isCurrent: () => boolean) {
  const network = createCloudRequestQueue(transport, isCurrent)
  const request = network.request
  const state = atom<CloudComputerViewState>({ ...emptyState })
  const abort = new AbortController()
  let live = true
  let revision = 0
  let frameSequence = 0
  let pollGeneration = 0
  let viewerToken: string | null = null
  let tokenEpoch: number | null = null
  let reading = false
  let failures = 0
  let polling: ReturnType<typeof setTimeout> | undefined
  let renewal: ReturnType<typeof setInterval> | undefined
  let inputQueue = Promise.resolve()
  let inputsPending = 0

  const current = () => live && isCurrent()

  const write = (patch: Partial<CloudComputerViewState>) => {
    if (current()) {
      state.set({ ...state.get(), ...patch })
    }
  }

  const clearControl = () => {
    viewerToken = null
    tokenEpoch = null
    write({ controlling: false })
  }

  const accept = (snapshot: CloudComputerSnapshot) => {
    const prior = state.get().snapshot

    const changed =
      prior?.computer?.generation !== snapshot.computer?.generation || prior?.lease.epoch !== snapshot.lease.epoch

    if (changed || snapshot.computer?.state !== 'running' || snapshot.lease.holder !== 'human') {
      clearControl()
    }

    write({ snapshot, ...(changed || snapshot.computer?.state !== 'running' ? { frame: null } : {}) })
  }

  async function capture(ticket = revision): Promise<void> {
    const snapshot = state.get().snapshot

    if (!current() || snapshot?.computer?.state !== 'running' || !snapshot.computer.capabilities.capture) {
      return
    }

    const sequence = ++frameSequence

    const result = await request<CloudComputerCaptureResult>(
      'cloudComputer.capture',
      {
        computerGeneration: snapshot.computer.generation,
        leaseEpoch: snapshot.lease.epoch,
        ...(viewerToken ? { viewerToken } : {})
      },
      abort.signal
    )

    if (!current() || ticket !== revision || sequence !== frameSequence) {
      return
    }

    const now = state.get().snapshot

    if (result.computerGeneration === now?.computer?.generation && result.leaseEpoch === now?.lease.epoch) {
      write({ frame: result })
    }
  }

  async function refresh(force = false): Promise<void> {
    if (!current() || reading || state.get().busy || (!force && (network.pending() > 0 || inputsPending > 0))) {
      return
    }

    reading = true
    const ticket = revision

    try {
      const snapshot = await request<CloudComputerSnapshot>('cloudComputer.status', {}, abort.signal)

      if (!current() || ticket !== revision) {
        return
      }

      accept(snapshot)
      await capture(ticket)

      if (ticket === revision) {
        failures = 0
        write({ error: null })
      }
    } catch (error) {
      if (current() && ticket === revision) {
        failures += 1

        if (isConflict(error)) {
          clearControl()
        }

        write({ frame: null, error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      reading = false
    }
  }

  async function fail(error: unknown): Promise<void> {
    clearControl()
    write({ frame: null, error: error instanceof Error ? error.message : String(error) })

    if (isConflict(error) && current()) {
      // Refresh truth, never repeat a click or keystroke against a different generation.
      const message = state.get().error
      await refresh(true)
      write({ error: message })
    }
  }

  async function mutate(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!current() || state.get().busy) {
      return
    }

    revision += 1
    const ticket = revision
    write({ busy: true, error: null })
    let applied = false

    try {
      const result = await request<CloudComputerSnapshot & { viewerToken?: string }>(method, params, abort.signal)

      if (!current() || ticket !== revision) {
        if (method === 'cloudComputer.lease.acquire' && result.viewerToken && isCurrent()) {
          void request('cloudComputer.lease.release', { viewerToken: result.viewerToken }).catch(() => undefined)
        }

        return
      }

      const { viewerToken: minted, ...snapshot } = result
      accept(snapshot)

      if (method === 'cloudComputer.lease.acquire' && minted && result.lease.holder === 'human') {
        viewerToken = minted
        tokenEpoch = result.lease.epoch
        write({ controlling: true })
      }

      if (method === 'cloudComputer.lease.release' || method === 'cloudComputer.stop') {
        clearControl()
      }

      applied = true
      await capture(ticket)
    } catch (error) {
      if (current() && ticket === revision) {
        write({ busy: false })

        if (applied && !isConflict(error)) {
          // A failed screenshot must not discard a successfully acquired lease capability.
          write({ frame: null, error: error instanceof Error ? error.message : String(error) })
        } else {
          await fail(error)
        }
      }
    } finally {
      if (ticket === revision) {
        write({ busy: false })
      }
    }
  }

  function action(action: CloudAction): Promise<void> {
    const snapshot = state.get().snapshot
    const token = viewerToken
    const generation = snapshot?.computer?.generation
    const epoch = tokenEpoch

    if (
      !current() ||
      !token ||
      !state.get().controlling ||
      !state.get().frame ||
      snapshot?.computer?.state !== 'running' ||
      !snapshot.computer.capabilities.actions.includes(action.action)
    ) {
      return Promise.resolve()
    }

    if (!snapshot.lease.expiresAt || Date.parse(snapshot.lease.expiresAt) <= Date.now()) {
      clearControl()

      return Promise.resolve()
    }

    inputsPending += 1
    inputQueue = inputQueue.then(async () => {
      if (
        !current() ||
        viewerToken !== token ||
        tokenEpoch !== epoch ||
        state.get().snapshot?.computer?.generation !== generation ||
        state.get().busy
      ) {
        return
      }

      try {
        await request(
          'cloudComputer.action',
          { ...action, viewerToken: token, computerGeneration: generation, leaseEpoch: epoch },
          abort.signal
        )

        if (current() && viewerToken === token && !state.get().busy) {
          await capture()
        }
      } catch (error) {
        if (current()) {
          await fail(error)
        }
      }
    })

    inputQueue = inputQueue.finally(() => {
      inputsPending -= 1
    })

    return inputQueue
  }

  async function renew(): Promise<void> {
    const token = viewerToken

    if (!current() || !token || state.get().busy) {
      return
    }

    try {
      const result = await request<CloudComputerSnapshot>(
        'cloudComputer.lease.renew',
        { viewerToken: token },
        abort.signal
      )

      if (current() && viewerToken === token) {
        accept(result)
      }
    } catch (error) {
      if (current() && viewerToken === token) {
        await fail(error)
      }
    }
  }

  async function poll(generation: number): Promise<void> {
    await refresh()

    if (current() && generation === pollGeneration && failures < 3) {
      polling = setTimeout(() => {
        void poll(generation)
      }, 1000)
    }
  }

  function dispose(): void {
    const token = viewerToken
    const release = current() && token
    live = false
    revision += 1
    abort.abort()
    clearTimeout(polling)
    clearInterval(renewal)
    viewerToken = null
    tokenEpoch = null
    state.set({ ...emptyState })

    if (release) {
      void request('cloudComputer.lease.release', { viewerToken: token }).catch(() => undefined)
    }
  }

  return {
    state,
    action,
    dispose,
    start() {
      void poll(++pollGeneration)
      renewal = setInterval(() => {
        void renew()
      }, 20_000)
    },
    async retry() {
      failures = 0
      clearTimeout(polling)
      await poll(++pollGeneration)
    },
    launch: () => mutate('cloudComputer.start'),
    stop: () => mutate('cloudComputer.stop'),
    acquire: () => mutate('cloudComputer.lease.acquire'),
    release: () => (viewerToken ? mutate('cloudComputer.lease.release', { viewerToken }) : Promise.resolve()),
    async configure(enabled: boolean) {
      if (!current() || state.get().busy) {
        return
      }

      const ticket = ++revision
      write({ busy: true })

      try {
        const result = await request<{ enabled: boolean }>('cloudComputer.configure', { enabled }, abort.signal)
        const snapshot = state.get().snapshot

        if (snapshot && ticket === revision) {
          write({ snapshot: { ...snapshot, agentEnabled: result.enabled }, error: null })
        }
      } catch (error) {
        write({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        write({ busy: false })
      }
    }
  }
}
