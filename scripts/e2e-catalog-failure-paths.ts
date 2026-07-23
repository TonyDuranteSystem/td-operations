/* eslint-disable no-console -- CLI E2E harness, stdout IS the report. */
/* eslint-disable no-restricted-syntax -- the harness seeds its OWN throwaway delivery to prove the live-client guard fires; going through the operations layer would create a real SD with side effects. */
/**
 * The FAILURE paths of the Service Catalog save, against a real database.
 *
 * Every previous attempt at this fix was verified on happy paths only, and every
 * previous attempt was rejected for something that only shows up when a save is
 * interrupted, raced, or fed a shape the admin can genuinely produce. Three
 * separate times the tests could not fail. This harness exists to cover exactly
 * those cases:
 *
 *   - a pipeline whose step numbers are negative and gapped (Tax Return's real
 *     shape) — renumbering them changes what a payment does
 *   - a save interrupted half-way through reordering, then retried
 *   - deleting a step that live clients are sitting on
 *   - renaming a step that live clients are sitting on
 *   - a second tab that added a step since this page loaded
 *   - a pipeline name that already belongs to another service
 *
 * Throwaway service types and throwaway deliveries only; cleaned up on every
 * exit path.
 *
 *   npx tsx scripts/e2e-catalog-failure-paths.ts
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { replaceStagesForService, getStagesForService, planStageOrders } from "@/lib/services/stages"

const SVC = "ZZ_QA_FAIL"
let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = "") {
  checks++
  if (ok) console.log(`   ok   ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`) }
}
function scenario(n: string) { console.log(`\n── ${n}`) }

const LAYOUT = { components: [{ type: "waiting_notice", label: "Mail to: {td_mailing_address}" }] }

async function cleanup() {
  await supabaseAdmin.from("service_deliveries").delete().eq("service_type", SVC)
  await supabaseAdmin.from("pipeline_stages").delete().eq("service_type", SVC)
  await supabaseAdmin.from("pipeline_stages").delete().eq("service_type", `${SVC}_B`)
}

/** Seed a pipeline with the REAL Tax-Return shape: negative and gapped orders. */
async function seedGapped() {
  await cleanup()
  const orders = [-10, 0, 10, 20, 35, 90]
  const { error } = await supabaseAdmin.from("pipeline_stages").insert(
    orders.map((o, i) => ({
      service_type: SVC,
      stage_order: o,
      stage_name: `S${i + 1}`,
      stage_layout: LAYOUT,
      client_label: `Client ${i + 1}`,
      board_visible: true,
      client_visible: true,
    })),
  )
  if (error) throw new Error(`seed: ${error.message}`)
}

async function orders() {
  const { data } = await supabaseAdmin
    .from("pipeline_stages").select("stage_name, stage_order")
    .eq("service_type", SVC).order("stage_order")
  return (data ?? []) as Array<{ stage_name: string; stage_order: number }>
}

async function layoutsIntact() {
  const { data } = await supabaseAdmin
    .from("pipeline_stages").select("stage_name, stage_layout").eq("service_type", SVC)
  const rows = (data ?? []) as Array<{ stage_name: string; stage_layout: unknown }>
  return rows.length > 0 && rows.every(r => JSON.stringify(r.stage_layout) === JSON.stringify(LAYOUT))
}

async function main() {
  console.log("\nE2E — Service Catalog save, FAILURE paths\n")

  // ═══ 1. The semantic step numbers must survive an ordinary edit ══════════
  scenario("1. A pipeline with negative and gapped step numbers (Tax Return's real shape)")
  await seedGapped()
  let loaded = await getStagesForService(SVC)
  const before = (await orders()).map(o => o.stage_order).join(",")
  check("seeded with the real shape", before === "-10,0,10,20,35,90", before)

  await replaceStagesForService(SVC, loaded.map(s => s.stage_name === "S3" ? { ...s, sla_days: 9 } : s))
  const after = (await orders()).map(o => o.stage_order).join(",")
  check("an SLA edit does NOT renumber the pipeline", after === before, `became ${after}`)
  check("the negative intake steps kept their sign", after.startsWith("-10,0,"), after)
  check("workspaces intact", await layoutsIntact())

  // ═══ 2. Reordering is refused ════════════════════════════════════════════
  scenario("2. Reordering steps is refused, and nothing changes")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  const beforeSeq = (await orders()).map(o => `${o.stage_name}:${o.stage_order}`).join(" ")
  let reorderRefused = false
  let reorderMsg = ""
  try { await replaceStagesForService(SVC, [...loaded].reverse()) }
  catch (e) { reorderRefused = true; reorderMsg = e instanceof Error ? e.message : String(e) }
  check("the reorder is refused", reorderRefused)
  check("the message explains why", reorderMsg.includes("not available yet"), reorderMsg.slice(0, 100))
  check("the pipeline is byte-identical afterwards",
    (await orders()).map(o => `${o.stage_name}:${o.stage_order}`).join(" ") === beforeSeq)
  check("workspaces intact", await layoutsIntact())

  // ═══ 3. A new step extends the scale, it does not compress it ════════════
  scenario("3. Adding a step")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  await replaceStagesForService(SVC, [...loaded, { stage_order: 999, stage_name: "S7" }])
  const added = await orders()
  check("existing numbers untouched", added.slice(0, 6).map(r => r.stage_order).join(",") === "-10,0,10,20,35,90")
  check("the new step extends past the maximum", added[6].stage_order === 100, `got ${added[6].stage_order}`)

  // ═══ 3b. Deleting a step must NOT slide the others onto new numbers ══════
  scenario("3b. Deleting a step leaves the survivors' numbers alone (payment-rule safety)")
  await cleanup()
  // A shape with the intake boundary in the middle: -10 and -5 are intake,
  // 1 and up are auto-advance eligible.
  await supabaseAdmin.from("pipeline_stages").insert(
    [-10, -5, 1, 10, 20].map((o, i) => ({
      service_type: SVC, stage_order: o, stage_name: `B${i + 1}`,
      stage_layout: LAYOUT, board_visible: true, client_visible: true,
    })),
  )
  loaded = await getStagesForService(SVC)
  const ownBefore = new Map((await orders()).map(r => [r.stage_name, r.stage_order]))
  // Delete the FIRST step — the worst case for a positional shift.
  await replaceStagesForService(SVC, loaded.filter(s => s.stage_name !== "B1"))
  const ownAfter = await orders()
  check("every surviving step kept its OWN number",
    ownAfter.every(r => ownBefore.get(r.stage_name) === r.stage_order),
    ownAfter.map(r => `${r.stage_name}:${r.stage_order}`).join(" "))
  check("no step crossed the intake boundary",
    ownAfter.filter(r => r.stage_order >= 1).length === 3,
    `${ownAfter.filter(r => r.stage_order >= 1).length} steps at >= 1, expected 3`)

  // ═══ 4. THE DEADLOCK: a save interrupted mid-reorder, then retried ═══════
  scenario("4. A save interrupted half-way through reordering")
  await seedGapped()
  const rows = await orders()
  const { data: idRows } = await supabaseAdmin
    .from("pipeline_stages").select("id, stage_name, stage_order").eq("service_type", SVC).order("stage_order")
  const ids = (idRows ?? []) as Array<{ id: string; stage_name: string; stage_order: number }>
  // Simulate: the park loop wrote 3 of 6 rows and then the process died.
  const base = Math.max(100000, ...rows.map(r => r.stage_order)) + 1
  for (let i = 0; i < 3; i++) {
    await supabaseAdmin.from("pipeline_stages").update({ stage_order: base + i }).eq("id", ids[i].id)
  }
  const wrecked = (await orders()).map(o => `${o.stage_name}:${o.stage_order}`).join(" ")
  check("the interrupted state is as expected", wrecked.includes("100001"), wrecked)

  let retryRefused = false
  let retryMsg = ""
  try {
    const reloaded = await getStagesForService(SVC)
    await replaceStagesForService(SVC, reloaded)
  } catch (e) { retryRefused = true; retryMsg = e instanceof Error ? e.message : String(e) }
  check("a wrecked pipeline REFUSES the save rather than silently renumbering it",
    retryRefused, "it accepted the save and rewrote the numbering")
  check("the refusal explains itself", retryMsg.includes("not available yet"), retryMsg.slice(0, 100))
  const healed = await orders()
  check("all six steps still present", healed.length === 6, `${healed.length}`)
  check("workspaces intact", await layoutsIntact())

  // ═══ 5. Deleting a step with live clients on it must be REFUSED ══════════
  scenario("5. Deleting a step that live clients are sitting on")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  const { error: sdErr } = await supabaseAdmin.from("service_deliveries").insert({
    service_type: SVC, service_name: SVC, stage: "S3", status: "active",
  })
  if (sdErr) throw new Error(`seed delivery: ${sdErr.message}`)

  let refused = false
  let msg = ""
  try {
    await replaceStagesForService(SVC, loaded.filter(s => s.stage_name !== "S3"))
  } catch (e) { refused = true; msg = e instanceof Error ? e.message : String(e) }
  check("the delete is refused", refused)
  check("the message names the step and the count", msg.includes("S3") && msg.includes("1 active"), msg.slice(0, 120))
  const stillThere = await orders()
  check("nothing was changed by the refused save", stillThere.length === 6)
  check("workspaces intact", await layoutsIntact())

  // ═══ 6. Renaming a step is refused (names are matched literally in code) ══
  scenario("6. Renaming a step is refused, and nothing changes")
  loaded = await getStagesForService(SVC)
  let renameRefused = false
  let renameMsg = ""
  try {
    await replaceStagesForService(SVC, loaded.map(s => s.stage_name === "S3" ? { ...s, stage_name: "S3 Renamed" } : s))
  } catch (e) { renameRefused = true; renameMsg = e instanceof Error ? e.message : String(e) }
  check("the rename is refused", renameRefused)
  check("the message explains why", renameMsg.includes("matched by name"), renameMsg.slice(0, 120))
  const afterRename = await orders()
  check("the step kept its original name", afterRename.some(r => r.stage_name === "S3"))
  check("workspaces intact", await layoutsIntact())
  await supabaseAdmin.from("service_deliveries").delete().eq("service_type", SVC)

  // ═══ 6b. The ordinary editing loop: add, save, tweak, save again ══════════
  scenario("6b. Add a step, save, then save again (the loop that false-refused)")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  const frozenIds = loaded.map(s => s.id!).filter(Boolean)
  await replaceStagesForService(SVC, [...loaded, { stage_order: 999, stage_name: "Added" }], {
    knownStageIds: frozenIds,
  })
  // The page does NOT remount, so it still holds the ORIGINAL id list.
  const reloaded = await getStagesForService(SVC)
  let secondSaveOk = true
  let secondErr = ""
  try {
    await replaceStagesForService(
      SVC,
      reloaded.map(s => s.stage_name === "Added" ? { ...s, sla_days: 4 } : s),
      { knownStageIds: frozenIds },
    )
  } catch (e) { secondSaveOk = false; secondErr = e instanceof Error ? e.message : String(e) }
  check("the second save SUCCEEDS (it used to blame a tab that does not exist)", secondSaveOk, secondErr)
  const loopRows = await orders()
  check("no duplicate step was created", loopRows.filter(r => r.stage_name === "Added").length === 1)
  check("the edit applied", loopRows.length === 7, `${loopRows.length}`)

  // ═══ 6c. Clearing every step is refused ═══════════════════════════════════
  scenario("6c. Removing every step at once")
  await seedGapped()
  let wipeRefused = false
  try { await replaceStagesForService(SVC, []) } catch { wipeRefused = true }
  check("clearing the whole pipeline is refused", wipeRefused)
  check("all six steps survive", (await orders()).length === 6)

  // ═══ 7. Stale tab: a step appeared since this page loaded ════════════════
  scenario("7. A second tab added a step while this page was open")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  const knownStageIds = loaded.map(s => s.id!).filter(Boolean)
  // Another session adds a stage.
  await supabaseAdmin.from("pipeline_stages").insert({
    service_type: SVC, stage_order: 500, stage_name: "Added Elsewhere",
    stage_layout: LAYOUT, board_visible: true, client_visible: true,
  })
  let staleRefused = false
  let staleMsg = ""
  try {
    await replaceStagesForService(SVC, loaded, { knownStageIds })
  } catch (e) { staleRefused = true; staleMsg = e instanceof Error ? e.message : String(e) }
  check("the stale save is refused", staleRefused)
  check("the message names what appeared", staleMsg.includes("Added Elsewhere"), staleMsg.slice(0, 140))
  const survived = await orders()
  check("the other tab's step was NOT deleted", survived.some(r => r.stage_name === "Added Elsewhere"))
  check("all seven steps present", survived.length === 7, `${survived.length}`)

  // ═══ 7b. A BLOCKED client is live work too ═══════════════════════════════
  scenario("7b. Deleting a step that a BLOCKED client sits on (135 such rows exist)")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  await supabaseAdmin.from("service_deliveries").insert({
    service_type: SVC, service_name: SVC, stage: "S4", status: "blocked",
  })
  let blockedRefused = false
  let blockedMsg = ""
  try {
    await replaceStagesForService(SVC, loaded.filter(s => s.stage_name !== "S4"))
  } catch (e) { blockedRefused = true; blockedMsg = e instanceof Error ? e.message : String(e) }
  check("a BLOCKED client also blocks the delete", blockedRefused, "blocked clients were ignored")
  check("the message names the step", blockedMsg.includes("S4"), blockedMsg.slice(0, 100))

  // A capitalised status must not slip through either.
  await supabaseAdmin.from("service_deliveries").delete().eq("service_type", SVC)
  await supabaseAdmin.from("service_deliveries").insert({
    service_type: SVC, service_name: SVC, stage: "S4", status: "Active",
  })
  let capRefused = false
  try {
    await replaceStagesForService(SVC, loaded.filter(s => s.stage_name !== "S4"))
  } catch { capRefused = true }
  check('a capitalised "Active" status is not missed', capRefused)

  // A genuinely finished client must NOT block the delete.
  await supabaseAdmin.from("service_deliveries").delete().eq("service_type", SVC)
  await supabaseAdmin.from("service_deliveries").insert({
    service_type: SVC, service_name: SVC, stage: "S4", status: "completed",
  })
  let completedBlocked = false
  try {
    await replaceStagesForService(SVC, loaded.filter(s => s.stage_name !== "S4"))
  } catch { completedBlocked = true }
  check("a COMPLETED client does not block the delete", !completedBlocked)
  await supabaseAdmin.from("service_deliveries").delete().eq("service_type", SVC)

  // ═══ 7c. A step deleted elsewhere must not silently come back EMPTY ══════
  scenario("7c. A step this page loaded was deleted elsewhere")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  const known2 = loaded.map(s => s.id!).filter(Boolean)
  // Another session deletes S2 entirely.
  const { data: victim } = await supabaseAdmin
    .from("pipeline_stages").select("id").eq("service_type", SVC).eq("stage_name", "S2").maybeSingle()
  await supabaseAdmin.from("pipeline_stages").delete().eq("id", (victim as { id: string }).id)

  let vanishRefused = false
  let vanishMsg = ""
  try {
    // This page still has S2 in its draft and would re-insert it BARE.
    await replaceStagesForService(SVC, loaded, { knownStageIds: known2 })
  } catch (e) { vanishRefused = true; vanishMsg = e instanceof Error ? e.message : String(e) }
  check("the save is refused rather than recreating it empty", vanishRefused)
  check("the message names the vanished step", vanishMsg.includes("S2"), vanishMsg.slice(0, 130))
  const afterVanish = await orders()
  check("no bare replacement was inserted", afterVanish.length === 5, `${afterVanish.length}`)
  check("the remaining workspaces are untouched", await layoutsIntact())

  // ═══ 8. Without the known-ids the delete still works (deliberate) ════════
  scenario("8. A deliberate delete still works when no stale-guard data is sent")
  await seedGapped()
  loaded = await getStagesForService(SVC)
  await replaceStagesForService(SVC, loaded.filter(s => s.stage_name !== "S6"))
  const deleted = await orders()
  check("the step was removed as asked", deleted.length === 5 && !deleted.some(r => r.stage_name === "S6"))
  check("the deletion was recorded in the audit log", await (async () => {
    const { data } = await supabaseAdmin
      .from("action_log").select("summary")
      .eq("table_name", "pipeline_stages").eq("action_type", "delete")
      .order("created_at", { ascending: false }).limit(3)
    return ((data ?? []) as Array<{ summary: string }>).some(r => r.summary?.includes("S6"))
  })())

  // ═══ 9. planStageOrders is pure — check it directly ══════════════════════
  // ═══ 8b. The real ITIN shape: eight steps, an ordinary edit ══════════════
  scenario("8b. The real ITIN pipeline — the exact reported bug")
  await cleanup()
  const ITIN = ["Data Collection", "Document Preparation", "Client Signing", "Documents Received",
                "CAA Review", "Submitted to IRS", "IRS Processing", "ITIN Approved"]
  await supabaseAdmin.from("pipeline_stages").insert(
    ITIN.map((n, i) => ({
      service_type: SVC, stage_order: i + 1, stage_name: n, stage_layout: LAYOUT,
      client_label: `Client view of ${n}`, board_visible: true, client_visible: true,
    })),
  )
  loaded = await getStagesForService(SVC)
  await replaceStagesForService(SVC, loaded.map(s => s.stage_name === "CAA Review" ? { ...s, sla_days: 21 } : s))
  const itinRows = await orders()
  check("all eight steps survive an SLA edit", itinRows.length === 8, `${itinRows.length}`)
  check("every workspace survives", await layoutsIntact())
  check("the numbering is untouched", itinRows.map(r => r.stage_order).join(",") === "1,2,3,4,5,6,7,8")
  const { data: lbl } = await supabaseAdmin
    .from("pipeline_stages").select("client_label").eq("service_type", SVC)
    .eq("stage_name", "CAA Review").maybeSingle()
  check("the client-facing label survives",
    (lbl as { client_label: string } | null)?.client_label === "Client view of CAA Review")

  scenario("9. The order planner itself")
  check("same count reuses the same numbers",
    planStageOrders(3, [10, 20, 30]).join(",") === "10,20,30")
  check("fewer steps take the lowest numbers",
    planStageOrders(2, [-10, 0, 10]).join(",") === "-10,0")
  check("more steps extend beyond the maximum",
    planStageOrders(4, [-10, 0, 10]).join(",") === "-10,0,10,20")
  check("an empty pipeline starts at 10",
    planStageOrders(2, []).join(",") === "10,20")

  await cleanup()
  console.log(`\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECKS FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async err => {
  console.error("\nERROR:", err instanceof Error ? err.message : err)
  try { await cleanup() } catch { /* best effort */ }
  process.exit(1)
})
