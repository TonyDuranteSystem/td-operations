/**
 * New Calendar — "update by itself" rules (dev job 40235e3c, Antonio 2026-10-16: "the page should refresh automatically and right away when
 * we do something, not a hard refresh or waiting"). PURE: the timings and the event test, so they are unit-tested. The component
 * (components/new-calendar/live-refresh.tsx) only wires them to the browser.
 *
 * A job change reaches the page as a `td-ui-event` of kind `jobs` (a database trigger writes it; the dashboard's UiEventListener turns it into
 * that DOM event). Several signals in a burst (a batch of moves) collapse into ONE refresh: a trailing debounce with a MAX WAIT, so a
 * long unbroken stream cannot postpone the refresh forever. A slow safety poll covers a dropped socket and the time before the database
 * trigger exists.
 */

/** Wait this long after the LAST signal before refreshing (so a burst becomes one refresh). */
export const LIVE_DEBOUNCE_MS = 800
/** Never wait longer than this after the FIRST signal of a burst. */
export const LIVE_MAX_WAIT_MS = 4_000
/** Safety net: refresh this often while the tab is visible, whatever else happens. */
export const LIVE_POLL_MS = 60_000

/** True for the `td-ui-event` detail of a job change. Tolerates any shape (it comes from the network). */
export function isJobsEvent(detail: unknown): boolean {
  return !!detail && typeof detail === "object" && (detail as { kind?: unknown }).kind === "jobs"
}

/**
 * How long to wait before refreshing, given the time of this signal and of the first signal of the burst (null = this IS the first).
 * Always between 0 and LIVE_DEBOUNCE_MS, and never past the burst's max wait.
 */
export function refreshDelay(nowMs: number, firstSignalMs: number | null): number {
  const waited = firstSignalMs === null ? 0 : Math.max(0, nowMs - firstSignalMs)
  return Math.max(0, Math.min(LIVE_DEBOUNCE_MS, LIVE_MAX_WAIT_MS - waited))
}
