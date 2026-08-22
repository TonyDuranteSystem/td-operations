/**
 * Race a promise against a timeout. On timeout the returned promise rejects
 * with Error('timeout') immediately — but the original promise keeps running,
 * JS can't cancel it. If it settles later, `onLateSettle` fires so the caller
 * can clean up anything the late result left behind (e.g. a push subscription
 * that was created but never saved to the server before we gave up on it).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onLateSettle?: (
    result: { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown },
  ) => void,
): Promise<T> {
  let settled = false
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('timeout'))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        if (settled) {
          onLateSettle?.({ status: 'fulfilled', value })
          return
        }
        settled = true
        resolve(value)
      },
      (reason) => {
        clearTimeout(timer)
        if (settled) {
          onLateSettle?.({ status: 'rejected', reason })
          return
        }
        settled = true
        reject(reason)
      },
    )
  })
}
