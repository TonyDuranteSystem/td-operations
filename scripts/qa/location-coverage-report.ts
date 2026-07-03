/* eslint-disable no-console -- CLI reporting tool; console output IS the product */
/**
 * Location-labeler coverage report (Phase 2b ship gate — architect cond. 7).
 *
 * READ-ONLY: runs the deterministic labeler + period detector IN MEMORY over
 * one workspace's transactions and prints the report Antonio decides on
 * before any prod approval:
 *   - rows located, by source and confidence;
 *   - % of presence-candidate rows the period cards can actually clear;
 *   - the detected periods (dates, counts, dollars, top merchants);
 *   - what the fiscal-residence anchor suppressed.
 * Writes NOTHING — safe against production.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/qa/location-coverage-report.ts \
 *     --workspace <id> [--residence AE] [--url <supabase url> --key <service key>]
 * (--url/--key override the env — for a prod read-only run use the prod
 *  values; this script builds its own client and never touches supabase-admin.)
 */
import { createClient } from "@supabase/supabase-js"
import { inferLocation } from "@/lib/tax/merchant-locations"
import { detectPresencePeriods, isSweepableRow, type LocatableRow } from "@/lib/tax/presence-periods"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const workspaceId = arg("workspace")
  if (!workspaceId) throw new Error("usage: location-coverage-report.ts --workspace <id> [--residence XX] [--url ... --key ...]")
  const url = arg("url") ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = arg("key") ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabase url/key missing (env or --url/--key)")
  const residence = arg("residence") ?? null

  const db = createClient(url, key, { auth: { persistSession: false } })

  const rows: Array<{ id: string; transaction_date: string; description: string | null; counterparty: string | null; amount: number; category: string | null; notes: string | null }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select("id, transaction_date, description, counterparty, amount, category, notes")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as typeof rows))
    if (!data || data.length < 1000) break
  }
  if (rows.length === 0) throw new Error("workspace has no transactions")

  // In-memory labeling (identical pure functions the deterministic pass uses).
  const located: LocatableRow[] = []
  const bySource = new Map<string, number>()
  let outflows = 0
  for (const r of rows) {
    const amt = Number(r.amount)
    if (amt < 0) outflows++
    const hit = inferLocation({ description: r.description, counterparty: r.counterparty, amount: amt, category: r.category })
    if (!hit) continue
    bySource.set(`${hit.loc_source}:${hit.loc_confidence}`, (bySource.get(`${hit.loc_source}:${hit.loc_confidence}`) ?? 0) + 1)
    located.push({
      id: r.id, transaction_date: r.transaction_date, description: r.description,
      counterparty: r.counterparty, amount: amt, category: r.category, notes: r.notes,
      loc_code: hit.loc_code,
    })
  }

  const byLoc = new Map<string, { rows: number; dollars: number }>()
  for (const r of located) {
    const e = byLoc.get(r.loc_code as string) ?? { rows: 0, dollars: 0 }
    e.rows++; e.dollars += Math.abs(r.amount)
    byLoc.set(r.loc_code as string, e)
  }

  const uncategorized = rows.filter(r => (r.category ?? "uncategorized") === "uncategorized").length
  const locatedUncat = located.filter(r => (r.category ?? "uncategorized") === "uncategorized").length
  const sweepable = located.filter(isSweepableRow).length

  const allPeriods = detectPresencePeriods(located, null)
  const withResidence = detectPresencePeriods(located, residence)
  const suppressed = allPeriods.filter(p => !withResidence.some(q => q.primary === p.primary && q.start === p.start))

  console.log(`\n== LOCATION COVERAGE REPORT — workspace ${workspaceId} ==`)
  console.log(`rows: ${rows.length} total | ${outflows} outflows | ${uncategorized} uncategorized`)
  console.log(`located: ${located.length} rows (${((located.length / Math.max(1, outflows)) * 100).toFixed(1)}% of outflows)`)
  for (const [src, n] of Array.from(bySource.entries()).sort()) console.log(`  ${src}: ${n}`)
  console.log(`located & still-uncategorized: ${locatedUncat} (${((locatedUncat / Math.max(1, uncategorized)) * 100).toFixed(1)}% of the open pile)`)
  console.log(`sweepable by a period answer right now: ${sweepable}`)
  console.log(`\nby location:`)
  for (const [loc, e] of Array.from(byLoc.entries()).sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`  ${loc}: ${e.rows} rows · $${e.dollars.toFixed(2)}`)
  }
  console.log(`\nresidence anchor: ${residence ?? "(none given — pass --residence XX to preview suppression)"}`)
  console.log(`detected periods${residence ? " (after residence suppression)" : ""}: ${withResidence.length}`)
  for (const p of withResidence) {
    console.log(`  ${p.loc_codes.join("+")} ${p.start} → ${p.end} [${p.confidence}] ${p.row_count} rows · $${p.dollar_total.toFixed(2)} · sweepable ${p.sweepable_count} ($${p.sweepable_total.toFixed(2)})`)
    console.log(`    top merchants: ${p.top_merchants.join(", ")}`)
  }
  if (suppressed.length > 0) {
    console.log(`suppressed as home-base periods: ${suppressed.map(p => `${p.primary} ${p.start}→${p.end} (${p.row_count} rows)`).join("; ")}`)
  }
}

main().catch(e => { console.error("REPORT FAILED:", e); process.exit(1) })
