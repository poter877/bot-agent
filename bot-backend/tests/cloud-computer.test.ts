import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CloudAction, CloudWorker, WorkerComputer } from '../src/modules/cloud-computer/protocol.js'
import { CloudComputerService, type cloudSnapshot } from '../src/modules/cloud-computer/service.js'
import { cookieFrom, createTestApp, flushRateLimits, jsonRequest, registerUser, signIn, TEST_BASE_URL, truncateAll, uniqueEmail, type RegisteredUser, type TestApp } from './helpers.js'

type Snapshot = ReturnType<typeof cloudSnapshot>
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII='

class MemoryWorker implements CloudWorker {
  computers = new Map<string, WorkerComputer>()
  owners = new Map<string, string>()
  starts: string[] = []
  actions: CloudAction[] = []
  unavailable = false
  captureWait: (() => Promise<void>) | null = null
  private lookup(owner: string, id: string): WorkerComputer {
    if (this.unavailable) throw new Error('private Docker failure: secret-worker-token')
    if (this.owners.has(id) && this.owners.get(id) !== owner) throw new Error('wrong owner')
    return this.computers.get(id) ?? { id, state: 'missing', width: 1440, height: 900 }
  }
  async status(owner: string, id: string) { return this.lookup(owner, id) }
  async start(owner: string, id: string) {
    const computer = { ...this.lookup(owner, id), state: 'running' as const }
    this.computers.set(id, computer)
    this.owners.set(id, owner)
    this.starts.push(id)
    return computer
  }
  async stop(owner: string, id: string) {
    const computer = { ...this.lookup(owner, id), state: 'stopped' as const }
    this.computers.set(id, computer)
    return computer
  }
  async capture(owner: string, id: string) {
    const computer = this.lookup(owner, id)
    await this.captureWait?.()
    return { image: { mediaType: 'image/png' as const, data: png, width: computer.width, height: computer.height } }
  }
  async action(owner: string, id: string, action: CloudAction) {
    this.lookup(owner, id)
    this.actions.push(action)
    return { ok: true as const }
  }
}

describe('company account cloud computer', () => {
  let app: TestApp
  let worker: MemoryWorker
  let alice: RegisteredUser
  let bob: RegisteredUser
  const request = (user: RegisteredUser, path: string, body?: unknown) =>
    jsonRequest(app.app, body === undefined ? 'GET' : 'POST', `/v1/cloud-computer/${path}`, body, { cookie: user.cookie, origin: TEST_BASE_URL })
  const snapshot = async (user: RegisteredUser) => await (await request(user, 'status')).json() as Snapshot
  const boot = async (user: RegisteredUser) => {
    expect((await request(user, 'start', {})).status).toBe(200)
    await app.cloudComputers!.reconcile()
    const result = await snapshot(user)
    expect(result.computer?.state).toBe('running')
    return result
  }
  const authority = (state: Snapshot, actor = 'agent') => ({ actor, computerGeneration: state.computer!.generation, leaseEpoch: state.lease.epoch })
  beforeAll(async () => {
    worker = new MemoryWorker()
    app = await createTestApp({ CLOUD_COMPUTER_ENABLED: 'true', CLOUD_COMPUTER_WORKER_URL: 'http://127.0.0.1:3999', CLOUD_COMPUTER_WORKER_TOKEN: 'test-worker-token-0123456789abcdef012345' }, undefined, { worker })
  })
  beforeEach(async () => {
    await truncateAll(app.database)
    await flushRateLimits(app.redis)
    worker.computers.clear(); worker.owners.clear(); worker.starts = []; worker.actions = []; worker.unavailable = false; worker.captureWait = null
    alice = await registerUser(app.app, app.database, uniqueEmail(), 'password-123456')
    bob = await registerUser(app.app, app.database, uniqueEmail(), 'password-123456')
  })
  afterAll(async () => app.close())

  it('requires a live server session and same-origin mutations, and accepts no claimed owner or runtime', async () => {
    for (const path of ['start', 'stop', 'capture', 'actions', 'lease/acquire', 'lease/renew', 'lease/release']) {
      expect((await jsonRequest(app.app, 'POST', `/v1/cloud-computer/${path}`, {})).status).toBe(401)
    }
    expect((await jsonRequest(app.app, 'GET', '/v1/cloud-computer/status')).status).toBe(401)
    expect((await jsonRequest(app.app, 'POST', '/v1/cloud-computer/start', {}, { cookie: alice.cookie })).status).toBe(403)
    for (const forged of [{ userId: bob.userId }, { id: 'another-computer' }, { workerUrl: 'http://attacker.local' }]) {
      expect((await request(alice, 'start', forged)).status).toBe(400)
    }
    await app.database.pool.query('DELETE FROM session WHERE user_id=$1', [alice.userId])
    expect((await request(alice, 'start', {})).status).toBe(401)
    expect(worker.starts).toEqual([])
  })

  it('creates one computer per account, stops independently and restores the same resource', async () => {
    const a = await boot(alice)
    const b = await boot(bob)
    expect(a.computer!.id).not.toBe(b.computer!.id)
    expect(worker.owners.get(a.computer!.id)).toBe(alice.userId)
    expect((await (await request(alice, 'start', {})).json() as Snapshot).computer).toEqual(a.computer)
    expect((await request(alice, 'stop', {})).status).toBe(200)
    await app.cloudComputers!.reconcile()
    expect((await snapshot(alice)).computer?.state).toBe('stopped')
    expect((await snapshot(bob)).computer?.state).toBe('running')
    const resumed = await boot(alice)
    expect(resumed.computer!.id).toBe(a.computer!.id)
    expect(resumed.computer!.generation).toBeGreaterThan(a.computer!.generation)
    expect(worker.starts.filter((id) => id === a.computer!.id)).toHaveLength(2)
  })

  it('allows watching without control but fences agent captures and input during human takeover', async () => {
    const initial = await boot(alice)
    expect((await request(alice, 'capture', authority(initial))).status).toBe(200)
    const lease = await (await request(alice, 'lease/acquire', {})).json() as Snapshot & { viewerToken: string }
    expect(lease.lease.holder).toBe('human')
    expect((await request(alice, 'capture', authority(lease))).status).toBe(409)
    const view = await request(alice, 'capture', authority(lease, 'human'))
    expect(view.status).toBe(200)
    expect(view.headers.get('cache-control')).toBe('private, no-store')
    const click = { action: 'click', params: { x: 12, y: 24 } }
    expect((await request(alice, 'actions', { ...authority(lease), ...click })).status).toBe(409)
    expect((await request(alice, 'actions', { ...authority(lease, 'human'), ...click })).status).toBe(409)
    expect((await request(alice, 'actions', { ...authority(lease, 'human'), viewerToken: lease.viewerToken, ...click })).status).toBe(200)
    expect(worker.actions).toHaveLength(1)
    const publicState = await snapshot(alice)
    expect(JSON.stringify(publicState)).not.toContain(lease.viewerToken)
    const row = (await app.database.pool.query('SELECT lease_token_hash FROM cloud_computer WHERE user_id=$1', [alice.userId])).rows[0]
    expect(row.lease_token_hash).not.toBe(lease.viewerToken)
    const released = await (await request(alice, 'lease/release', { viewerToken: lease.viewerToken })).json() as Snapshot
    expect((await request(alice, 'actions', { ...authority(released), ...click })).status).toBe(200)
  })

  it('binds a lease to account, login session and generation, and rejects stale screen coordinates', async () => {
    await boot(alice); await boot(bob)
    const lease = await (await request(alice, 'lease/acquire', {})).json() as Snapshot & { viewerToken: string }
    expect((await request(bob, 'lease/renew', { viewerToken: lease.viewerToken })).status).toBe(409)
    const newLogin = { ...alice, cookie: cookieFrom(await signIn(app.app, alice.email, alice.password)) }
    expect((await request(newLogin, 'lease/renew', { viewerToken: lease.viewerToken })).status).toBe(409)
    const replacement = await (await request(newLogin, 'lease/acquire', {})).json() as Snapshot & { viewerToken: string }
    expect((await request(alice, 'lease/release', { viewerToken: lease.viewerToken })).status).toBe(409)
    expect((await request(newLogin, 'actions', { ...authority(replacement, 'human'), viewerToken: replacement.viewerToken, action: 'click', params: { x: 1440, y: 1 } })).status).toBe(400)
    expect((await request(newLogin, 'actions', { ...authority(replacement, 'human'), computerGeneration: 0, viewerToken: replacement.viewerToken, action: 'click', params: { x: 1, y: 1 } })).status).toBe(409)
    expect((await request(newLogin, 'actions', { ...authority(replacement, 'human'), viewerToken: replacement.viewerToken, action: 'shell', params: { command: 'id' } })).status).toBe(400)
    await request(alice, 'stop', {})
    expect((await request(newLogin, 'lease/renew', { viewerToken: replacement.viewerToken })).status).toBe(409)
    expect(worker.actions).toEqual([])
  })

  it('releases expired or server-revoked control sessions before agent use', async () => {
    await boot(alice)
    const first = await (await request(alice, 'lease/acquire', {})).json() as Snapshot & { viewerToken: string }
    await app.database.pool.query("UPDATE cloud_computer SET lease_expires_at=now()-interval '1 second' WHERE user_id=$1", [alice.userId])
    const expired = await snapshot(alice)
    expect(expired.lease.holder).toBe('agent')
    expect(expired.lease.epoch).toBeGreaterThan(first.lease.epoch)
    await request(alice, 'lease/acquire', {})
    await app.database.pool.query('DELETE FROM session WHERE user_id=$1', [alice.userId])
    const newLogin = { ...alice, cookie: cookieFrom(await signIn(app.app, alice.email, alice.password)) }
    const restored = await snapshot(newLogin)
    expect(restored.lease.holder).toBe('agent')
    expect((await request(newLogin, 'capture', authority(restored))).status).toBe(200)
  })

  it('serializes takeover with a pending capture and never allows stale agent input after takeover', async () => {
    const state = await boot(alice)
    let release!: () => void
    let entered!: () => void
    const began = new Promise<void>((resolve) => { entered = resolve })
    const pending = new Promise<void>((resolve) => { release = resolve })
    worker.captureWait = async () => { entered(); await pending }
    const capture = request(alice, 'capture', authority(state))
    await began
    expect((await request(alice, 'lease/acquire', {})).status).toBe(409)
    release()
    expect((await capture).status).toBe(200)
    expect((await request(alice, 'lease/acquire', {})).status).toBe(200)
    expect((await request(alice, 'actions', { ...authority(state), action: 'key', params: { keys: ['Enter'] } })).status).toBe(409)
    expect(worker.actions).toEqual([])
  })

  it('recovers durable lifecycle work across service instances and invalidates unexpectedly restarted screens', async () => {
    await request(alice, 'start', {})
    worker.unavailable = true
    await app.cloudComputers!.reconcile()
    const failed = await snapshot(alice)
    expect(failed.computer?.state).toBe('error')
    expect(JSON.stringify(failed)).not.toContain('secret-worker-token')
    worker.unavailable = false
    await app.database.pool.query("UPDATE cloud_computer SET reconcile_after=now()-interval '1 second'")
    const restartedApi = new CloudComputerService(app.database.db, worker)
    await restartedApi.reconcile()
    const beforeCrash = await snapshot(alice)
    expect(beforeCrash.computer?.state).toBe('running')
    worker.unavailable = true
    await app.database.pool.query("UPDATE cloud_computer SET reconcile_after=now()-interval '1 second'")
    await restartedApi.reconcile()
    expect((await snapshot(alice)).computer?.state).toBe('error')
    worker.unavailable = false
    worker.computers.delete(beforeCrash.computer!.id)
    await app.database.pool.query("UPDATE cloud_computer SET reconcile_after=now()-interval '1 second'")
    await restartedApi.reconcile()
    const afterCrash = await snapshot(alice)
    expect(afterCrash.computer?.id).toBe(beforeCrash.computer?.id)
    expect(afterCrash.computer!.generation).toBeGreaterThan(beforeCrash.computer!.generation)
    expect((await request(alice, 'capture', authority(beforeCrash))).status).toBe(409)
  })
})
