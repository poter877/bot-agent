import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudComputerCaptureResult, CloudComputerSnapshot, CloudRequest } from './protocol'
import { createCloudComputerSession } from './session'

const sessions: ReturnType<typeof createCloudComputerSession>[] = []
const click = { action: 'click', params: { x: 20, y: 30, button: 'left', clicks: 1 } } as const

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

function fixture() {
  let current = true

  const snapshot: CloudComputerSnapshot = {
    enabled: true,
    agentEnabled: false,
    computer: {
      id: 'account-computer',
      state: 'running',
      generation: 4,
      width: 1280,
      height: 800,
      capabilities: { actions: ['click', 'move', 'drag', 'type', 'key', 'scroll'], capture: true },
      error: null
    },
    lease: { holder: 'agent', epoch: 0, expiresAt: null }
  }

  const frame = (): CloudComputerCaptureResult => ({
    image: { mediaType: 'image/png', data: 'aW1hZ2U=', width: 1280, height: 800 },
    computerGeneration: snapshot.computer!.generation,
    leaseEpoch: snapshot.lease.epoch
  })

  const handler = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'cloudComputer.capture') {
      return frame()
    }

    if (method === 'cloudComputer.lease.acquire') {
      snapshot.lease = {
        holder: 'human',
        epoch: snapshot.lease.epoch + 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }

      return { ...structuredClone(snapshot), viewerToken: 'viewer-secret' }
    }

    if (method === 'cloudComputer.lease.renew') {
      snapshot.lease.expiresAt = new Date(Date.now() + 60_000).toISOString()
    }

    if (method === 'cloudComputer.stop') {
      snapshot.computer!.state = 'stopped'
      snapshot.computer!.generation += 1
    }

    if (method === 'cloudComputer.start') {
      snapshot.computer!.state = 'running'
      snapshot.computer!.generation += 1
    }

    if (method === 'cloudComputer.lease.release') {
      snapshot.lease = { holder: 'agent', epoch: snapshot.lease.epoch + 1, expiresAt: null }
    }

    if (method === 'cloudComputer.configure') {
      snapshot.agentEnabled = Boolean(params.enabled)

      return { enabled: snapshot.agentEnabled, appliesTo: 'new-sessions' }
    }

    return structuredClone(snapshot)
  }

  const request = vi.fn(handler)
  const session = createCloudComputerSession(request as CloudRequest, () => current)
  sessions.push(session)

  return {
    snapshot,
    frame,
    handler,
    request,
    session,
    changeAccount() {
      current = false
      session.dispose()
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-15T00:00:00Z'))
})
afterEach(() => {
  sessions.splice(0).forEach(session => session.dispose())
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('cloud computer account viewer', () => {
  it('starts and resumes the same computer, and clears its picture when stopped', async () => {
    const f = fixture()
    f.snapshot.computer!.state = 'stopped'
    await f.session.retry()
    expect(f.session.state.get().frame).toBeNull()
    await f.session.launch()
    expect(f.session.state.get().snapshot?.computer?.id).toBe('account-computer')
    expect(f.session.state.get().frame?.computerGeneration).toBe(5)
    await f.session.stop()
    expect(f.session.state.get().snapshot?.computer?.state).toBe('stopped')
    expect(f.session.state.get().frame).toBeNull()
  })

  it('cannot input while observing; acquisition allows ordered input with its exact lease and generation', async () => {
    const f = fixture()
    await f.session.retry()
    await f.session.action(click)
    expect(f.request.mock.calls.filter(([method]) => method === 'cloudComputer.action')).toHaveLength(0)
    await f.session.acquire()
    await Promise.all([f.session.action(click), f.session.action({ action: 'type', params: { text: '你好' } })])
    const sent = f.request.mock.calls.filter(([method]) => method === 'cloudComputer.action')
    expect(sent.map(([, payload]) => payload?.action)).toEqual(['click', 'type'])
    expect(sent[0][1]).toMatchObject({ computerGeneration: 4, leaseEpoch: 1, viewerToken: 'viewer-secret' })
    expect(f.session.state.get().snapshot).not.toHaveProperty('viewerToken')
    await f.session.release()
    expect(f.session.state.get().controlling).toBe(false)
  })

  it('renews its lease every 20 seconds and releases it on normal unmount', async () => {
    const f = fixture()
    f.session.start()
    await vi.advanceTimersByTimeAsync(0)
    await f.session.acquire()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.request.mock.calls.filter(([method]) => method === 'cloudComputer.lease.renew')).toEqual([
      ['cloudComputer.lease.renew', { viewerToken: 'viewer-secret' }, expect.any(AbortSignal)]
    ])
    f.session.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.request).toHaveBeenLastCalledWith(
      'cloudComputer.lease.release',
      { viewerToken: 'viewer-secret' },
      undefined
    )
    expect(f.session.state.get().frame).toBeNull()
  })

  it('refreshes a 409 without replaying the input or later queued input', async () => {
    const f = fixture()
    await f.session.retry()
    await f.session.acquire()
    f.request.mockImplementation(async (method, params) => {
      if (method === 'cloudComputer.action') {
        f.snapshot.lease = { holder: 'human', epoch: 5, expiresAt: new Date(Date.now() + 60_000).toISOString() }
        throw Object.assign(new Error('Control changed'), { data: { httpStatus: 409 } })
      }

      return f.handler(method, params)
    })
    await Promise.all([f.session.action(click), f.session.action(click)])
    expect(f.request.mock.calls.filter(([method]) => method === 'cloudComputer.action')).toHaveLength(1)
    expect(f.session.state.get()).toMatchObject({
      controlling: false,
      error: 'Control changed',
      snapshot: { lease: { epoch: 5 } }
    })
  })

  it('rejects a delayed frame after stop', async () => {
    const f = fixture()
    const pending = deferred<CloudComputerCaptureResult>()
    const old = f.frame()
    f.request.mockImplementation((method, params) =>
      method === 'cloudComputer.capture' ? pending.promise : f.handler(method, params)
    )
    const refreshing = f.session.retry()
    await vi.advanceTimersByTimeAsync(0)
    const stopping = f.session.stop()
    pending.resolve(old)
    await Promise.all([refreshing, stopping])
    expect(f.session.state.get()).toMatchObject({ frame: null, snapshot: { computer: { state: 'stopped' } } })
  })

  it('clears frames and pending authority on account change, without sending the old token to the new account', async () => {
    const f = fixture()
    await f.session.retry()
    await f.session.acquire()
    f.changeAccount()
    await f.session.action(click)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.session.state.get()).toMatchObject({ frame: null, snapshot: null, controlling: false })
    expect(
      f.request.mock.calls.some(([method]) =>
        ['cloudComputer.action', 'cloudComputer.lease.release', 'cloudComputer.lease.renew'].includes(method)
      )
    ).toBe(false)
  })

  it('does not revive control from an acquire reply delivered after account change', async () => {
    const f = fixture()
    await f.session.retry()
    const pending = deferred<Awaited<ReturnType<typeof f.handler>>>()
    f.request.mockImplementation((method, params) =>
      method === 'cloudComputer.lease.acquire' ? pending.promise : f.handler(method, params)
    )
    const acquiring = f.session.acquire()
    await vi.advanceTimersByTimeAsync(0)
    f.changeAccount()
    pending.resolve(await f.handler('cloudComputer.lease.acquire'))
    await acquiring
    expect(f.session.state.get().controlling).toBe(false)
    expect(f.request.mock.calls.some(([method]) => method === 'cloudComputer.lease.release')).toBe(false)
  })

  it('does not send unsupported actions or input from an expired lease', async () => {
    const f = fixture()
    await f.session.retry()
    await f.session.acquire()
    f.snapshot.computer!.capabilities.actions = ['type']
    await f.session.retry()
    await f.session.action(click)
    vi.setSystemTime(new Date(Date.now() + 61_000))
    await f.session.action({ action: 'type', params: { text: 'late' } })
    expect(f.request.mock.calls.some(([method]) => method === 'cloudComputer.action')).toBe(false)
    expect(f.session.state.get().controlling).toBe(false)
  })

  it('bounds failed polling and permits an explicit retry', async () => {
    const f = fixture()
    f.request.mockRejectedValue(new Error('Offline'))
    f.session.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.request).toHaveBeenCalledTimes(3)
    f.request.mockImplementation(f.handler)
    await f.session.retry()
    expect(f.session.state.get().frame).not.toBeNull()
    expect(f.session.state.get().error).toBeNull()
  })

  it('serializes input, renewal and polling without racing the computer lock or replaying input', async () => {
    const f = fixture()
    f.session.start()
    await vi.advanceTimersByTimeAsync(0)
    await f.session.acquire()
    const pending = deferred<void>()
    let active = 0
    let highest = 0
    f.request.mockClear()
    f.request.mockImplementation(async (method, params) => {
      active += 1
      highest = Math.max(highest, active)

      try {
        if (method === 'cloudComputer.action') {
          await pending.promise
        }

        return await f.handler(method, params)
      } finally {
        active -= 1
      }
    })
    const action = f.session.action(click)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['cloudComputer.action'])
    pending.resolve()
    await action
    await vi.advanceTimersByTimeAsync(0)
    expect(highest).toBe(1)
    expect(f.request.mock.calls.filter(([method]) => method === 'cloudComputer.action')).toHaveLength(1)
    expect(f.request.mock.calls.some(([method]) => method === 'cloudComputer.lease.renew')).toBe(true)
    expect(f.session.state.get().controlling).toBe(true)
  })

  it('keeps a newly acquired lease renewable and releasable when its first screenshot fails', async () => {
    const f = fixture()
    f.session.start()
    await vi.advanceTimersByTimeAsync(0)
    f.request.mockImplementation(async (method, params) => {
      if (method === 'cloudComputer.capture') {
        throw new Error('Screenshot unavailable')
      }

      return f.handler(method, params)
    })
    await f.session.acquire()
    expect(f.session.state.get()).toMatchObject({ controlling: true, frame: null, error: 'Screenshot unavailable' })
    await f.session.action(click)
    expect(f.request.mock.calls.some(([method]) => method === 'cloudComputer.action')).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.request.mock.calls.some(([method]) => method === 'cloudComputer.lease.renew')).toBe(true)
    await f.session.release()
    expect(f.request.mock.calls.some(([method]) => method === 'cloudComputer.lease.release')).toBe(true)
    expect(f.session.state.get().controlling).toBe(false)
  })

  it('persists the new-chat setting without starting a computer or changing existing control', async () => {
    const f = fixture()
    await f.session.retry()
    await f.session.configure(true)
    expect(f.session.state.get().snapshot?.agentEnabled).toBe(true)
    expect(
      f.request.mock.calls.some(([method]) => ['cloudComputer.start', 'cloudComputer.lease.acquire'].includes(method))
    ).toBe(false)
  })
})
