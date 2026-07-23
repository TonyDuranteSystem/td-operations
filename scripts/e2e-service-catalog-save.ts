/* eslint-disable no-console -- CLI E2E harness, stdout IS the report. */
/**
 * Full end-to-end QA of the Service Catalog save path, against a real database.
 *
 * Scope: every scenario an admin can produce from the editor screen, run through
 * the SAME sequence the server action performs (validate the draft → re-key the
 * stages if the pipeline was renamed → reconcile the stages). The server action
 * itself is behind an admin session, so the browser pass covers that gate; this
 * covers the data behaviour underneath it, including the cases a browser pass
 * would take an hour to reproduce by hand.
 *
 * Fixtures are throwaway service_types, removed at the end and on failure. No
 * real service is touched. Layouts mirror the real ITIN shape, including an
 * advance button that names its destination stage — the detail that made a
 * name-keyed save cross-wire two workspaces.
 *
 *   npx tsx scripts/e2e-service-catalog-save.ts
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  replaceStagesForService,
  renameServiceTypeForStages,
  validateStageDraft,
  getStagesForService,
  type StageRow,
} from "@/lib/services/stages"

const SVC = "ZZ_QA_SAVE"
const SVC_RENAMED = "ZZ_QA_SAVE_RENAMED"

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = "") {
  checks++
  if (ok) console.log(`   ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}
function scenario(n: string) {
  console.log(`\n── ${n}`)
}

/** The eight ITIN stages, shaped like production. */
const ITIN_STAGES = [
  { name: "Data Collection", layout: { components: [{ type: "waiting_notice", label: "Waiting for the client." }, { type: "chat" }] } },
  { name: "Document Preparation", layout: { components: [{ type: "document_viewer" }, { type: "chat" }] } },
  { name: "Client Signing", layout: { components: [{ type: "waiting_notice", label: "Mail to: {td_mailing_address}" }, { type: "shipping_info" }, { type: "action_buttons", actions: [{ key: "advance_next", label: "Documents Received at Office", target: "Documents Received" }] }] } },
  { name: "Documents Received", layout: { components: [{ type: "document_upload", label: "Upload received package scan" }, { type: "action_buttons", actions: [{ key: "advance_next", target: "CAA Review" }] }] } },
  { name: "CAA Review", layout: { components: [{ type: "document_viewer" }] } },
  { name: "Submitted to IRS", layout: { components: [{ type: "waiting_notice", label: "IRS ITIN Operation, PO Box 149342, Austin TX 78714-9342" }] } },
  { name: "IRS Processing", layout: { components: [{ type: "waiting_notice", label: "7-11 weeks." }] } },
  { name: "ITIN Approved", layout: { components: [{ type: "document_upload", label: "Upload CP565" }] } },
]

async function wipe(serviceType: string) {
  await supabaseAdmin.from("pipeline_stages").delete().eq("service_type", serviceType)
}
async function cleanup() {
  await wipe(SVC)
  await wipe(SVC_RENAMED)
}

/** Seed an ITIN-shaped pipeline. Uniform keys — see the PostgREST note below. */
async function seedItin(serviceType = SVC) {
  await wipe(serviceType)
  const rows = ITIN_STAGES.map((s, i) => ({
    service_type: serviceType,
    stage_order: i + 1,
    stage_name: s.name,
    stage_layout: s.layout,
    client_label: `Client view of ${s.name}`,
    client_label_it: `Vista cliente di ${s.name}`,
    icon: "circle",
    color: "blue",
    stale_days: 14,
    sla_days: 7,
    // Every row must carry the SAME keys: in a PostgREST bulk insert a column
    // named by ANY row is named for ALL of them, so an omitting row gets NULL
    // instead of the column default — which a NOT NULL column rejects.
    board_visible: true,
    client_visible: true,
  }))
  const { error } = await supabaseAdmin.from("pipeline_stages").insert(rows)
  if (error) throw new Error(`seed: ${error.message}`)
}

async function raw(serviceType = SVC) {
  const { data, error } = await supabaseAdmin
    .from("pipeline_stages")
    .select("id, stage_name, stage_order, stage_layout, client_label, client_label_it, icon, color, stale_days, sla_days, board_visible, client_visible")
    .eq("service_type", serviceType)
    .order("stage_order", { ascending: true })
  if (error) throw new Error(`read: ${error.message}`)
  return (data ?? []) as Array<Record<string, unknown>>
}

/** Layout of the named stage, as JSON, or "" if the stage/layout is gone. */
function layoutOf(rows: Array<Record<string, unknown>>, name: string) {
  const r = rows.find(x => x.stage_name === name)
  return r?.stage_layout ? JSON.stringify(r.stage_layout) : ""
}
function expectedLayout(name: string) {
  const s = ITIN_STAGES.find(x => x.name === name)
  return s ? JSON.stringify(s.layout) : ""
}
/** Every layout intact, every label intact. The blanket assertion. */
function allIntact(rows: Array<Record<string, unknown>>, names = ITIN_STAGES.map(s => s.name)) {
  return names.every(n => layoutOf(rows, n) === expectedLayout(n))
      && names.every(n => rows.find(r => r.stage_name === n)?.client_label === `Client view of ${n}`)
}

/** The sequence the server action runs, minus the admin gate. */
async function save(opts: {
  serviceType: string
  stages: StageRow[]
  previousPipeline?: string
}) {
  const problem = validateStageDraft(opts.stages)
  if (problem) throw new Error(problem)
  if (opts.previousPipeline && opts.previousPipeline !== opts.serviceType) {
    await renameServiceTypeForStages(opts.previousPipeline, opts.serviceType)
  }
  await replaceStagesForService(opts.serviceType, opts.stages)
}

async function main() {
  console.log("\nE2E — Service Catalog save, all scenarios (throwaway services)\n")

  // ═══ 1. The exact bug report: change one SLA on an ITIN-shaped service ════
  scenario("1. Ordinary edit — change one SLA day count (the reported wipe)")
  await seedItin()
  let loaded = await getStagesForService(SVC)
  check("8 stages loaded, all with an id", loaded.length === 8 && loaded.every(s => !!s.id))
  await save({ serviceType: SVC, stages: loaded.map(s => s.stage_name === "CAA Review" ? { ...s, sla_days: 21 } : s) })
  let rows = await raw()
  check("the SLA edit applied", rows.find(r => r.stage_name === "CAA Review")?.sla_days === 21)
  check("ALL EIGHT workspaces survived", allIntact(rows))
  check("the mailing-address notice survived verbatim", layoutOf(rows, "Client Signing").includes("{td_mailing_address}"))
  check("the advance button still names its target", layoutOf(rows, "Client Signing").includes("Documents Received"))

  // ═══ 2. Edit every editable field at once ════════════════════════════════
  scenario("2. Edit every editor-authored field on one stage")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: loaded.map(s => s.stage_name === "CAA Review" ? {
    ...s, stage_description: "new staff note", sla_days: 3, auto_advance: true,
    notify_client_email: true, client_description: "new client note",
  } : s) })
  rows = await raw()
  check("all edits applied and nothing else lost", allIntact(rows) && rows.find(r => r.stage_name === "CAA Review")?.sla_days === 3)

  // ═══ 3. Rename one stage ═════════════════════════════════════════════════
  scenario("3. Rename a stage")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: loaded.map(s => s.stage_name === "CAA Review" ? { ...s, stage_name: "Antonio Review" } : s) })
  rows = await raw()
  check("rename applied", rows.some(r => r.stage_name === "Antonio Review"))
  check("renamed stage kept ITS OWN workspace", layoutOf(rows, "Antonio Review") === expectedLayout("CAA Review"))
  check("the other seven are untouched", allIntact(rows, ITIN_STAGES.filter(s => s.name !== "CAA Review").map(s => s.name)))
  check("still eight stages", rows.length === 8)

  // ═══ 4. Swap two names (the cross-wire case) ═════════════════════════════
  scenario("4. Swap two stage names")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: loaded.map(s =>
    s.stage_name === "CAA Review" ? { ...s, stage_name: "Submitted to IRS" } :
    s.stage_name === "Submitted to IRS" ? { ...s, stage_name: "CAA Review" } : s) })
  rows = await raw()
  check("workspaces stayed with their ROWS, not the names",
    layoutOf(rows, "Submitted to IRS") === expectedLayout("CAA Review") &&
    layoutOf(rows, "CAA Review") === expectedLayout("Submitted to IRS"),
    "cross-wired — a stage is showing another stage's buttons")

  // ═══ 5. Reorder ══════════════════════════════════════════════════════════
  scenario("5. Reorder — move the last stage to the front")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: [loaded[7], ...loaded.slice(0, 7)] })
  rows = await raw()
  check("new order applied", rows[0].stage_name === "ITIN Approved")
  check("orders dense 1..8", rows.map(r => r.stage_order).join(",") === "1,2,3,4,5,6,7,8", rows.map(r => r.stage_order).join(","))
  check("no parked order left behind", rows.every(r => (r.stage_order as number) < 1000))
  check("every workspace survived the reorder", allIntact(rows))

  // ═══ 6. Full reversal — the worst reorder for a unique index ═════════════
  scenario("6. Reverse the entire pipeline")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: [...loaded].reverse() })
  rows = await raw()
  check("fully reversed", rows[0].stage_name === "ITIN Approved" && rows[7].stage_name === "Data Collection")
  check("no unique-constraint casualty — all 8 present", rows.length === 8)
  check("every workspace survived", allIntact(rows))

  // ═══ 7. Delete a stage ═══════════════════════════════════════════════════
  scenario("7. Delete one stage")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: loaded.filter(s => s.stage_name !== "IRS Processing") })
  rows = await raw()
  check("the stage is gone", rows.length === 7 && !rows.some(r => r.stage_name === "IRS Processing"))
  check("the survivors kept everything", allIntact(rows, ITIN_STAGES.filter(s => s.name !== "IRS Processing").map(s => s.name)))

  // ═══ 8. Add a stage ══════════════════════════════════════════════════════
  scenario("8. Add a stage at the end")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: [...loaded, { stage_order: 9, stage_name: "Closed" }] })
  rows = await raw()
  check("nine stages now", rows.length === 9)
  check("the new one starts blank", rows.find(r => r.stage_name === "Closed")?.stage_layout === null)
  check("the existing eight are untouched", allIntact(rows))

  // ═══ 9. Add + rename + reorder + delete in ONE save ══════════════════════
  scenario("9. Everything at once — add, rename, reorder and delete in one save")
  await seedItin()
  loaded = await getStagesForService(SVC)
  const mixed = [
    { ...loaded[1] },                                        // moved to front
    { ...loaded[0], stage_name: "Intake" },                  // renamed
    ...loaded.slice(2, 7),                                   // unchanged
    { stage_order: 99, stage_name: "Aftercare" },            // added
  ]                                                          // loaded[7] dropped
  await save({ serviceType: SVC, stages: mixed })
  rows = await raw()
  check("count is right (8 - 1 dropped + 1 added)", rows.length === 8, `got ${rows.length}`)
  check("the renamed stage kept its workspace", layoutOf(rows, "Intake") === expectedLayout("Data Collection"))
  check("the moved stage kept its workspace", layoutOf(rows, "Document Preparation") === expectedLayout("Document Preparation"))
  check("the dropped stage is gone", !rows.some(r => r.stage_name === "ITIN Approved"))
  check("the added stage is blank", rows.find(r => r.stage_name === "Aftercare")?.stage_layout === null)
  check("orders dense", rows.map(r => r.stage_order).join(",") === "1,2,3,4,5,6,7,8")

  // ═══ 10. Rename the PIPELINE itself ══════════════════════════════════════
  scenario("10. Rename the pipeline (the hole that bypassed the previous fix)")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC_RENAMED, stages: loaded, previousPipeline: SVC })
  const movedRows = await raw(SVC_RENAMED)
  const leftBehind = await raw(SVC)
  check("all eight stages moved to the new pipeline name", movedRows.length === 8)
  check("nothing orphaned under the old name", leftBehind.length === 0, `${leftBehind.length} orphaned`)
  check("every workspace came across", allIntact(movedRows))
  await wipe(SVC_RENAMED)

  // ═══ 11. Bad drafts — refused, nothing written ═══════════════════════════
  scenario("11. Bad drafts are refused with nothing written")
  await seedItin()
  loaded = await getStagesForService(SVC)
  for (const [label, bad] of [
    ["a blank stage name", [...loaded, { stage_order: 9, stage_name: "" }]],
    ["a whitespace-only name", [...loaded, { stage_order: 9, stage_name: "   " }]],
    ["a duplicate name", [...loaded, { stage_order: 9, stage_name: "CAA Review" }]],
    ["a duplicate differing only by case", [...loaded, { stage_order: 9, stage_name: "caa review" }]],
  ] as Array<[string, StageRow[]]>) {
    let threw = false
    try { await save({ serviceType: SVC, stages: bad }) } catch { threw = true }
    check(`${label} is refused`, threw)
  }
  rows = await raw()
  check("after four refused saves the pipeline is untouched", rows.length === 8 && allIntact(rows))

  // ═══ 12. Stale id — another admin deleted the row meanwhile ══════════════
  scenario("12. A submitted id that no longer exists")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await supabaseAdmin.from("pipeline_stages").delete().eq("id", loaded[3].id!)
  await save({ serviceType: SVC, stages: loaded })
  rows = await raw()
  check("the vanished stage was re-created, not silently skipped", rows.length === 8)
  check("it came back blank (its workspace really was deleted)", rows.find(r => r.stage_name === "Documents Received")?.stage_layout === null)
  check("the other seven kept theirs", allIntact(rows, ITIN_STAGES.filter(s => s.name !== "Documents Received").map(s => s.name)))

  // ═══ 13. Save twice with no changes — idempotent ═════════════════════════
  scenario("13. Save the same thing twice")
  await seedItin()
  loaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: loaded })
  const after1 = await raw()
  await save({ serviceType: SVC, stages: await getStagesForService(SVC) })
  const after2 = await raw()
  check("second save changed nothing", JSON.stringify(after1) === JSON.stringify(after2))
  check("workspaces still intact after two saves", allIntact(after2))

  // ═══ 14. A service with no stages at all ═════════════════════════════════
  scenario("14. A pipeline that has no stages yet")
  await wipe(SVC)
  await save({ serviceType: SVC, stages: [{ stage_order: 1, stage_name: "Only Stage" }] })
  rows = await raw()
  check("first stage created from nothing", rows.length === 1 && rows[0].stage_name === "Only Stage")

  // ═══ 15. Clear every stage ═══════════════════════════════════════════════
  scenario("15. Clear all stages (explicit destructive act)")
  await seedItin()
  await save({ serviceType: SVC, stages: [] })
  rows = await raw()
  check("all stages cleared as asked", rows.length === 0, `${rows.length} left`)

  // ═══ 16. Many stages — batch behaviour ═══════════════════════════════════
  scenario("16. A long pipeline (25 stages)")
  await wipe(SVC)
  const many: StageRow[] = Array.from({ length: 25 }, (_, i) => ({ stage_order: i + 1, stage_name: `Stage ${i + 1}` }))
  await save({ serviceType: SVC, stages: many })
  rows = await raw()
  check("all 25 created", rows.length === 25, `got ${rows.length}`)
  const reloaded = await getStagesForService(SVC)
  await save({ serviceType: SVC, stages: [...reloaded].reverse() })
  rows = await raw()
  check("all 25 survive a full reversal", rows.length === 25 && rows[0].stage_name === "Stage 25")

  await cleanup()
  console.log(`\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECKS FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async err => {
  console.error("\nERROR:", err instanceof Error ? err.message : err)
  await cleanup()
  process.exit(1)
})
