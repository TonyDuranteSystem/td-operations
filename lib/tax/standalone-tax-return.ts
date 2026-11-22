/**
 * The STANDALONE business tax return (Antonio, 22 Nov 2026): a client who buys ONLY a tax return — no annual management, no other service, no
 * installments. The tax form opens the moment the payment is confirmed (there is no "1st installment" wait and no 2nd payment gate), and the
 * extension is optional (file it or skip it).
 *
 * The one rule that decides "standalone" lives here so the activation, the company-info intake and the welcome message can never disagree:
 * an offer is standalone when its ONLY service is the Tax Return. (`contract_type = 'tax_return'` is NOT the test: a Tax Return sold with
 * other services also carries that type, and an annual client's return rides in the annual agreement, not an offer.)
 *
 * Pure: no database, no network. See docs/systems/tax-returns.md.
 */

/** The stages a standalone return moves through at the start. Names are the live Tax Return pipeline's. */
export const STANDALONE_TR_STAGES = {
  /** the company is not known yet: the client fills in the company information first */
  companyDataPending: 'Company Data Pending',
  /** paid, company known, the tax record not ready yet (a short stop before the form opens) */
  paidAwaitingData: 'Paid - Awaiting Data',
  /** the tax form is open for the client */
  open: 'Wizard Available',
} as const

/** True when the offer's services are exactly one thing: the Tax Return (a repeated entry of the same name still counts as one). */
export function isStandaloneTaxReturnPipelines(pipelines: unknown): boolean {
  if (!Array.isArray(pipelines)) return false
  const names = Array.from(
    new Set(
      pipelines
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    ),
  )
  return names.length === 1 && names[0] === 'Tax Return'
}

export interface StandaloneStartInput {
  /** the offer sells only a Tax Return */
  standalone: boolean
  /** the Tax Return line is a company return (an individual 1040-NR has no company tax form: it keeps the existing path) */
  companyReturn: boolean
  /** the offer already carries a company (it was made on the company's page) */
  hasCompany: boolean
}

export interface StandaloneStart {
  /** the stage the job is created at */
  createAt: string
  /** after the tax record is ready the job moves here (null = it stays where it was created) */
  openAt: string | null
}

/**
 * Where a standalone return starts, or null when the offer is not a standalone COMPANY return (the existing path then applies, unchanged).
 *  - no company yet → "Company Data Pending"; the company-information step creates the company and opens the form itself;
 *  - company known  → created at "Paid - Awaiting Data" and moved to "Wizard Available" once its tax record exists (the record must exist
 *    first, the same order the 2nd-installment path uses).
 */
export function standaloneTaxReturnStart(p: StandaloneStartInput): StandaloneStart | null {
  if (!p.standalone || !p.companyReturn) return null
  if (!p.hasCompany) return { createAt: STANDALONE_TR_STAGES.companyDataPending, openAt: null }
  return { createAt: STANDALONE_TR_STAGES.paidAwaitingData, openAt: STANDALONE_TR_STAGES.open }
}
