/**
 * TD Marketing — who may read the team's notes (pure; dev job 9aec66fa, build step 1). The setters' and the owner's free-text notes, and the ticks from a call, are
 * for the people who work the leads: whoever may mark or pick a lead. A person who may only SEE leads (the ad person) reads the lead's facts and the form answers
 * but never what the team wrote about it. Enforced where the data is read (the lead pane), not only hidden on the screen.
 */
import type { LeadEventRow, LeadRow } from "@/lib/marketing/leads-read"

export function canSeeNotes(permissions: readonly string[]): boolean {
  return permissions.includes("leads.mark") || permissions.includes("leads.pick")
}

/** The kinds of history line that are plain facts about a lead; a person who may not read the team's notes sees only these (never money lines, never a kind this list does not know). */
const FACT_KINDS = new Set(["received", "claimed", "released", "assigned", "details_filled", "possible_existing_client", "client_check_failed", "status_changed"])

/** The history without anything a person written for the team: note rows go, money lines go; the note and the ticks inside a Good / Not in target / Call back row go; the facts stay. */
export function redactTimeline(events: readonly LeadEventRow[], seesNotes: boolean): LeadEventRow[] {
  if (seesNotes) return [...events]
  return events
    .filter(e => FACT_KINDS.has(e.kind))
    .map(e => {
      if (e.kind !== "status_changed") return e
      const { note: _note, qualification: _qualification, ...rest } = e.data ?? {}
      void _note; void _qualification
      return { ...e, data: rest }
    })
}

/** The lead without the ticks from the call when the person may not read the team's notes. */
export function redactLead<T extends Pick<LeadRow, "qualification">>(lead: T, seesNotes: boolean): T {
  return seesNotes ? lead : { ...lead, qualification: null }
}
