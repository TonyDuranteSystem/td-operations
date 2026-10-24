/**
 * TD Marketing — who may read the team's notes (pure; dev job 9aec66fa, build step 1). The setters' and the owner's free-text notes, and the ticks from a call, are
 * for the people who work the leads: whoever may mark or pick a lead. A person who may only SEE leads (the ad person) reads the lead's facts and the form answers
 * but never what the team wrote about it. Enforced where the data is read (the lead pane), not only hidden on the screen.
 */
import type { LeadEventRow, LeadRow } from "@/lib/marketing/leads-read"

export function canSeeNotes(permissions: readonly string[]): boolean {
  return permissions.includes("team.notes")
}

/** Phone numbers are for the people who call: without "See phone numbers and call leads" the number is not sent to the page at all. */
export function canSeePhone(permissions: readonly string[]): boolean {
  return permissions.includes("leads.call")
}

/** The same rows with the phone number removed when the person may not see it (and the phone-looking form answers). */
export function withoutPhone<T extends { phone: string | null }>(rows: readonly T[], permissions: readonly string[]): T[] {
  return canSeePhone(permissions) ? [...rows] : rows.map(r => ({ ...r, phone: null }))
}

const PHONE_ANSWER = /phone|telefon|cellul|mobile|whatsapp|tel\b/i
/** Form answers without the ones that are a phone number, when the person may not see phone numbers. */
const PHONE_VALUE = /(\d[\s().-]?){7,}/
export function answersWithoutPhone<T extends { name?: string; label?: string; question?: string; values?: readonly string[] }>(answers: readonly T[], permissions: readonly string[]): T[] {
  // by the question's name, and by what the answer looks like (a long run of digits is a phone number whatever the question is called)
  return canSeePhone(permissions) ? [...answers] : answers.filter(a => !PHONE_ANSWER.test(`${a.name ?? ""} ${a.label ?? ""} ${a.question ?? ""}`) && !(a.values ?? []).some(v => PHONE_VALUE.test(String(v))))
}

/** The kinds of history line that are plain facts about a lead; a person who may not read the team's notes sees only these (never money lines, never a kind this list does not know). */
const FACT_KINDS = new Set(["received", "claimed", "released", "assigned", "details_filled", "possible_existing_client", "client_check_failed", "status_changed", "whatsapp", "attempt", "appointment", "callback_moved", "handover"])
/** Facts whose row may carry a written note: the note is removed for a person who may not read the team's notes. */
const NOTE_BEARING = new Set(["status_changed", "whatsapp", "attempt", "appointment", "callback_moved", "handover"])

/** The history without anything a person written for the team: note rows go, money lines go; the note and the ticks inside a Good / Not in target / Call back row go; the facts stay. */
export function redactTimeline(events: readonly LeadEventRow[], seesNotes: boolean): LeadEventRow[] {
  if (seesNotes) return [...events]
  return events
    .filter(e => FACT_KINDS.has(e.kind))
    .map(e => {
      if (!NOTE_BEARING.has(e.kind)) return e
      const { note: _note, qualification: _qualification, ...rest } = e.data ?? {}
      void _note; void _qualification
      return { ...e, data: rest }
    })
}

/** The lead without the ticks from the call when the person may not read the team's notes. */
export function redactLead<T extends Pick<LeadRow, "qualification">>(lead: T, seesNotes: boolean): T {
  return seesNotes ? lead : { ...lead, qualification: null }
}
