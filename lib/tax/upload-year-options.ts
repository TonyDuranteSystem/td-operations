/**
 * The "Tax year" list on the client's Tax Documents upload box, and which year it starts on.
 *
 * It used to put the CURRENT CALENDAR YEAR first and pre-select it, so in 2026 a client uploading papers for the
 * return they were working on (the 2025 return) had them tagged 2026 unless they noticed and changed it — and next
 * season the box would have started on 2027 while the open return is 2026 (Antonio 2026-11-05: "next year must be
 * right"). The current year stays in the list (a client may upload something for the year in progress) but is no
 * longer the starting choice.
 *
 * Starts on: the OLDEST tax year that is still OPEN (not TR Filed / TR Completed / Cancelled) — the same rule the tax
 * wizard uses for "which return is being worked" (`decideTaxWizardEligibility`: back-filing collects oldest first), so a
 * company with a 2025 return in progress and a 2026 record already seeded starts on 2025; else the newest tax year the
 * company has a record for; else the year before today's (the most recent finished tax year). The starting year is
 * ALWAYS in the list (a company with no record would otherwise start on a year the list does not show). Pure — unit-tested.
 */

export interface UploadYearRecord {
  tax_year: number | null
  status: string | null
}

const FINISHED = new Set(['TR Filed', 'TR Completed', 'Cancelled'])

export function uploadYearOptions(
  records: ReadonlyArray<UploadYearRecord> | null | undefined,
  currentYear: number,
): { years: number[]; defaultYear: number } {
  const rows = (records ?? []).filter((r): r is { tax_year: number; status: string | null } => typeof r.tax_year === 'number' && r.tax_year > 1900)
  const open = rows.filter(r => !FINISHED.has(r.status ?? '')).map(r => r.tax_year)
  const defaultYear = open.length > 0
    ? Math.min(...open)
    : rows.length > 0
      ? Math.max(...rows.map(r => r.tax_year))
      : currentYear - 1
  const years = Array.from(new Set([...rows.map(r => r.tax_year), currentYear, defaultYear])).sort((a, b) => b - a)
  return { years, defaultYear }
}
