/**
 * Opening a TD Talk chat: what counts as a failed load, when to try again, and what to tell the person.
 *
 * Antonio (2026-11-24): tapping a lock-screen alert opened TD Talk with "No messages yet. Say hello." — going back and tapping the chat again showed them.
 * Reproduced: when the FIRST chat request fails (a phone that has just woken up), the screen swallowed the error and drew the same words as a really
 * empty chat until the 10-second refresh. RULE: a chat that could not be loaded is NEVER drawn as an empty chat. It says so, tries again by itself,
 * and offers a Retry button. "No messages yet" is only for an answer the server gave and found nothing.
 *
 * Pure (no React), so the rules are unit-tested; the screen (components/talk/talk-app.tsx) only calls these.
 */

/** A chat request that has not answered after this long is treated as failed (a dead connection after a wake never errors by itself). */
export const CHAT_LOAD_TIMEOUT_MS = 15_000

export type ChatLoadFailureKind = 'network' | 'timeout' | 'http'

export interface ChatLoadFailure {
  kind: ChatLoadFailureKind
  /** The HTTP status (only for `http`). */
  status?: number
  /** The server's own words, when it gave some (never shown for a 5xx: those are said the same way every time). */
  error?: string
  elapsedMs: number
}

export type ChatFetchResult = { ok: true; data: unknown; elapsedMs: number } | ({ ok: false } & ChatLoadFailure)

/** The tries a chat opened by the person makes: the same request, the same again after 0.5 s, then the light one (newest 60, no message jump) after 1.5 s. */
export const LOAD_STEPS: ReadonlyArray<{ delayMs: number; light: boolean }> = [
  { delayMs: 0, light: false },
  { delayMs: 500, light: false },
  { delayMs: 1500, light: true },
]

/**
 * Worth trying again: no connection, no answer in time, a server fault, "busy" or "slow down". NEVER a refusal (401/403) or a chat that is gone (404):
 * trying again cannot change those.
 */
export function isRetryable(f: ChatLoadFailure): boolean {
  if (f.kind !== 'http') return true
  const s = f.status ?? 0
  return s >= 500 || s === 408 || s === 429
}

/** What the screen says under "Could not load this chat." */
export function failureMessage(f: ChatLoadFailure): string {
  if (f.kind === 'http' && (f.status === 403 || f.status === 404) && f.error) return f.error
  if (f.kind === 'timeout') return 'The connection is too slow. Check it and try again.'
  if (f.kind === 'network') return 'No connection. Check it and try again.'
  return 'The server could not read this chat. Try again in a moment.'
}

/** One chat request with a time limit and the server's own words kept on a refusal (R099). `fetchFn` is injected so the rules can be tested. */
export async function fetchChatAnswer(
  url: string,
  fetchFn: (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> = (u, i) => fetch(u, i),
  timeoutMs: number = CHAT_LOAD_TIMEOUT_MS,
): Promise<ChatFetchResult> {
  const startedAt = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchFn(url, { signal: ctl.signal })
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { error?: unknown }
      return { ok: false, kind: 'http', status: r.status, error: typeof d?.error === 'string' ? d.error : undefined, elapsedMs: Date.now() - startedAt }
    }
    // an answer that is not the server's JSON (a Wi-Fi sign-in page) is a failure too, not an empty chat
    const data = await r.json()
    return { ok: true, data, elapsedMs: Date.now() - startedAt }
  } catch {
    return { ok: false, kind: ctl.signal.aborted ? 'timeout' : 'network', elapsedMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** What is reported (to Sentry) so the real cause on a real phone becomes visible the next time. No message text, no names. */
export interface TalkLoadReport {
  event: 'failed' | 'recovered' | 'suspect_empty'
  threadId: string
  attempts: number
  firstFailure?: { kind: ChatLoadFailureKind; status?: number; elapsedMs: number }
  limit: number
  hadMessageLink: boolean
  hadSavedCopy: boolean
  visibility: string
  online: boolean
}

export function buildLoadReport(r: TalkLoadReport): { message: string; level: 'error' | 'warning'; tags: Record<string, string>; extra: Record<string, unknown> } {
  return {
    message: `talk_chat_load_${r.event}`,
    level: r.event === 'failed' ? 'error' : 'warning',
    tags: { area: 'talk', event: r.event, failure: r.firstFailure ? (r.firstFailure.status ? `${r.firstFailure.kind}_${r.firstFailure.status}` : r.firstFailure.kind) : 'none' },
    extra: { ...r },
  }
}

/** Best effort, never throws, never waits: a report must not be able to break the chat. (Sentry is only switched on in production.) */
export function reportTalkLoad(r: TalkLoadReport): void {
  try {
    const rep = buildLoadReport(r)
    void import('@sentry/nextjs')
      .then(S => { S.captureMessage(rep.message, { level: rep.level, tags: rep.tags, extra: rep.extra }) })
      .catch(() => { /* ignore */ })
  } catch { /* ignore */ }
}
