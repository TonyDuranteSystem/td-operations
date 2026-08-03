/**
 * The plain-English (and Italian) sentences that tell a client how much of
 * their Profit & Loss is still OUR guess rather than their decision.
 *
 * Pure + locale-aware, and deliberately OUTSIDE the gate module: `evaluateGates`
 * is locale-free and its `detail` strings are written for staff, but the portal
 * renders gate details verbatim to the client — so the one sentence that now
 * fails for nearly every client was going out in English only. Extracted here
 * (rather than left inline in the 2,700-line review component) so it is unit
 * testable; the component's test runner cannot parse TSX.
 *
 * Two bugs this file exists to prevent recurring (2026-08-03, bug-hunter):
 *  1. Reporting only the folded EXPENSE. A client whose undecided rows are
 *     INFLOWS was shown "−0.00" and told they were expenses, while gate 6 on
 *     the same screen showed the real positive figure. Both directions are
 *     netted here, once.
 *  2. "1 transactions are still classified by us" — a single leftover row is
 *     the NORMAL end-state of a review, and it appeared in the consent text a
 *     client signs.
 */

/** Signed-total inputs — the shape `computePnlTotals` returns. */
export interface PendingPnl {
  uncategorizedCount: number
  uncategorizedTotal: number
  foldedUncategorizedCount: number
  foldedUncategorizedIncome: number
  foldedUncategorizedExpense: number
}

const money = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * How many transactions are still booked on our suggestion.
 * Exactly one of the two counters is non-zero by construction (folding on →
 * `folded*`, folding off → `uncategorized*`), so summing is safe and gives the
 * right answer for BOTH the client draft and the staff workspace.
 */
export function pendingCount(pnl: PendingPnl): number {
  return pnl.uncategorizedCount + pnl.foldedUncategorizedCount
}

/**
 * Their NET effect, signed: negative = money out on balance.
 * `foldedUncategorizedExpense` is a positive magnitude; `foldedUncategorizedIncome`
 * is signed positive — so income − expense, plus the folding-off total.
 */
export function pendingNet(pnl: PendingPnl): number {
  return pnl.uncategorizedTotal + pnl.foldedUncategorizedIncome - pnl.foldedUncategorizedExpense
}

/** "1 transaction is" / "394 transactions are" — EN + IT. */
export function suggestedPhrase(n: number, it: boolean): string {
  if (it) return n === 1 ? "1 transazione è" : `${n} transazioni sono`
  return n === 1 ? "1 transaction is" : `${n} transactions are`
}

/**
 * Gate 6's client-facing sentence, in the client's language.
 *
 * NOTE: the OTHER gates' details are still English-only on the portal. That is
 * pre-existing (a client already sees "The balance sheet is off by …" in
 * English) and is a separate decision — not silently changed here.
 */
export function gateSixText(pnl: PendingPnl, it: boolean): string {
  const count = pendingCount(pnl)
  if (count === 0) return it ? "Hai deciso ogni transazione." : "You have decided every transaction."
  const net = pendingNet(pnl)
  const amount = `${net < 0 ? "−" : ""}${money(Math.abs(net))}`
  // Pronoun has to agree too — "1 transaction is … Answer them" reads as broken
  // English on the one screen a client is asked to trust (browser QA 2026-08-03).
  const one = count === 1
  return it
    ? `${suggestedPhrase(count, true)} classificate da noi e non ancora confermate da te (netto ${amount}) — ${one ? 'è già inclusa' : 'sono già incluse'} nei totali qui sotto. Rispondi per ${one ? 'renderla tua' : 'renderle tue'}.`
    : `${suggestedPhrase(count, false)} booked on our suggestion and not yet confirmed by you (net ${amount}) — already counted in the figures below. Answer ${one ? 'it' : 'them'} to make these numbers yours.`
}
