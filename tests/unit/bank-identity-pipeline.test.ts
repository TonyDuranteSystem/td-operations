/**
 * END-TO-END pipeline QA: real CSV bytes → the REAL parser (parseBankStatement)
 * → the REAL identity step (buildAccountRef, exactly as ingest does) → the REAL
 * engine (buildFinancialDraft). Proves the whole server-side computation chain
 * for every scenario, without a DB. (The DB insert + view assembly are verified
 * separately against the sandbox database.)
 */
import { describe, it, expect } from "vitest"
import { parseBankStatement, categorizeTransaction } from "@/lib/bank-statement-parser"
import { buildAccountRef } from "@/lib/tax/bank-identity"
import { buildFinancialDraft, type DraftTransaction } from "@/lib/tax/financials-engine"
import { resolveOwnership } from "@/lib/tax/ownership-resolution"

const MEMBERS = resolveOwnership({ priorK1s: [], accountContacts: [], wizardMembers: [{ name: "Owner", pct: 100 }] })

const CSV = (rows: Array<[string, string, string]>) =>
  Buffer.from("Date,Description,Amount\n" + rows.map(r => r.join(",")).join("\n") + "\n")

// Ingest's identity step, verbatim: parse → canonical bank_name + account_ref per file.
async function ingestFile(bytes: Buffer, fileName: string, bankLabel: string, accountNumber: string | null): Promise<DraftTransaction[]> {
  const parsed = await parseBankStatement(bytes, fileName, "text/csv", { taxYear: 2025 })
  const bankDetected = parsed.bank_name && parsed.bank_name !== "unknown" ? parsed.bank_name : bankLabel
  const ident = buildAccountRef({ rawBankName: bankDetected, accountNumber })
  return parsed.transactions
    .map(tx => categorizeTransaction(tx, [], []))
    .filter(tx => tx.transaction_date.startsWith("2025"))
    .map((tx, i) => ({
      id: `${fileName}-${i}`, transaction_date: tx.transaction_date, description: tx.description,
      counterparty: tx.counterparty, amount: tx.amount, currency: tx.currency,
      category: tx.category, subcategory: tx.subcategory,
      bank_name: ident.canonical, account_type: tx.account_type, account_ref: ident.account_ref,
      balance_after: tx.balance_after,
    }))
}
const bankKeysOf = (txs: DraftTransaction[]) =>
  buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null })
    .banks.map(b => b.bank_key).sort()

describe("pipeline E2E — real CSV → parse → identity → engine", () => {
  it("Scenario 1: the SAME Chase account uploaded under two bank NAMES → ONE bank position", async () => {
    const jan = await ingestFile(CSV([["2025-01-10", "Payment A", "-100.00"]]), "chase-jan.csv", "JPMorgan Chase Bank, N.A.", "0001234555678")
    const feb = await ingestFile(CSV([["2025-02-10", "Payment B", "-200.00"]]), "chase-feb.csv", "Chase", "5678")
    expect(bankKeysOf([...jan, ...feb])).toEqual(["Chase#5678 USD"])
  })

  it("Scenario 2: two DIFFERENT Chase accounts → two bank positions", async () => {
    const a = await ingestFile(CSV([["2025-03-01", "A", "-10.00"]]), "a.csv", "Chase", "1111")
    const b = await ingestFile(CSV([["2025-03-02", "B", "-20.00"]]), "b.csv", "Chase", "2222")
    expect(bankKeysOf([...a, ...b])).toEqual(["Chase#1111 USD", "Chase#2222 USD"])
  })

  it("Scenario 3: multi-currency service (Wise) — no account number, splits by currency", async () => {
    const usd = await ingestFile(CSV([["2025-04-01", "US pay", "-30.00"]]), "wise-usd.csv", "Wise", null)
    const eur = (await ingestFile(CSV([["2025-04-02", "EU pay", "-25.00"]]), "wise-eur.csv", "Wise", null))
      .map(t => ({ ...t, currency: "EUR", account_type: "EUR" }))
    expect(bankKeysOf([...usd, ...eur])).toEqual(["Wise EUR", "Wise USD"])
  })

  it("Scenario 4: crypto (Kraken legal name) → one identity, no number", async () => {
    const k = await ingestFile(CSV([["2025-05-01", "trade", "-5.00"]]), "k.csv", "Kraken (Payward Interactive, Inc.)", null)
    expect(k[0].account_ref).toBe("Kraken")
    expect(bankKeysOf(k)).toEqual(["Kraken USD"])
  })

  it("Scenario 5: unknown bank keeps the client's exact label (no false merge)", async () => {
    const rows = await ingestFile(CSV([["2025-06-01", "x", "-1.00"]]), "u.csv", "Chase County Credit Union", "4242")
    expect(rows[0].bank_name).toBe("Chase County Credit Union")
    expect(rows[0].account_ref).toBe("Chase County Credit Union#4242")
    expect(bankKeysOf(rows)).toEqual(["Chase County Credit Union#4242 USD"])
  })

  it("Scenario 6: the parser actually read the CSV rows (sanity — pipeline is live)", async () => {
    const rows = await ingestFile(CSV([["2025-07-01", "one", "-1.00"], ["2025-07-02", "two", "-2.00"]]), "s.csv", "Mercury", "9999")
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.account_ref === "Mercury#9999")).toBe(true)
  })
})
