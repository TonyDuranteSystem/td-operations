/**
 * Formation Date Installment Rule
 *
 * If a company is formed AFTER September 1st of a year,
 * the FIRST installment (January) of the FOLLOWING year is SKIPPED.
 * The setup fee covers through end of formation year.
 * First annual maintenance starts from June of the following year.
 *
 * Enforced at DB level via trigger `trg_formation_date_installment_rule`
 * on the `payments` table. This utility is for code-level checks and
 * annotations in query results.
 */

export function shouldSkipJanuaryInstallment(
  formationDate: string | null,
  installmentYear: number
): boolean {
  if (!formationDate) return false

  const date = new Date(formationDate)
  const formationMonth = date.getMonth() + 1 // 1-based
  const formationYear = date.getFullYear()

  return formationMonth > 8 && installmentYear === formationYear + 1
}

export function getInstallmentSchedule(formationDate: string | null): {
  skipFirstJanuary: boolean
  firstJanuaryYear: number | null
  firstJuneYear: number
} {
  if (!formationDate) {
    return { skipFirstJanuary: false, firstJanuaryYear: null, firstJuneYear: new Date().getFullYear() + 1 }
  }

  const date = new Date(formationDate)
  const formationMonth = date.getMonth() + 1
  const formationYear = date.getFullYear()
  const nextYear = formationYear + 1

  if (formationMonth > 8) {
    return {
      skipFirstJanuary: true,
      firstJanuaryYear: nextYear + 1, // skip next Jan, first Jan is year+2
      firstJuneYear: nextYear,
    }
  }

  return {
    skipFirstJanuary: false,
    firstJanuaryYear: nextYear,
    firstJuneYear: nextYear,
  }
}
