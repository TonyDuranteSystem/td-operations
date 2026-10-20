/**
 * The decisions of the save-where window that are NOT drawing (pure, unit-tested): when a proposal is current, what the window shows,
 * whether Save is possible, when the proposal must be asked for again, and what happens to a place staff chose by hand.
 */
import type { FaxPurpose } from "./save-where"

export type CompanyAnswer = { accountId: string; name: string } | "business" | null

/** What a proposal depends on: what the fax is, which company, and — only for a tax return, whose year comes from the name — the file name. */
export function answersKey(purpose: FaxPurpose, company: CompanyAnswer, name: string): string {
  return `${purpose}|${company === "business" ? "business" : company ? company.accountId : ""}|${purpose === "irs_tax_return" ? name : ""}`
}

export interface WindowState {
  purpose: FaxPurpose | null
  company: CompanyAnswer
  name: string
  loading: boolean
  /** the answers the shown proposal was made for */
  proposalKey: string | null
  /** the answers the last request was made for (a request already on its way) */
  requestedKey: string | null
  proposalState: "proposed" | "choose" | "refused" | null
  picked: { path: string } | null
  busy: boolean
}

/** A proposal is usable only when it was made for the CURRENT answers and nothing is loading. */
export function proposalIsCurrent(s: WindowState): boolean {
  return !!s.purpose && !s.loading && s.proposalKey === answersKey(s.purpose, s.company, s.name)
}

/** Save is possible only with a place (staff's own, or a CURRENT proposal), a file name, and nothing in flight. */
export function canSave(s: WindowState): boolean {
  if (!s.purpose || s.busy || !s.name.trim()) return false
  if (s.picked) return true
  return s.proposalState === "proposed" && proposalIsCurrent(s)
}

/** The proposal is shown as "working out…" while it loads or while it is out of date. */
export function showsWorking(s: WindowState): boolean {
  return !s.picked && (s.loading || (s.proposalState !== null && !proposalIsCurrent(s)))
}

/** A tax return's proposal is asked for again (after a pause) when the file name changed it and no request for these answers is already on its way. */
export function needsRepropose(s: WindowState): boolean {
  if (s.purpose !== "irs_tax_return" || s.picked) return false
  const key = answersKey(s.purpose, s.company, s.name)
  return s.proposalKey !== key && s.requestedKey !== key
}

/** "Business › Business › Fax" → "Business › Fax": consecutive repeats of a name in a path are shown once. */
export function tidyPath(path: string): string {
  const out: string[] = []
  for (const seg of path.split(" › ")) if (out[out.length - 1] !== seg) out.push(seg)
  return out.join(" › ")
}
