import { z } from 'zod'

const schema = z.object({
  CLOUD_WORKER_TOKEN: z.string().min(32),
  CLOUD_WORKER_HOST: z.string().default('127.0.0.1'),
  CLOUD_WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3031),
  CLOUD_WORKER_DOCKER: z.string().default('docker'),
  CLOUD_WORKER_IPTABLES: z.string().default('iptables'),
  CLOUD_WORKER_PYTHON: z.string().default('python3'),
  CLOUD_WORKER_IMAGE: z.string().min(1).default('bot-cloud-desktop:local'),
  CLOUD_WORKER_NETWORK: z.string().regex(/^[A-Za-z0-9_-]+$/).default('bot-cloud-desktop'),
  CLOUD_WORKER_RUNTIME: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  CLOUD_WORKER_WIDTH: z.coerce.number().int().min(640).max(3840).default(1440),
  CLOUD_WORKER_HEIGHT: z.coerce.number().int().min(480).max(2160).default(900),
  CLOUD_WORKER_CPUS: z.coerce.number().min(0.25).max(16).default(2),
  CLOUD_WORKER_MEMORY_MB: z.coerce.number().int().min(512).max(32768).default(2048),
  CLOUD_WORKER_MAX_RUNNING: z.coerce.number().int().min(1).max(1000).default(10),
})

export type WorkerConfig = z.infer<typeof schema>
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return schema.parse(env)
}

export const NETWORK_POLICY_LABEL = 'bot.cloud.network-policy'
export const NETWORK_POLICY = 'restricted-v1'
export const OWNER_LABEL = 'bot.cloud.owner'
export const COMPUTER_LABEL = 'bot.cloud.computer'
export const MANAGED_LABEL = 'bot.cloud.managed'
