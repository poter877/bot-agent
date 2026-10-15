import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { cloudActionSchema, type CloudAction, type CloudImage, type CloudWorker, type WorkerComputer } from '../modules/cloud-computer/protocol.js'
import { COMPUTER_LABEL, MANAGED_LABEL, NETWORK_POLICY, NETWORK_POLICY_LABEL, OWNER_LABEL, type WorkerConfig } from './config.js'
import { containerName, createArguments, ownerHash, volumeName } from './docker-policy.js'
import { WorkerError } from './errors.js'
import { ProcessFailure, runProcess, type ProcessRunner } from './process.js'

const inspectionSchema = z.object({
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean() }),
  HostConfig: z.object({ NetworkMode: z.string(), Privileged: z.boolean(), ReadonlyRootfs: z.boolean() }),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
})
type Inspection = z.infer<typeof inspectionSchema>
const imageSchema = z.object({
  mediaType: z.literal('image/png'), data: z.string().min(1).max(12 * 1024 * 1024),
  width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
})

export class DockerCloudWorker implements CloudWorker {
  private readonly locks = new Map<string, Promise<void>>()
  private admission = Promise.resolve()

  constructor(private readonly config: WorkerConfig, private readonly runner: ProcessRunner = runProcess) {}

  private exec(args: string[], signal: AbortSignal, input?: string): Promise<string> {
    return this.runner({ command: this.config.CLOUD_WORKER_DOCKER, args, signal, input })
  }

  private async operation<T>(owner: string, id: string,
    work: (signal: AbortSignal, inputDeadline: number) => Promise<T>, budget = 30_000): Promise<T> {
    if (!owner || owner.length > 256 || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      throw new WorkerError(400, 'invalid_identity', 'Invalid cloud computer identity.')
    }
    // Serialize by owner: two simultaneous IDs must never share a writable home.
    const key = ownerHash(owner)
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(key, current)
    const signal = AbortSignal.timeout(budget)
    const inputDeadline = Date.now() + budget - 2500
    await previous
    try {
      signal.throwIfAborted()
      return await work(signal, inputDeadline)
    } finally {
      release()
      if (this.locks.get(key) === current) this.locks.delete(key)
    }
  }

  private async inspect(owner: string, id: string, signal: AbortSignal): Promise<Inspection | null> {
    let raw: string
    try {
      raw = await this.exec(['inspect', '--type', 'container', containerName(id)], signal)
    } catch (error) {
      if (error instanceof ProcessFailure && /no such (object|container)/i.test(error.stderr)) return null
      throw error
    }
    const instance = inspectionSchema.parse((JSON.parse(raw) as unknown[])[0])
    const labels = instance.Config.Labels ?? {}
    if (labels[OWNER_LABEL] !== ownerHash(owner) || labels[COMPUTER_LABEL] !== id || labels[MANAGED_LABEL] !== 'true') {
      throw new WorkerError(404, 'computer_not_found', 'Cloud computer not found.')
    }
    return instance
  }

  private result(id: string, instance: Inspection | null): WorkerComputer {
    const labels = instance?.Config.Labels ?? {}
    return { id, state: instance ? (instance.State.Running ? 'running' : 'stopped') : 'missing',
      width: Number(labels['bot.cloud.width'] ?? this.config.CLOUD_WORKER_WIDTH),
      height: Number(labels['bot.cloud.height'] ?? this.config.CLOUD_WORKER_HEIGHT) }
  }

  private assertContainerPolicy(instance: Inspection): void {
    const networks = Object.keys(instance.NetworkSettings.Networks)
    if (instance.HostConfig.NetworkMode !== this.config.CLOUD_WORKER_NETWORK || instance.HostConfig.Privileged
        || !instance.HostConfig.ReadonlyRootfs || networks.some((name) => name !== this.config.CLOUD_WORKER_NETWORK)) {
      throw new WorkerError(409, 'runtime_policy_mismatch', 'The cloud computer does not match its isolation policy.')
    }
  }

  private async assertNetwork(signal: AbortSignal): Promise<void> {
    try {
      await this.runner({ command: this.config.CLOUD_WORKER_PYTHON, signal,
        args: [fileURLToPath(new URL('../../cloud-computer-runtime/firewall-policy.py', import.meta.url)),
          'verify', '--iptables', this.config.CLOUD_WORKER_IPTABLES] })
    } catch {
      throw new WorkerError(503, 'network_not_ready', 'Restore the cloud desktop firewall policy on the worker host before starting computers.')
    }
    const raw = await this.exec(['network', 'inspect', this.config.CLOUD_WORKER_NETWORK], signal)
    const networks = JSON.parse(raw) as Array<{ Driver?: string; EnableIPv6?: boolean;
      Labels?: Record<string, string>; Options?: Record<string, string> }>
    const network = networks[0]
    if (network?.Driver !== 'bridge' || network.EnableIPv6 !== false
        || network.Labels?.[NETWORK_POLICY_LABEL] !== NETWORK_POLICY
        || network.Options?.['com.docker.network.bridge.enable_icc'] !== 'false'
        || network.Options?.['com.docker.network.bridge.name'] !== 'br-bot-cloud') {
      throw new WorkerError(503, 'network_not_ready', 'Provision the restricted cloud desktop network before starting computers.')
    }
  }

  private async ensureVolume(owner: string, signal: AbortSignal): Promise<void> {
    const name = volumeName(owner)
    await this.exec(['volume', 'create', '--label', `${OWNER_LABEL}=${ownerHash(owner)}`, name], signal)
    const raw = await this.exec(['volume', 'inspect', name], signal)
    const volume = (JSON.parse(raw) as Array<{ Labels?: Record<string, string> }>)[0]
    if (volume?.Labels?.[OWNER_LABEL] !== ownerHash(owner)) {
      throw new WorkerError(409, 'volume_owner_mismatch', 'The persistent home belongs to another owner.')
    }
  }

  private async assertCapacity(owner: string, id: string, signal: AbortSignal): Promise<void> {
    const owned = await this.exec(['ps', '-a', '--filter', `label=${OWNER_LABEL}=${ownerHash(owner)}`,
      '--filter', `label=${MANAGED_LABEL}=true`, '--format', '{{.Names}}'], signal)
    if (owned.trim().split('\n').some((name) => name && name !== containerName(id))) {
      throw new WorkerError(409, 'owner_has_computer', 'This account already has a cloud computer.')
    }
    const running = await this.exec(['ps', '--filter', `label=${MANAGED_LABEL}=true`, '--format', '{{.ID}}'], signal)
    if (running.trim().split('\n').filter(Boolean).length >= this.config.CLOUD_WORKER_MAX_RUNNING) {
      throw new WorkerError(429, 'capacity_exceeded', 'The cloud computer service is at capacity. Please retry later.')
    }
  }

  private async command(id: string, command: unknown, signal: AbortSignal, inputDeadline?: number): Promise<unknown> {
    const deadlineAt = Math.min(inputDeadline ?? Infinity, Date.now() + 4500)
    try {
      const raw = await this.exec(['exec', '-i', '--user', '1000:1000', containerName(id),
        'timeout', '--signal=TERM', '--kill-after=0.5s', '5s', 'python3', '/opt/cloud-desktop/control.py'], signal,
        JSON.stringify({ ...command as object, deadlineAt }))
      return JSON.parse(raw)
    } catch (error) {
      if (inputDeadline !== undefined) {
        // A dead Docker CLI is not evidence that exec stopped inside the container.
        // Retain the owner barrier until the absolute input deadline and cleanup grace pass.
        await delay(Math.max(0, deadlineAt + 1500 - Date.now()))
      }
      throw error
    }
  }

  private async waitForDesktop(id: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        await this.command(id, { action: 'status' }, signal)
        return
      } catch (error) {
        if (!(error instanceof ProcessFailure) || signal.aborted) throw error
        await delay(250, undefined, { signal })
      }
    }
  }

  private async admit<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = this.admission
    let release!: () => void
    this.admission = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      signal.throwIfAborted()
      return await work()
    } finally {
      release()
    }
  }

  status(owner: string, id: string): Promise<WorkerComputer> {
    return this.operation(owner, id, async (signal) => this.result(id, await this.inspect(owner, id, signal)))
  }

  start(owner: string, id: string): Promise<WorkerComputer> {
    return this.operation(owner, id, async (signal) => this.admit(signal, async () => {
      await this.assertNetwork(signal)
      let instance = await this.inspect(owner, id, signal)
      if (!instance?.State.Running) await this.assertCapacity(owner, id, signal)
      if (!instance) {
        await this.exec(['image', 'inspect', this.config.CLOUD_WORKER_IMAGE], signal)
        await this.ensureVolume(owner, signal)
        await this.exec(createArguments(this.config, owner, id), signal)
        instance = await this.inspect(owner, id, signal)
      }
      if (!instance) throw new WorkerError(503, 'runtime_unavailable', 'Cloud computer creation failed.')
      this.assertContainerPolicy(instance)
      if (!instance.State.Running) await this.exec(['start', containerName(id)], signal)
      await this.waitForDesktop(id, signal)
      return { ...this.result(id, instance), state: 'running' }
    }))
  }

  stop(owner: string, id: string): Promise<WorkerComputer> {
    return this.operation(owner, id, async (signal) => {
      const instance = await this.inspect(owner, id, signal)
      if (!instance) return this.result(id, null)
      if (instance.State.Running) await this.exec(['stop', '--time', '10', containerName(id)], signal)
      return { ...this.result(id, instance), state: 'stopped' }
    })
  }

  private async running(owner: string, id: string, signal: AbortSignal): Promise<void> {
    const instance = await this.inspect(owner, id, signal)
    if (!instance?.State.Running) throw new WorkerError(409, 'computer_stopped', 'Start the cloud computer first.')
    this.assertContainerPolicy(instance)
    await this.assertNetwork(signal)
  }

  capture(owner: string, id: string): Promise<{ image: CloudImage }> {
    return this.operation(owner, id, async (signal, deadline) => {
      await this.running(owner, id, signal)
      const captured = await this.command(id, { action: 'screenshot' }, signal, deadline) as { image?: unknown }
      return { image: imageSchema.parse(captured.image) }
    }, 7000)
  }

  action(owner: string, id: string, action: CloudAction): Promise<{ ok: true }> {
    return this.operation(owner, id, async (signal, deadline) => {
      const validated = cloudActionSchema.parse(action)
      await this.running(owner, id, signal)
      await this.command(id, validated, signal, deadline)
      return { ok: true }
    }, 7000)
  }
}
