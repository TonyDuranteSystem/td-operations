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

export interface CoverageTx {
  bank_name: string
  account_type: string | null
  transaction_date: string
}

export interface CoverageQuestion {
  /** Stable key: `${bank_key}|leading|2025-03` etc. — the answer store key. */
  key: string
  bank_key: string
  kind: "leading" | "trailing" | "internal" | "missing_bank"
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
    const key = `${t.bank_name} ${t.account_type ?? "Checking"}`
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

/** S2 slice 4 — banks we KNOW about (prior-year books) with ZERO rows this
 * year. The system uses what it already knows instead of discovering a whole
 * missing bank from a $750k discrepancy (the Dynamiq Chase case). Same answer
 * store: "no_activity" = closed/unused (resolved); "had_activity" = the client
 * must upload it (blocks like an incomplete export). PURE.
 */
export function missingBankQuestions(
  knownBankKeys: string[],
  currentTxs: CoverageTx[],
  taxYear: number,
): CoverageQuestion[] {
  const present = new Set(currentTxs.map(t => `${t.bank_name} ${t.account_type ?? "Checking"}`))
  const presentBanks = new Set(Array.from(present).map(k => k.split(" ")[0].toLowerCase()))
  const out: CoverageQuestion[] = []
  for (const known of Array.from(new Set(knownBankKeys)).sort()) {
    if (present.has(known)) continue
    // Match on the BANK level too — "Chase Checking" counts as present if any
    // "Chase …" account uploaded (sub-account labels drift year to year).
    const bankToken = known.split(" ")[0].toLowerCase()
    if (bankToken && presentBanks.has(bankToken)) continue
    out.push({
      key: `${known}|missing_bank|${taxYear}`,
      bank_key: known,
      kind: "missing_bank",
      months: [],
      question: `You used ${known} last year but we have no ${taxYear} statements for it — did it have any ${taxYear} activity?`,
    })
  }
  return out
}
