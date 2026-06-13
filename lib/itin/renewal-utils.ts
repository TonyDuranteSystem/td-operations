/**
 * Pure ITIN renewal calculation helpers.
 * No DB access — unit-tested in tests/unit/itin-renewal-utils.test.ts.
 */

/**
 * Calculate itin_renewal_date from itin_issue_date.
 * Rule: renewal is due June 1st of (issue_year + 3).
 */
export function calcITINRenewalDate(issueDate: string | Date | null | undefined): Date | null {
  if (!issueDate) return null
  const d = typeof issueDate === "string" ? new Date(issueDate) : issueDate
  if (isNaN(d.getTime())) return null
  return new Date(d.getFullYear() + 3, 5, 1) // month 5 = June
}

/**
 * Extract the middle 2 digits from a formatted ITIN (9XX-XX-XXXX).
 * Returns the 2-digit string or null.
 */
export function extractITINMiddleDigits(itinNumber: string | null | undefined): string | null {
  if (!itinNumber) return null
  const clean = itinNumber.replace(/\D/g, "")
  if (clean.length !== 9) return null
  return clean.substring(3, 5)
}
