/**
 * Commands from the CRM to the Mac-side WhatsApp bridge — PURE, no I/O, unit-tested.
 *
 * The CRM cannot call the Mac, so the Mac asks: every heartbeat reply carries what is wanted (`wabridge_take_commands`):
 *   - want_code     → "Get a new code" was pressed while the device is unlinked: fetch ONE pairing code from GOWA and post it
 *   - recover_days  → "Recover missing messages" was pressed: run the normal catch-up over that many days and report back
 * The Mac reports a recover job as a signed `{event:"bridge.recover.result", ts, saved, read}`.
 */

import { HEARTBEAT_MAX_SKEW_MS } from "./wabridge-health"

/** What the Mac is told on its heartbeat. */
export interface BridgeCommands {
  want_code: boolean
  recover_days: number | null
}

export const NO_COMMANDS: BridgeCommands = { want_code: false, recover_days: null }

/** Normalise the database answer; anything unexpected means "nothing to do" (a bad reply must never start work on the Mac). */
export function normalizeCommands(raw: unknown): BridgeCommands {
  if (typeof raw !== "object" || raw === null) return NO_COMMANDS
  const r = raw as Record<string, unknown>
  const days = typeof r.recover_days === "number" && Number.isInteger(r.recover_days) && r.recover_days >= 1 && r.recover_days <= 30 ? r.recover_days : null
  return { want_code: r.want_code === true, recover_days: days }
}

export type RecoverResultParse =
  | null // not a recover-result event at all
  | { ok: false; reason: string }
  | { ok: true; saved: number; read: number }

const MAX_COUNT = 100_000

/** Validate an untrusted bridge.recover.result body: fresh signed timestamp + two sane counts. */
export function parseRecoverResult(body: unknown, now: Date): RecoverResultParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.recover.result") return null
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing timestamp" }
  }
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null)
  const saved = count(b.saved)
  const read = count(b.read)
  if (saved === null || read === null) return { ok: false, reason: "bad counts" }
  if (saved > read) return { ok: false, reason: "saved is more than read" }
  return { ok: true, saved, read }
}

/** How long the screen waits for the Mac before saying it did not answer. The database drops an unanswered request after 5 minutes. */
export const RECOVER_WAIT_MS = 3 * 60_000
/** How long a finished result stays on the screen. */
export const RECOVER_RESULT_SHOW_MS = 10 * 60_000

export interface RecoverFields {
  recover_requested_at?: string | null
  recover_started_at?: string | null
  recover_done_at?: string | null
  recover_saved?: number | null
  recover_read?: number | null
}

export type RecoverView =
  | { state: "idle" }
  | { state: "waiting" } // pressed, the Mac has not picked it up yet
  | { state: "running" } // the Mac picked it up and is reading
  | { state: "done"; saved: number; read: number; at: string }
  | { state: "no_answer" } // pressed more than RECOVER_WAIT_MS ago and nothing came back (Mac off / offline)

/** The Recover button's state, derived from the database row alone. */
export function recoverView(f: RecoverFields | null | undefined, now: Date): RecoverView {
  if (!f || !f.recover_requested_at) return { state: "idle" }
  const requested = Date.parse(f.recover_requested_at)
  if (Number.isNaN(requested)) return { state: "idle" }
  if (f.recover_done_at) {
    const done = Date.parse(f.recover_done_at)
    if (Number.isNaN(done) || now.getTime() - done > RECOVER_RESULT_SHOW_MS) return { state: "idle" }
    return { state: "done", saved: f.recover_saved ?? 0, read: f.recover_read ?? 0, at: f.recover_done_at }
  }
  if (now.getTime() - requested > RECOVER_WAIT_MS) return { state: "no_answer" }
  return f.recover_started_at ? { state: "running" } : { state: "waiting" }
}

/** Plain words for a finished recover job. */
export function describeRecoverDone(saved: number, read: number): string {
  if (saved === 0) return read === 0 ? "Nothing to recover — the phone's history is empty." : "Nothing missing — everything the phone has is already in the CRM."
  return saved === 1 ? "1 missing message recovered." : `${saved} missing messages recovered.`
}

/** The state of the "Get a new code" request, derived from the database row alone. */
export function codeRequestView(
  f: { link_code_wanted_at?: string | null; link_attempts?: number | null; link_window_at?: string | null } | null | undefined,
  now: Date,
): { requested: boolean; limitUntil: string | null } {
  const wanted = f?.link_code_wanted_at ? Date.parse(f.link_code_wanted_at) : NaN
  const requested = !Number.isNaN(wanted) && now.getTime() - wanted <= 5 * 60_000
  const win = f?.link_window_at ? Date.parse(f.link_window_at) : NaN
  const limitUntil = !Number.isNaN(win) && now.getTime() - win < 60 * 60_000 && (f?.link_attempts ?? 0) >= 5 ? new Date(win + 60 * 60_000).toISOString() : null
  return { requested, limitUntil }
}
