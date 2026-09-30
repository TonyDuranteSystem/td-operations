/**
 * File Understanding — green or red (job 685467b5, Part 15 point 3). PURE. The AI's own confidence is never an
 * input: GREEN needs the whole file read, a type from the list, the CRM record agreeing, a past staff-confirmed
 * example agreeing, and no unexplained twin. Anything else is RED with the reasons in plain words. A person reviews red.
 */
import type { PairVerdict } from "./duplicates"

export interface VerdictInput {
  read: { ok: boolean; partial: boolean; hasWords: boolean }
  ai: { typeSlug: string | null; injection: boolean; nameRejected: boolean; failed: boolean } | null
  crm: "pass" | "fail" | "none"
  example: "pass" | "fail" | "none"
  ownerMismatch: boolean
  duplicate: PairVerdict | null
}

export function computeVerdict(v: VerdictInput): { verdict: "green" | "red"; reasons: string[] } {
  const r: string[] = []
  if (!v.read.ok) r.push("unreadable")
  else {
    if (v.read.partial) r.push("partly_read")
    if (!v.read.hasWords) r.push("no_words")
  }
  if (!v.ai || v.ai.failed) r.push("ai_failed")
  else {
    if (v.ai.injection) r.push("injection")
    if (v.ai.nameRejected) r.push("bad_name")
    if (!v.ai.typeSlug) r.push("no_type")
  }
  if (v.crm === "fail") r.push("crm_disagrees")
  if (v.crm === "none") r.push("crm_none")
  if (v.example === "fail") r.push("example_disagrees")
  if (v.example === "none") r.push("no_example")
  if (v.ownerMismatch) r.push("wrong_client")
  if (v.duplicate === "different_words" || v.duplicate === "minor_marks" || v.duplicate === "not_compared") r.push("duplicate_differs")
  return { verdict: r.length === 0 ? "green" : "red", reasons: r }
}
