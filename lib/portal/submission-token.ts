/**
 * Submission token builder — one token per (person, SUBJECT, filing period).
 *
 * The legacy shape `portal-{name-slug}-{calendarYear}` carried NO subject
 * discriminator, and every submission table upserts on token: an owner of two
 * companies submitting both in the same calendar year had the second upsert
 * MATCH the first company's row — reassigning it and overwriting its data.
 * Proven live during the 2026-07-16 MMLLC E2E walk (dev job 8cc8e1c8): the
 * QA fixture's submit hijacked the sibling QA company's existing submission.
 *
 * New shape: `portal-{name-slug}-{period}-{scope8}` where
 *  - period = `ty{taxYear}` for tax submissions (two open back-filing years
 *    must not collide within one calendar year), else the calendar year;
 *  - scope8 = first 8 chars of the submission's SUBJECT id — account when
 *    present, else the formation lead, else the contact.
 *
 * Review-loop edits never touch tokens (they UPDATE the pinned row by id),
 * so legacy-format tokens on existing rows stay valid forever; only FRESH
 * submissions mint the new shape. Retry-idempotency is preserved: the same
 * client retrying the same fresh submit rebuilds the identical token and the
 * upsert lands on the same row.
 */

export function slugifyClientName(clientName: string): string {
  return clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").slice(0, 40)
}

export interface BuildSubmissionTokenParams {
  clientName: string
  wizardType: string
  /** Pinned tax year (tax wizards only — the eligibility resolver guarantees it). */
  taxYear?: number | null
  accountId?: string | null
  leadId?: string | null
  contactId?: string | null
  /** Calendar year for non-tax tokens; injectable for tests. */
  calendarYear: number
}

export function buildSubmissionToken(p: BuildSubmissionTokenParams): string {
  const slug = slugifyClientName(p.clientName)
  const isTax = p.wizardType === "tax" || p.wizardType === "tax_return"
  const period = isTax && p.taxYear != null ? `ty${p.taxYear}` : String(p.calendarYear)
  const scopeId = p.accountId || p.leadId || p.contactId || ""
  const scope = scopeId ? `-${String(scopeId).slice(0, 8)}` : ""
  return `portal-${slug}-${period}${scope}`
}
