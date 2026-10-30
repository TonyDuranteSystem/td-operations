/** Small pure helpers for showing a lead (client-safe; TD Marketing, dev job 9aec66fa). */
import { makeT, type TFn } from "@/lib/marketing/i18n"
import { zoneName } from "@/lib/marketing/zones"

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
export function formatWhen(iso: string | null | undefined, timeZone = "Europe/Rome", locale = "en-GB"): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone, hour12: false }).format(d)
}

export interface ExistingClientFlag { contact_ids?: string[]; matched_on?: string[]; check_failed?: boolean }

/** A short plain-English note when the lead looks like (or may be) an existing TD client; null when nothing to say. */
export function clientFlagText(flag: ExistingClientFlag | null | undefined, t: TFn = makeT("en")): string | null {
  if (!flag) return null
  if (flag.check_failed) return t("We could not check whether this person is already a TD client. Ask before selling.")
  if (flag.contact_ids?.length) {
    const how = (flag.matched_on ?? []).map(m => (m === "email" ? t("email") : m === "phone" ? t("phone number") : m)).join(t(" and "))
    return t("Looks like an existing TD client (same {how}). Do not cold-sell; check with Antonio first.", { how: how || t("details") })
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
export function eventText(kind: string, data: Record<string, unknown>, stages: readonly StageOption[], reasons: readonly StageOption[], t: TFn = makeT("en"), locale = "en-GB", zone = "Europe/Rome"): string {
  const fw = (iso: string | null) => formatWhen(iso, zone, locale)
  const note = typeof data.note === "string" && data.note ? ` — ${data.note}` : ""
  switch (kind) {
    case "received": return t("Lead arrived from the ad")
    case "possible_existing_client": return t("Flagged: may already be a TD client")
    case "client_check_failed": return t("Could not check whether this is a TD client")
    case "assigned": return t("Assigned to {team}", { team: typeof data.team_name === "string" ? data.team_name : t("a team") })
    case "details_filled": return t("Name, email and phone filled in from the form answers")
    case "given": return t("Given to {name} by Antonio", { name: typeof data.to_name === "string" ? data.to_name : t("a person") })
    case "claimed": return t("Picked")
    case "released": return t("Given back")
    case "note": return t("Note: {text}", { text: typeof data.text === "string" ? data.text : "" })
    case "whatsapp": return `${data.state === "no_wa" ? t("No WhatsApp on this number") : data.state === "opened" ? t("WhatsApp Web opened") : t("WhatsApp sent")}${note}`
    case "attempt": return `${t("No answer ({via})", { via: data.via === "whatsapp" ? "WhatsApp" : t("call") })}${note}`
    case "appointment": if (data.rescheduled === true && data.at) return `${t("Call moved to {when}. Reason: {reason}", { when: fw(typeof data.at === "string" ? data.at : null), reason: t(String(data.reason ?? "")) })}${note}`
      return data.at ? `${t("Call booked for {when}", { when: fw(typeof data.at === "string" ? data.at : null) })}${note}` : `${t("Booked call cancelled")}${note}`
    case "callback_moved": return `${t("Call back moved to {when}. Reason: {reason}", { when: fw(typeof data.callback_at === "string" ? data.callback_at : null), reason: t(String(data.reason ?? "")) })}${note}`
    case "handover": return `${t("Passed to Rocco, no call booked yet")}${note}`
    case "zone_set": return t("Time zone set to {zone}", { zone: typeof data.zone === "string" ? zoneName(data.zone) : "—" })
    case "booking_link": return `${t("Booking link sent by {via}: {url}", { via: data.via === "email" ? t("email") : data.via === "copied" ? t("copy") : "WhatsApp", url: typeof data.url === "string" ? data.url : "" })}${note}`
    case "payment_link_created": return t("Payment link created")
    case "payment_received": return t("Payment received")
    case "sale_refunded": return t("Sale refunded")
    case "sale_paid_out": return t("Seller's share paid out")
    case "sale_terms_applied": return t("Split applied to the sale")
    case "stage_not_moved": return t("Paid, but the lead could not be moved to the next stage automatically: check it")
    case "status_changed": {
      const to = t(stageLabel(stages, typeof data.to === "string" ? data.to : null))
      if (data.outcome === "not_in_target") return `${t("Not in target ({reason})", { reason: t(reasons.find(r => r.key === data.reason)?.label ?? String(data.reason ?? "")) })}${note}`
      if (data.outcome === "call_back") return `${t("Call back on {when}", { when: fw(typeof data.callback_at === "string" ? data.callback_at : null) })}${note}`
      if (data.outcome === "not_ready") return `${t("Not ready now — come back on {when}", { when: fw(typeof data.callback_at === "string" ? data.callback_at : null) })}${note}`
      if (data.outcome === "closed" || data.outcome === "link_sent") return `${t("Link sent")}${note}`
      if (data.outcome === "not_closed") return `${t("Not closed")}${note}`
      if (data.outcome === "contacted") return `${t("Contacted")}${note}`
      if (data.outcome === "upsell") return `${t("Upsell")}${note}`
      if (data.outcome === "waiting") return `${t("Waiting")}${note}`
      if (data.outcome === "archive") return `${t("Archived")}${note}`
      if (data.outcome === "good") return `${t("Good — moved to {to}", { to })}${note}`
      return `${t("Moved to {to}", { to })}${note}`
    }
    default: return kind
  }
}

/** A Meta form answer made readable: "servizi_e_consulenze" -> "Servizi e consulenze", "30.000_-_100.000€" -> "30.000 - 100.000€". */
export function prettyAnswer(v: string): string {
  const s = v.replace(/_/g, " ").replace(/\s+/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : v
}


const HOUR = 3600_000
export interface RowFacts { waiting: { text: string; late: boolean } | null; ad: string | null }

/**
 * The extra facts on a Leads row. A new lead nobody has touched shows how long it has been waiting (red after a day); a lead somebody has picked or worked shows none: it is not waiting.
 * `ad` is the ad it came from, or null when the form came with no ad name.
 */
export function rowFacts(l: { status: string; claimed_by: string | null; callback_at: string | null; ad_name: string | null; meta_created_time: string | null; received_at: string }, firstStage: string | undefined, nowMs: number): RowFacts {
  const arrived = new Date(l.meta_created_time ?? l.received_at).getTime()
  const waitingNow = firstStage !== undefined && l.status === firstStage && l.claimed_by === null && l.callback_at === null
  const ms = Math.max(0, nowMs - arrived)
  const text = ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / (24 * HOUR))} d`
  return { waiting: waitingNow ? { text, late: ms > 24 * HOUR } : null, ad: l.ad_name }
}

/** "Good" / "Not in target" / "Call back" for a mark, in the words the buttons use. */
export const markWords = (o: "good" | "not_in_target" | "call_back"): string => (o === "good" ? "Good" : o === "not_in_target" ? "Not in target" : "Call back")
