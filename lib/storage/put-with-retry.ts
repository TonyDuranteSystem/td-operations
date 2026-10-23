/**
 * Send a file to a Supabase signed upload link, and try again when the CONNECTION (not the file) is what failed.
 *
 * Why: a LAN→WiFi switch or a Cloudflare hiccup (status 520) failed a whole upload at the first try, with no second
 * chance (Antonio 2026-10-23). Every upload screen sent the bytes with one bare `fetch(...PUT...)`.
 *
 * The one rule that makes a retry safe: EVERY attempt asks for a FRESH link and a FRESH staging path (`prepare()` is
 * called again). A signed upload link is single-use, and a first attempt that half-succeeded would otherwise make the
 * second one fail with "already exists". Staging paths carry a timestamp + random part, so a fresh `prepare()` gives a
 * new one; a half-written first copy is left behind in the staging bucket (the staging clean-up already removes those).
 *
 * What is retried: the network failing (fetch throws), a server error (5xx, incl. Cloudflare's 520–524), "request
 * timeout" (408) and "slow down" (429). What is NOT: any other 4xx (the file or the link was refused — trying again
 * cannot help) — that surfaces at once with the real status.
 */

export interface PutTarget {
  signedUrl: string
  /** the staging path this link writes to — returned so the caller registers exactly the copy that arrived */
  path?: string
}

/**
 * Deliberately a FLAT shape, not a union on `ok`: this repo compiles with `strict: false`, where narrowing a union by a
 * boolean literal does not work (the build failed on `put.message` after `if (!put.ok)`). `message` is '' and `status`
 * null on success; `path` is only set on success.
 */
export interface PutOutcome {
  ok: boolean
  path?: string
  status: number | null
  message: string
  attempts: number
}

export interface PutWithRetryOptions {
  /** called before EVERY attempt: returns a fresh link (and path). May throw. */
  prepare: () => Promise<PutTarget>
  file: Blob
  contentType?: string
  /** total tries, first one included (default 3) */
  attempts?: number
  /** wait before try 2, try 3 … (default 1.5 s, 4 s) */
  delaysMs?: number[]
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** told before each wait, so a screen can say "connection problem — trying again (2 of 3)" */
  onRetry?: (info: { attempt: number; of: number; status: number | null }) => void
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Statuses worth a second try. Everything else below 500 means the request itself was refused. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

/** A thrown `fetch` error with no HTTP status is the network failing ("Failed to fetch", "Load failed", …). */
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError
}

export function putFailureMessage(status: number | null, attempts: number): string {
  const tried = attempts > 1 ? ` after ${attempts} tries` : ''
  return status === null
    ? `The file could not be sent (connection lost)${tried} — check the connection and try again.`
    : `The file could not be sent (status ${status})${tried} — please try again.`
}

export async function putFileWithRetry(opts: PutWithRetryOptions): Promise<PutOutcome> {
  const total = Math.max(1, opts.attempts ?? 3)
  const delays = opts.delaysMs ?? [1500, 4000]
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? wait
  let lastStatus: number | null = null
  let attempt = 0
  while (attempt < total) {
    attempt++
    let target: PutTarget
    try {
      target = await opts.prepare()
    } catch (e) {
      // the link request itself failed: retry only when it was the network; a refusal (403 …) says so at once
      if (isNetworkError(e) && attempt < total) {
        lastStatus = null
        opts.onRetry?.({ attempt, of: total, status: null })
        await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0)
        continue
      }
      if (isNetworkError(e)) return { ok: false, status: null, message: putFailureMessage(null, attempt), attempts: attempt }
      throw e
    }
    let status: number | null = null
    try {
      const res = await doFetch(target.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': opts.contentType || (opts.file as File).type || 'application/octet-stream' },
        body: opts.file,
      })
      if (res.ok) return { ok: true, path: target.path, status: res.status, message: '', attempts: attempt }
      status = res.status
      if (!isRetryableStatus(status)) return { ok: false, status, message: putFailureMessage(status, attempt), attempts: attempt }
    } catch (e) {
      if (!isNetworkError(e)) throw e
      status = null
    }
    lastStatus = status
    if (attempt < total) {
      opts.onRetry?.({ attempt, of: total, status })
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0)
    }
  }
  return { ok: false, status: lastStatus, message: putFailureMessage(lastStatus, total), attempts: total }
}
