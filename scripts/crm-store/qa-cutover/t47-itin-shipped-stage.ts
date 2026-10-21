/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script uses throw-away fixtures */
/**
 * ITIN "Shipped" stage QA (Antonio 2026-10-21): the REAL advanceServiceDelivery on throw-away ITIN cases in the sandbox database.
 * Needs the migration 20261021-1800-itin-shipped-stage.sql applied and the cases 'QA ITIN shipped-*' seeded with the OLD numbers before it.
 * Run: DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t47-itin-shipped-stage.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const { advanceServiceDelivery } = await import("../../../lib/service-delivery")
  const { data: rows } = await sb.from("service_deliveries").select("id, service_name, stage, stage_order").like("service_name", "QA ITIN shipped-%").order("service_name")
  const by = (n: string) => (rows ?? []).find((r: { service_name: string }) => r.service_name === `QA ITIN shipped-${n}`)
  const cs = by("1"), dr = by("2")
  const stageOf = async (id: string) => (await sb.from("service_deliveries").select("stage, stage_order").eq("id", id).single()).data

  // the client's tracking entry (legacy path) → Shipped
  const r1 = await advanceServiceDelivery({ delivery_id: cs.id, target_stage: "Shipped", actor: "qa:client-mailed", notes: "QA: client entered tracking" })
  const s1 = await stageOf(cs.id)
  check("S1 the client's mailing moves the case to Shipped (stage 4)", r1.success !== false && s1.stage === "Shipped" && s1.stage_order === 4, JSON.stringify(s1))
  // the office receives the package → Documents Received (and the 'verify received' to-do appears now, not when the client shipped)
  const { count: before } = await sb.from("tasks").select("id", { count: "exact", head: true }).eq("delivery_id", cs.id)
  const r2 = await advanceServiceDelivery({ delivery_id: cs.id, target_stage: "Documents Received", actor: "qa:staff-received" })
  const s2 = await stageOf(cs.id)
  const { data: t2 } = await sb.from("tasks").select("task_title, assigned_to, stage_order").eq("delivery_id", cs.id)
  check("S2 the office's button moves Shipped → Documents Received (stage 5) and its to-do is created", r2.success !== false && s2.stage === "Documents Received" && s2.stage_order === 5 && (t2 ?? []).some((t: { task_title: string }) => /Verify signed documents received/.test(t.task_title)), JSON.stringify({ s2, before, tasks: t2 }))
  // a case that already sat at Documents Received BEFORE the migration (stored number moved 4 → 5): the normal 'next' step goes to CAA Review, not nowhere
  const r3 = await advanceServiceDelivery({ delivery_id: dr.id, actor: "qa:next" })
  const s3 = await stageOf(dr.id)
  check("S3 an older case at Documents Received still advances to CAA Review (its stored number moved with the stages)", r3.success !== false && s3.stage === "CAA Review" && s3.stage_order === 6, JSON.stringify(s3))
  // staff can still mark 'received' straight from Client Signing (package arrived with no tracking entered)
  const { data: cs2 } = await sb.from("service_deliveries").insert({ service_name: "QA ITIN shipped-6", service_type: "ITIN", stage: "Client Signing", stage_order: 3, status: "active" }).select("id").single()
  const r4 = await advanceServiceDelivery({ delivery_id: cs2.id, target_stage: "Documents Received", actor: "qa:staff-received-no-tracking" })
  const s4 = await stageOf(cs2.id)
  check("S4 staff can still mark 'Documents Received' straight from Client Signing (no tracking entered)", r4.success !== false && s4.stage === "Documents Received" && s4.stage_order === 5, JSON.stringify(s4))
  // the catalog chain (workflow path + staff 'Mark client has mailed') targets Shipped
  const { data: cat } = await sb.from("catalog_entries").select("metadata").eq("catalog_id", "services").eq("slug", "itin").single()
  check("S5 the workflow chain's client_mailed targets Shipped", cat.metadata?.workflow_chain?.transitions?.itin_await_client_mailing?.client_mailed?.advance_sd_stage === "Shipped")
  // the stage shows what the client and the Calendar need
  const { data: st } = await sb.from("pipeline_stages").select("waiting_on, client_visible, board_visible, client_label, stage_layout").eq("service_type", "ITIN").eq("stage_name", "Shipped").single()
  const kinds = (st.stage_layout?.components ?? []).map((c: { type: string }) => c.type)
  check("S6 Shipped waits on 'outside', is visible to the client and the board, and its workspace has tracking + the office's button", st.waiting_on === "outside" && st.client_visible && st.board_visible && kinds.includes("shipping_info") && kinds.includes("action_buttons"), JSON.stringify({ st: { ...st, stage_layout: undefined }, kinds }))
  // clean up
  await sb.from("service_deliveries").update({ status: "cancelled" }).like("service_name", "QA ITIN shipped-%")
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
