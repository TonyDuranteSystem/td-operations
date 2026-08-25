/**
 * Coverage / activity questions (Slice 9, master plan §3.4) — PURE.
 *
 * Gate 1 reconciles what's IN the file; it cannot see what an export simply
 * left out — a CSV that ends in October is internally coherent. Coverage
 * closes that hole without false demands: for each bank account whose months
 * don't span the year, we FIRST ask "did this account have any activity
 * before X / after Y / between A and B?". "No" (account opened later, closed
 * earlier, dormant) records the answer and the dataset is complete. "Yes"
 * guides the client to delete the file and re-export the full period.
 *
 * Unanswered coverage questions BLOCK the attestation — the client cannot
 * confirm numbers whose completeness is still an open question.
 */

import { accountKeyOf } from "./bank-identity"

export interface CoverageTx {
  bank_name: string
  account_type: string | null
  account_ref?: string | null
  transaction_date: string
}

export interface CoverageQuestion {
  /** Stable key: `${bank_key}|leading|2025-03` etc. — the answer store key. */
  key: string
  bank_key: string
  kind: "leading" | "trailing" | "internal"
  /** Months (YYYY-MM) the question covers. */
  months: string[]
  /** EN question text — the UI renders both languages from the parts. */
  question: string
}

export type CoverageAnswers = Record<string, { answer: "no_activity" | "had_activity"; at: string }>

const monthOf = (d: string) => d.slice(0, 7)

function monthRange(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
}

/** Derive the coverage questions for an account-year's transactions. */
export function coverageQuestions(txs: CoverageTx[], taxYear: number): CoverageQuestion[] {
  const all = monthRange(taxYear)
  const byBank = new Map<string, Set<string>>()
  for (const t of txs) {
    const key = accountKeyOf(t)
    if (!byBank.has(key)) byBank.set(key, new Set())
    byBank.get(key)!.add(monthOf(t.transaction_date))
  }

  const out: CoverageQuestion[] = []
  for (const [bankKey, months] of Array.from(byBank.entries())) {
    const present = all.filter(m => months.has(m))
    if (present.length === 0) continue
    const first = present[0]
    const last = present[present.length - 1]

    const leading = all.filter(m => m < first)
    if (leading.length > 0) {
      out.push({
        key: `${bankKey}|leading|${first}`,
        bank_key: bankKey,
        kind: "leading",
        months: leading,
        question: `Did ${bankKey} have any activity before ${first}?`,
      })
    }
    const trailing = all.filter(m => m > last)
    if (trailing.length > 0) {
      out.push({
        key: `${bankKey}|trailing|${last}`,
        bank_key: bankKey,
        kind: "trailing",
        months: trailing,
        question: `Did ${bankKey} have any activity after ${last}?`,
      })
    }
    const internal = all.filter(m => m > first && m < last && !months.has(m))
    if (internal.length > 0) {
      out.push({
        key: `${bankKey}|internal|${internal.join(",")}`,
        bank_key: bankKey,
        kind: "internal",
        months: internal,
        question: `${bankKey} has no transactions in ${internal.join(", ")} — did the account have any activity in those months?`,
      })
    }
  }
  return out
}

/** Questions still without an answer — these block the attestation. */
export function unansweredCoverage(questions: CoverageQuestion[], answers: CoverageAnswers): CoverageQuestion[] {
  return questions.filter(q => !answers[q.key])
}

/** A "had_activity" answer means the export is incomplete — the client must
 *  replace the file. These also block attestation, with a different message. */
export function incompleteCoverage(questions: CoverageQuestion[], answers: CoverageAnswers): CoverageQuestion[] {
  return questions.filter(q => answers[q.key]?.answer === "had_activity")
}

/**
 * Structural data problem (2026-08-20, Antonio's hard-stop ruling) — as
 * opposed to routine in-progress work (open categorization decisions,
 * pending AI, unanswered location periods), which stays a provisional
 * "not final yet" banner, never a hard stop.
 *
 * A structural problem means the UNDERLYING bank data itself is known to be
 * incomplete or unreadable — a P&L built on top of it isn't "90% done", it
 * could be badly wrong (a missing month could hide the year's biggest
 * transaction). When true, callers must refuse to generate/display/download/
 * save the numbers — identically for the client portal and the staff
 * workspace tool. No override for either audience: Antonio's words, "if
 * something is wrong, it is wrong," reject a softer staff-only bypass.
 *
 * ONE function, imported everywhere this is enforced (display, both Excel
 * downloads, save-to-client) — this repo has already been burned once by the
 * same completeness check computed independently in multiple places and
 * quietly drifting (card 4a39e0fd / the resolve-submission incident).
 *
 * `failedFilesOverridden`: honors the EXISTING staff CRM override for a
 * failed file (lib/tax/confirm-unlock.ts) — a deliberate override already
 * lets Confirm proceed; this must agree, not silently re-block it. Workspaces
 * have no such override today, so callers there pass `false`.
 *
 * `quarantined` (2026-08-21, round-3 bug-hunter blocker): a file awaiting a
 * staff format confirmation is NOT counted by `ingestFailed` — it's a
 * distinct ingest-file state (lib/tax/ingest-file-status.ts) precisely
 * because it isn't shown to the client as "delete and re-upload". But that
 * means before this field existed, a quarantined-only file produced NO
 * structural-problem signal at all: it isn't a plain failure, and a bank with
 * zero ingested rows generates no coverage question either (coverageQuestions
 * only sees banks present in the data). The numbers rendered/downloaded/saved
 * were then silently missing that bank's transactions while reporting as
 * complete. Always blocking, no override — `failedFilesOverridden` is
 * specifically the EXISTING mechanism for a genuinely-failed file staff has
 * chosen to proceed past; quarantine's own resolution is the one-tap format
 * confirmation itself, which transitions the file out of "quarantined"
 * entirely (computeIngestFileStates re-resolves per path, succeeded wins).
 *
 * `unansweredCoverage` is DELIBERATELY NOT blocking (Antonio, 2026-08-25:
 * "if there are no statements, means there are no activity" — no client
 * question, no hold-up). A leading/trailing/internal gap is a month with NO
 * uploaded statement at all; the default assumption is now zero activity for
 * that month, exactly like a statement that reads as genuinely empty
 * (`recognized_empty`, lib/bank-statement-ai-extract.ts, same day's ruling).
 * `unansweredCoverage` is kept as an input (not removed) so a caller can still
 * SHOW the assumption to the client for transparency without it ever
 * blocking. `incompleteCoverage` is UNCHANGED and still blocks: that fires
 * only when someone has AFFIRMATIVELY answered "yes, there was activity" for
 * a gap with no file — the opposite of "no statement, assume none" — so it
 * remains a genuine unresolved problem needing the actual file.
 */
export function hasStructuralProblem(input: {
  ingestFailed: number
  failedFilesOverridden: boolean
  quarantined: number
  unansweredCoverage: number
  incompleteCoverage: number
}): boolean {
  const failed = input.ingestFailed > 0 && !input.failedFilesOverridden
  return failed || input.quarantined > 0 || input.incompleteCoverage > 0
}
