/**
 * A guard that lets ONE call at a time through, decided synchronously (a ref, not React state): three clicks in the same instant start
 * ONE action, because a state-based "busy" flag only changes at the next render. Used where an action cannot be taken back (an IRS fax).
 */
export function createOnceGuard() {
  let running = false
  return {
    /** Runs `fn` unless one is already running (then returns `undefined` at once). The guard opens again when `fn` finishes or throws. */
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined
      running = true
      try { return await fn() } finally { running = false }
    },
    get busy() { return running },
  }
}
