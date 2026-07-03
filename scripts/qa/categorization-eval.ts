/* eslint-disable no-console -- CLI reporting tool; console output IS the product */
/**
 * Categorization eval runner (Smart Categorization v2, Phase 1 — 2026-07-03).
 *
 * Runs the categorization pipeline against a GOLDEN fixture set and reports
 * the release-gate metrics (lib/tax/categorization-eval.ts). This is the gate
 * for Phases 2 & 4 of the approved plan: no rule/AI change ships unless this
 * passes on the golden panel.
 *
 * LEAKAGE-FREE BY CONSTRUCTION (re-review COND-5):
 *  - rules come from a FIXTURE file ({fixtures}/rules.json), injected through
 *    the engine's DI seam — no DB rules, no learned rules, frozen snapshot;
 *  - buckets come from {fixtures}/meta.json (frozen list) when the AI stage
 *    runs — never the live client-mutable catalog;
 *  - labels were reconciled BY HAND before the layers under test existed.
 *
 * Fixture dir layout (NOT in the repo — client PII; see .gitignore):
 *   {fixtures}/statements/*.csv     the raw bank exports
 *   {fixtures}/labels.json          [{ key, label, confidence? }] where
 *                                   key = `${fileName}|${date}|${amount}|${ref}`
 *                                   confidence 'low' rows are reported but
 *                                   EXCLUDED from gate metrics
 *   {fixtures}/rules.json           frozen CategorizationRule[]
 *   {fixtures}/meta.json            { companyName, memberNames, fxRateToUsd, buckets? }
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/qa/categorization-eval.ts --fixtures <dir> [--ai]
 * The --ai stage needs ANTHROPIC_API_KEY; without the flag the report covers
 * the deterministic layers only (stated in the output).
 */
import fs from "fs"
import path from "path"
import { parseBankStatement } from "@/lib/bank-statement-parser"
import { computeRecategorizationUpdates, decideAiSuggestion, type CategorizableRow, type CategorizationRule } from "@/lib/tax/categorization-engine"
import { aiSuggestCategories, type AiCategorizableTx } from "@/lib/tax/ai-categorizer"
import { rowRootKey } from "@/lib/tax/row-root"
import { computeEvalReport, type EvalRow } from "@/lib/tax/categorization-eval"

interface LabelEntry { key: string; label: string; confidence?: "high" | "low" }
interface Meta { companyName: string; memberNames: string[]; fxRateToUsd: Record<string, number>; buckets?: { slug: string; label: string }[] }

const rowKey = (fileName: string, date: string, amount: number, ref: string) =>
  `${fileName}|${date}|${amount}|${ref}`

async function main() {
  const args = process.argv.slice(2)
  const fixturesIdx = args.indexOf("--fixtures")
  const fixtures = fixturesIdx >= 0 ? args[fixturesIdx + 1] : process.env.EVAL_FIXTURES_DIR
  const runAi = args.includes("--ai")
  if (!fixtures) throw new Error("usage: categorization-eval.ts --fixtures <dir> [--ai]")

  const meta = JSON.parse(fs.readFileSync(path.join(fixtures, "meta.json"), "utf-8")) as Meta
  const rules = JSON.parse(fs.readFileSync(path.join(fixtures, "rules.json"), "utf-8")) as CategorizationRule[]
  const labels = JSON.parse(fs.readFileSync(path.join(fixtures, "labels.json"), "utf-8")) as LabelEntry[]
  const labelByKey = new Map(labels.map(l => [l.key, l]))

  // 1. Parse every statement (same parsers as production).
  const rows: Array<CategorizableRow & { fileName: string }> = []
  const stmtDir = path.join(fixtures, "statements")
  for (const f of fs.readdirSync(stmtDir).filter(f => f.toLowerCase().endsWith(".csv"))) {
    const parsed = await parseBankStatement(fs.readFileSync(path.join(stmtDir, f)), f, "text/csv")
    for (const t of parsed.transactions) {
      rows.push({
        id: rowKey(f, t.transaction_date, t.amount, t.transaction_ref),
        fileName: f,
        transaction_date: t.transaction_date,
        description: t.description,
        counterparty: t.counterparty,
        amount: t.amount,
        currency: t.currency,
        balance_after: t.balance_after,
        transaction_ref: t.transaction_ref,
        bank_name: t.bank_name,
        account_type: t.account_type,
        category: "uncategorized",
        subcategory: "",
        is_related_party: null,
        notes: null,
        ai_lean: null,
        ai_bucket: null,
      })
    }
  }

  // 2. Deterministic passes with the FROZEN fixture rules (DI — no DB).
  const { updates } = computeRecategorizationUpdates(rows, rules, meta.memberNames, meta.companyName)
  const effCat = new Map(rows.map(r => [r.id, updates.get(r.id)?.category ?? "uncategorized"]))
  // Legacy built-ins run inside applyRules via the engine core; anything the
  // engine decided is source 'rule' for attribution purposes.
  const source = new Map(rows.map(r => [r.id, effCat.get(r.id) !== "uncategorized" ? "rule" : "none"]))

  // 3. Optional AI stage (frozen buckets from meta; same policy as production).
  let aiInfo = "AI stage: SKIPPED (run with --ai and ANTHROPIC_API_KEY to include it)"
  if (runAi) {
    const candidates = rows.filter(r => effCat.get(r.id) === "uncategorized")
    // Short synthetic ids for the AI call — the eval's composite keys contain
    // pipe characters that collide with the prompt's field separator.
    const shortId = new Map<string, string>()
    const longId = new Map<string, string>()
    candidates.forEach((r, i) => { shortId.set(r.id, `e${i}`); longId.set(`e${i}`, r.id) })
    const txs: AiCategorizableTx[] = candidates.map(r => ({
      id: shortId.get(r.id)!, transaction_date: r.transaction_date, description: r.description ?? "",
      counterparty: r.counterparty ?? "", amount: Number(r.amount), currency: r.currency ?? "USD", bank_name: r.bank_name ?? "",
    }))
    const ai = await aiSuggestCategories(txs, {
      companyName: meta.companyName, memberNames: meta.memberNames,
      bankNames: Array.from(new Set(rows.map(r => r.bank_name ?? "").filter(Boolean))),
      buckets: meta.buckets,
    })
    let applied = 0
    for (const s of ai.suggestions) {
      const rid = longId.get(s.id)
      if (!rid) continue
      const d = decideAiSuggestion(s, effCat.get(rid))
      if (d.applied && d.update?.category) {
        effCat.set(rid, d.update.category)
        source.set(rid, "ai:high")
        applied++
      }
    }
    aiInfo = `AI stage: ran — ${ai.stats.batchesSent} batches, ${ai.suggestions.length} suggestions, ${applied} applied high-confidence${ai.errors.length ? `, ${ai.errors.length} errors` : ""}`
  }

  // 4. Join with labels → eval rows.
  const evalRows: EvalRow[] = []
  let unlabeled = 0
  let lowConfidence = 0
  for (const r of rows) {
    const l = labelByKey.get(r.id)
    if (!l) { unlabeled++; continue }
    if (l.confidence === "low") { lowConfidence++; continue } // reported, not gated
    evalRows.push({
      id: r.id,
      amount: Number(r.amount),
      currency: r.currency ?? "USD",
      predicted: effCat.get(r.id) ?? "uncategorized",
      source: source.get(r.id) ?? "none",
      label: l.label,
      // Phase 3R cond. 12: eval measures the SHIPPED grouping (openQuestionGroups
      // is the human-workload metric — it must count the groups the UI shows).
      groupKey: rowRootKey(r.description as string | null, r.counterparty as string | null).key,
    })
  }

  const report = computeEvalReport(evalRows, { fxRateToUsd: meta.fxRateToUsd })

  // 5. Emit.
  const out = {
    generated_at: new Date().toISOString(),
    fixtures: path.basename(fixtures),
    panel_note: "Panel size: 1 golden set (B&P 2025, hand-reconciled + client-confirmed). Held-out second set: PENDING — gates are PROVISIONAL until the panel has a never-mined holdout (approved plan §1.1).",
    ai: aiInfo,
    rows_total: rows.length,
    rows_labeled: evalRows.length,
    rows_unlabeled: unlabeled,
    rows_low_confidence_excluded: lowConfidence,
    report,
  }
  const dest = path.join(fixtures, `report-${new Date().toISOString().slice(0, 10)}${runAi ? "-ai" : "-det"}.json`)
  fs.writeFileSync(dest, JSON.stringify(out, null, 2))

  console.log(`\n== CATEGORIZATION EVAL (${runAi ? "deterministic + AI" : "deterministic only"}) ==`)
  console.log(out.panel_note)
  console.log(aiInfo)
  console.log(`rows: ${rows.length} (labeled ${evalRows.length}, unlabeled ${unlabeled}, low-confidence excluded ${lowConfidence})`)
  console.log(`auto rate: ${(report.autoRate * 100).toFixed(1)}% of rows / ${(report.autoRateDollars * 100).toFixed(1)}% of dollars`)
  console.log(`auto-applied precision: ${(report.autoAppliedPrecisionDollars * 100).toFixed(2)}% ($-weighted) / ${(report.autoAppliedPrecisionRows * 100).toFixed(2)}% (rows)`)
  console.log(`critical — owner-draw-as-expense: $${report.ownerDrawAsExpenseDollars.toFixed(2)} (${(report.ownerDrawAsExpenseShare * 100).toFixed(3)}%)`)
  console.log(`critical — transfer legs misbooked: ${report.transferLegMisbookedCount} ($${report.transferLegMisbookedDollars.toFixed(2)})`)
  console.log(`open question groups (human workload): ${report.openQuestionGroups}`)
  console.log(`|ΔP&L$| vs golden: $${report.pnlDeltaDollars.toFixed(2)}`)
  console.log(`GATES: ${report.gates.pass ? "PASS ✅" : `FAIL ❌ — ${report.gates.failures.join(" | ")}`}`)
  console.log(`report written: ${dest}`)
}

main().catch(e => { console.error("EVAL FAILED:", e); process.exit(1) })
