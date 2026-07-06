/* eslint-disable no-console, no-restricted-syntax -- QA harness; console output IS the product, QA fixture accounts are seeded raw */
/**
 * S4 country-policy sweep — DB-level E2E against the sandbox stack.
 * Run: npx tsx scripts/qa/country-policy-sweep-e2e.ts   (refuses on prod ref)
 *
 * Scenarios (the approved plan's sandbox matrix, lib-level half):
 *  1. Workspace policy + new located rows → auto-sweep books them (system batch,
 *     provenance set, exact prior-state capture).
 *  2. Second sweep run → nothing to do, ZERO new batch headers (idempotent).
 *  3. Undo the auto-batch (route logic exercised at lib level: restore +
 *     revoke) → rows restored EXACTLY, source policy revoked, third sweep
 *     books nothing.
 *  4. Save-to-client promotes active policies → account_location_policies;
 *     a FRESH workspace for the same account replays them (next-year zero-tap).
 *  5. Fresh-workspace answer overrides the account policy (workspace wins).
 *  6. Residence country policy never sweeps.
 *  7. Manual (hand-answered) rows are never touched by the sweep.
 */
import { createClient } from "@supabase/supabase-js"
import * as dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (url.includes("ydzipybqeebtpcvsbtvs")) { console.error("REFUSED: production ref"); process.exit(1) }
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "") as ReturnType<typeof createClient>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = db as any

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const YEAR = 2025
const ids: { workspaces: string[]; accounts: string[] } = { workspaces: [], accounts: [] }

async function makeAccount(name: string): Promise<string> {
  const { data, error } = await raw.from("accounts").insert({ company_name: name }).select("id").single()
  if (error) throw new Error(`account insert: ${error.message}`)
  ids.accounts.push(data.id)
  return data.id
}

async function makeWorkspace(name: string, accountId: string | null): Promise<string> {
  const { data, error } = await raw.from("pnl_workspaces").insert({
    company_name: name,
    tax_year: YEAR,
    linked_account_id: accountId,
    generated_at: new Date().toISOString(),
    created_by: "qa:s4",
  }).select("id").single()
  if (error) throw new Error(`workspace insert: ${error.message}`)
  ids.workspaces.push(data.id)
  return data.id
}

let txSeq = 0
async function addRow(wsId: string, over: Record<string, unknown> = {}) {
  txSeq++
  const { error } = await raw.from("pnl_workspace_transactions").insert({
    workspace_id: wsId,
    tax_year: YEAR,
    transaction_date: `${YEAR}-06-1${txSeq % 9}`,
    description: `QA S4 row ${txSeq}`,
    amount: -25,
    currency: "USD",
    category: "uncategorized",
    transaction_ref: `qa-s4-${wsId.slice(0, 8)}-${txSeq}`,
    loc_code: "ES",
    loc_source: "ai",
    loc_confidence: "medium",
    // created_at backdated so the stale guard (created_at > generated_at) passes
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  })
  if (error) throw new Error(`tx insert: ${error.message}`)
}

async function countBatches(wsId: string): Promise<number> {
  const { count } = await raw.from("pnl_period_answers").select("id", { count: "exact", head: true }).eq("workspace_id", wsId)
  return count ?? 0
}

async function main() {
  const { runCountryPolicySweep, applyLocationAnswer, resolveCountryPolicies } = await import("../../lib/tax/country-policy-sweep")

  console.log("\n— Scenario 1: workspace policy + new AI-located rows → auto-booked —")
  const acctA = await makeAccount("QA S4 Alpha LLC")
  const wsA = await makeWorkspace("QA S4 Alpha", acctA)
  // Two rows located in ES; the staff answers the country card (human batch).
  await addRow(wsA); await addRow(wsA)
  const human = await applyLocationAnswer({
    workspaceId: wsA, locCodes: ["ES"], choice: "business", scope: "country",
    actorId: "qa@tonydurante.us", actorRole: "staff",
    expected: { rowCount: 2, dollarTotal: 50 },
  })
  check("human country answer books 2 rows", human.status === "ok" && human.swept === 2, JSON.stringify(human))
  // The AI chain later locates 3 MORE rows in ES → the auto-sweep replays.
  await addRow(wsA); await addRow(wsA); await addRow(wsA)
  const sweep1 = await runCountryPolicySweep(wsA)
  const s1 = sweep1.sweeps.find(s => s.loc_code === "ES")
  check("auto-sweep books the 3 late rows", s1?.status === "ok" && s1.swept === 3, JSON.stringify(sweep1))
  const { data: autoBatch } = await raw.from("pnl_period_answers")
    .select("id, actor_role, actor_id, source_policy_batch_id, source_account_policy_id, row_count")
    .eq("workspace_id", wsA).eq("actor_role", "system").maybeSingle()
  check("auto batch is actor_role=system with workspace provenance",
    !!autoBatch && autoBatch.source_policy_batch_id === (human.status === "ok" ? human.batchId : "?") && !autoBatch.source_account_policy_id,
    JSON.stringify(autoBatch))
  const { count: priorRows } = await raw.from("pnl_period_answer_rows").select("*", { count: "exact", head: true }).eq("batch_id", autoBatch?.id)
  check("prior state captured for all 3 swept rows", priorRows === 3, String(priorRows))

  console.log("\n— Scenario 2: second sweep run is a no-op (no empty batches) —")
  const before = await countBatches(wsA)
  const sweep2 = await runCountryPolicySweep(wsA)
  check("nothing_left reported", sweep2.sweeps.every(s => s.status === "nothing_left"), JSON.stringify(sweep2))
  check("zero new batch headers", (await countBatches(wsA)) === before)

  console.log("\n— Scenario 3: undo auto-batch → exact restore + policy revoked → sweep books nothing —")
  // Restore (the undo route's core: prior-state restore, then revoke source).
  const { data: restoreRows } = await raw.from("pnl_period_answer_rows")
    .select("transaction_id, prev_category, prev_subcategory, prev_notes").eq("batch_id", autoBatch.id)
  for (const r of restoreRows ?? []) {
    await raw.from("pnl_workspace_transactions")
      .update({ category: r.prev_category ?? "uncategorized", subcategory: r.prev_subcategory, notes: r.prev_notes })
      .eq("id", r.transaction_id)
      .like("notes", `manual: % answer ${autoBatch.id}%`)
  }
  await raw.from("pnl_period_answers").update({ undone_at: new Date().toISOString() }).eq("id", autoBatch.id)
  await raw.from("pnl_period_answers").update({ policy_revoked_at: new Date().toISOString() })
    .eq("id", autoBatch.source_policy_batch_id).is("policy_revoked_at", null)
  const { count: restoredOpen } = await raw.from("pnl_workspace_transactions")
    .select("*", { count: "exact", head: true }).eq("workspace_id", wsA).eq("category", "uncategorized")
  check("3 rows restored to uncategorized", restoredOpen === 3, String(restoredOpen))
  const sweep3 = await runCountryPolicySweep(wsA)
  check("revoked policy no longer sweeps", sweep3.policies === 0, JSON.stringify(sweep3))

  console.log("\n— Scenario 4: promotion → fresh workspace replays with zero taps —")
  const acctB = await makeAccount("QA S4 Beta LLC")
  const wsB1 = await makeWorkspace("QA S4 Beta year1", acctB)
  await addRow(wsB1); await addRow(wsB1)
  const humanB = await applyLocationAnswer({
    workspaceId: wsB1, locCodes: ["ES"], choice: "business", scope: "country",
    actorId: "qa@tonydurante.us", actorRole: "staff", expected: { rowCount: 2, dollarTotal: 50 },
  })
  check("year-1 answer books", humanB.status === "ok")
  // Promotion (the workspace-save block, exercised directly).
  const { data: answerRows } = await raw.from("pnl_period_answers")
    .select("id, loc_codes, period_start, period_end, choice, actor_role, created_at, undone_at, policy_revoked_at")
    .eq("workspace_id", wsB1)
  const pols = resolveCountryPolicies({ workspaceAnswers: answerRows ?? [], accountPolicies: [], taxYear: YEAR, residenceCountry: "AE" })
  for (const pol of pols) {
    await raw.from("account_location_policies").upsert({
      account_id: acctB, loc_code: pol.loc_code, choice: pol.choice, active: true,
      promoted_from_workspace: wsB1, promoted_batch_id: pol.source_id, created_by: "qa:s4",
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id,loc_code" })
  }
  const { data: acctPol } = await raw.from("account_location_policies").select("id, loc_code, choice, active").eq("account_id", acctB)
  check("ES policy promoted to the account", acctPol?.length === 1 && acctPol[0].loc_code === "ES" && acctPol[0].active === true, JSON.stringify(acctPol))
  // "Next year": a fresh workspace, same account, new located rows — zero taps.
  const wsB2 = await makeWorkspace("QA S4 Beta year2", acctB)
  await addRow(wsB2); await addRow(wsB2); await addRow(wsB2); await addRow(wsB2)
  const sweepB2 = await runCountryPolicySweep(wsB2)
  const sB2 = sweepB2.sweeps.find(s => s.loc_code === "ES")
  check("fresh workspace auto-books all 4 rows from the ACCOUNT policy", sB2?.status === "ok" && sB2.swept === 4 && sB2.source === "account", JSON.stringify(sweepB2))
  const { data: autoBatchB } = await raw.from("pnl_period_answers")
    .select("source_account_policy_id, actor_role").eq("workspace_id", wsB2).eq("actor_role", "system").maybeSingle()
  check("account-policy provenance recorded", autoBatchB?.source_account_policy_id === acctPol?.[0]?.id, JSON.stringify(autoBatchB))

  console.log("\n— Scenario 5: fresh workspace answer OVERRIDES the account policy —")
  const wsB3 = await makeWorkspace("QA S4 Beta year3", acctB)
  await addRow(wsB3); await addRow(wsB3)
  const humanB3 = await applyLocationAnswer({
    workspaceId: wsB3, locCodes: ["ES"], choice: "personal", scope: "country",
    actorId: "qa@tonydurante.us", actorRole: "staff", expected: { rowCount: 2, dollarTotal: 50 },
  })
  check("this-year personal answer books", humanB3.status === "ok")
  await addRow(wsB3)
  const sweepB3 = await runCountryPolicySweep(wsB3)
  const sB3 = sweepB3.sweeps.find(s => s.loc_code === "ES")
  check("late row follows the WORKSPACE answer (personal), not the account policy (business)",
    sB3?.status === "ok" && sB3.choice === "personal" && sB3.source === "workspace", JSON.stringify(sweepB3))
  // 2 human-answered + 1 auto-swept = 3 personal draws, zero business expenses.
  const { count: drawCount } = await raw.from("pnl_workspace_transactions")
    .select("*", { count: "exact", head: true }).eq("workspace_id", wsB3).eq("category", "distribution")
  const { count: expCount } = await raw.from("pnl_workspace_transactions")
    .select("*", { count: "exact", head: true }).eq("workspace_id", wsB3).eq("category", "expense")
  check("all 3 rows are personal draws, none business", drawCount === 3 && expCount === 0, `draws=${drawCount} expenses=${expCount}`)

  console.log("\n— Scenario 6: residence country never sweeps —")
  // Account policy for AE exists BUT the contact's residence is AE → dropped.
  await raw.from("account_location_policies").insert({
    account_id: acctB, loc_code: "AE", choice: "business", active: true, created_by: "qa:s4",
  })
  const { data: contact, error: contactErr } = await raw.from("contacts").insert({
    first_name: "QA", last_name: "S4 Resident", full_name: "QA S4 Resident", email: `qa-s4-${Date.now()}@example.test`, address_country: "United Arab Emirates",
  }).select("id").single()
  if (contactErr || !contact) throw new Error(`contact insert: ${contactErr?.message}`)
  await raw.from("account_contacts").insert({ account_id: acctB, contact_id: contact.id })
  const wsB4 = await makeWorkspace("QA S4 Beta AE", acctB)
  await addRow(wsB4, { loc_code: "AE", loc_source: "text" })
  const sweepB4 = await runCountryPolicySweep(wsB4)
  check("AE (residence) is not among the swept policies", !sweepB4.sweeps.some(s => s.loc_code === "AE"), JSON.stringify(sweepB4))
  const { data: aeRow } = await raw.from("pnl_workspace_transactions")
    .select("category").eq("workspace_id", wsB4).eq("loc_code", "AE").single()
  check("AE row stays open", aeRow?.category === "uncategorized", JSON.stringify(aeRow))
  await raw.from("account_contacts").delete().eq("contact_id", contact.id)
  await raw.from("contacts").delete().eq("id", contact.id)

  console.log("\n— Scenario 7: hand-answered rows are never touched —")
  const wsC = await makeWorkspace("QA S4 Gamma", null)
  await addRow(wsC, { category: "expense", subcategory: "software", notes: "manual: group answer qa" })
  await addRow(wsC)
  const humanC = await applyLocationAnswer({
    workspaceId: wsC, locCodes: ["ES"], choice: "business", scope: "country",
    actorId: "qa@tonydurante.us", actorRole: "staff", expected: { rowCount: 1, dollarTotal: 25 },
  })
  check("only the open row is booked (manual row skipped, counted honestly)",
    humanC.status === "ok" && humanC.swept === 1 && humanC.skippedManual === 1, JSON.stringify(humanC))
  const { data: manualRow } = await raw.from("pnl_workspace_transactions")
    .select("notes").eq("workspace_id", wsC).like("notes", "manual: group answer qa").single()
  check("hand-answered row untouched", !!manualRow)

  // Cleanup (workspaces cascade their transactions + batches).
  for (const w of ids.workspaces) await raw.from("pnl_workspaces").delete().eq("id", w)
  for (const a of ids.accounts) {
    await raw.from("account_location_policies").delete().eq("account_id", a)
    await raw.from("accounts").delete().eq("id", a)
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error("FATAL:", e); process.exit(1) })
