import { describe, expect, it } from 'vitest'
import { createWorkerApp } from '../src/cloud-worker/app.js'
import { loadWorkerConfig } from '../src/cloud-worker/config.js'
import type { WorkerDiagnostic } from '../src/cloud-worker/diagnostics.js'
import { WorkerError } from '../src/cloud-worker/errors.js'
import { ProcessFailure } from '../src/cloud-worker/process.js'
import type { CloudWorker } from '../src/modules/cloud-computer/protocol.js'

describe('private worker diagnostics', () => {
  it('records failure class and registered route without leaking credentials, input or raw process output', async () => {
    const token = 'secret-worker-token-never-logged-with-thirty-two-characters'
    const config = loadWorkerConfig({ CLOUD_WORKER_TOKEN: token })
    const records: WorkerDiagnostic[] = []
    let failure: Error = new ProcessFailure(125, 'secret upstream token and user text from Docker stderr')
    const reject = async () => { throw failure }
    const worker: CloudWorker = { status: reject, start: reject, stop: reject, capture: reject, action: reject }
    const app = createWorkerApp(config, worker, (entry) => records.push(entry))
    const request = (suffix: string, body?: unknown) => app.request(`/v1/computers/private-computer-id/${suffix}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Cloud-Owner': 'private-account-id',
        'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    })

    expect((await request('start')).status).toBe(503)
    failure = new WorkerError(429, 'capacity_exceeded', 'Safe capacity explanation.')
    expect((await request('actions', { action: 'type', params: { text: 'private keyboard text' } })).status).toBe(429)
    expect(records).toEqual([
      { event: 'cloud_worker_request_failed', method: 'POST', route: '/v1/computers/:id/start',
        category: 'process', code: 'runtime_command_failed', exitCode: 125 },
      { event: 'cloud_worker_request_failed', method: 'POST', route: '/v1/computers/:id/actions',
        category: 'policy', code: 'capacity_exceeded' },
    ])
    const output = JSON.stringify(records)
    for (const secret of [token, 'private-computer-id', 'private-account-id', 'private keyboard text', 'Docker stderr']) {
      expect(output).not.toContain(secret)
    }
  })
})
