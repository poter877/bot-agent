import { createHash } from 'node:crypto'
import type { WorkerConfig } from './config.js'
import { COMPUTER_LABEL, MANAGED_LABEL, OWNER_LABEL } from './config.js'

export function ownerHash(owner: string): string {
  return createHash('sha256').update(owner).digest('hex')
}

export function containerName(id: string): string {
  return `bot-cloud-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}

export function volumeName(owner: string): string {
  return `bot-cloud-home-${ownerHash(owner).slice(0, 32)}`
}

export function createArguments(config: WorkerConfig, owner: string, id: string): string[] {
  return [
    'create', '--name', containerName(id), '--hostname', 'cloud-desktop',
    '--label', `${MANAGED_LABEL}=true`, '--label', `${OWNER_LABEL}=${ownerHash(owner)}`,
    '--label', `${COMPUTER_LABEL}=${id}`, '--label', `bot.cloud.width=${config.CLOUD_WORKER_WIDTH}`,
    '--label', `bot.cloud.height=${config.CLOUD_WORKER_HEIGHT}`,
    '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    // Hono advances generation before every restart; Docker must not bypass that fence.
    '--init', '--restart', 'no', '--network', config.CLOUD_WORKER_NETWORK,
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
    '--cpus', String(config.CLOUD_WORKER_CPUS), '--memory', `${config.CLOUD_WORKER_MEMORY_MB}m`,
    '--memory-swap', `${config.CLOUD_WORKER_MEMORY_MB}m`, '--pids-limit', '256', '--shm-size', '256m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', // no-tmp: ok — private container tmpfs for X11 and standard desktop applications.
    '--tmpfs', '/run/cloud-desktop:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000,mode=0700',
    '--mount', `type=volume,src=${volumeName(owner)},dst=/home/desktop`,
    '--env', `CLOUD_DESKTOP_WIDTH=${config.CLOUD_WORKER_WIDTH}`,
    '--env', `CLOUD_DESKTOP_HEIGHT=${config.CLOUD_WORKER_HEIGHT}`,
    '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2',
    ...(config.CLOUD_WORKER_RUNTIME ? ['--runtime', config.CLOUD_WORKER_RUNTIME] : []),
    config.CLOUD_WORKER_IMAGE,
  ]
}
