/**
 * Pattern-grouped client questions (Slice 8, master plan §3.6 + A2).
 *
 * What the deterministic + AI passes leave uncategorized is dominated by
 * merchant patterns (the 5b benchmark: Glovo ×265, Uber ×164, …). Grouping
 * by merchant root means ONE answer covers every transaction from that
 * merchant — ~10-15 clicks instead of hundreds of questions.
 *
 * The client answers in plain language; each answer maps to a bookkeeping
 * category. "Personal (owner) spending" maps to DISTRIBUTION — personal
 * spend on a company card is an owner draw, never a deductible expense.
 */

export interface UncategorizedRow {
  id: string
  description: string
  counterparty: string | null
  amount: number
  transaction_date: string
  bank_name: string
}

export interface QuestionGroup {
  /** Stable key — the normalized merchant root. */
  group_key: string
  /** Display label (the merchant root as seen on the statement). */
  label: string
  count: number
  total: number
  /** 'in' | 'out' | 'mixed' — drives which answers make sense. */
  direction: "in" | "out" | "mixed"
  transaction_ids: string[]
  sample: string
}

/** Merchant root: strip card suffixes (••1234), embedded dates, amounts, and
 *  collapse whitespace. Exported for tests. */
export function merchantRoot(description: string): string {
  return description
    .replace(/\s*••\d+/g, "")
    .replace(/\b\d{2}\/\d{2}\b/g, "")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim()
}

export function groupUncategorized(rows: UncategorizedRow[]): QuestionGroup[] {
  const groups = new Map<string, { rows: UncategorizedRow[]; label: string }>()
  for (const r of rows) {
    const root = merchantRoot(r.description || r.counterparty || "")
    const key = root.toLowerCase() || "(no description)"
    if (!groups.has(key)) groups.set(key, { rows: [], label: root || "(no description)" })
    groups.get(key)!.rows.push(r)
  }
  return Array.from(groups.entries())
    .map(([group_key, g]) => {
      const ins = g.rows.filter(r => r.amount > 0).length
      const outs = g.rows.filter(r => r.amount < 0).length
      return {
        group_key,
        label: g.label,
        count: g.rows.length,
        total: g.rows.reduce((s, r) => s + r.amount, 0),
        direction: (ins > 0 && outs > 0 ? "mixed" : ins > 0 ? "in" : "out") as QuestionGroup["direction"],
        transaction_ids: g.rows.map(r => r.id),
        sample: g.rows[0].description,
      }
    })
    .sort((a, b) => b.count - a.count)
}

/** The client-facing answer choices and the category each maps to.
 *  Filtered by the group's money direction in the UI. */
export const ANSWER_CHOICES = [
  { value: "business_expense", category: "expense", subcategory: "client_confirmed", directions: ["out", "mixed"], label: "Business expense", labelIt: "Spesa aziendale" },
  { value: "personal_spending", category: "distribution", subcategory: "personal_draw", directions: ["out", "mixed"], label: "Personal (owner) spending — not a business cost", labelIt: "Spesa personale (del socio) — non aziendale" },
  { value: "business_income", category: "income", subcategory: "revenue", directions: ["in", "mixed"], label: "Business income / a sale", labelIt: "Incasso aziendale / vendita" },
  { value: "owner_money_in", category: "contribution", subcategory: "capital_contribution", directions: ["in", "mixed"], label: "My own money put into the company", labelIt: "Soldi miei messi nella società" },
  { value: "own_transfer", category: "conversion", subcategory: "internal_transfer", directions: ["in", "out", "mixed"], label: "Transfer between my own accounts", labelIt: "Trasferimento tra i miei conti" },
  { value: "bank_fee", category: "fee", subcategory: "bank_fee", directions: ["out", "mixed"], label: "Bank / platform fee", labelIt: "Commissione bancaria / piattaforma" },
] as const

export type AnswerValue = (typeof ANSWER_CHOICES)[number]["value"]

export function categoryForAnswer(value: string): { category: string; subcategory: string } | null {
  const c = ANSWER_CHOICES.find(a => a.value === value)
  return c ? { category: c.category, subcategory: c.subcategory } : null
}
