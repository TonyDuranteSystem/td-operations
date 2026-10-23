/**
 * What happened when the team tried to REACH a lead (pure; TD Marketing, dev job 9aec66fa — Antonio, 2026-10-23: the team's sheet tracks "WhatsApp sent / no WhatsApp",
 * "NR + date" and the booked appointment; the system must hold the same). Read from the lead's history, newest wins; Antonio's "View as" rows are not the team's work.
 *   whatsapp  { state: "sent" | "no_wa", template?: string }     the opening message went out / the number has no WhatsApp
 *   attempt   { result: "no_answer", via: "whatsapp" | "call" }   one try that got no answer (each one counts once)
 *   appointment { at: ISO | null }                               a call booked with the seller; at = null cancels it
 * "Contacted" has ONE definition: a WhatsApp was sent, or somebody tried (an attempt), or an outcome was recorded.
 */
import { makeT, type TFn } from "@/lib/marketing/i18n"

export interface ContactEvent { lead_id?: string; kind: string; actor?: string; created_at: string; data: Record<string, unknown> }

export interface ContactState {
  whatsapp: "sent" | "no_wa" | null
  whatsappAt: string | null
  /** tries with no answer since the last time the person was reached (an outcome resets it) */
  attempts: number
  lastAttemptAt: string | null
  /** the booked call, or null (none, or cancelled) */
  appointmentAt: string | null
  /** somebody has reached out in some way */
  contacted: boolean
}

const real = (e: ContactEvent) => e.data?.via_view_as !== true
const isOutcome = (e: ContactEvent) => e.kind === "status_changed" && typeof e.data?.outcome === "string"

export const EMPTY_CONTACT: ContactState = { whatsapp: null, whatsappAt: null, attempts: 0, lastAttemptAt: null, appointmentAt: null, contacted: false }

/** The contact state of ONE lead from its history rows, in any order. */
export function contactState(events: readonly ContactEvent[]): ContactState {
  const list = events.filter(real).slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
  const out: ContactState = { ...EMPTY_CONTACT }
  for (const e of list) {
    if (e.kind === "whatsapp") {
      const s = e.data?.state
      if (s === "sent" || s === "no_wa") { out.whatsapp = s; out.whatsappAt = e.created_at; if (s === "sent") out.contacted = true }
    } else if (e.kind === "attempt" && e.data?.result === "no_answer") {
      out.attempts++; out.lastAttemptAt = e.created_at; out.contacted = true
    } else if (isOutcome(e)) {
      out.attempts = 0; out.contacted = true // the person was reached and a decision recorded
    } else if (e.kind === "appointment") {
      const at = e.data?.at
      out.appointmentAt = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null
      if (out.appointmentAt) out.contacted = true
    }
  }
  return out
}

/** The contact state of many leads from one flat list of history rows. */
export function contactStates(events: readonly (ContactEvent & { lead_id: string })[]): Map<string, ContactState> {
  const by = new Map<string, ContactEvent[]>()
  for (const e of events) { let l = by.get(e.lead_id); if (!l) { l = []; by.set(e.lead_id, l) } l.push(e) }
  const out = new Map<string, ContactState>()
  for (const [id, list] of Array.from(by)) out.set(id, contactState(list))
  return out
}

/** Short words for a list row: "WhatsApp ✓", "No WhatsApp", "No answer ×3", "Call 27 Oct 11:00". Empty when nothing happened yet. */
export function contactChips(s: ContactState, fmtWhen: (iso: string) => string, t: TFn = makeT("en")): Array<{ key: string; text: string; tone: "ok" | "warn" | "info" }> {
  const chips: Array<{ key: string; text: string; tone: "ok" | "warn" | "info" }> = []
  if (s.whatsapp === "sent") chips.push({ key: "wa", text: t("WhatsApp ✓"), tone: "ok" })
  else if (s.whatsapp === "no_wa") chips.push({ key: "wa", text: t("No WhatsApp"), tone: "warn" })
  if (s.attempts > 0) chips.push({ key: "nr", text: t("No answer ×{n}", { n: s.attempts }), tone: "warn" })
  if (s.appointmentAt) chips.push({ key: "appt", text: t("Call {when}", { when: fmtWhen(s.appointmentAt) }), tone: "info" })
  return chips
}
