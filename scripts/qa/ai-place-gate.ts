/* eslint-disable no-console -- CLI gate; console output IS the product */
/**
 * S2 — AI-place accuracy gate (the ship gate for AI_PLACE_ENABLED).
 *
 * DRY-RUN, READ-ONLY. Ground truth = rows the DETERMINISTIC layer located
 * (loc_source 'text'/'map'). For each such row we REDACT the tokens the
 * deterministic matcher used (brute force: drop the smallest word window
 * until inferLocation goes blind), rebuild grouped candidates from the
 * redacted text, and ask the v4 grouped prompt for 'place'. The AI therefore
 * has to read location the way a human does — from the remaining language,
 * city fragments, and brand names — with the giveaway token hidden.
 *
 * Gate terms (dual review, binding):
 *  - floor: ≥40 groups with truth, else FAIL CLOSED;
 *  - aggregate precision ≥95% over groups where the AI emitted a place
 *    ('EU' truth counts any eurozone country as a match);
 *  - per-country strata printed; any country with ≥10 truth groups must be
 *    ≥90% or the gate fails (an aggregate can hide a rotten stratum);
 *  - emission rate (recall) is REPORTED, not gated — omission is the designed
 *    safe behavior.
 *
 * Usage: npx tsx scripts/qa/ai-place-gate.ts --workspace <id> --url <supabase-url> --key <service-key> --anthropic <api-key>
 */
import { createClient } from "@supabase/supabase-js"
import { buildGroupedAiCandidates } from "@/lib/tax/group-ai-candidates"
import { aiSuggestCategories, type AiCategorizableTx } from "@/lib/tax/ai-categorizer"
import { inferLocation, EU_COUNTRIES } from "@/lib/tax/merchant-locations"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Remove the smallest word window that blinds the deterministic matcher.
 *  Repeats until no hit remains (a line can carry city AND country tokens). */
function redact(description: string, counterparty: string | null): { description: string; counterparty: string | null } {
  let desc = description
  let cp = counterparty
  for (let guard = 0; guard < 8; guard++) {
    const hit = inferLocation({ description: desc, counterparty: cp, amount: -1, category: "expense" })
    if (!hit) return { description: desc, counterparty: cp }
    const words = desc.split(/\s+/)
    let redacted = false
    outer: for (let win = 1; win <= 3 && !redacted; win++) {
      for (let i = 0; i + win <= words.length; i++) {
        const candidate = [...words.slice(0, i), ...words.slice(i + win)].join(" ")
        if (!inferLocation({ description: candidate, counterparty: cp, amount: -1, category: "expense" })) {
          desc = candidate
          redacted = true
          break outer
        }
      }
    }
    if (!redacted) {
      // Signal must live in the counterparty — blank it.
      if (cp && inferLocation({ description: desc, counterparty: null, amount: -1, category: "expense" }) === null) { cp = null; continue }
      // Irreducible (e.g. single-word description that IS the token): drop row.
      return { description: "", counterparty: cp }
    }
  }
  return { description: desc, counterparty: cp }
}

async function main() {
  const workspaceId = arg("workspace")
  const url = arg("url"); const key = arg("key")
  const anthropicKey = arg("anthropic") ?? process.env.ANTHROPIC_API_KEY
  if (!workspaceId || !url || !key || !anthropicKey) throw new Error("usage: --workspace --url --key --anthropic")
  process.env.ANTHROPIC_API_KEY = anthropicKey
  const db = createClient(url, key, { auth: { persistSession: false } })

  interface Row { id: string; transaction_date: string; description: string | null; counterparty: string | null; amount: number; currency: string | null; bank_name: string | null; loc_code: string; loc_source: string }
  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("pnl_workspace_transactions")
      .select("id, transaction_date, description, counterparty, amount, currency, bank_name, loc_code, loc_source")
      .eq("workspace_id", workspaceId)
      .in("loc_source", ["text", "map"])
      .order("id", { ascending: true }).range(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as Row[]))
    if (!data || data.length < 1000) break
  }
  console.log(`deterministically-located rows (ground truth): ${rows.length}`)

  // Redact + drop irreducible rows.
  const truthById = new Map<string, string>()
  const txs: AiCategorizableTx[] = []
  let dropped = 0
  for (const r of rows) {
    const red = redact(r.description ?? "", r.counterparty)
    if (!red.description.trim()) { dropped++; continue }
    truthById.set(r.id, r.loc_code)
    txs.push({
      id: r.id, transaction_date: r.transaction_date, description: red.description,
      counterparty: red.counterparty ?? "", amount: Number(r.amount), currency: r.currency ?? "USD", bank_name: r.bank_name ?? "",
    })
  }
  console.log(`redacted candidates: ${txs.length} (dropped ${dropped} irreducible)`)

  const { data: ws } = await db.from("pnl_workspaces").select("company_name").eq("id", workspaceId).single()
  const { data: members } = await db.from("pnl_workspace_members").select("display_name").eq("workspace_id", workspaceId)
  const bankNames = Array.from(new Set(txs.map(t => t.bank_name).filter(Boolean)))

  const { txs: grouped, expansion } = buildGroupedAiCandidates(txs)
  // Truth per GROUP: majority loc_code across members (mixed-truth groups are
  // themselves suspect — report them, exclude from scoring).
  const groupTruth = new Map<string, string>()
  let mixedTruth = 0
  for (const g of grouped) {
    const memberIds = expansion.get(g.id) ?? [g.id]
    const counts = new Map<string, number>()
    for (const id of memberIds) {
      const t = truthById.get(id)
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
    if (sorted.length === 0) continue
    if (sorted.length > 1 && sorted[1][1] === sorted[0][1]) { mixedTruth++; continue }
    groupTruth.set(g.id, sorted[0][0])
  }
  console.log(`groups with truth: ${groupTruth.size} (${mixedTruth} mixed-truth excluded)`)
  if (groupTruth.size < 40) {
    console.log(`\nGATE: FAIL CLOSED ❌ — sample floor not met (need ≥40 groups with truth)`)
    process.exit(1)
  }

  const ai = await aiSuggestCategories(
    grouped,
    { companyName: (ws?.company_name as string) ?? "the company", memberNames: ((members ?? []) as Array<{ display_name: string }>).map(m => m.display_name), bankNames, grouped: true },
    { maxBatches: 80 },
  )
  console.log(`AI: ${ai.stats.batchesSent} batches, ${ai.suggestions.length} suggestions`)

  const matches = (truth: string, place: string) =>
    truth === place || (truth === "EU" && EU_COUNTRIES.has(place))

  let emitted = 0, correct = 0
  const perCountry = new Map<string, { n: number; ok: number }>()
  const wrong: string[] = []
  for (const s of ai.suggestions) {
    const truth = groupTruth.get(s.id)
    if (!truth) continue
    const stratum = perCountry.get(truth) ?? { n: 0, ok: 0 }
    stratum.n++
    perCountry.set(truth, stratum)
    if (!s.place) continue
    emitted++
    if (matches(truth, s.place)) { correct++; stratum.ok++ }
    else {
      const rep = grouped.find(g => g.id === s.id)
      wrong.push(`truth=${truth} ai=${s.place} · "${(rep?.description ?? "").slice(0, 60)}"`)
    }
  }
  const scored = Array.from(perCountry.values()).reduce((s, v) => s + v.n, 0)
  const precision = emitted > 0 ? correct / emitted : 1
  const recall = scored > 0 ? emitted / scored : 0

  console.log(`\nemission (recall, reported not gated): ${emitted}/${scored} = ${(recall * 100).toFixed(1)}%`)
  console.log(`precision on emitted: ${correct}/${emitted} = ${(precision * 100).toFixed(2)}%`)
  console.log(`\nper-country strata (truth country · emitted-correct/truth-groups):`)
  let strataFail = false
  for (const [c, v] of Array.from(perCountry.entries()).sort((a, b) => b[1].n - a[1].n)) {
    // Per-country precision: of this stratum's groups where the AI emitted,
    // how many matched. Emissions for this stratum = ok + wrong-with-this-truth.
    const wrongHere = wrong.filter(w => w.startsWith(`truth=${c} `)).length
    const emittedHere = v.ok + wrongHere
    const p = emittedHere > 0 ? v.ok / emittedHere : 1
    const gateNote = v.n >= 10 && p < 0.9 ? "  ⟵ FAILS ≥90% stratum floor" : ""
    if (v.n >= 10 && p < 0.9) strataFail = true
    console.log(`  ${c} · ${v.n} groups · emitted ${emittedHere} · precision ${(p * 100).toFixed(1)}%${gateNote}`)
  }
  if (wrong.length > 0) {
    console.log(`\nwrong emissions (${wrong.length}):`)
    for (const w of wrong.slice(0, 20)) console.log(`  🔴 ${w}`)
  }

  const pass = precision >= 0.95 && !strataFail
  console.log(`\nGATE: ${pass ? "PASS ✅" : "FAIL ❌"} (precision ≥95% on emitted AND every ≥10-group country ≥90%)`)
  process.exit(pass ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
