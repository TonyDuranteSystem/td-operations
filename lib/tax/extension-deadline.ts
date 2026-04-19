/**
 * IRS extension deadlines by return type.
 *
 * The `tax_returns.extension_deadline` column is often null in our DB
 * (every one of the 203 rows suspended for the 2025 season had null),
 * so the portal banner and any UI that shows this value falls back to
 * computing from tax_year + return_type.
 *
 * Rules (calendar-year filers):
 *   SMLLC   — 1040 Schedule C filed by the owner: Oct 15 of (tax_year + 1)
 *   Corp    — 1120: Oct 15 of (tax_year + 1)
 *   MMLLC   — 1065 partnership: Sept 15 of (tax_year + 1)
 *
 * Non-calendar-year filers (rare in our book) should have a real
 * extension_deadline written by whoever filed the extension.
 */

export type TaxReturnType = "SMLLC" | "MMLLC" | "Corp" | "S-Corp" | null | undefined

/**
 * Resolve the extension deadline for a return. If the caller has a non-null
 * `stored` value from tax_returns.extension_deadline, we trust it.
 * Otherwise compute from tax_year + return_type.
 *
 * @param stored       tax_returns.extension_deadline (ISO YYYY-MM-DD) or null
 * @param taxYear      tax_returns.tax_year (integer, e.g. 2025)
 * @param returnType   tax_returns.return_type — one of SMLLC / MMLLC / Corp
 * @returns            ISO YYYY-MM-DD string, or null if we can't resolve
 */
export function resolveExtensionDeadline(
  stored: string | null | undefined,
  taxYear: number | null | undefined,
  returnType: TaxReturnType,
): string | null {
  if (stored) return stored
  if (!taxYear || typeof taxYear !== "number") return null
  const filingYear = taxYear + 1
  // MMLLC partnerships and S-Corps file earlier (Sept 15); everyone else Oct 15.
  const isPartnershipLike =
    returnType === "MMLLC" || returnType === "S-Corp"
  const month = isPartnershipLike ? "09" : "10"
  return `${filingYear}-${month}-15`
}

/**
 * Pretty-format a deadline string for a locale. Defaults to English
 * "Month D, YYYY"; Italian is "D MMMM YYYY" (no comma). Returns the raw
 * string on parse failure so callers never render "Invalid Date".
 */
export function formatDeadlineForDisplay(
  iso: string | null,
  locale: "en" | "it" = "en",
): string {
  if (!iso) return ""
  const parts = iso.split("-")
  if (parts.length !== 3) return iso
  const [yearStr, monthStr, dayStr] = parts
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (!year || !month || !day) return iso
  const monthNameEn = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][month - 1]
  const monthNameIt = [
    "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
  ][month - 1]
  if (!monthNameEn || !monthNameIt) return iso
  if (locale === "it") {
    return `${day} ${monthNameIt} ${year}`
  }
  return `${monthNameEn} ${day}, ${year}`
}
