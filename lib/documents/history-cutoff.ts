/**
 * A person added to a company that already has history can be set to see only what comes from a date on
 * (Storage check Phase 2 slice 3, dev job d14e823f; Antonio 2026-10-17: new owners do not see old history by
 * default, with an option to show it). account_contacts.history_visible_from holds that date; NULL = sees everything.
 *
 * Deliberately zero imports (client-safe, like visibility-guard.ts). The date compared is created_at — the day the
 * file was SAVED in the CRM, not the document's own date (documents moved from Drive on 14-15 Oct 2026 all carry that
 * date). So the cutoff is always "the day staff added the person", never a backdated one.
 */

export interface CutoffDoc {
  created_at: string
  category?: number | null
  contact_id?: string | null
  visible_to_new_owners?: boolean | null
}

/** True when the viewer must NOT see this company document because it is older than their start date. */
export function isHiddenByHistoryCutoff(doc: CutoffDoc, cutoffIso: string | null | undefined, viewerContactId: string | null | undefined): boolean {
  if (!cutoffIso) return false
  if (doc.visible_to_new_owners) return false // staff opened this one on purpose
  // A person's OWN personal document is theirs, not company history.
  if (doc.category === 2 && doc.contact_id && viewerContactId && doc.contact_id === viewerContactId) return false
  const created = Date.parse(doc.created_at)
  const cutoff = Date.parse(cutoffIso)
  if (Number.isNaN(created) || Number.isNaN(cutoff)) return false // never hide on a bad date
  return created < cutoff
}

/** The choice staff make when they add a person to a company that already has history. */
export type HistoryChoice = "today" | "all"

export function normalizeHistoryChoice(v: unknown): HistoryChoice {
  return v === "all" ? "all" : "today"
}
