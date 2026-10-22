/**
 * TD Marketing — the "Setter's note" (pure; dev job 9aec66fa, build step 2). What the setter decided about a lead, in one block: the outcome (Good / Not in target / Call back
 * later), who and when, the note she wrote, the ticks from the call, and the latest other notes on the lead. Built from the lead's history, never from the lead's current stage.
 */
import type { LeadEventRow } from "@/lib/marketing/leads-read"

export type OutcomeKind = "good" | "not_in_target" | "call_back"
export interface NoteOption { key: string; label: string }

/** "chiara.neri@x.com" -> "Chiara Neri"; anything that is not an email is shown as it is. */
export function personName(actor: string | null | undefined): string {
  const a = (actor ?? "").trim()
  if (!a) return "Someone"
  const local = a.includes("@") ? a.split("@")[0] : a
  const words = local.split(/[._\-+]+/).filter(Boolean).filter(w => !/^\d+$/.test(w))
  if (words.length === 0) return a
  return words.map(w => { const [first = "", ...rest] = Array.from(w); return first.toUpperCase() + rest.join("") }).join(" ")
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

export interface OutcomeNote {
  /** done by Antonio looking in with "View as" */
  viaViewAs: boolean
  outcome: OutcomeKind
  by: string
  at: string
  /** the reason's label for "Not in target"; null otherwise */
  reasonLabel: string | null
  callbackAt: string | null
  note: string
}
export interface OtherNote { by: string; at: string; text: string; viaViewAs: boolean }
export interface SetterNote { outcome: OutcomeNote | null; notes: OtherNote[] }

const isOutcome = (o: unknown): o is OutcomeKind => o === "good" || o === "not_in_target" || o === "call_back"

/** The latest outcome (with its note) and up to `max` other notes, newest first. The history may come in any order. */
export function buildSetterNote(events: readonly LeadEventRow[], reasons: readonly NoteOption[], max = 3): SetterNote {
  const byTime = [...events].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
  let outcome: OutcomeNote | null = null
  const notes: OtherNote[] = []
  for (const e of byTime) {
    if (e.kind === "status_changed" && isOutcome(e.data?.outcome)) {
      if (!outcome) {
        outcome = {
          viaViewAs: e.data?.via_view_as === true, outcome: e.data.outcome, by: personName(e.actor), at: e.created_at,
          reasonLabel: e.data.outcome === "not_in_target" ? (reasons.find(r => r.key === e.data.reason)?.label ?? text(e.data.reason)) || null : null,
          callbackAt: e.data.outcome === "call_back" ? text(e.data.callback_at) || null : null,
          note: text(e.data.note),
        }
      }
    } else if (e.kind === "note" && text(e.data?.text) && notes.length < max) {
      notes.push({ by: personName(e.actor), at: e.created_at, text: text(e.data.text), viaViewAs: e.data?.via_view_as === true })
    }
  }
  return { outcome, notes }
}

export interface LatestNote { text: string; by: string; at: string }

/**
 * For each lead id: its newest written note, the same one the lead's own page shows first: a standalone note, or the note of the lead's LATEST outcome (an older outcome's note
 * is out of date once a newer outcome exists, even a newer one with no note). Antonio's "View as" rows are not the team's words and are left out. Nothing written = left out.
 */
export function pickLatestNotes(events: ReadonlyArray<Pick<LeadEventRow, "kind" | "actor" | "data" | "created_at"> & { lead_id: string }>): Map<string, LatestNote> {
  const real = events.filter(e => e.data?.via_view_as !== true)
  const latestOutcomeAt = new Map<string, string>()
  for (const e of real) if (e.kind === "status_changed" && isOutcome(e.data?.outcome) && e.created_at > (latestOutcomeAt.get(e.lead_id) ?? "")) latestOutcomeAt.set(e.lead_id, e.created_at)
  const best = new Map<string, LatestNote>()
  for (const e of real) {
    const isOut = e.kind === "status_changed" && isOutcome(e.data?.outcome)
    if (isOut && e.created_at !== latestOutcomeAt.get(e.lead_id)) continue
    const t = e.kind === "note" ? text(e.data?.text) : isOut ? text(e.data.note) : ""
    if (!t) continue
    const cur = best.get(e.lead_id)
    if (!cur || e.created_at > cur.at) best.set(e.lead_id, { text: t, by: personName(e.actor), at: e.created_at })
  }
  return best
}

export interface LatestMark { outcome: OutcomeKind; by: string; at: string }

/** For each lead id: who gave it its latest outcome (Good / Not in target / Call back), and when. Antonio's "View as" rows are not the team's work and are left out. */
export function pickLatestMarks(events: ReadonlyArray<Pick<LeadEventRow, "kind" | "actor" | "data" | "created_at"> & { lead_id: string }>): Map<string, LatestMark> {
  const best = new Map<string, LatestMark>()
  for (const e of events) {
    if (e.kind !== "status_changed" || e.data?.via_view_as === true || !isOutcome(e.data?.outcome)) continue
    const cur = best.get(e.lead_id)
    if (!cur || e.created_at > cur.at) best.set(e.lead_id, { outcome: e.data.outcome as OutcomeKind, by: personName(e.actor), at: e.created_at })
  }
  return best
}
