/* eslint-disable no-console -- CLI reporting tool; console output IS the product */
/**
 * Grouping dry-run (Phase 3R cond. 16 — ship-gate measurement, READ-ONLY).
 * Compares OLD (legacy merchantRoot, description-first, case-preserving key)
 * vs NEW (shared rowRootKey) grouping over one workspace's UNCATEGORIZED rows:
 * group count, singleton share (the locale-drift detector), top-10 sizes
 * (empirical mega-group check). Writes nothing.
 *
 * Usage: npx tsx scripts/qa/grouping-dryrun.ts --workspace <id> --url <supabase-url> --key <service-key>
 */
import { createClient } from "@supabase/supabase-js"
import { merchantRoot } from "@/lib/tax/question-groups"
import { rowRootKey } from "@/lib/tax/row-root"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

interface Row { description: string | null; counterparty: string | null; amount: number }

function report(name: string, keys: string[], rows: Row[]): { groups: number; singletons: number } {
  const byKey = new Map<string, number>()
  keys.forEach(k => byKey.set(k, (byKey.get(k) ?? 0) + 1))
  const sizes = Array.from(byKey.entries()).sort((a, b) => b[1] - a[1])
  const singletons = sizes.filter(([, n]) => n === 1).length
  console.log(`\n-- ${name} --`)
  console.log(`groups: ${byKey.size} | singleton share: ${((singletons / byKey.size) * 100).toFixed(1)}% (${singletons})`)
  console.log(`top 10: ${sizes.slice(0, 10).map(([k, n]) => `${k.slice(0, 28)}×${n}`).join(" · ")}`)
  const biggest = sizes[0]
  console.log(`largest group share of rows: ${((biggest[1] / rows.length) * 100).toFixed(1)}%`)
  return { groups: byKey.size, singletons }
}

async function main() {
  const workspaceId = arg("workspace")
  const url = arg("url") ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = arg("key") ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!workspaceId || !url || !key) throw new Error("usage: --workspace <id> [--url --key]")
  const db = createClient(url, key, { auth: { persistSession: false } })

  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select("description, counterparty, amount")
      .eq("workspace_id", workspaceId)
      .eq("category", "uncategorized")
      .order("id", { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as Row[]))
    if (!data || data.length < 1000) break
  }
  console.log(`workspace ${workspaceId}: ${rows.length} uncategorized rows`)

  const oldKeys = rows.map(r => (merchantRoot(r.description || r.counterparty || "").toLowerCase() || "(no description)"))
  const newKeys = rows.map(r => rowRootKey(r.description, r.counterparty).key)
  const o = report("OLD grouping (shipped today)", oldKeys, rows)
  const n = report("NEW grouping (rowRootKey)", newKeys, rows)
  console.log(`\n== RESULT: ${o.groups} → ${n.groups} groups (${(((o.groups - n.groups) / o.groups) * 100).toFixed(1)}% fewer) ==`)
}

main().catch(e => { console.error("DRY-RUN FAILED:", e); process.exit(1) })
