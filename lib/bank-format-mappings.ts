/**
 * Learned statement-format mappings (S1, 2026-07-07 — tri-role reviewed:
 * CPA + senior engineer + AI architect).
 *
 * Formats are DATA, not code. For a CSV layout no hand-coded signature knows:
 *  1. look up a stored mapping by the header FINGERPRINT — hit = parse
 *     deterministically, zero AI;
 *  2. miss = derive a mapping: heuristically when the file is unambiguous,
 *     else ONE AI call that proposes COLUMN ROLES ONLY (the AI never touches
 *     row values — engineer condition);
 *  3. run the deterministic VERIFIER: hard checks (every dated row parses,
 *     every amount numeric, balance column self-consistent when present) and
 *     ambiguity checks (competing date/amount columns, ambiguous day/month
 *     order, settled-vs-original currency pair, unknown account identity);
 *  4. zero ambiguity + hard pass → store as verified_auto and parse;
 *     any ambiguity → QUARANTINE (status 'proposed'): the file does NOT
 *     ingest until staff confirms the proposed reading with one tap.
 *
 * CPA rules baked in: when a settled amount coexists with an "original
 * currency" column, the books take the SETTLED amount in the account currency
 * (the original currency is display metadata only — the Dynamiq double-
 * conversion class); confirmed mappings are audit records (who, when, from
 * which file).
 */

import { createHash } from "crypto"
import {
  sniffCsvDialect, parseDelimitedRows, stableRowRef, dedupeRefs,
  parseSignedAmount, parseAmount, detectDateOrder, flexibleDateToIso, findCol,
  G_DATE, G_AMOUNT, G_DEBIT, G_CREDIT, G_BALANCE, G_CURRENCY, G_DESC, G_PARTY,
  type CsvDialect,
} from "./bank-csv-parsers"
import type { ParseResult, ParsedTransaction } from "./bank-statement-parser"

// ─── Mapping shape (stored as JSONB) ─────────────────────────

export interface FormatMapping {
  version: 1
  bank_label: string
  /** Index of the header row (some exports carry preamble lines). Default 0. */
  header_row?: number
  date: { col: number; order: "mdy" | "dmy" }
  description_cols: number[]
  counterparty_col?: number | null
  amount:
    | { mode: "signed"; col: number; positive_is: "in" | "out" }
    | { mode: "debit_credit"; debit_col: number; credit_col: number }
  currency:
    | { mode: "fixed"; value: string }
    | { mode: "column"; col: number } // true multi-currency ledgers (Wise-class)
    | { mode: "settled_fixed_with_original"; value: string; original_col: number }
  account: { mode: "fixed"; label?: string | null } | { mode: "column"; col: number }
  balance_col?: number | null
  status?: { col: number; include: string[] } | null
  ref_extra_cols?: number[]
}

/** Validate an untrusted mapping object (AI output / DB row). Throws on shape errors. */
export function assertValidMapping(m: unknown, headerLen: number): FormatMapping {
  const fail = (why: string): never => { throw new Error(`Invalid format mapping: ${why}`) }
  if (typeof m !== "object" || m === null) fail("not an object")
  const x = m as Record<string, unknown>
  const colOk = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < headerLen
  if (x.version !== 1) fail("version must be 1")
  if (typeof x.bank_label !== "string" || !x.bank_label.trim()) fail("bank_label required")
  const date = x.date as Record<string, unknown>
  if (!date || !colOk(date.col) || (date.order !== "mdy" && date.order !== "dmy")) fail("date.col/order")
  if (!Array.isArray(x.description_cols) || x.description_cols.length === 0 || !x.description_cols.every(colOk)) fail("description_cols")
  const amount = x.amount as Record<string, unknown>
  if (!amount) fail("amount required")
  if (amount.mode === "signed") {
    if (!colOk(amount.col) || (amount.positive_is !== "in" && amount.positive_is !== "out")) fail("amount.signed")
  } else if (amount.mode === "debit_credit") {
    if (!colOk(amount.debit_col) || !colOk(amount.credit_col)) fail("amount.debit_credit")
  } else fail("amount.mode")
  const currency = x.currency as Record<string, unknown>
  if (!currency) fail("currency required")
  if (currency.mode === "fixed" || currency.mode === "settled_fixed_with_original") {
    if (typeof currency.value !== "string" || !/^[A-Z]{3}$/.test(currency.value as string)) fail("currency.value")
    if (currency.mode === "settled_fixed_with_original" && !colOk(currency.original_col)) fail("currency.original_col")
  } else if (currency.mode === "column") {
    if (!colOk(currency.col)) fail("currency.col")
  } else fail("currency.mode")
  const account = x.account as Record<string, unknown>
  if (!account) fail("account required")
  if (account.mode === "column") { if (!colOk(account.col)) fail("account.col") }
  else if (account.mode !== "fixed") fail("account.mode")
  if (x.balance_col !== undefined && x.balance_col !== null && !colOk(x.balance_col)) fail("balance_col")
  if (x.status !== undefined && x.status !== null) {
    const s = x.status as Record<string, unknown>
    if (!colOk(s.col) || !Array.isArray(s.include) || s.include.length === 0) fail("status")
  }
  if (x.counterparty_col !== undefined && x.counterparty_col !== null && !colOk(x.counterparty_col)) fail("counterparty_col")
  if (x.ref_extra_cols !== undefined && (!Array.isArray(x.ref_extra_cols) || !(x.ref_extra_cols as unknown[]).every(colOk))) fail("ref_extra_cols")
  return m as FormatMapping
}

// ─── Fingerprint ─────────────────────────────────────────────

/** Normalized header cells — the identity of a format. */
export function normalizeHeader(cells: string[]): string[] {
  return cells.map(c => c.trim().toLowerCase())
}

/** Human-readable fingerprint: normalized header joined with '|'. Long headers
 *  fall back to a sha256 so the unique key stays bounded. */
export function formatFingerprint(headerCells: string[]): string {
  const joined = normalizeHeader(headerCells).join("|")
  return joined.length <= 600 ? joined : `sha256:${createHash("sha256").update(joined).digest("hex")}`
}

// ─── Deterministic parse THROUGH a mapping ───────────────────

export function applyFormatMapping(content: string, mapping: FormatMapping): ParseResult {
  const errors: string[] = []
  const dialect: CsvDialect = sniffCsvDialect(content)
  const rows = parseDelimitedRows(content, dialect.delimiter)
  const headerRow = mapping.header_row ?? 0
  if (rows.length <= headerRow + 1) {
    return { transactions: [], bank_name: mapping.bank_label, currency: "USD", account_holder: "", period: "", errors: ["Empty CSV"], extraction_method: "mapped_csv" }
  }
  const body = rows.slice(headerRow + 1)
  const transactions: ParsedTransaction[] = []
  let skippedStatus = 0

  for (const row of body) {
    if (mapping.status) {
      const st = (row[mapping.status.col] ?? "").trim().toLowerCase()
      if (st && !mapping.status.include.includes(st)) { skippedStatus++; continue }
    }
    const rawDate = (row[mapping.date.col] ?? "").trim()
    if (!rawDate) continue // blank/footer rows
    const iso = flexibleDateToIso(rawDate, mapping.date.order)
    if (!iso) { errors.push(`Unparseable date: "${rawDate}"`); continue }

    let amount: number
    if (mapping.amount.mode === "signed") {
      amount = parseSignedAmount(row[mapping.amount.col] ?? "", dialect.commaDecimals)
      if (!isNaN(amount) && mapping.amount.positive_is === "out") amount = -amount
    } else {
      const deb = parseSignedAmount(row[mapping.amount.debit_col] ?? "", dialect.commaDecimals)
      const cre = parseSignedAmount(row[mapping.amount.credit_col] ?? "", dialect.commaDecimals)
      amount = (isNaN(cre) ? 0 : Math.abs(cre)) - (isNaN(deb) ? 0 : Math.abs(deb))
      if (isNaN(deb) && isNaN(cre)) amount = NaN
    }
    if (isNaN(amount)) { errors.push(`Unparseable amount (${iso})`); continue }

    // CPA rule: settled amount + settled currency enter the books; an
    // original-currency column is metadata only.
    const currency = mapping.currency.mode === "column"
      ? ((row[mapping.currency.col] ?? "").trim().toUpperCase() || "USD")
      : mapping.currency.value

    const desc = Array.from(new Set(
      mapping.description_cols.map(i => (row[i] ?? "").trim()).filter(Boolean),
    )).join(" | ") || "Transaction"
    const counterparty = mapping.counterparty_col != null ? (row[mapping.counterparty_col] ?? "").trim() : ""
    const account = mapping.account.mode === "column"
      ? ((row[mapping.account.col] ?? "").trim() || currency)
      : (mapping.account.label || currency)
    const balanceRaw = mapping.balance_col != null ? (row[mapping.balance_col] ?? "").trim() : ""
    const balance = balanceRaw ? parseAmount(balanceRaw, dialect.commaDecimals) : NaN

    transactions.push({
      transaction_date: iso,
      description: desc,
      counterparty,
      amount,
      currency,
      balance_after: !isNaN(balance) ? balance : null,
      transaction_ref: stableRowRef([iso, amount, desc, ...(mapping.ref_extra_cols ?? []).map(i => (row[i] ?? "").trim())]),
      bank_name: mapping.bank_label,
      account_type: account,
    })
  }
  if (skippedStatus > 0) errors.push(`Skipped ${skippedStatus} row(s) outside status ${JSON.stringify(mapping.status?.include)}`)

  const refs = dedupeRefs(transactions.map(t => t.transaction_ref))
  transactions.forEach((t, i) => { t.transaction_ref = refs[i] })
  const dates = transactions.map(t => t.transaction_date).sort()
  return {
    transactions,
    bank_name: mapping.bank_label,
    currency: transactions[0]?.currency || "USD",
    account_holder: "",
    period: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "",
    errors,
    extraction_method: "mapped_csv",
  }
}

// ─── Verifier: hard checks + ambiguity detection ─────────────

export interface MappingVerification {
  hard_failures: string[]
  ambiguities: string[]
  /** Rendered sample rows for the confirm UI. */
  sample: Array<{ date: string; description: string; amount: number; currency: string; account: string }>
  ok: boolean            // no hard failures
  auto_acceptable: boolean // ok AND zero ambiguities
}

export function verifyMapping(content: string, mapping: FormatMapping): MappingVerification {
  const hard: string[] = []
  const ambiguities: string[] = []
  const dialect = sniffCsvDialect(content)
  const rows = parseDelimitedRows(content, dialect.delimiter)
  const headerRow = mapping.header_row ?? 0
  const header = normalizeHeader(rows[headerRow] ?? [])
  const body = rows.slice(headerRow + 1)

  // Hard: every row with a date-cell value must parse; every parsed row's amount numeric.
  let dated = 0, dateFails = 0, amountFails = 0
  for (const row of body) {
    const rawDate = (row[mapping.date.col] ?? "").trim()
    if (!rawDate) continue
    if (mapping.status) {
      const st = (row[mapping.status.col] ?? "").trim().toLowerCase()
      if (st && !mapping.status.include.includes(st)) continue
    }
    dated++
    if (!flexibleDateToIso(rawDate, mapping.date.order)) { dateFails++; continue }
    if (mapping.amount.mode === "signed") {
      if (isNaN(parseSignedAmount(row[mapping.amount.col] ?? "", dialect.commaDecimals))) amountFails++
    } else {
      const deb = parseSignedAmount(row[mapping.amount.debit_col] ?? "", dialect.commaDecimals)
      const cre = parseSignedAmount(row[mapping.amount.credit_col] ?? "", dialect.commaDecimals)
      if (isNaN(deb) && isNaN(cre)) amountFails++
    }
  }
  if (dated === 0) hard.push("No data rows found through this mapping.")
  if (dateFails > 0) hard.push(`${dateFails}/${dated} dated row(s) failed to parse as dates.`)
  if (amountFails > 0) hard.push(`${amountFails}/${dated} row(s) have non-numeric amounts.`)

  const parsed = applyFormatMapping(content, mapping)

  // Hard: balance-column self-consistency (both row orders tried, per account).
  if (mapping.balance_col != null && parsed.transactions.length > 1) {
    const byAccount = new Map<string, ParsedTransaction[]>()
    for (const t of parsed.transactions) {
      if (t.balance_after === null) continue
      const list = byAccount.get(t.account_type) ?? []
      list.push(t)
      byAccount.set(t.account_type, list)
    }
    for (const [account, list] of Array.from(byAccount.entries())) {
      if (list.length < 3) continue
      const consistent = (seq: ParsedTransaction[]) => {
        let okCount = 0
        for (let i = 1; i < seq.length; i++) {
          if (Math.abs((seq[i - 1].balance_after as number) + seq[i].amount - (seq[i].balance_after as number)) <= 0.011) okCount++
        }
        return okCount / (seq.length - 1)
      }
      const fwd = consistent(list)
      const rev = consistent([...list].reverse())
      if (Math.max(fwd, rev) < 0.9) {
        hard.push(`Balance column does not reconcile with amounts for account "${account}" (best ${(Math.max(fwd, rev) * 100).toFixed(0)}% of steps).`)
      }
    }
  }

  // Ambiguities (block auto-accept, require the one-tap staff confirm):
  const dateCols = G_DATE.map(s => header.indexOf(s)).filter(i => i !== -1)
  if (dateCols.length > 1 && !dateCols.every(i => i === mapping.date.col)) {
    ambiguities.push(`Multiple date-like columns (${dateCols.map(i => `"${header[i]}"`).join(", ")}) — confirm which one is the transaction date.`)
  }
  const dateSamples = body.map(r => (r[mapping.date.col] ?? "").trim()).filter(Boolean).slice(0, 300)
  const seenUnambiguousDay = dateSamples.some(d => {
    const m = d.match(/^(\d{1,2})[/-](\d{1,2})[/-]/)
    return m ? (Number(m[1]) > 12 || Number(m[2]) > 12) : true // ISO/textual dates count as unambiguous
  })
  if (!seenUnambiguousDay && dateSamples.length > 0) {
    ambiguities.push(`Day/month order cannot be proven from the data (assumed ${mapping.date.order.toUpperCase()}) — confirm.`)
  }
  const originalCurrencyCol = header.findIndex(h => h.includes("original") && (h.includes("currency") || h.includes("ccy")))
  if (originalCurrencyCol !== -1 && mapping.currency.mode === "column") {
    ambiguities.push(`The file carries an "original currency" column — confirm whether amounts are settled (one currency) or per-row.`)
  }
  const currencyCol = findCol(header, G_CURRENCY, ["original"])
  if (currencyCol !== -1 && mapping.currency.mode !== "column") {
    const values = new Set(body.map(r => (r[currencyCol] ?? "").trim().toUpperCase()).filter(Boolean))
    if (values.size > 1) ambiguities.push(`A currency column with ${values.size} distinct values exists but the mapping fixes currency to ${(mapping.currency as { value: string }).value} — confirm.`)
  }
  // Competing amount columns: EXACT header matches only — findCol's substring
  // fallback would let G_CREDIT's "in" hit "bookING date" (test-caught noise).
  const exactCol = (synonyms: string[]) => synonyms.map(s => header.indexOf(s)).find(i => i !== -1) ?? -1
  const amountCols = Array.from(new Set([exactCol(G_AMOUNT), exactCol(G_DEBIT), exactCol(G_CREDIT)].filter(i => i !== -1)))
  if (mapping.amount.mode === "signed" && amountCols.some(i => i !== (mapping.amount as { col: number }).col)) {
    ambiguities.push("Multiple amount-like columns — confirm which carries the signed amount.")
  }

  const sample = parsed.transactions.slice(0, 5).map(t => ({
    date: t.transaction_date, description: t.description.slice(0, 80), amount: t.amount, currency: t.currency, account: t.account_type,
  }))
  return { hard_failures: hard, ambiguities, sample, ok: hard.length === 0, auto_acceptable: hard.length === 0 && ambiguities.length === 0 }
}

// ─── Heuristic proposal (no AI) for simple unambiguous files ──

export function proposeMappingHeuristically(content: string): FormatMapping | null {
  const dialect = sniffCsvDialect(content)
  const rows = parseDelimitedRows(content, dialect.delimiter)
  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const h = normalizeHeader(rows[r])
    const date = findCol(h, G_DATE)
    const amount = findCol(h, G_AMOUNT, ["balance", "fee", "running", "original"])
    const debit = findCol(h, G_DEBIT)
    const credit = findCol(h, G_CREDIT)
    if (date === -1 || (amount === -1 && (debit === -1 || credit === -1))) continue
    const body = rows.slice(r + 1)
    const order = detectDateOrder(body.map(row => row[date] ?? "").slice(0, 200))
    const descCols = G_DESC.map(s => h.indexOf(s)).filter(i => i !== -1)
    const currency = findCol(h, G_CURRENCY, ["original"])
    return {
      version: 1,
      bank_label: "Bank",
      header_row: r,
      date: { col: date, order },
      description_cols: descCols.length ? descCols : [date === 0 ? 1 : 0],
      counterparty_col: (() => { const p = findCol(h, G_PARTY); return p === -1 ? null : p })(),
      amount: amount !== -1 ? { mode: "signed", col: amount, positive_is: "in" } : { mode: "debit_credit", debit_col: debit, credit_col: credit },
      currency: currency !== -1 ? { mode: "column", col: currency } : { mode: "fixed", value: "USD" },
      account: { mode: "fixed", label: null },
      balance_col: (() => { const b = findCol(h, G_BALANCE); return b === -1 ? null : b })(),
      status: null,
      ref_extra_cols: [],
    }
  }
  return null
}

// ─── AI proposal — COLUMN ROLES ONLY, one call per new format ─

const AI_MODEL = "claude-sonnet-5"
const PROPOSAL_MAX_TOKENS = 1500

export async function proposeMappingWithAI(
  headerCells: string[],
  sampleRows: string[][],
  opts?: { fetchImpl?: typeof fetch; model?: string },
): Promise<{ mapping: FormatMapping | null; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey && !opts?.fetchImpl) return { mapping: null, error: "ANTHROPIC_API_KEY not configured" }
  const doFetch = opts?.fetchImpl || fetch
  const header = normalizeHeader(headerCells)

  const prompt = `You map bank-statement CSV columns to roles. Reply with ONLY a JSON object, no prose.

Header columns (0-indexed): ${JSON.stringify(header)}
Sample rows (first and last of the file):
${sampleRows.slice(0, 8).map(r => JSON.stringify(r)).join("\n")}

Rules:
- You assign COLUMN ROLES only. Never invent values.
- "amount": the SETTLED amount that moved on the account. If the file has BOTH a settled amount and an "original currency" column (card purchases abroad), currency mode MUST be "settled_fixed_with_original" with the account's settled currency — never the original currency.
- "positive_is": "in" when positive numbers are money received.
- "status": if a status-like column exists, include only values that represent completed/settled transactions (lowercased).
- "account": the column naming the source account/card if one exists, else fixed.
- Omit nothing; use null where allowed. If you cannot determine a required role, reply {"error":"<why>"}.

JSON schema:
{"version":1,"bank_label":string,"header_row":0,"date":{"col":int,"order":"mdy"|"dmy"},"description_cols":[int,...],"counterparty_col":int|null,"amount":{"mode":"signed","col":int,"positive_is":"in"|"out"}|{"mode":"debit_credit","debit_col":int,"credit_col":int},"currency":{"mode":"fixed","value":"USD"}|{"mode":"column","col":int}|{"mode":"settled_fixed_with_original","value":"USD","original_col":int},"account":{"mode":"fixed","label":string|null}|{"mode":"column","col":int},"balance_col":int|null,"status":{"col":int,"include":[string,...]}|null,"ref_extra_cols":[int,...]}`

  try {
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey ?? "test", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: opts?.model || AI_MODEL, max_tokens: PROPOSAL_MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
    })
    if (!res.ok) return { mapping: null, error: `AI proposal request failed: ${res.status}` }
    const data = await res.json() as { content?: Array<{ type: string; text?: string }> }
    const text = (data.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("")
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { mapping: null, error: "AI proposal returned no JSON" }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    if (parsed.error) return { mapping: null, error: `AI could not map the format: ${parsed.error}` }
    return { mapping: assertValidMapping(parsed, headerCells.length) }
  } catch (e) {
    return { mapping: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── DB store / lookup ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface StoredMapping {
  id: string
  fingerprint: string
  mapping: FormatMapping
  status: "proposed" | "verified_auto" | "staff_confirmed" | "rejected"
  bank_label: string
}

export async function lookupMapping(db: Db, fingerprint: string): Promise<StoredMapping | null> {
  const { data } = await db
    .from("statement_format_mappings")
    .select("id, fingerprint, mapping, status, bank_label")
    .eq("fingerprint", fingerprint)
    .maybeSingle()
  if (!data) return null
  return data as StoredMapping
}

export async function recordMappingHit(db: Db, id: string): Promise<void> {
  try {
    const { data } = await db.from("statement_format_mappings").select("hits").eq("id", id).maybeSingle()
    await db.from("statement_format_mappings").update({ hits: (data?.hits ?? 0) + 1, updated_at: new Date().toISOString() }).eq("id", id)
  } catch { /* telemetry only */ }
}

export async function storeMapping(db: Db, row: {
  fingerprint: string
  delimiter: string
  mapping: FormatMapping
  status: StoredMapping["status"]
  bank_label: string
  sample: unknown
  proposed_by: "ai" | "heuristic" | "staff" | "migration"
  source_file: string | null
  created_by: string
}): Promise<string | null> {
  const { data, error } = await db
    .from("statement_format_mappings")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "fingerprint" })
    .select("id")
    .single()
  if (error) { console.error("[format-mappings] store failed:", error.message); return null }
  return data?.id ?? null
}

/** Supabase-backed store adapter for parseBankStatement's mappingStore option. */
export function makeSupabaseMappingStore(db: Db) {
  return {
    lookup: (fingerprint: string) => lookupMapping(db, fingerprint),
    recordHit: (id: string) => recordMappingHit(db, id),
    store: (row: {
      fingerprint: string; delimiter: string; mapping: FormatMapping
      status: "proposed" | "verified_auto"; bank_label: string; sample: unknown
      proposed_by: "ai" | "heuristic"; source_file: string | null; created_by: string
    }) => storeMapping(db, row),
  }
}
