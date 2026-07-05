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

export const AI_MODEL = "claude-sonnet-4-6"
const MODEL = AI_MODEL
const BATCH_SIZE = 40
// 8192 (was 4096, Phase 0.1 2026-07-03): 40 suggestions × (UUID echo + 6 fields)
// ≈ 3-4k output tokens — batches were hitting max_tokens mid-tool-call and a
// truncated tool_use block parses to ZERO suggestions silently (fail-open
// looked like a low auto-rate with no signal). stop_reason is now surfaced.
const MAX_TOKENS = 8192
const TIMEOUT_MS = 90_000

/** Prompt/policy version — stamped into applied-row notes (ai:high@vN) so a
 *  challenged categorization is traceable to the exact prompt that made it
 *  (audit requirement for a tax product). Bump on ANY change to systemPrompt,
 *  SUGGEST_TOOL, or the apply policy. */
export const AI_PROMPT_VERSION = "v4"

/** Kill switch (Phase 0.4): set AI_CATEGORIZATION_DISABLED=1 on Vercel to stop
 *  the AI pass fleet-wide (both the workspace and client paths call through
 *  here). Deterministic passes and human answers keep working. */
export function aiCategorizationDisabled(): boolean {
  return process.env.AI_CATEGORIZATION_DISABLED === "1"
}

export interface AiCategorizableTx {
  id: string
  transaction_date: string
  description: string
  counterparty: string
  amount: number
  currency: string
  bank_name: string
  /** Group-level candidates (Phase 3R-B): this line REPRESENTS a merchant
   *  group of `group_count` transactions totalling `group_total` (same root,
   *  same direction, same currency). Singletons omit both — their line renders
   *  byte-identically to the pre-group format. */
  group_count?: number
  group_total?: number
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
  /** S2 (2026-07-05): ISO-3166 alpha-2 country where the spend physically
   *  happened, read from the DESCRIPTION — only when it carries an explicit
   *  anchor (city, country, airport, single-country local brand). Merchant-name
   *  LANGUAGE alone is never enough (Spanish names exist in Miami and Mexico).
   *  Advisory: stamped as loc_source='ai', never overwrites deterministic
   *  locations, never creates presence periods, gated by an accuracy test
   *  before it can influence anything. */
  place?: string
}

export interface AiCategorizeContext {
  companyName: string
  /** Group-level mode (Phase 3R-B): lines are MERCHANT GROUPS, not single
   *  transactions — adds the group instructions to the system prompt. Only
   *  the workspace path sets this in v1 (client path gated on the rebuilt
   *  eval fixtures, review F6c). */
  grouped?: boolean
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
            place: {
              type: "string",
              description: "ADVISORY, OPTIONAL: ISO-3166 alpha-2 country code (e.g. ES, US, PT, AE) where the transaction PHYSICALLY happened, ONLY when the description contains an explicit place anchor: a city ('Tampa', 'Cascais'), a country word, an airport code, or a local shop/brand that exists in exactly one country. The LANGUAGE of a merchant name alone is NOT an anchor — omit. Online/SaaS/global merchants (Google, Meta, Amazon, subscriptions): omit. When in ANY doubt: omit. A wrong country here is worse than none.",
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
    "- 'low' for personal-looking spending on company cards (food delivery, restaurants, streaming, gyms, supermarkets): it may be a deductible business cost OR the owner's personal spending (a distribution) — only the client knows. NEVER 'high' for these; a wrong deduction corrupts a TAX RETURN, an honest 'low' just asks the client" + (ctx.grouped ? " — and in group mode this applies PER GROUP: a wrong 'high' corrupts every transaction of that merchant at once." : "."),
    ctx.grouped
      ? "GROUP MODE: each line is a MERCHANT GROUP, not a single transaction — every transaction from the same merchant, in the same direction and currency, shown as one representative with '×N (total T CUR)'. Your verdict is applied to EVERY transaction in the group. If the transactions under one merchant could plausibly mix business and personal purposes — or the name looks like a marketplace, a person, or a generic transfer rather than one specific merchant — do NOT guess: answer confidence 'low'. A wrong 'high' here corrupts N rows of a tax P&L at once; an honest 'low' asks the client once."
      : "",
    // Calibration pins (v4 — adjudicated from the 2026-07-04 retro-gate run):
    ctx.grouped
      ? (ctx.businessDescription
        ? "Category discipline: platform/SaaS/tooling charges (e-commerce platforms, hosting, marketing tools, app subscriptions) are 'expense' — use 'cogs' ONLY when the stated business activity is physical-goods resale AND the charge is clearly supplier/inventory purchasing."
        : "Category discipline: with no business description available, platform/SaaS/tooling charges (e-commerce platforms, hosting, marketing tools, app subscriptions) are 'expense', and NEVER exceed confidence 'medium' for the expense-vs-cogs call — the client confirms.")
      : "",
    ctx.grouped
      ? "FX / EXCHANGE-RATE ADJUSTMENT FEE lines follow the purchase they ride on: business purchase → 'fee'; the owner's personal purchase → 'distribution'; when the fees in a group ride on mixed or unknown purchases, answer confidence 'low' — never 'high'."
      : "",
    // Own-bank inbound pin (v4b — adjudicated 2026-07-05: 'WISE US INC ACH In'
    // on Mercury = the company's own Wise balance topping up Mercury; the
    // human ruling is conversion, the model kept flip-flopping to income).
    ctx.grouped && ctx.bankNames.length
      ? `An INBOUND transfer whose sender/description names one of the company's OWN banks listed above (e.g. an ACH arriving FROM ${ctx.bankNames[0]}) is the company moving its own money between its accounts: category 'conversion' — NEVER 'income'. Real customer revenue arrives from customers or payment processors, not from the company's own banks.`
      : "",
    ctx.buckets?.length ? `Accountant buckets — put the single best-fit SLUG in the 'bucket' field (or 'other'): ${ctx.buckets.map(b => `${b.slug} (${b.label})`).join("; ")}.` : "",
    "For EVERY transaction also set 'lean' (business/personal/unsure) and 'bucket'. These are ADVISORY hints used only to pre-sort the client's review — the client confirms, and they NEVER change the bookkeeping category. 'lean=personal' for personal-looking owner spending; 'business' for inflows, transfers, and clear business costs; 'unsure' when you truly cannot tell.",
    ctx.grouped
      ? "PLACE (optional, advisory): when the description carries an EXPLICIT place anchor, set 'place' to the ISO alpha-2 country where the spend physically happened. Anchors: city names ('Whole Foods TAMPA' → US; 'Bcascais' = Cascais → PT), country words, airport codes, or a shop type/brand that exists in exactly one country ('Estanco García' — estanco is a Spanish tobacco shop → ES). The mere LANGUAGE of a name is NOT an anchor (Spanish names exist in Miami and Mexico; 'MMI home delivery Dubai' → AE because of the word Dubai, not the brand). Online/SaaS/global merchants and card processors: OMIT. When in doubt: OMIT — a wrong country is worse than none."
      : "",
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
    const { id, category, subcategory, confidence, lean, bucket, place } = s as Record<string, unknown>
    if (typeof id !== "string" || !validIds.has(id)) continue
    if (typeof category !== "string" || !VALID_CATEGORIES.has(category) || category === "uncategorized") continue
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") continue
    // Advisory fields (#2): tolerate missing/garbage — they only hint the review.
    const leanOk = lean === "business" || lean === "personal" || lean === "unsure"
    const bucketStr = typeof bucket === "string" ? bucket.trim() : ""
    const bucketOk = bucketStr.length > 0 && (!validBuckets || validBuckets.has(bucketStr) || bucketStr === "other")
    // place (S2): garbage-tolerant — accept only a clean ISO alpha-2 shape;
    // anything else ("Spain", "eu", "", 3 letters) is silently dropped.
    const placeStr = typeof place === "string" ? place.trim().toUpperCase() : ""
    const placeOk = /^[A-Z]{2}$/.test(placeStr)
    out.push({
      id,
      category: category as AiSuggestion["category"],
      subcategory: typeof subcategory === "string" ? subcategory.slice(0, 60) : "",
      confidence,
      ...(leanOk ? { lean: lean as AiSuggestion["lean"] } : {}),
      ...(bucketOk ? { bucket: bucketStr } : {}),
      ...(placeOk ? { place: placeStr } : {}),
    })
  }
  return out
}

export interface AiCategorizeOptions {
  fetchImpl?: typeof fetch
  model?: string
  /** Cap on API calls per run (cost guard). Default 80 batches (~3200 tx). */
  maxBatches?: number
  /** Phase 3R (chained chunks): hard wall-clock deadline (epoch ms). The loop
   *  refuses to START a batch unless a worst-case batch (API timeout + persist)
   *  fits before it — the run stops CLEANLY (`stats.stoppedOnDeadline`) and the
   *  caller hands the baton to a continuation job. Anchored to the RUNNER's
   *  invocation start, never the handler's (review cond. 1). */
  deadlineAt?: number
  /** Injectable clock for deadline tests (time-travel pattern). */
  now?: () => number
  /** Per-batch persistence hook (Phase 0.3, 2026-07-03): called after EACH
   *  batch's suggestions are parsed, BEFORE the next API call. Callers persist
   *  incrementally so a killed run loses nothing already paid for. A throw
   *  here is recorded as a batch error and the run continues — the final
   *  return still includes ALL suggestions, so an end-of-run reconcile can
   *  retry anything a mid-run write missed. */
  onBatch?: (batchSuggestions: AiSuggestion[], meta: { batchIndex: number; stopReason: string | null; parsed: number }) => Promise<void>
}

/** Per-run stats for the observability record (Phase 0.5). */
export interface AiRunStats {
  batchesSent: number
  batchesFailed: number
  suggestionsParsed: number
  truncatedBatches: number
  capped: boolean
  /** Phase 3R: run stopped cleanly on `deadlineAt` with batches left — the
   *  caller must enqueue a continuation chunk. */
  stoppedOnDeadline?: boolean
}

/** Worst-case single batch: the 90s API timeout + parse/persist allowance.
 *  A batch is only STARTED if this still fits before the deadline. */
export const BATCH_TIME_ALLOWANCE_MS = 100_000

/**
 * Ask Claude for category suggestions for a set of uncategorized transactions.
 * Returns ALL suggestions with confidence — the caller decides the apply
 * policy (recategorizeAccountYear applies only "high").
 */
export async function aiSuggestCategories(
  txs: AiCategorizableTx[],
  ctx: AiCategorizeContext,
  opts?: AiCategorizeOptions,
): Promise<{ suggestions: AiSuggestion[]; errors: string[]; stats: AiRunStats }> {
  const emptyStats = (capped = false): AiRunStats =>
    ({ batchesSent: 0, batchesFailed: 0, suggestionsParsed: 0, truncatedBatches: 0, capped })
  if (aiCategorizationDisabled()) {
    return { suggestions: [], errors: ["AI_CATEGORIZATION_DISABLED=1 — AI pass skipped (kill switch)"], stats: emptyStats() }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { suggestions: [], errors: ["ANTHROPIC_API_KEY not set — AI categorization skipped"], stats: emptyStats() }
  const doFetch = opts?.fetchImpl ?? fetch
  const maxBatches = opts?.maxBatches ?? 80

  const suggestions: AiSuggestion[] = []
  const errors: string[] = []
  const validBuckets = ctx.buckets ? new Set(ctx.buckets.map(b => b.slug)) : undefined

  const batches: AiCategorizableTx[][] = []
  for (let i = 0; i < txs.length; i += BATCH_SIZE) batches.push(txs.slice(i, i + BATCH_SIZE))
  const capped = batches.length > maxBatches
  if (capped) {
    errors.push(`Capped at ${maxBatches} batches (${maxBatches * BATCH_SIZE} tx) of ${batches.length} — rerun to continue`)
    batches.length = maxBatches
  }
  const stats: AiRunStats = emptyStats(capped)

  const clock = opts?.now ?? Date.now
  for (let bi = 0; bi < batches.length; bi++) {
    // Deadline guard (Phase 3R): don't start a batch that can't finish.
    if (opts?.deadlineAt && clock() + BATCH_TIME_ALLOWANCE_MS > opts.deadlineAt) {
      stats.stoppedOnDeadline = true
      break
    }
    const batch = batches[bi]
    const validIds = new Set(batch.map(t => t.id))
    const lines = batch.map(t =>
      `${t.id} | ${t.transaction_date} | ${t.bank_name} | ${t.amount > 0 ? "+" : ""}${t.amount} ${t.currency}${(t.group_count ?? 1) > 1 ? ` ×${t.group_count} (total ${t.group_total} ${t.currency})` : ""} | ${t.counterparty || "-"} | ${t.description}`,
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
            content: ctx.grouped
              ? `Categorize these ${batch.length} merchant groups (format: id | date | bank | amount currency [×count (total)] | counterparty | description — the id is the group's representative transaction):\n\n${lines}`
              : `Categorize these ${batch.length} transactions (format: id | date | bank | amount | counterparty | description):\n\n${lines}`,
          }],
        }),
      })
      clearTimeout(timer)
      stats.batchesSent++
      if (!res.ok) {
        stats.batchesFailed++
        errors.push(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`)
        continue
      }
      const data = await res.json() as { stop_reason?: string; content?: Array<{ type: string; name?: string; input?: unknown }> }
      // Truncation surfacing (Phase 0.1): a max_tokens stop mid-tool-call used
      // to parse to zero suggestions with NO signal — now it's counted + logged.
      const stopReason = data.stop_reason ?? null
      if (stopReason === "max_tokens") {
        stats.truncatedBatches++
        errors.push(`Batch ${bi + 1}/${batches.length} TRUNCATED at max_tokens — suggestions from this batch are partial/lost`)
      }
      const toolBlock = data.content?.find(b => b.type === "tool_use" && b.name === "suggest_categories")
      const parsed = parseSuggestions(toolBlock?.input, validIds, validBuckets)
      stats.suggestionsParsed += parsed.length
      suggestions.push(...parsed)
      // Per-batch persistence (Phase 0.3): caller writes THIS batch before the
      // next API call — a killed run keeps everything already paid for.
      if (opts?.onBatch) await opts.onBatch(parsed, { batchIndex: bi, stopReason, parsed: parsed.length })
    } catch (e) {
      stats.batchesFailed++
      errors.push(`Batch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { suggestions, errors, stats }
}
