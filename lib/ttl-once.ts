/**
 * A tiny "remember the answer for a little while" holder (dev job cf265457), used where a lookup is slow and a slightly old answer is harmless
 * (the staff names on TD Talk's chat list).
 *
 * - A fresh answer is returned without calling `load` again.
 * - Callers that arrive while a load is already running share that one load (no pile-up of identical slow requests).
 * - A load that fails is NOT remembered: the next caller tries again, and the failure reaches the callers that were waiting on it.
 * - Per server instance only (module memory); another instance simply loads its own copy.
 * `now` is injectable so tests move the clock instead of waiting.
 */
export function createTtlOnce<T>(ttlMs: number, now: () => number = Date.now) {
  let value: T | undefined
  let loadedAt = -Infinity
  let running: Promise<T> | null = null

  return {
    async get(load: () => Promise<T>): Promise<T> {
      if (value !== undefined && now() - loadedAt < ttlMs) return value
      if (running) return running
      const started = load()
        .then(v => {
          value = v
          loadedAt = now()
          return v
        })
        .finally(() => { running = null })
      running = started
      return started
    },
    /** Forget the remembered answer (the next `get` loads again). */
    clear() {
      value = undefined
      loadedAt = -Infinity
    },
  }
}
