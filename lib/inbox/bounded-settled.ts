/**
 * Bounded-concurrency Promise.allSettled (INCIDENT 2026-08-02).
 *
 * The inbox list enriches a page by fetching thread metadata from Gmail. It used
 * a bare `Promise.allSettled(threads.map(fetch))` over up to 300 threads — i.e.
 * 300 simultaneous calls. Gmail allows ~250 quota units/user/second and
 * `threads.get` costs 10, so ~25 calls/sec is the real ceiling: the burst
 * self-throttled, most calls came back rate-limited, and every rejected thread
 * rendered as a "Couldn't load this email — retrying" stub. Any other Gmail
 * activity (a capture cron, a second staff member) made it far worse.
 *
 * This runs the same work with a ceiling on in-flight requests, preserving
 * allSettled's contract exactly: same order, same {status, value|reason} shape,
 * never throws. Fewer requests are rejected, so fewer rows stub out.
 */
export type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }

/**
 * Like `Promise.allSettled(items.map(fn))` but with at most `concurrency`
 * promises in flight. Results are returned in INPUT ORDER.
 */
export async function allSettledBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  const out = new Array<Settled<R>>(items.length)
  if (items.length === 0) return out
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))

  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i], i) }
      } catch (reason) {
        out[i] = { status: "rejected", reason }
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
  return out
}
