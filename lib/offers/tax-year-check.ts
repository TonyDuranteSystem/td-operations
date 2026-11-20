/**
 * The check a new offer gets about its Tax Return line (dev job 0a60f416 part B, widened by job 06a3c8e9 — "any offer"). Server side — it looks at the company.
 *
 * ANY offer that carries a Tax Return line is judged, whatever it is led by — a tax return, a closure, an ITIN, a name change, a custom service… (not a
 * FORMATION or ONBOARDING offer: their Tax Return is created later by the company's own setup, which picks its own year — see `taxYearAppliesToOffer`).
 * The activation reads the year from that line for those offers, so a year that cannot exist must be caught wherever the line sits. (It used to be only a
 * short-contract tax return offer — a "Tax Return 2026" line inside a closure offer silently lost its year.)
 *
 *  - Refused (it would sign a return nobody can ever file): a year before the company existed / after this year; and, on a tax-return offer, two Tax
 *    Return lines (a line is for ONE year — two years are two offers).
 *  - Warned (the offer is still created): the line states no year (it will be tracked as last year, as before); the company already has a return
 *    tracked for that year that is filed or paid; or, on any other kind of offer, two Tax Return lines (the system tracks ONE year per offer, so the
 *    years are not used — make one offer for each year). Not refused there: such an offer is sold today and must keep working.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { taxYearAppliesToOffer, taxYearOfOffer, taxYearProblem } from '@/lib/offers/tax-year'

export interface TaxYearCheck {
  error: string | null
  warnings: string[]
}

export async function checkTaxYearOnOffer(input: {
  contractType: string | null | undefined
  services: unknown
  accountId: string | null | undefined
  now?: Date
}): Promise<TaxYearCheck> {
  const none: TaxYearCheck = { error: null, warnings: [] }
  // a formation / onboarding offer's Tax Return is created later by the company's own setup, which picks its year: nothing here reads the line
  if (!taxYearAppliesToOffer(input.contractType)) return none
  const { year, lineCount } = taxYearOfOffer(input.services)
  if (lineCount > 1) {
    const msg = `This offer has ${lineCount} Tax Return lines. A Tax Return line is for one tax year — make one offer for each year.`
    // A tax-return offer is refused (the activation could only pay one of them). Any other offer keeps working as it always did: the years are simply not read.
    return input.contractType === 'tax_return' ? { error: msg, warnings: [] } : { error: null, warnings: [`${msg} The years in these lines will not be used (last year is tracked).`] }
  }
  if (lineCount === 0) return none

  const currentYear = (input.now ?? new Date()).getFullYear()
  if (year === null) {
    return {
      error: null,
      warnings: [`The Tax Return line does not say which tax year it is for, so it will be tracked as ${currentYear - 1}. To set it, write the year in the line name (for example "Tax Return ${currentYear}").`],
    }
  }

  let formationYear: number | null = null
  const warnings: string[] = []
  if (input.accountId) {
    const { data: account } = await supabaseAdmin.from('accounts').select('formation_date').eq('id', input.accountId).maybeSingle()
    const f = account?.formation_date ? new Date(account.formation_date).getFullYear() : NaN
    formationYear = Number.isFinite(f) ? f : null
  }
  const problem = taxYearProblem(year, { formationYear, currentYear })
  if (problem) return { error: `Tax Return line: ${problem}`, warnings: [] }

  if (input.accountId) {
    const { data: tracked } = await supabaseAdmin.from('tax_returns').select('status, paid').eq('account_id', input.accountId).eq('tax_year', year).limit(1).maybeSingle()
    if (tracked && (tracked.paid || /filed/i.test(tracked.status ?? ''))) {
      warnings.push(`This company already has a ${year} tax return tracked (status "${tracked.status}", ${tracked.paid ? 'paid' : 'not paid'}). Check that the offer is for the right year.`)
    }
  }
  return { error: null, warnings }
}
