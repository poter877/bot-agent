import type { CloudRequest } from './protocol'

/** The server serializes each computer; one viewer must not race itself for that lock. */
export function createCloudRequestQueue(transport: CloudRequest, isCurrent: () => boolean) {
  let tail = Promise.resolve()
  let pending = 0

  const request: CloudRequest = <T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
    pending += 1

    const result = tail.then(() => {
      if (!isCurrent() || signal?.aborted) {
        throw new DOMException('Viewer retired', 'AbortError')
      }

      return transport<T>(method, params, signal)
    })

    tail = result.then(
      () => undefined,
      () => undefined
    )

    return result.finally(() => {
      pending -= 1
    })
  }

  return { request, pending: () => pending }
}
