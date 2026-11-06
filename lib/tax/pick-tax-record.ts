/**
 * Which tax record does a Tax Return pipeline move belong to? (dev job 6f555c9f, Part 2 item 1 — "the year fix")
 *
 * When staff (or a tool) move a Tax Return pipeline, `advanceServiceDelivery` copies the new step onto the
 * company's tax record. It used to look for the record of the CURRENT CALENDAR YEAR (`new Date().getFullYear()`),
 * which is the year the work is DONE in, not the year the return is FOR: in 2026 it looked for a 2026 record, so the
 * 2025 return was never updated (the client's banner stayed on), and when a 2026 record happened to exist that one was
 * stamped by mistake (Kasabi, MaoBao, TradeLink, Xecom — proven in the change log). Next season it would have looked for
 * 2027 while the work is for 2026: the same failure, one year later.
 *
 * The record is the one whose tax year equals the pipeline's OWN tax year — the same year the chat tab and the
 * workspace title show (`taxReturnYear` in lib/flows/resolve-flows.ts: the year the pipeline was opened minus one).
 * It never guesses: when there is no date to read a year from, no record of that year, or (impossible with the
 * `uq_tax_returns_account_year` index, but checked) more than one, it returns `none` with a plain reason so the caller can
 * leave a visible note instead of changing a record that is not the right one. Pure — unit-tested.
 */

export interface TaxRecordRow {
  id: string
  status: string | null
  tax_year: number | null
}

export type PickTaxRecordResult =
  | { kind: 'record'; row: TaxRecordRow }
  | { kind: 'none'; reason: string }

export function pickTaxRecordForPipeline(
  rows: ReadonlyArray<TaxRecordRow> | null | undefined,
  pipelineTaxYear: number | null | undefined,
): PickTaxRecordResult {
  if (pipelineTaxYear == null || !Number.isFinite(pipelineTaxYear)) {
    return { kind: 'none', reason: 'the pipeline has no date to read its tax year from' }
  }
  const matches = (rows ?? []).filter(r => r.tax_year === pipelineTaxYear)
  if (matches.length === 0) {
    return { kind: 'none', reason: `the company has no ${pipelineTaxYear} tax record` }
  }
  if (matches.length > 1) {
    return { kind: 'none', reason: `the company has ${matches.length} tax records for ${pipelineTaxYear}` }
  }
  return { kind: 'record', row: matches[0] }
}
