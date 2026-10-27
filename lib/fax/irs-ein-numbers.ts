/**
 * The IRS EIN fax lines (dev job ff2b73d7): the domestic line and the international one. A fax to either of them is an SS-4 filing FOR A
 * CLIENT'S COMPANY, which is the only kind of fax the SS-4 state check applies to — a fax to any other number (a bank, an attorney, a
 * client) is never checked and never asks for a company.
 *
 * Kept in its own module (not in faxage.ts) because the fax route's tests replace faxage.ts wholesale; a test pins these two numbers to
 * the constants faxage.ts exports, so the two can never drift apart.
 */
export const IRS_EIN_FAX_NUMBERS: readonly string[] = ['8556416935', '8552151627']

/** "1 (855) 641-6935", "855-641-6935", "+18556416935" … -> true for an IRS EIN line. */
export function isIrsEinFaxNumber(faxno: string | null | undefined): boolean {
  if (typeof faxno !== 'string') return false
  let digits = faxno.replace(/\D/g, '')
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1)
  return IRS_EIN_FAX_NUMBERS.indexOf(digits) !== -1
}
