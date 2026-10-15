import type { Logger } from '../../shared/logger.js'
import type { CloudComputerService } from './service.js'

export function startCloudComputerReconciler(service: CloudComputerService | null, logger: Logger): () => Promise<void> {
  let active: Promise<void> | null = null
  let stopped = false
  const tick = () => {
    if (!service || active || stopped) return
    active = service.reconcile().catch((error: unknown) => {
      logger.error({ err: error }, 'cloud_computer_reconcile_failed')
    }).finally(() => { active = null })
  }
  const timer = setInterval(tick, 1000).unref()
  tick()
  return async () => {
    stopped = true
    clearInterval(timer)
    await active
  }
}
