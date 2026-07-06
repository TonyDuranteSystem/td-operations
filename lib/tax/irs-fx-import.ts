/**
 * IRS yearly-average FX rate importer — PURE half (2026-07-06, Antonio: "I
 * want it fully automatic"). The cron route (app/api/cron/irs-fx-rates) feeds
 * this the fetched page HTML; everything here is deterministic and DB-free so
 * the failure modes live under unit tests with a real page fixture.
 *
 * Hard-won rules baked in (all hit during the 2026-07-06 manual seed):
 *  - The IRS page itself contains locale artifacts: EUR 2024 is printed
 *    "0,924" (decimal COMMA). Rule: comma-without-dot = decimal comma;
 *    comma-with-dot = thousands separator. A naive comma-strip stores 924 and
 *    divides every euro by ~1000x the true rate.
 *  - Country naming drifts ("South Korean", not "South Korea") — the ISO map
 *    is EXPLICIT and unmapped rows are surfaced, never guessed (R093).
 *  - Direction: FOREIGN UNITS PER 1 USD ("divide by the rate") — matches
 *    lib/tax/fx.ts::toUsd and lib/pnl-generator.ts. If the IRS ever flips
 *    direction, the sanity floor below (min currencies + bounds) won't catch
 *    it — the diff alarm will (every known rate suddenly "changes").
 *
 * FAIL-CLOSED: any structural surprise (few rows, missing year header, absurd
 * value) throws — the cron aborts with ZERO writes and alerts staff.
 * INSERT-ONLY: an existing (year, currency) row is NEVER overwritten by the
 * cron; a value that differs from the page is reported as a diff for humans.
 * A rate already used in a filed return must not drift silently.
 */

/** The official IRS yearly-average exchange-rate page. */
export const IRS_FX_URL =
  "https://www.irs.gov/individuals/international-taxpayers/yearly-average-currency-exchange-rates"

/** Explicit "Country|Currency" → ISO 4217. Names exactly as the IRS prints them. */
export const IRS_CURRENCY_ISO: Readonly<Record<string, string>> = {
  "Afghanistan|Afghani": "AFN",
  "Algeria|Dinar": "DZD",
  "Argentina|Peso": "ARS",
  "Australia|Dollar": "AUD",
  "Bahrain|Dinar": "BHD",
  "Brazil|Real": "BRL",
  "Canada|Dollar": "CAD",
  "Cayman Islands|Dollar": "KYD",
  "China|Yuan": "CNY",
  "Denmark|Krone": "DKK",
  "Egypt|Pound": "EGP",
  "Euro Zone|Euro": "EUR",
  "Hong Kong|Dollar": "HKD",
  "Hungary|Forint": "HUF",
  "Iceland|Krona": "ISK",
  "India|Rupee": "INR",
  "Iraq|Dinar": "IQD",
  "Israel|New Shekel": "ILS",
  "Japan|Yen": "JPY",
  "Lebanon|Pound": "LBP",
  "Mexico|Peso": "MXN",
  "Morocco|Dirham": "MAD",
  "New Zealand|Dollar": "NZD",
  "Norway|Kroner": "NOK",
  "Qatar|Rial": "QAR",
  "Russia|Ruble": "RUB",
  "Saudi Arabia|Riyal": "SAR",
  "Singapore|Dollar": "SGD",
  "South Africa|Rand": "ZAR",
  "South Korean|Won": "KRW",
  "Sweden|Krona": "SEK",
  "Switzerland|Franc": "CHF",
  "Taiwan|Dollar": "TWD",
  "Thailand|Baht": "THB",
  "Tunisia|Dinar": "TND",
  "Turkey|New Lira": "TRY",
  "United Arab Emirates|Dirham": "AED",
  "United Kingdom|Pound": "GBP",
  "Venezuela|Bolivar (Fuerte)": "VES",
}

/** Structural floor: fewer mapped currencies than this = page redesign → abort. */
export const MIN_CURRENCIES = 30
/** At least this many year columns expected in the header. */
export const MIN_YEARS = 2

export interface IrsRate {
  tax_year: number
  currency: string
  rate_to_usd: number
}

export interface IrsParseResult {
  rates: IrsRate[]
  years: number[]
  /** Country|Currency labels the ISO map doesn't know — surfaced, not guessed. */
  unmapped: string[]
  /** Individual cells that don't parse as a usable rate (the real page prints
   *  Russia 2021 as ".73.686") — skipped + surfaced, never guessed. A single
   *  bad cell must not block the other ~194 good rates; the structural floor
   *  below still fails the whole run if the page itself collapses. */
  badCells: Array<{ key: string; tax_year: number; raw: string }>
}

/**
 * Normalize one printed rate cell. Comma-without-dot is a decimal comma
 * ("0,924" → 0.924); comma-with-dot is a thousands separator ("1,234.56").
 * Throws on non-numeric or out-of-bounds values (fail-closed).
 */
export function normalizeIrsRate(raw: string): number {
  let s = raw.trim()
  if (s.includes(",") && !s.includes(".")) s = s.replace(/,/g, ".")
  else s = s.replace(/,/g, "")
  const v = Number(s)
  // Bounds: Bahrain 0.377 is the real low; Venezuela's bolívar is legitimately
  // astronomical (1.3e16 in 2025), so the ceiling is generous but finite.
  if (!Number.isFinite(v) || v <= 0 || v >= 1e18) {
    throw new Error(`IRS FX import: unusable rate cell "${raw}"`)
  }
  return v
}

/** Strip tags and entities from one HTML fragment. */
function cellText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&#39;/g, "'")
    .trim()
}

/**
 * Parse the IRS page HTML into rates. Years are read from the TABLE HEADER —
 * never assumed — so the annual column shift (2026 appearing, 2022 dropping)
 * needs no code change. Throws (fail-closed) on any structural surprise.
 */
export function parseIrsRatesHtml(html: string): IrsParseResult {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []
  if (rows.length === 0) throw new Error("IRS FX import: no table rows found (page redesign?)")

  // Header row: "Country" + "Currency" + one column per year.
  let years: number[] | null = null
  const rates: IrsRate[] = []
  const unmapped: string[] = []
  const badCells: IrsParseResult["badCells"] = []

  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(cellText)
    if (cells.length < 3) continue
    if (!years && /^country$/i.test(cells[0])) {
      years = cells.slice(2).map(c => Number(c.replace(/[^\d]/g, ""))).filter(y => y >= 2000 && y <= 2100)
      if (years.length < MIN_YEARS) throw new Error(`IRS FX import: could not read year columns from header [${cells.join(", ")}]`)
      continue
    }
    if (!years) continue // rows before the header are page furniture
    const key = `${cells[0]}|${cells[1]}`
    const iso = IRS_CURRENCY_ISO[key]
    if (!iso) {
      if (cells[0] && cells[1]) unmapped.push(key)
      continue
    }
    const valueCells = cells.slice(2, 2 + years.length)
    if (valueCells.length < years.length) throw new Error(`IRS FX import: row "${key}" has ${valueCells.length} value cells, expected ${years.length}`)
    for (let i = 0; i < years.length; i++) {
      try {
        rates.push({ tax_year: years[i], currency: iso, rate_to_usd: normalizeIrsRate(valueCells[i]) })
      } catch {
        badCells.push({ key, tax_year: years[i], raw: valueCells[i] })
      }
    }
  }

  if (!years) throw new Error("IRS FX import: header row not found (page redesign?)")
  const currencyCount = new Set(rates.map(r => r.currency)).size
  if (currencyCount < MIN_CURRENCIES) {
    throw new Error(`IRS FX import: only ${currencyCount} currencies parsed (floor ${MIN_CURRENCIES}) — aborting, no writes`)
  }
  return { rates, years, unmapped, badCells }
}

export interface FxImportDecision {
  /** (year, currency) pairs absent from the DB — safe to insert. */
  inserts: IrsRate[]
  /** Existing rows whose stored value differs from the page — NEVER auto-
   *  overwritten; reported for human review (a filed return may depend on it). */
  diffs: Array<{ tax_year: number; currency: string; stored: number; page: number }>
}

/** Rates equal within a half-unit of the page's own printed precision. */
const DIFF_EPSILON = 0.0005

/** INSERT-ONLY reconciliation of parsed page rates against stored rows. */
export function decideFxImport(
  parsed: IrsRate[],
  existing: Array<{ tax_year: number; currency: string; rate_to_usd: number | string }>,
): FxImportDecision {
  const stored = new Map(existing.map(e => [`${e.tax_year}|${e.currency}`, Number(e.rate_to_usd)]))
  const inserts: IrsRate[] = []
  const diffs: FxImportDecision["diffs"] = []
  for (const r of parsed) {
    const key = `${r.tax_year}|${r.currency}`
    const cur = stored.get(key)
    if (cur === undefined) {
      inserts.push(r)
    } else if (Math.abs(cur - r.rate_to_usd) > Math.max(DIFF_EPSILON, Math.abs(r.rate_to_usd) * 1e-6)) {
      diffs.push({ tax_year: r.tax_year, currency: r.currency, stored: cur, page: r.rate_to_usd })
    }
  }
  return { inserts, diffs }
}
