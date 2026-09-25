/**
 * Reconnect-from-the-CRM helpers for the self-hosted WhatsApp bridge — PURE, no I/O, unit-tested.
 *
 * When WhatsApp unlinks the device (bridge health = "unlinked"), the Mac asks its own GOWA for a pairing code and posts it
 * as a signed `{event:"bridge.linkcode", ts, code}`. The CRM stores only the latest code (wa_bridge_state.link_code) and the
 * owner-only page shows it — while it is still fresh and the bridge is still unlinked — so Antonio can type it into
 * WhatsApp > Linked devices > Link with phone number.
 */

import { HEARTBEAT_MAX_SKEW_MS, type BridgeHealth } from "./wabridge-health"

/** A pairing code is only shown while it is this fresh (WhatsApp codes are short-lived; the Mac refreshes about every 2 min). */
export const LINK_CODE_MAX_AGE_MS = 2 * 60_000

/** GOWA returns e.g. "ABCD-1234" (9 chars). Accept 8 letters/digits with or without the hyphen; normalise to the hyphenated form. */
const LINK_CODE_RE = /^([A-Z0-9]{4})-?([A-Z0-9]{4})$/

export type LinkCodeParse =
  | null // not a linkcode event at all
  | { ok: false; reason: string }
  | { ok: true; code: string }

/** Validate an untrusted bridge.linkcode body: fresh signed timestamp + a well-formed code. Never echoes the code in a reason. */
export function parseLinkCode(body: unknown, now: Date): LinkCodeParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.linkcode") return null
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing timestamp" }
  }
  if (typeof b.code !== "string") return { ok: false, reason: "missing code" }
  const m = LINK_CODE_RE.exec(b.code.trim().toUpperCase())
  if (!m) return { ok: false, reason: "malformed code" }
  return { ok: true, code: `${m[1]}-${m[2]}` }
}

export interface LinkCodeView {
  /** The code to show, or null. Only ever set for the owner, only while unlinked, only while fresh. */
  code: string | null
  /** Seconds since the code arrived (for the countdown), or null. */
  ageSeconds: number | null
}

/**
 * What the status route may reveal. The code is shown only when ALL hold: the caller is the owner, the bridge is
 * currently "unlinked", and the code is under LINK_CODE_MAX_AGE_MS old. Anything else returns no code.
 */
export function visibleLinkCode(
  input: { isOwner: boolean; health: BridgeHealth | "unmonitored" | "none"; code?: string | null; codeAt?: string | null },
  now: Date,
): LinkCodeView {
  if (!input.isOwner || input.health !== "unlinked" || !input.code || !input.codeAt) return { code: null, ageSeconds: null }
  const at = Date.parse(input.codeAt)
  if (Number.isNaN(at)) return { code: null, ageSeconds: null }
  const age = now.getTime() - at
  if (age < 0 || age > LINK_CODE_MAX_AGE_MS) return { code: null, ageSeconds: null }
  return { code: input.code, ageSeconds: Math.floor(age / 1000) }
}
