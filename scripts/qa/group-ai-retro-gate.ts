/* eslint-disable no-console -- CLI gate; console output IS the product */
/**
 * Group-level AI retro-consistency gate (Phase 3R-B, review F6 — the ship gate
 * for prompt v3 grouped mode on the WORKSPACE path while the golden fixtures
 * are being rebuilt).
 *
 * DRY-RUN, READ-ONLY: takes every TRUSTED-labeled row of one workspace
 * (ai:high@v2 machine labels + manual: human answers), rebuilds the grouped
 * candidates exactly as production would, asks the v3 grouped prompt for
 * verdicts (suggestion-only — nothing is written anywhere), and compares.
 *
 * Gate terms (review F6, binding):
 *  - sample floor: ≥300 trusted rows AND ≥60 eligible groups, else FAIL CLOSED;
 *  - ≥98% dollar-weighted agreement over rows where v3 WOULD auto-apply
 *    (confidence=high on the group);
 *  - ZERO disagreements in the critical classes: trusted 'conversion' booked
 *    income/expense (transfer leg) or trusted 'distribution' booked
 *    expense/cogs/fee (owner draw as deduction);
 *  - every disagreement printed for human adjudication (agreement measures
 *    CONSISTENCY, not correctness — a human decides which side was wrong).
 *
 * Usage: npx tsx scripts/qa/group-ai-retro-gate.ts --workspace <id> --url <supabase-url> --key <service-key> --anthropic <api-key>
 */
import { createClient } from "@supabase/supabase-js"
import { buildGroupedAiCandidates } from "@/lib/tax/group-ai-candidates"
import { aiSuggestCategories, type AiCategorizableTx } from "@/lib/tax/ai-categorizer"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const workspaceId = arg("workspace")
  const url = arg("url"); const key = arg("key")
  const anthropicKey = arg("anthropic") ?? process.env.ANTHROPIC_API_KEY
  if (!workspaceId || !url || !key || !anthropicKey) throw new Error("usage: --workspace --url --key --anthropic")
  process.env.ANTHROPIC_API_KEY = anthropicKey
  const db = createClient(url, key, { auth: { persistSession: false } })

  interface Row { id: string; transaction_date: string; description: string | null; counterparty: string | null; amount: number; currency: string | null; bank_name: string | null; category: string; notes: string | null }
  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("pnl_workspace_transactions")
      .select("id, transaction_date, description, counterparty, amount, currency, bank_name, category, notes")
      .eq("workspace_id", workspaceId)
      .or("notes.like.ai:high%,notes.like.manual:%")
      .order("id", { ascending: true }).range(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as Row[]))
    if (!data || data.length < 1000) break
  }

  const { data: ws } = await db.from("pnl_workspaces").select("company_name").eq("id", workspaceId).single()
  const { data: members } = await db.from("pnl_workspace_members").select("display_name").eq("workspace_id", workspaceId)
  const { data: bucketRows } = await db.from("catalog_entries").select("slug, label").eq("catalog_id", "expense_categories").eq("status", "active")
  const bankNames = Array.from(new Set(rows.map(r => r.bank_name ?? "").filter(Boolean)))

  const trusted = new Map(rows.map(r => [r.id, r]))
  const txs: AiCategorizableTx[] = rows.map(r => ({
    id: r.id, transaction_date: r.transaction_date, description: r.description ?? "",
    counterparty: r.counterparty ?? "", amount: Number(r.amount), currency: r.currency ?? "USD", bank_name: r.bank_name ?? "",
  }))
  const { txs: grouped, expansion } = buildGroupedAiCandidates(txs)
  const eligibleGroups = grouped.filter(t => (t.group_count ?? 1) > 1).length

  console.log(`\n== GROUP-AI RETRO-CONSISTENCY GATE — workspace ${workspaceId} ==`)
  console.log(`trusted rows: ${rows.length} (${rows.filter(r => (r.notes ?? "").startsWith("ai:high")).length} ai / ${rows.filter(r => (r.notes ?? "").startsWith("manual:")).length} manual)`)
  console.log(`candidate lines: ${grouped.length} (${eligibleGroups} multi-row groups)`)
  if (rows.length < 300 || eligibleGroups < 60) {
    console.log(`GATE: FAIL CLOSED — sample floor not met (need ≥300 rows AND ≥60 groups)`)
    process.exit(1)
  }

  const ai = await aiSuggestCategories(grouped, {
    companyName: (ws?.company_name as string) ?? "the company",
    memberNames: ((members ?? []) as Array<{ display_name: string | null }>).map(m => m.display_name ?? "").filter(Boolean),
    bankNames,
    buckets: (bucketRows ?? []) as Array<{ slug: string; label: string }>,
    grouped: true,
  })
  console.log(`AI: ${ai.stats.batchesSent} batches, ${ai.suggestions.length} suggestions${ai.errors.length ? `, errors: ${ai.errors.length}` : ""}`)

  let appliedDollars = 0, agreeDollars = 0, appliedRows = 0, agreeRows = 0
  const critical: string[] = []
  const disagreements = new Map<string, { verdict: string; label: string; rows: number; dollars: number; sample: string }>()
  for (const s of ai.suggestions) {
    if (s.confidence !== "high") continue // only what v3 would auto-apply
    for (const memberId of expansion.get(s.id) ?? [s.id]) {
      const t = trusted.get(memberId)
      if (!t) continue
      const usd = Math.abs(Number(t.amount)) // consistency metric — no FX needed for agreement shares
      appliedRows++; appliedDollars += usd
      if (t.category === s.category) { agreeRows++; agreeDollars += usd; continue }
      const k = `${s.category}↔${t.category}:${(t.description ?? "").slice(0, 30)}`
      const d = disagreements.get(k) ?? { verdict: s.category, label: t.category, rows: 0, dollars: 0, sample: (t.description ?? "").slice(0, 50) }
      d.rows++; d.dollars += usd
      disagreements.set(k, d)
      if (t.category === "conversion" && (s.category === "income" || s.category === "expense" || s.category === "cogs" || s.category === "fee")) {
        critical.push(`TRANSFER LEG: "${t.description}" trusted=conversion verdict=${s.category}`)
      }
      if (t.category === "distribution" && (s.category === "expense" || s.category === "cogs" || s.category === "fee")) {
        critical.push(`OWNER DRAW AS DEDUCTION: "${t.description}" trusted=distribution verdict=${s.category}`)
      }
    }
  }

  const pctRows = appliedRows ? (agreeRows / appliedRows) * 100 : 0
  const pctDollars = appliedDollars ? (agreeDollars / appliedDollars) * 100 : 0
  console.log(`\nagreement (rows where v3 would auto-apply): ${agreeRows}/${appliedRows} rows = ${pctRows.toFixed(2)}% | $-weighted ${pctDollars.toFixed(2)}%`)
  console.log(`critical-class disagreements: ${critical.length}`)
  for (const c of critical.slice(0, 10)) console.log(`  🔴 ${c}`)
  console.log(`\ndisagreements for human adjudication (${disagreements.size} shapes):`)
  for (const [, d] of Array.from(disagreements.entries()).sort((a, b) => b[1].dollars - a[1].dollars).slice(0, 15)) {
    console.log(`  verdict=${d.verdict} vs trusted=${d.label} · ${d.rows} rows · $${d.dollars.toFixed(0)} · e.g. "${d.sample}"`)
  }
  const pass = pctDollars >= 98 && critical.length === 0
  console.log(`\nGATE: ${pass ? "PASS ✅" : "FAIL ❌"} (≥98% $-weighted AND zero critical)`)
  if (!pass) process.exit(1)
}

main().catch(e => { console.error("GATE FAILED:", e); process.exit(1) })
