/**
 * The check a new offer gets about its Tax Return line (dev job 0a60f416, part B). Server side — it looks at the company.
 *
 * Only a SHORT-CONTRACT tax return offer (contract_type "tax_return") is judged: that is the one whose year the activation reads. On a formation
 * or onboarding offer a bundled Tax Return keeps paying the previous year as it always did, so nothing is said or refused there.
 *
 *  - Refused (it would sign a return nobody can ever file): two Tax Return lines (a line is for ONE year — two years are two offers), or a year
 *    before the company existed / after this year.
 *  - Warned (the offer is still created): the line states no year (it will be tracked as last year, as before), or the company already has a
 *    return tracked for that year that is filed or paid.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { taxYearOfOffer, taxYearProblem } from '@/lib/offers/tax-year'

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
  if (input.contractType !== 'tax_return') return none

  const { year, lineCount } = taxYearOfOffer(input.services)
  if (lineCount > 1) {
    return { error: `This offer has ${lineCount} Tax Return lines. A Tax Return line is for one tax year — make one offer for each year.`, warnings: [] }
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
