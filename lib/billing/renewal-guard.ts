/** Pure function: determine Year 1 skip and September rule for a given TD start date and renewal year. */
export function getRenewalGuard(tdStartDate: string | null, renewalYear: number): { skipAccount: boolean; skipJanuary: boolean } {
  if (!tdStartDate) return { skipAccount: false, skipJanuary: false }
  const d = new Date(tdStartDate)
  const startYear = d.getUTCFullYear()
  const startMonth = d.getUTCMonth() + 1
  if (startYear === renewalYear) return { skipAccount: true, skipJanuary: false }
  const skipJanuary = startYear === renewalYear - 1 && startMonth >= 9
  return { skipAccount: false, skipJanuary }
}
