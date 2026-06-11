/**
 * Slice 5b benchmark — measures categorization coverage on a real client's
 * uncategorized transaction patterns (exported read-only to a JSON file).
 *
 * Coverage is measured at PATTERN level weighted by transaction count, which
 * equals per-transaction coverage (a pattern's transactions all share the
 * description the engine matches on).
 *
 * Usage:
 *   npx tsx scripts/benchmark-ai-categorization.ts /tmp/dynamiq-uncat-patterns.json
 *
 * Reads ANTHROPIC_API_KEY from .env.local (dotenv) — same convention as
 * scripts/check-catalog-validity.ts. Makes REAL API calls (~27 batches for
 * 1,100 patterns). Writes full results to <input>.results.json for review.
 */

/* eslint-disable no-console -- CLI benchmark script: console output is the UI */
import { config } from "dotenv"
import { readFileSync, writeFileSync } from "fs"
import { aiSuggestCategories, type AiCategorizableTx } from "@/lib/tax/ai-categorizer"

config({ path: ".env.local" })

interface Pattern {
  bank_name: string
  dir: number
  descr: string
  cp: string
  n: number
  avg_amount: number
  first_date: string
  currency: string
}

interface BenchmarkFile {
  account_id: string
  company_name: string
  tax_year: number
  total_uncategorized: number
  members: string[]
  patterns: Pattern[]
}

// Candidate seed rules discovered from the live uncategorized set — these are
// generic bank vocabulary (not merchant names), safe as global rules. They are
// evaluated here BEFORE the AI pass, exactly like the engine's rule pass.
const CANDIDATE_RULES: Array<{ pattern: string; direction: "in" | "out"; category: string; subcategory: string }> = [
  { pattern: "Intl. Transaction Fee", direction: "out", category: "fee", subcategory: "bank_fee" },
  { pattern: "Corporate Card -", direction: "out", category: "expense", subcategory: "card_payment" },
]

function ruleFor(p: Pattern): { category: string; subcategory: string } | null {
  for (const r of CANDIDATE_RULES) {
    if (r.direction === "out" && p.dir >= 0) continue
    if (r.direction === "in" && p.dir <= 0) continue
    const hay = `${p.descr} ${p.cp}`.toLowerCase()
    if (hay.includes(r.pattern.toLowerCase())) return { category: r.category, subcategory: r.subcategory }
  }
  return null
}

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) { console.error("Usage: npx tsx scripts/benchmark-ai-categorization.ts <patterns.json>"); process.exit(1) }
  const data: BenchmarkFile = JSON.parse(readFileSync(inputPath, "utf8"))
  const totalAccountTxs = 4807 // Dynamiq 2025 full set; uncategorized subset = total_uncategorized
  const alreadyCategorized = totalAccountTxs - data.total_uncategorized

  // Pass 1: candidate deterministic rules
  const ruleHits: Array<Pattern & { category: string; subcategory: string }> = []
  const residual: Pattern[] = []
  for (const p of data.patterns) {
    const hit = ruleFor(p)
    if (hit) ruleHits.push({ ...p, ...hit })
    else residual.push(p)
  }
  const ruleWeight = ruleHits.reduce((s, p) => s + p.n, 0)
  console.log(`Patterns: ${data.patterns.length} (${data.total_uncategorized} txs)`)
  console.log(`Candidate rules cover: ${ruleHits.length} patterns = ${ruleWeight} txs`)

  // Pass 2: AI on the residual patterns (one synthetic tx per pattern)
  const txs: AiCategorizableTx[] = residual.map((p, i) => ({
    id: `p${i}`,
    transaction_date: p.first_date,
    description: p.cp && p.cp !== p.descr ? `${p.descr} | counterparty: ${p.cp}` : p.descr,
    counterparty: p.cp,
    amount: p.avg_amount,
    currency: p.currency || "USD",
    bank_name: p.bank_name,
  }))

  const t0 = Date.now()
  const ai = await aiSuggestCategories(txs, {
    companyName: data.company_name,
    memberNames: data.members,
    bankNames: Array.from(new Set(data.patterns.map(p => p.bank_name))),
    businessDescription: process.argv[3] || undefined,
  })
  console.log(`AI pass: ${ai.suggestions.length} suggestions in ${Math.round((Date.now() - t0) / 1000)}s, ${ai.errors.length} errors`)
  for (const e of ai.errors) console.log(`  ! ${e}`)

  const byId = new Map(ai.suggestions.map(s => [s.id, s]))
  let aiHigh = 0, aiMed = 0, aiLow = 0, aiNone = 0
  const results = residual.map((p, i) => {
    const s = byId.get(`p${i}`)
    if (!s) aiNone += p.n
    else if (s.confidence === "high") aiHigh += p.n
    else if (s.confidence === "medium") aiMed += p.n
    else aiLow += p.n
    return { ...p, ai_category: s?.category ?? null, ai_subcategory: s?.subcategory ?? null, ai_confidence: s?.confidence ?? null }
  })

  const finalUncat = data.total_uncategorized - ruleWeight - aiHigh
  const coverage = (totalAccountTxs - finalUncat) / totalAccountTxs

  console.log("\n=== COVERAGE (per-transaction, weighted) ===")
  console.log(`Already categorized (old engine):   ${alreadyCategorized}`)
  console.log(`+ candidate deterministic rules:    ${ruleWeight}`)
  console.log(`+ AI high-confidence (applied):     ${aiHigh}`)
  console.log(`AI medium (→ client questions):     ${aiMed}`)
  console.log(`AI low / no suggestion:             ${aiLow + aiNone}`)
  console.log(`Final uncategorized:                ${finalUncat} of ${totalAccountTxs}`)
  console.log(`TOTAL COVERAGE: ${(coverage * 100).toFixed(1)}%  (target ≥90%)`)

  const outPath = inputPath.replace(/\.json$/, "") + ".results.json"
  writeFileSync(outPath, JSON.stringify({ ruleHits, results, summary: { ruleWeight, aiHigh, aiMed, aiLow, aiNone, finalUncat, coverage } }, null, 1))
  console.log(`\nFull results: ${outPath}`)

  // Review sample: the 40 highest-volume AI-high patterns — these carry the
  // accuracy risk, a human should eyeball them.
  console.log("\n=== TOP AI HIGH-CONFIDENCE ASSIGNMENTS (review these) ===")
  results.filter(r => r.ai_confidence === "high").sort((a, b) => b.n - a.n).slice(0, 40)
    .forEach(r => console.log(`${String(r.n).padStart(4)}x ${r.bank_name.padEnd(8)} ${r.dir > 0 ? "+" : "-"} ${r.descr.slice(0, 45).padEnd(46)} → ${r.ai_category}/${r.ai_subcategory}`))
}

main().catch(e => { console.error(e); process.exit(1) })
