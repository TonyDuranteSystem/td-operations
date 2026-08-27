/**
 * Whether a client's locked package pick can still be undone by staff.
 *
 * Deliberately its own tiny, dependency-free file rather than living inline
 * in lib/offers/package-pick.ts: that module pulls in supabaseAdmin (a
 * server-only client keyed by the service-role secret), so a CRM button that
 * needs to decide "should I even show?" cannot import it without dragging a
 * server-only module into the client bundle. Exporting the rule on its own
 * means the server enforcement (resetPackagePick) and the CRM button that
 * offers the action read the EXACT same definition — never two independently
 * hand-typed copies of "which statuses count as closed" drifting apart.
 *
 * NOT the same rule as the client-facing pick-package route's blocked-status
 * check (that one also blocks 'expired' — a different question, "can the
 * client still pick", not "can staff still undo one"; 'expired' stays
 * reachable here on purpose because staff may legitimately want to reopen an
 * offer that only lapsed on time, unlike the two statuses below).
 *
 * 'superseded' WAS missing from this list until it was found reachable for
 * the first time (bug-hunter, full E2E QA, 2026-08-27) — before the
 * offers_status_check migration that finally let 'superseded' exist at all,
 * this gap was structurally impossible to hit. It is added here, not left to
 * the pick-package-style reasoning above: a superseded offer is not "the
 * current document, just past its window" the way an expired one is — its
 * replacement already exists as a SEPARATE token, and revise-offer/route.ts's
 * own contract is that the original is "PRESERVED — never deleted or
 * modified beyond status + superseded_by". Letting a stale render of the OLD
 * version undo the client's historical pick would violate that directly.
 *
 * The array is exported too so resetPackagePick's own database write can be
 * conditioned on it directly (a `.not("status", "in", ...)` built from this
 * same list) instead of re-typing the values a second time — the write
 * enforces the rule atomically; this function is for a caller (the CRM
 * button) that only needs to decide whether to render at all.
 */
export const PACKAGE_PICK_LOCKED_STATUSES = ["signed", "completed", "superseded"] as const

export function canResetPackagePick(status: string | null | undefined): boolean {
  return !(PACKAGE_PICK_LOCKED_STATUSES as readonly string[]).includes(status ?? "")
}
