/* eslint-disable no-console -- CLI E2E harness, stdout IS the report. */
/**
 * End-to-end proof, against a real database, that saving a service's stages
 * cannot destroy the columns the Service Catalog editor does not author.
 *
 * Unit tests assert which statements are issued. This asserts what SURVIVES in
 * an actual table — the gap that let an earlier attempt at this fix ship fifteen
 * green tests over six real blockers.
 *
 * Uses a throwaway service_type so no real service is touched, and deletes it
 * again at the end (including on failure).
 *
 *   npx tsx scripts/e2e-stages-carry.ts
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { replaceStagesForService, getStagesForService } from "@/lib/services/stages"

const SERVICE = "ZZ_QA_CARRY_FORWARD"

const LAYOUT_A = {
  components: [
    { type: "waiting_notice", label: "Mail to: {td_mailing_address}" },
    { type: "action_buttons", actions: [{ key: "advance_next", target: "Second" }] },
  ],
  description: "Staff workspace for the first stage.",
}
const LAYOUT_B = { components: [{ type: "document_upload", label: "Upload the scan" }] }

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function cleanup() {
  await supabaseAdmin.from("pipeline_stages").delete().eq("service_type", SERVICE)
}

async function seed() {
  await cleanup()
  const { error } = await supabaseAdmin.from("pipeline_stages").insert([
    {
      service_type: SERVICE,
      stage_order: 1,
      stage_name: "First",
      sla_days: 5,
      stage_layout: LAYOUT_A,
      client_label: "Getting started",
      client_label_it: "Iniziamo",
      icon: "pen",
      color: "blue",
      stale_days: 30,
      board_visible: false,
    },
    // NOTE: every row must carry the SAME keys. In a PostgREST bulk insert a
    // column named by ANY row is named for ALL of them, so a row that omits it
    // gets NULL rather than the column default — and board_visible is NOT NULL.
    { service_type: SERVICE, stage_order: 2, stage_name: "Second", stage_layout: LAYOUT_B, client_label: "In progress", client_label_it: null, icon: null, color: null, stale_days: null, sla_days: null, board_visible: true },
    { service_type: SERVICE, stage_order: 3, stage_name: "Third", stage_layout: LAYOUT_B, client_label: null, client_label_it: null, icon: null, color: null, stale_days: null, sla_days: null, board_visible: true },
  ])
  if (error) throw new Error(`seed failed: ${error.message}`)
}

async function readRaw() {
  const { data, error } = await supabaseAdmin
    .from("pipeline_stages")
    .select("id, stage_name, stage_order, sla_days, stage_layout, client_label, client_label_it, icon, color, stale_days, board_visible")
    .eq("service_type", SERVICE)
    .order("stage_order", { ascending: true })
  if (error) throw new Error(`read failed: ${error.message}`)
  return (data ?? []) as Array<Record<string, unknown>>
}

async function main() {
  console.log(`\nE2E — stage save must not destroy unmanaged columns (service_type=${SERVICE})\n`)

  // ── 1. An ordinary edit: change one SLA, touch nothing else ───────────────
  await seed()
  let loaded = await getStagesForService(SERVICE)
  check("the loader returns a row id (without it the whole fix is inert)", loaded.every(s => !!s.id))

  await replaceStagesForService(
    SERVICE,
    loaded.map(s => (s.stage_name === "First" ? { ...s, sla_days: 14 } : s)),
  )
  let rows = await readRaw()
  const first = rows.find(r => r.stage_name === "First")!
  check("SLA edit applied", first.sla_days === 14, `got ${first.sla_days}`)
  check("workspace layout survived an SLA edit", JSON.stringify(first.stage_layout) === JSON.stringify(LAYOUT_A))
  check("client labels survived", first.client_label === "Getting started" && first.client_label_it === "Iniziamo")
  check("display settings survived", first.icon === "pen" && first.color === "blue" && first.stale_days === 30)
  check("a FALSE display flag survived (not treated as missing)", first.board_visible === false)
  check("stage count unchanged", rows.length === 3, `got ${rows.length}`)

  // ── 2. Rename — impossible under the previous design ──────────────────────
  await seed()
  loaded = await getStagesForService(SERVICE)
  await replaceStagesForService(
    SERVICE,
    loaded.map(s => (s.stage_name === "First" ? { ...s, stage_name: "Renamed First" } : s)),
  )
  rows = await readRaw()
  const renamed = rows.find(r => r.stage_name === "Renamed First")
  check("rename succeeded", !!renamed)
  check("renamed stage KEPT its workspace", JSON.stringify(renamed?.stage_layout) === JSON.stringify(LAYOUT_A))
  check("no stage was lost to the rename", rows.length === 3, `got ${rows.length}`)

  // ── 3. Name SWAP — the case that used to cross-wire two workspaces ────────
  await seed()
  loaded = await getStagesForService(SERVICE)
  const swapped = loaded.map(s =>
    s.stage_name === "First" ? { ...s, stage_name: "Second" } :
    s.stage_name === "Second" ? { ...s, stage_name: "First" } : s,
  )
  await replaceStagesForService(SERVICE, swapped)
  rows = await readRaw()
  const nowSecond = rows.find(r => r.stage_name === "Second")!
  const nowFirst = rows.find(r => r.stage_name === "First")!
  check("swap kept each workspace with its own ROW, not its name",
    JSON.stringify(nowSecond.stage_layout) === JSON.stringify(LAYOUT_A) &&
    JSON.stringify(nowFirst.stage_layout) === JSON.stringify(LAYOUT_B),
    "layouts followed the name instead of the row — cross-wired")

  // ── 4. Reorder — must not trip the unique (service_type, stage_order) ─────
  await seed()
  loaded = await getStagesForService(SERVICE)
  const reversed = [...loaded].reverse()
  await replaceStagesForService(SERVICE, reversed)
  rows = await readRaw()
  check("reorder applied", rows.map(r => r.stage_name).join(",") === "Third,Second,First", rows.map(r => r.stage_name).join(","))
  check("orders are dense 1..n after reorder", rows.map(r => r.stage_order).join(",") === "1,2,3", rows.map(r => r.stage_order).join(","))
  check("no parked order left behind", rows.every(r => (r.stage_order as number) < 1000))
  check("layouts survived the reorder", rows.find(r => r.stage_name === "First")?.stage_layout !== null)

  // ── 5. Delete one stage — the others keep everything ──────────────────────
  await seed()
  loaded = await getStagesForService(SERVICE)
  await replaceStagesForService(SERVICE, loaded.filter(s => s.stage_name !== "Third"))
  rows = await readRaw()
  check("the removed stage is gone", rows.length === 2 && !rows.some(r => r.stage_name === "Third"))
  check("survivors kept their workspaces", JSON.stringify(rows.find(r => r.stage_name === "First")?.stage_layout) === JSON.stringify(LAYOUT_A))

  // ── 6. Add a stage alongside existing ones ────────────────────────────────
  await seed()
  loaded = await getStagesForService(SERVICE)
  await replaceStagesForService(SERVICE, [...loaded, { stage_order: 4, stage_name: "Fourth" }])
  rows = await readRaw()
  check("new stage added", rows.length === 4 && rows.some(r => r.stage_name === "Fourth"))
  check("new stage starts with no workspace", rows.find(r => r.stage_name === "Fourth")?.stage_layout === null)
  check("existing workspaces untouched by the addition", JSON.stringify(rows.find(r => r.stage_name === "First")?.stage_layout) === JSON.stringify(LAYOUT_A))

  // ── 7. Bad drafts are refused before anything is written ─────────────────
  await seed()
  loaded = await getStagesForService(SERVICE)
  let threw = false
  try {
    await replaceStagesForService(SERVICE, [...loaded, { stage_order: 4, stage_name: "  " }])
  } catch { threw = true }
  check("a blank stage name is refused", threw)
  rows = await readRaw()
  check("the refused save changed nothing", rows.length === 3 && JSON.stringify(rows.find(r => r.stage_name === "First")?.stage_layout) === JSON.stringify(LAYOUT_A))

  threw = false
  try {
    await replaceStagesForService(SERVICE, loaded.map(s => ({ ...s, stage_name: "Same" })))
  } catch { threw = true }
  check("duplicate stage names are refused", threw)
  rows = await readRaw()
  check("the refused duplicate save changed nothing", rows.length === 3)

  await cleanup()
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async err => {
  console.error("\nERROR:", err instanceof Error ? err.message : err)
  await cleanup()
  process.exit(1)
})
