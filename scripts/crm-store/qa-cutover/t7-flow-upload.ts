/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * Phase 3 QA t7 (bug-hunter finding 1): a workspace flow-stage upload (/api/flows/[id]/upload-document) for a switched company
 * lands in the new storage, internal, stamped with the flow; the Drive company keeps the old path; a moving company refuses.
 */
import { config } from "dotenv"
import { call, check, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const staff = await sessionCookie("staff")
  const clientUx = await sessionCookie("clientUx")
  const t0 = new Date().toISOString()

  const { data: acct } = await sb.from("accounts").select("id").eq("company_name", "Test Company LLC").limit(1).maybeSingle()
  const mkSd = async (accountId: string) => {
    const { data: sd } = await sb.from("service_deliveries").select("id, stage").eq("account_id", accountId).eq("service_type", "Tax Return").eq("status", "active").limit(1).maybeSingle()
    if (sd) return sd as { id: string; stage: string }
    const ins = await sb.from("service_deliveries").insert({ account_id: accountId, service_type: "Tax Return", service_name: "QA Test cutover flow", stage: "Intake", status: "active", pipeline: "Tax Return" }).select("id, stage").single()
    if (ins.error) throw new Error(`fixture SD: ${ins.error.message}`)
    return ins.data as { id: string; stage: string }
  }
  const stage = async (name: string) => { const p = `qa-cutover/${Date.now()}-${name}`; await sb.storage.from("onboarding-uploads").upload(p, pdf(name), { contentType: "application/pdf", upsert: true }); return p }

  const sdUx = await mkSd(UX)
  const r = await call(`/api/flows/${sdUx.id}/upload-document`, { cookie: staff, json: { storage_path: await stage("QA Test flow doc.pdf"), file_name: "QA Test flow doc.pdf", mime_type: "application/pdf", flow_stage: sdUx.stage, folder: "1. Company", auto_advance: false } })
  check("FL1 flow upload accepted for a switched company", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`)
  const { data: docs } = await sb.from("documents").select("id, drive_file_id, portal_visible, service_delivery_id, flow_stage").eq("account_id", UX).gt("created_at", t0)
  const doc = (docs ?? []).find((d: { service_delivery_id: string }) => d.service_delivery_id === sdUx.id)
  check("FL2 the row points into the storage, internal, stamped with the flow", !!doc && doc.drive_file_id.startsWith("store:") && doc.portal_visible === false && !!doc.flow_stage, JSON.stringify(doc))
  if (doc) {
    const o = await call(`/api/portal/documents/${doc.id}`, { cookie: clientUx })
    check("FL3 the client gets 404 for it", o.status === 404, `HTTP ${o.status}`)
  }
  const again = await call(`/api/flows/${sdUx.id}/upload-document`, { cookie: staff, json: { storage_path: await stage("QA Test flow doc.pdf"), file_name: "QA Test flow doc.pdf", mime_type: "application/pdf", flow_stage: sdUx.stage, folder: "1. Company", auto_advance: false } })
  const { data: docs2 } = await sb.from("documents").select("id, drive_file_id").eq("account_id", UX).eq("service_delivery_id", sdUx.id).gt("created_at", t0)
  check("FL4 the same upload again is a new version of the same file (one row)", again.status === 200 && (docs2 ?? []).length === 1, `HTTP ${again.status} rows=${(docs2 ?? []).length}`)

  // Drive company: unchanged path (sandbox keeps the file as a storage: bucket pointer, as before)
  const sdTc = await mkSd(acct.id)
  const t = await call(`/api/flows/${sdTc.id}/upload-document`, { cookie: staff, json: { storage_path: await stage("QA Test flow drive.pdf"), file_name: "QA Test flow drive.pdf", mime_type: "application/pdf", flow_stage: sdTc.stage, auto_advance: false } })
  const { data: tdoc } = await sb.from("documents").select("drive_file_id").eq("account_id", acct.id).eq("service_delivery_id", sdTc.id).gt("created_at", t0).limit(1).maybeSingle()
  check("FL5 a Drive company's flow upload is unchanged (no storage pointer)", t.status === 200 && !!tdoc && !tdoc.drive_file_id.startsWith("store:"), `HTTP ${t.status} ${JSON.stringify(tdoc)}`)

  // moving: refused with the plain message
  const run = await sb.from("store_import_runs").insert({ account_id: acct.id, mode: "move", status: "moving" }).select("id").single()
  const m = await call(`/api/flows/${sdTc.id}/upload-document`, { cookie: staff, json: { storage_path: await stage("QA Test flow moving.pdf"), file_name: "QA Test flow moving.pdf", mime_type: "application/pdf", flow_stage: sdTc.stage, auto_advance: false } })
  check("FL6 a moving company refuses (409, plain message)", m.status === 409, `HTTP ${m.status} ${m.text.slice(0, 160)}`)
  if (run.data) await sb.from("store_import_runs").delete().eq("id", run.data.id)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
