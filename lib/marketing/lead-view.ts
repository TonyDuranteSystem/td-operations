/** Small pure helpers for showing a lead (client-safe; TD Marketing, dev job 9aec66fa). */
export interface StageOption { key: string; label: string }

/** The label of a pipeline stage; an unknown key is shown as itself so a lead is never displayed blank. */
export function stageLabel(stages: readonly StageOption[], key: string | null | undefined): string {
  if (!key) return "—"
  return stages.find(s => s.key === key)?.label ?? key
}

/** "hai_una_attività" -> "Hai una attività": Meta form question keys read as plain text. */
export function prettyQuestion(name: string): string {
  const s = name.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name
}

/** "19 Oct 2026, 10:15" in a fixed zone so every viewer sees the same time for the same lead. */
export function formatWhen(iso: string | null | undefined, timeZone = "Europe/Rome"): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone, hour12: false }).format(d)
}

export interface ExistingClientFlag { contact_ids?: string[]; matched_on?: string[]; check_failed?: boolean }

/** A short plain-English note when the lead looks like (or may be) an existing TD client; null when nothing to say. */
export function clientFlagText(flag: ExistingClientFlag | null | undefined): string | null {
  if (!flag) return null
  if (flag.check_failed) return "We could not check whether this person is already a TD client. Ask before selling."
  if (flag.contact_ids?.length) {
    const how = (flag.matched_on ?? []).map(m => (m === "email" ? "email" : m === "phone" ? "phone number" : m)).join(" and ")
    return `Looks like an existing TD client (same ${how || "details"}). Do not cold-sell; check with Antonio first.`
  }
  return null
}

/** Digits-only phone for a tel: link. */
export function telHref(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/[^\d+]/g, "")
  return d.replace(/\D/g, "").length >= 6 ? `tel:${d}` : null
}

export type LeadShow = "all" | "free" | "mine" | "callbacks"
export const LEAD_SHOW_OPTIONS: ReadonlyArray<{ key: LeadShow; label: string }> = [
  { key: "all", label: "All" }, { key: "free", label: "Not picked yet" }, { key: "mine", label: "Picked by me" }, { key: "callbacks", label: "Call backs" },
]
export function parseLeadShow(v: string | string[] | undefined): LeadShow {
  const s = Array.isArray(v) ? v[0] : v
  return LEAD_SHOW_OPTIONS.some(o => o.key === s) ? (s as LeadShow) : "all"
}

export interface FilterableLead { status: string; claimed_by: string | null; callback_at: string | null }

/**
 * The one lead list, narrowed. Call backs come first, soonest first (a promised call is the most urgent thing); every other filter keeps
 * the order it was given (newest first). `stage` is a pipeline stage key or empty for all.
 */
export function filterLeads<T extends FilterableLead>(leads: readonly T[], f: { show: LeadShow; stage?: string | null }, userId: string): T[] {
  let out = leads.filter(l => (f.stage ? l.status === f.stage : true))
  if (f.show === "free") out = out.filter(l => l.claimed_by === null)
  else if (f.show === "mine") out = out.filter(l => l.claimed_by === userId)
  else if (f.show === "callbacks") {
    out = out.filter(l => l.callback_at !== null).sort((a, b) => String(a.callback_at).localeCompare(String(b.callback_at)))
  }
  return out
}

/** Plain-English line for a history row. Unknown kinds show their own name so nothing is ever hidden. */
export function eventText(kind: string, data: Record<string, unknown>, stages: readonly StageOption[], reasons: readonly StageOption[]): string {
  const note = typeof data.note === "string" && data.note ? ` — ${data.note}` : ""
  switch (kind) {
    case "received": return "Lead arrived from the ad"
    case "possible_existing_client": return "Flagged: may already be a TD client"
    case "client_check_failed": return "Could not check whether this is a TD client"
    case "assigned": return `Assigned to ${typeof data.team_name === "string" ? data.team_name : "a team"}`
    case "details_filled": return "Name, email and phone filled in from the form answers"
    case "claimed": return "Picked"
    case "released": return "Given back"
    case "note": return `Note: ${typeof data.text === "string" ? data.text : ""}`
    case "payment_link_created": return "Payment link created"
    case "payment_received": return "Payment received"
    case "sale_refunded": return "Sale refunded"
    case "sale_paid_out": return "Seller's share paid out"
    case "sale_terms_applied": return "Split applied to the sale"
    case "stage_not_moved": return "Paid, but the lead could not be moved to the next stage automatically: check it"
    case "status_changed": {
      const to = stageLabel(stages, typeof data.to === "string" ? data.to : null)
      if (data.outcome === "not_in_target") return `Not in target (${reasons.find(r => r.key === data.reason)?.label ?? String(data.reason ?? "")})${note}`
      if (data.outcome === "call_back") return `Call back on ${formatWhen(typeof data.callback_at === "string" ? data.callback_at : null)}${note}`
      if (data.outcome === "good") return `Good — moved to ${to}${note}`
      return `Moved to ${to}${note}`
    }
    default: return kind
  }
}

/** A Meta form answer made readable: "servizi_e_consulenze" -> "Servizi e consulenze", "30.000_-_100.000€" -> "30.000 - 100.000€". */
export function prettyAnswer(v: string): string {
  const s = v.replace(/_/g, " ").replace(/\s+/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : v
}
