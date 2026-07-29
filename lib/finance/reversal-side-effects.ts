/**
 * What did settling this invoice set in motion — and what does un-matching it NOT undo?
 *
 * ⛔ THE CASE THIS EXISTS FOR (2026-07-22, production).
 * The instant a $1,000 wire was auto-credited to the wrong company, two other things happened:
 * a database trigger lifted that client's tax-return payment gate, and the CRM emailed the team
 * "second installment paid — tax ready for accountant". The correction two minutes later
 * reversed neither. It was harmless only by luck (the client genuinely paid four hours later).
 *
 * DESIGN — derived at read time, never stored.
 * A hand-maintained inventory of "things that fire downstream" has nothing forcing it to be
 * updated when the next trigger is added, and a stale checklist is worse than none because
 * staff would trust it. So this is a PURE function over the invoice and the live tax-return
 * row: it states what the current data implies, and it is re-derived every time it is asked.
 *
 * IT DOES NOT REVERSE ANYTHING. The tax-gate rollback belongs to the database trigger, which
 * deliberately refuses to walk a return backwards once it has progressed past the early stages.
 * Duplicating that decision here would create a second source of truth for the same rule. This
 * function's whole job is to make the consequence VISIBLE and say plainly what cannot be undone.
 */

/** The early stages the tax-gate trigger is willing to roll back. */
const ROLLBACK_ELIGIBLE_STATUSES = new Set(["Activated - Need Link", "Paid - Not Started"])

export interface ReversalSideEffectInput {
  invoiceNumber: string | null
  /** `payments.installment`, e.g. "Installment 2 (Jun)". */
  installment: string | null
  description: string | null
  /** `payments.year` — the BILLING year. */
  year: number | null
  /** The client's tax-return row for the year this invoice pays for, if one exists. */
  taxReturn: { tax_year: number; paid: boolean; status: string | null } | null
  /** Is another paid installment / tax payment on record for the same account+year? The
   *  trigger refuses to roll the gate back when there is — the obligation is still met. */
  otherPaidPaymentExists: boolean
}

export interface ReversalSideEffects {
  /** Plain-English statements for a human. Empty ⇒ nothing else was set in motion. */
  statements: string[]
  /** True ⇒ something fired that this reversal does NOT undo. Worth alerting on. */
  needsAttention: boolean
  /** The tax year this invoice pays for, when it is a tax-linked payment. */
  targetTaxYear: number | null
}

/** Which tax year does this payment pay for? Mirrors the database trigger's own rule. */
export function resolveTargetTaxYear(input: {
  installment: string | null
  description: string | null
  year: number | null
}): number | null {
  if (input.year == null) return null
  // An annual installment for year N pays for the tax return of year N-1.
  if (input.installment && /^Installment/i.test(input.installment)) return input.year - 1
  const desc = (input.description ?? "").toLowerCase()
  if (desc.includes("tax return") || desc.includes("tax filing")) return input.year
  return null
}

export function describeReversalSideEffects(
  input: ReversalSideEffectInput,
): ReversalSideEffects {
  const targetTaxYear = resolveTargetTaxYear(input)
  const statements: string[] = []
  let needsAttention = false

  if (targetTaxYear == null) {
    return { statements, needsAttention, targetTaxYear }
  }

  const tr = input.taxReturn
  if (tr && tr.paid) {
    const eligible =
      ROLLBACK_ELIGIBLE_STATUSES.has(tr.status ?? "") && !input.otherPaidPaymentExists
    if (eligible) {
      statements.push(
        `The ${tr.tax_year} tax return's payment gate was opened by this payment and will close again automatically.`,
      )
    } else {
      needsAttention = true
      const why = input.otherPaidPaymentExists
        ? "another payment for the same year is still recorded as paid"
        : `the return has already moved on to "${tr.status ?? "a later stage"}"`
      statements.push(
        `The ${tr.tax_year} tax return's payment gate stays OPEN — ${why}. It is NOT rolled back by this reversal; check whether that return should still be treated as paid.`,
      )
    }
  }

  // The internal hand-off email goes out when an installment is marked paid, and it has no
  // recall. Say so rather than implying the reversal cleaned up after itself.
  if (input.installment && /^Installment/i.test(input.installment)) {
    needsAttention = true
    statements.push(
      `An internal "installment paid — tax ready for the accountant" email was sent when this payment landed. It cannot be unsent.`,
    )
  }

  return { statements, needsAttention, targetTaxYear }
}
