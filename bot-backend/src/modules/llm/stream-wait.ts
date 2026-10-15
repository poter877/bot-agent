/** A heartbeat races the same pending read until it completes. Starting another
 * iterator.next() would consume (and silently discard) the signed model part. */
export async function waitForStreamEvent<T>(pending: Promise<IteratorResult<T>>, wakeAt: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.then(result => ({ kind: 'event' as const, result })),
      new Promise<{ kind: 'wake' }>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'wake' }), Math.max(0, wakeAt - Date.now()))
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
