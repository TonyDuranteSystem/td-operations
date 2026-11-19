/**
 * The WhatsApp program on the Mac (GOWA) updates itself every night (`~/wa-bridge/gowa-update.sh`) and signs a report of what happened to
 * this receiver. This file is the pure part: checking the report, and turning the LAST report into the plain-English notice the Inbox
 * WhatsApp banner shows. No I/O, so every rule is unit-tested.
 */

export const UPDATE_STATES = ["up_to_date", "updated", "update_available", "needs_review", "update_failed", "rolled_back", "broken", "check_failed"] as const
export type UpdateState = (typeof UPDATE_STATES)[number]

/** A report body is only accepted if its signed timestamp is this fresh (blocks replaying a captured report). */
export const UPDATE_REPORT_MAX_SKEW_MS = 2 * 60_000
/** The nightly run should report every day; silence for this long means the updater itself is not running. */
export const UPDATE_REPORT_STALE_MS = 3 * 24 * 3_600_000
const MAX_TEXT = 400

export interface UpdateReport {
  state: UpdateState
  message: string
  current: string
  latest: string
  checked_at: string
}

export type UpdateParse = { ok: true; report: UpdateReport } | { ok: false; reason: string } | null

const clean = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "")

export function parseUpdateReport(body: unknown, now: Date): UpdateParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.update.status") return null
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > UPDATE_REPORT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing timestamp" }
  }
  const state = b.state
  if (typeof state !== "string" || !(UPDATE_STATES as readonly string[]).includes(state)) return { ok: false, reason: "unknown state" }
  return {
    ok: true,
    report: { state: state as UpdateState, message: clean(b.message), current: clean(b.current, 40), latest: clean(b.latest, 40), checked_at: now.toISOString() },
  }
}

export interface UpdateNotice {
  /** problem = red (WhatsApp may be down); warning = amber (working, but a person should look) */
  level: "problem" | "warning"
  title: string
  text: string
}

/** The notice for the LAST report, or null when everything is fine (or the updater has never reported). */
export function updateNotice(row: { update_status?: unknown; update_status_at?: string | null } | null | undefined, now: Date): UpdateNotice | null {
  const at = row?.update_status_at ? Date.parse(row.update_status_at) : NaN
  const s = row?.update_status
  if (!Number.isFinite(at) || typeof s !== "object" || s === null) return null
  const st = s as Partial<UpdateReport>
  const days = Math.floor((now.getTime() - at) / 86_400_000)
  if (now.getTime() - at > UPDATE_REPORT_STALE_MS) {
    return {
      level: "warning",
      title: "The WhatsApp program has stopped checking for updates",
      text: `No update check was reported for ${days} days. Voice notes and other features can break when WhatsApp changes and the program is old. Ask Claude to check the Mac.`,
    }
  }
  switch (st.state) {
    case "broken":
      return { level: "problem", title: "WhatsApp may be down after an update", text: `${st.message || "An update failed and the old version could not be restored."} Check that WhatsApp shows as connected, then ask Claude.` }
    case "rolled_back":
      return { level: "warning", title: "The WhatsApp update went back to the old version", text: "A nightly update did not work, so the old version was put back. Messages are working. Nothing to do now: ask Claude to look at it." }
    case "update_failed":
      return { level: "warning", title: "The WhatsApp update could not be installed", text: `${st.message || "The new version was not installed."} The old version is still running and messages work. Ask Claude to look at it.` }
    case "needs_review":
      return { level: "warning", title: "A big WhatsApp program update is waiting for review", text: `${st.latest ? `Version ${st.latest} is out. ` : ""}It is not installed automatically because it may change how things work. Ask Claude to review it.` }
    default:
      return null
  }
}
