import { $accountAuth } from '@/store/account-auth'
import { $activeConnectionId } from '@/store/connections'
import { requestGatewayForAgent } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import type { CloudRequest } from './protocol'
import { createCloudComputerSession } from './session'

export function connectCloudComputer() {
  const accountId = $accountAuth.get().user?.id
  const connectionId = $activeConnectionId.get()
  const profile = $activeGatewayProfile.get()
  const backend = $connection.get()?.baseUrl

  const isCurrent = () =>
    $accountAuth.get().phase === 'authenticated' &&
    $accountAuth.get().user?.id === accountId &&
    $activeConnectionId.get() === connectionId &&
    $activeGatewayProfile.get() === profile &&
    $connection.get()?.baseUrl === backend

  const request: CloudRequest = (method, params = {}, signal) => {
    if (!isCurrent()) {
      return Promise.reject(new Error('Account or connection changed.'))
    }

    // The owner route is captured once. Never replay an input on the newly focused backend.
    return requestGatewayForAgent(connectionId, profile, method, { ...params, profile }, 60_000, signal, {
      spawnPriority: 'foreground'
    })
  }

  const session = createCloudComputerSession(request, isCurrent)

  const check = () => {
    if (!isCurrent()) {
      session.dispose()
    }
  }

  const off = [
    $accountAuth.listen(check),
    $activeConnectionId.listen(check),
    $activeGatewayProfile.listen(check),
    $connection.listen(check)
  ]

  return {
    ...session,
    dispose() {
      off.forEach(unsubscribe => unsubscribe())
      session.dispose()
    }
  }
}
