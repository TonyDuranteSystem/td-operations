/**
 * AI-assist categorization (Slice 5b, master plan §9 "Categorization").
 *
 * Runs AFTER the deterministic passes (DB rules + transfer matcher) and looks
 * ONLY at what they left uncategorized. Claude suggests a category per
 * transaction with a confidence level; only HIGH-confidence suggestions are
 * applied (marked "ai:" in notes so they are auditable and the review screen
 * can surface them). Medium/low stay uncategorized for the client questions.
 *
 * Hard guarantees:
 * - never touches rows categorized by rules, the matcher, or a human
 * - applied suggestions are tagged "ai:" — staff/clients can always tell
 * - an API failure categorizes nothing (fail-open to "uncategorized")
 */

import type { CategorizedTransaction } from "@/lib/bank-statement-parser"

const MODEL = "claude-sonnet-4-6"
const BATCH_SIZE = 40
const MAX_TOKENS = 4096
const TIMEOUT_MS = 90_000

export interface AiCategorizableTx {
  id: string
  transaction_date: string
  description: string
  counterparty: string
  amount: number
  currency: string
  bank_name: string
}

export interface AiSuggestion {
  id: string
  category: CategorizedTransaction["category"]
  subcategory: string
  confidence: "high" | "medium" | "low"
  /** ADVISORY review hint (#2, 2026-06-18) — not applied as a category. Whether
   *  this looks like a business cost or the owner's personal spending. The
   *  client confirms; only the owner truly knows. "unsure" when the AI can't tell. */
  lean?: "business" | "personal" | "unsure"
  /** ADVISORY accountant bucket slug from the live `expense_categories` catalog
   *  (or "other"). Used only to GROUP the review screen; never a tax category. */
  bucket?: string
}

export interface AiCategorizeContext {
  companyName: string
  /** Member/owner names — wires to these people are distributions, money from
   *  them is a contribution, NEVER revenue/expense. */
  memberNames: string[]
  /** The client's own banks in this dataset — moves between them are internal. */
  bankNames: string[]
  /** The client's own description of what the business does (from the tax
   *  form's us_business_activities). This is what lets the AI mark business
   *  tools (e-commerce platform, marketing software, …) high-confidence
   *  instead of hedging. */
  businessDescription?: string
  /** Live accountant buckets from the `expense_categories` catalog (#2). The AI
   *  picks one slug per transaction to GROUP the review; passing the list keeps
   *  it constrained to the shared vocabulary rather than inventing labels. */
  buckets?: { slug: string; label: string }[]
}

const VALID_CATEGORIES = new Set([
  "income", "cogs", "expense", "distribution", "contribution", "fee", "conversion", "refund", "uncategorized",
])

const SUGGEST_TOOL = {
  name: "suggest_categories",
  description: "Suggest a bookkeeping category for each transaction.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The transaction id exactly as given." },
            category: {
              type: "string",
              enum: ["income", "cogs", "expense", "distribution", "contribution", "fee", "conversion", "refund"],
              description: "Bookkeeping category. income=sales/revenue in; cogs=direct cost of delivering the product/service; expense=operating cost out; distribution=money OUT to an owner/member; contribution=owner's own money IN; fee=bank/platform charges; conversion=currency exchange or internal move between the company's own accounts; refund=returned payment (either direction).",
            },
            subcategory: { type: "string", description: "Short snake_case detail, e.g. revenue, software, advertising, contractor, bank_fee, member_distribution, capital_contribution." },
            confidence: {
              type: "string", enum: ["high", "medium", "low"],
              description: "high = the description makes the category unambiguous; medium = plausible but the business context could change it; low = guessing. BE CONSERVATIVE — a wrong 'high' corrupts a TAX RETURN, an honest 'medium' just asks the client.",
            },
            lean: {
              type: "string", enum: ["business", "personal", "unsure"],
              description: "ADVISORY only (the client confirms): does this OUTFLOW look like a business cost ('business') or the owner's personal spending on the company card ('personal', e.g. groceries/fuel/restaurants/personal travel)? Use 'unsure' when you genuinely cannot tell. Inflows/transfers: 'business'. Be honest — this is a suggestion, not a decision.",
            },
            bucket: {
              type: "string",
              description: "ADVISORY accountant bucket — the slug of the single best-fit category from the provided list, or 'other' if none fit. Used only to GROUP the review screen.",
            },
          },
          required: ["id", "category", "confidence"],
        },
      },
    },
    required: ["suggestions"],
  },
} as const

function systemPrompt(ctx: AiCategorizeContext): string {
  return [
    "You are a meticulous bookkeeper categorizing bank transactions for a US LLC's tax return (cash basis).",
    `Company: ${ctx.companyName}.`,
    ctx.businessDescription ? `What the business does (the client's own words): ${ctx.businessDescription}` : "",
    ctx.memberNames.length ? `Owners/members: ${ctx.memberNames.join(", ")}. Money OUT to an owner is a distribution; an owner's own money IN is a contribution — NEVER revenue or expense.` : "",
    ctx.bankNames.length ? `The company's own bank accounts in this dataset: ${ctx.bankNames.join(", ")}. Moves between them are 'conversion' (internal transfers), not income/expense.` : "",
    `CRITICAL: any transaction whose description/counterparty is the company's OWN name (${ctx.companyName}) or one of its own accounts — e.g. "sent money to ${ctx.companyName}", "transfer to ${ctx.companyName}" — is the company moving its OWN money: category 'conversion' (internal transfer), NEVER 'expense', 'fee', or 'income', even if no matching deposit is visible. A self-transfer wrongly booked as an expense corrupts the P&L on both sides.`,
    "Read the FULL description AND counterparty of every line — not just the amount. They usually state what the transaction actually is. Combine the description, counterparty, currency, the company's own name/accounts, and the business activity to decide the true category — never judge by amount alone.",
    "Foreign currency: a line that MOVES money between currencies or the company's own balances — e.g. 'Converted USD to EUR', 'Converted EUR to USD', 'Exchanged', an FX/wallet move — is category 'conversion' (NEVER expense or income), even though cash leaves the account. BUT a real purchase or payment to an OUTSIDE merchant/vendor that simply happens to be in a foreign currency (e.g. a EUR card payment at a shop, a supplier invoice paid in EUR) IS a genuine 'expense' — classify it as expense. Do NOT convert the amount to USD yourself: record it with its own currency and the system applies the official IRS yearly-average rate. When you cannot tell whether a foreign-currency outflow is a conversion or a real expense, use 'uncategorized' so the client confirms.",
    "When a money-OUT has no clear business purpose, do NOT guess 'expense' — return 'uncategorized' so the client confirms. A wrong deduction corrupts a tax return; an honest 'uncategorized' just asks.",
    "Sign convention: positive = money in, negative = money out.",
    "Confidence calibration:",
    "- 'high' when the description makes the category unambiguous, OR when the merchant/counterparty clearly serves the stated business activity (e.g. e-commerce platform, marketing/ads tools, hosting, freelancer marketplaces for an online business). Recurring INFLOWS from payment processors or repeated third-party customer payments (PayPal, Stripe, ACH from non-member companies) are sales revenue for this kind of business — 'high' unless something contradicts it.",
    "- 'medium' when the category is plausible but the business context could change it.",
    "- 'low' for personal-looking spending on company cards (food delivery, restaurants, streaming, gyms, supermarkets): it may be a deductible business cost OR the owner's personal spending (a distribution) — only the client knows. NEVER 'high' for these; a wrong deduction corrupts a TAX RETURN, an honest 'low' just asks the client.",
    ctx.buckets?.length ? `Accountant buckets — put the single best-fit SLUG in the 'bucket' field (or 'other'): ${ctx.buckets.map(b => `${b.slug} (${b.label})`).join("; ")}.` : "",
    "For EVERY transaction also set 'lean' (business/personal/unsure) and 'bucket'. These are ADVISORY hints used only to pre-sort the client's review — the client confirms, and they NEVER change the bookkeeping category. 'lean=personal' for personal-looking owner spending; 'business' for inflows, transfers, and clear business costs; 'unsure' when you truly cannot tell.",
    "Always respond by calling the suggest_categories tool with one entry per transaction.",
  ].filter(Boolean).join(" ")
}

/** Parse + validate the raw tool output into safe suggestions. Exported for tests. */
export function parseSuggestions(raw: unknown, validIds: Set<string>, validBuckets?: Set<string>): AiSuggestion[] {
  if (!raw || typeof raw !== "object") return []
  const list = (raw as { suggestions?: unknown }).suggestions
  if (!Array.isArray(list)) return []
  const out: AiSuggestion[] = []
  for (const s of list) {
    if (!s || typeof s !== "object") continue
    const { id, category, subcategory, confidence, lean, bucket } = s as Record<string, unknown>
    if (typeof id !== "string" || !validIds.has(id)) continue
    if (typeof category !== "string" || !VALID_CATEGORIES.has(category) || category === "uncategorized") continue
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") continue
    // Advisory fields (#2): tolerate missing/garbage — they only hint the review.
    const leanOk = lean === "business" || lean === "personal" || lean === "unsure"
    const bucketStr = typeof bucket === "string" ? bucket.trim() : ""
    const bucketOk = bucketStr.length > 0 && (!validBuckets || validBuckets.has(bucketStr) || bucketStr === "other")
    out.push({
      id,
      category: category as AiSuggestion["category"],
      subcategory: typeof subcategory === "string" ? subcategory.slice(0, 60) : "",
      confidence,
      ...(leanOk ? { lean: lean as AiSuggestion["lean"] } : {}),
      ...(bucketOk ? { bucket: bucketStr } : {}),
    })
  }
  return out
}

export interface AiCategorizeOptions {
  fetchImpl?: typeof fetch
  model?: string
  /** Cap on API calls per run (cost guard). Default 80 batches (~3200 tx). */
  maxBatches?: number
}

/**
 * Ask Claude for category suggestions for a set of uncategorized transactions.
 * Returns ALL suggestions with confidence — the caller decides the apply
 * policy (recategorizeAccountYear applies only "high").
 */
export async function aiSuggestCategories(
  txs: AiCategorizableTx[],
  ctx: AiCategorizeContext,
  opts?: AiCategorizeOptions,
): Promise<{ suggestions: AiSuggestion[]; errors: string[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { suggestions: [], errors: ["ANTHROPIC_API_KEY not set — AI categorization skipped"] }
  const doFetch = opts?.fetchImpl ?? fetch
  const maxBatches = opts?.maxBatches ?? 80

  const suggestions: AiSuggestion[] = []
  const errors: string[] = []
  const validBuckets = ctx.buckets ? new Set(ctx.buckets.map(b => b.slug)) : undefined

  const batches: AiCategorizableTx[][] = []
  for (let i = 0; i < txs.length; i += BATCH_SIZE) batches.push(txs.slice(i, i + BATCH_SIZE))
  if (batches.length > maxBatches) {
    errors.push(`Capped at ${maxBatches} batches (${maxBatches * BATCH_SIZE} tx) of ${batches.length} — rerun to continue`)
    batches.length = maxBatches
  }

  for (const batch of batches) {
    const validIds = new Set(batch.map(t => t.id))
    const lines = batch.map(t =>
      `${t.id} | ${t.transaction_date} | ${t.bank_name} | ${t.amount > 0 ? "+" : ""}${t.amount} ${t.currency} | ${t.counterparty || "-"} | ${t.description}`,
    ).join("\n")

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      const res = await doFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: opts?.model ?? MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt(ctx),
          tools: [SUGGEST_TOOL],
          tool_choice: { type: "tool", name: "suggest_categories" },
          messages: [{
            role: "user",
            content: `Categorize these ${batch.length} transactions (format: id | date | bank | amount | counterparty | description):\n\n${lines}`,
          }],
        }),
      })
      clearTimeout(timer)
      if (!res.ok) {
        errors.push(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`)
        continue
      }
      const data = await res.json() as { content?: Array<{ type: string; name?: string; input?: unknown }> }
      const toolBlock = data.content?.find(b => b.type === "tool_use" && b.name === "suggest_categories")
      suggestions.push(...parseSuggestions(toolBlock?.input, validIds, validBuckets))
    } catch (e) {
      errors.push(`Batch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { suggestions, errors }
}
