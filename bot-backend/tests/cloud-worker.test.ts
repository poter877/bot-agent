import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkerApp } from '../src/cloud-worker/app.js'
import { loadWorkerConfig } from '../src/cloud-worker/config.js'
import { DockerCloudWorker } from '../src/cloud-worker/docker-worker.js'
import { volumeName } from '../src/cloud-worker/docker-policy.js'
import { runProcess } from '../src/cloud-worker/process.js'
import { dockerFixture } from './cloud-worker-fixture.js'

describe('private Docker cloud worker', () => {
  let fixture: ReturnType<typeof dockerFixture>
  let app: ReturnType<typeof createWorkerApp>
  const token = 'worker-test-secret-with-at-least-thirty-two-characters'
  beforeEach(() => {
    fixture = dockerFixture()
    const config = loadWorkerConfig({ CLOUD_WORKER_TOKEN: token, CLOUD_WORKER_DOCKER: fixture.executable,
      CLOUD_WORKER_IPTABLES: fixture.iptables })
    app = createWorkerApp(config, new DockerCloudWorker(config))
  })
  afterEach(() => rmSync(fixture.root, { recursive: true, force: true }))

  async function request(owner: string, id: string, suffix = '', body?: unknown, auth = token) {
    return app.request(`/v1/computers/${id}${suffix}`, {
      method: suffix ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${auth}`, 'X-Cloud-Owner': owner, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  it('runs isolated computers and preserves their distinct home volumes across stop/start', async () => {
    expect((await request('alice', 'computer-a', '/start')).status).toBe(200)
    expect((await request('bob', 'computer-b', '/start')).status).toBe(200)
    expect((await request('bob', 'computer-a', '/capture')).status).toBe(404)
    const secret = "你好'; $(touch /tmp/should-never-exist)"
    expect((await request('alice', 'computer-a', '/actions', { action: 'type', params: { text: secret } })).status).toBe(200)
    const capture = await request('alice', 'computer-a', '/capture')
    expect(await capture.json()).toMatchObject({ image: { mediaType: 'image/png', width: 1, height: 1 } })
    expect(await (await request('alice', 'computer-a', '/stop')).json()).toMatchObject({ state: 'stopped' })
    expect((await request('alice', 'computer-a', '/start')).status).toBe(200)
    expect(Object.keys(fixture.read().volumes).sort()).toEqual([volumeName('alice'), volumeName('bob')].sort())
    const trace = fixture.trace()
    const creates = trace.filter(({ args }) => args[0] === 'create')
    expect(creates).toHaveLength(2)
    for (const { args } of creates) {
      expect(args).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL', '--pids-limit', '256', '--user', '1000:1000']))
      expect(args).not.toContain('--privileged')
      expect(args).not.toContain('-p')
      expect(args.join(' ')).not.toContain('/var/run/docker.sock')
    }
    const input = trace.find(({ input }) => input.includes('should-never-exist'))!
    expect(input.args.join(' ')).not.toContain(secret)
    expect(JSON.parse(input.input)).toMatchObject({ action: 'type', params: { text: secret }, deadlineAt: expect.any(Number) })
    expect(trace.some(({ args }) => args.includes('rm'))).toBe(false)
  })

  it('rejects unauthenticated, malformed, foreign-owner and unprovisioned-network calls before mutation', async () => {
    expect((await request('alice', 'computer-a', '/start', undefined, 'wrong')).status).toBe(401)
    expect(fixture.trace()).toHaveLength(0)
    expect((await request('', 'computer-a', '/start')).status).toBe(400)
    expect((await request('alice', 'computer-a', '/actions', { action: 'exec', params: { command: 'id' } })).status).toBe(400)
    fixture.write({ ...fixture.read(), policy: false })
    expect((await request('alice', 'computer-a', '/start')).status).toBe(503)
    expect(Object.keys(fixture.read().containers)).toHaveLength(0)
    fixture.write({ ...fixture.read(), policy: true, unavailable: true })
    expect((await request('alice', 'computer-a')).status).toBe(503)
  })

  it('serializes capacity admission and refuses a second computer sharing an owner home', async () => {
    const config = loadWorkerConfig({ CLOUD_WORKER_TOKEN: token, CLOUD_WORKER_DOCKER: fixture.executable,
      CLOUD_WORKER_IPTABLES: fixture.iptables, CLOUD_WORKER_MAX_RUNNING: '1' })
    const worker = new DockerCloudWorker(config)
    const results = await Promise.allSettled([worker.start('alice', 'computer-a'), worker.start('bob', 'computer-b')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    await expect(worker.start('alice', 'computer-other')).rejects.toMatchObject({ code: 'owner_has_computer' })
  })

  it('kills an actual stuck subprocess when the operation deadline expires', async () => {
    await expect(runProcess({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'],
      signal: AbortSignal.timeout(50) })).rejects.toThrow('runtime command failed')
  })

  it('refuses a surviving Docker policy label when host firewall rules disappeared', async () => {
    fixture.clearFirewall()
    expect(fixture.read().policy).toBe(true)
    expect((await request('alice', 'computer-a', '/start')).status).toBe(503)
    expect(Object.keys(fixture.read().containers)).toHaveLength(0)
  })

  it('keeps the owner barrier closed after a caller times out until its input process finishes', async () => {
    await request('alice', 'computer-a', '/start')
    fixture.write({ ...fixture.read(), actionDelay: 400 })
    const action = request('alice', 'computer-a', '/actions', { action: 'type', params: { text: 'old agent input' } })
    // The caller abandons its request. The worker continues owning the operation.
    await new Promise((resolve) => setTimeout(resolve, 20))
    let barrierOpened = false
    const barrier = request('alice', 'computer-a').then(() => { barrierOpened = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(barrierOpened).toBe(false)
    expect((await action).status).toBe(200)
    await barrier
    expect(barrierOpened).toBe(true)
  })
})
