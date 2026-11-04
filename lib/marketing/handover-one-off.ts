/**
 * TD Marketing — the rules of the one-off hand-over step (pure; dev job 9aec66fa, plan of 3 Nov 2026, Release 1). `scripts/marketing/handover-one-off.ts` reads the leads and writes; what to do with each lead is decided here.
 * A lead booked or passed BEFORE the new flow is unpicked, and one at Rocco's old "Contacted" step (seller_contacted) has no column any more. No database here.
 */
export interface OneOffLead { id: string; status: string; claimed_by: string | null }
export interface OneOffEvent { kind: string; data: Record<string, unknown> | null; created_at: string }
export const CALL_OVER_MS = 30 * 60_000

/** The newest call time still standing (a later cancel clears it; Antonio's "view as" rows are not the team's work). */
export function newestCall(events: readonly OneOffEvent[]): string | null {
  let at: string | null = null
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (e.kind !== "appointment" || e.data?.via_view_as === true) continue
    const v = e.data?.at
    at = typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null
  }
  return at
}

export interface OneOffPlan { call: string | null; /** give the lead to the seller */ pick: boolean; /** move it back from "seller_contacted" to "booked" */ toBooked: boolean; shows: "Calls prenotate" | "After the call" | "skip" }

export function planOneOff(lead: OneOffLead, events: readonly OneOffEvent[], now: Date): OneOffPlan {
  const call = newestCall(events)
  const toBooked = lead.status === "seller_contacted"
  const stage = toBooked ? "booked" : lead.status
  if (stage !== "booked" && stage !== "showed") return { call, pick: false, toBooked: false, shows: "skip" }
  const over = !call || Date.parse(call) + CALL_OVER_MS < now.getTime()
  return { call, pick: lead.claimed_by === null, toBooked, shows: over ? "After the call" : "Calls prenotate" }
}
