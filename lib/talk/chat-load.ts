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

/** What the screen says when the server refused because the sign-in has ended (a retry can never fix that). */
export const SIGNED_OUT_MESSAGE = 'Your sign-in has ended. Close TD Talk and open it again to sign in.'

/** The server answered, but not with something the screen could read (a Wi-Fi sign-in page, a damaged body). */
export const BAD_ANSWER = 'bad answer'

/** The sign-in has ended: the server says 401, or 403 "Unauthorized" (the chat route's own words for no valid session). */
export function isSignedOut(f: ChatLoadFailure): boolean {
  return f.kind === 'http' && (f.status === 401 || (f.status === 403 && f.error === 'Unauthorized'))
}

/** What the screen says under "Could not load this chat." */
export function failureMessage(f: ChatLoadFailure): string {
  if (isSignedOut(f)) return SIGNED_OUT_MESSAGE
  if (f.kind === 'http' && (f.status === 403 || f.status === 404) && f.error) return f.error
  if (f.kind === 'timeout') return 'The connection is too slow. Check it and try again.'
  if (f.kind === 'network' && f.error === BAD_ANSWER) return 'The answer could not be read. Try again in a moment.'
  if (f.kind === 'network') return 'No connection. Check it and try again.'
  return 'The server could not read this chat. Try again in a moment.'
}

/** Is a "Try again" button worth showing? Only for what a second try can fix (never a refusal, a missing chat or an ended sign-in). */
export function canRetryAfter(f: ChatLoadFailure): boolean {
  return isRetryable(f)
}

/**
 * What a failed open means for the screen: `guess` = before the real chat list is in, the chat shown early may simply be gone or refused — say nothing,
 * stay on "Loading…" until the list corrects it; `failed` = say so. An ended sign-in is NEVER a guess (a signed-out phone must say so).
 */
export function classifyFailure(last: ChatLoadFailure, listConfirmed: boolean): 'guess' | 'failed' {
  if (isSignedOut(last)) return 'failed'
  if (!listConfirmed && last.kind === 'http' && (last.status === 403 || last.status === 404)) return 'guess'
  return 'failed'
}

/** Two loads are the same one only if they ask the same chat, under the same choice of chat, in the same silent/read mode (a "now I am looking at it" request must not be swallowed by an "I am not looking" one). */
export interface LoadKey { threadId: string; seq: number; silent: boolean; viewed: boolean }
export const sameLoad = (a: LoadKey, b: LoadKey): boolean => a.threadId === b.threadId && a.seq === b.seq && a.silent === b.silent && a.viewed === b.viewed

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

export type ChatLoadOutcome =
  | { kind: 'applied'; attempts: number; first: ChatLoadFailure | null }
  /** Nothing more to do: another chat was chosen, a newer answer is already on screen, or the caller chose to ignore this answer. */
  | { kind: 'ignored' }
  | { kind: 'failed'; attempts: number; first: ChatLoadFailure; last: ChatLoadFailure }

export interface RunChatLoadArgs {
  /** A background refresh: one try, no retry. */
  silent: boolean
  /** Still the chat (and the choice of chat) this load started for. */
  isCurrent: () => boolean
  /** A newer good answer was applied while this open was still trying (a background refresh got through): stop, it is not failed. */
  newerGoodAnswer: () => boolean
  /** Is the person looking at the screen RIGHT NOW? Asked before EVERY try: the server marks the chat read only for a request that says so. */
  viewedNow: () => boolean
  limitFor: (light: boolean) => number
  urlFor: (markReadQuery: string, limit: number) => string
  fetchAnswer: (url: string) => Promise<ChatFetchResult>
  /** Puts an answer on screen. true = applied, false = deliberately ignored. A throw means the answer was unusable (it is tried again like any failure). */
  apply: (data: unknown, viewed: boolean) => boolean
  wait: (ms: number) => Promise<void>
  /** Called before each try (the screen keeps a tapped message link alive while its chat is still loading). */
  beforeAttempt?: () => void
}

/** The whole "open a chat" ladder as one function over injected parts, so its rules are tested by running it. */
export async function runChatLoad(a: RunChatLoadArgs): Promise<ChatLoadOutcome> {
  const steps = a.silent ? [LOAD_STEPS[0]] : LOAD_STEPS
  let first: ChatLoadFailure | null = null
  let last: ChatLoadFailure | null = null
  let attempts = 0
  for (const step of steps) {
    if (step.delayMs) await a.wait(step.delayMs)
    if (!a.isCurrent()) return { kind: 'ignored' }
    if (!a.silent && a.newerGoodAnswer()) return { kind: 'ignored' }
    a.beforeAttempt?.()
    attempts++
    const viewed = a.viewedNow()
    const res = await a.fetchAnswer(a.urlFor(viewed ? '' : '?mark_read=0', a.limitFor(step.light)))
    if (!a.isCurrent()) return { kind: 'ignored' }
    let fail: ChatLoadFailure
    if (res.ok === true) {
      try {
        if (!a.apply(res.data, viewed)) return { kind: 'ignored' }
        return { kind: 'applied', attempts, first }
      } catch {
        fail = { kind: 'network', error: BAD_ANSWER, elapsedMs: res.elapsedMs }
      }
    } else {
      fail = res as ChatLoadFailure
    }
    if (!a.silent && a.newerGoodAnswer()) return { kind: 'ignored' }
    first = first ?? fail
    last = fail
    if (!isRetryable(fail)) break
  }
  return { kind: 'failed', attempts, first: first as ChatLoadFailure, last: last as ChatLoadFailure }
}

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
