/* eslint-disable no-console, no-restricted-syntax */
/**
 * Phase A1 QA t15 (dev job ad09ea91, master plan Part 33): ONE rule decides which documents of the NEW storage a client may
 * see and open — the documents list, the services page, the search and the download agree. SANDBOX only; needs the dev server
 * (QA_BASE, default :3100) in sandbox mode.
 */
import { config } from "dotenv"
import { call, check, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

// the shared helper wants a detail string; most checks here need none
const chk = (name: string, ok: boolean, detail?: string) => check(name, ok, detail ?? "")

const UXIO = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const staff = await sessionCookie("staff")
  const client = await sessionCookie("clientUx")
  const tag = Date.now()
  const stage = async (name: string) => {
    const p = `crm-uploads/store-staging/qa-${tag}-${name}`
    await sb.storage.from("onboarding-uploads").upload(p, pdf(name), { contentType: "application/pdf" })
    return p
  }
  const { data: live } = await sb.from("store_owners").select("id").eq("account_id", UXIO).eq("study_only", false).maybeSingle()
  const { data: folder } = await sb.from("store_folders").select("id").eq("owner_id", live.id).eq("name", "1. Company").is("trashed_at", null).maybeSingle()
  const up = async (name: string, visible: boolean) => {
    const r = await call("/api/crm-store/browse/upload", { cookie: staff, json: { ownerId: live.id, folderId: folder.id, storagePath: await stage(name), fileName: name, mimeType: "application/pdf", documentType: "other_document", visible } })
    const fileId = (r.json as { fileId?: string } | null)?.fileId
    const { data: row } = await sb.from("documents").select("id").eq("drive_file_id", `store:${fileId}`).maybeSingle()
    return { fileId: fileId as string, docId: row?.id as string, status: r.status }
  }
  const listHtml = async () => (await call(`/portal/documents`, { cookie: `${client}; portal_account_id=${UXIO}` })).text

  // S1 visible, S2 hidden
  const vis = await up(`QA A1 visible ${tag}.pdf`, true)
  const hid = await up(`QA A1 hidden ${tag}.pdf`, false)
  chk("A1-0 fixtures created", !!vis.docId && !!hid.docId, JSON.stringify({ vis, hid }))
  chk("A1-1 a visible stored document opens for the client (regression)", (await call(`/api/portal/documents/${vis.docId}`, { cookie: client })).status === 200)
  chk("A1-2 a hidden stored document does NOT open (404)", (await call(`/api/portal/documents/${hid.docId}`, { cookie: client })).status === 404)

  // S3: hidden flag, but a flow document at a client-safe stage — the list always showed it, the download used to refuse it
  const { data: sd } = await sb.from("service_deliveries").select("id").eq("account_id", UXIO).eq("service_type", "Company Formation").limit(1).maybeSingle()
  if (sd?.id) {
    await sb.from("documents").update({ service_delivery_id: sd.id, flow_stage: "EIN Received", portal_visible: false }).eq("id", hid.docId)
    chk("A1-3 a flow document at a client-safe stage opens even though its flag is off", (await call(`/api/portal/documents/${hid.docId}`, { cookie: client })).status === 200)
    await sb.from("documents").update({ flow_stage: "Tax Return Prepared" }).eq("id", hid.docId)
    chk("A1-4 …and an internal stage stays closed", (await call(`/api/portal/documents/${hid.docId}`, { cookie: client })).status === 404)
    await sb.from("documents").update({ service_delivery_id: null, flow_stage: null }).eq("id", hid.docId)
  } else console.log("  (no Company Formation service delivery on the test company — A1-3/4 skipped)")

  // S5 untyped (closed), S6 personal type filed with the company
  const un = await up(`QA A1 untyped ${tag}.pdf`, true)
  await sb.from("store_files").update({ document_type: null }).eq("id", un.fileId)
  chk("A1-5 a visible but UNTYPED stored document stays closed to the client", (await call(`/api/portal/documents/${un.docId}`, { cookie: client })).status === 404)
  const pers = await up(`QA A1 passport ${tag}.pdf`, true)
  await sb.from("store_files").update({ document_type: "passport" }).eq("id", pers.fileId)
  chk("A1-6 a passport filed under the COMPANY's storage is never served to a client", (await call(`/api/portal/documents/${pers.docId}`, { cookie: client })).status === 404)

  // lists: names
  const html = await listHtml()
  chk("A1-7 the documents list names the visible document", html.includes(`QA A1 visible ${tag}`))
  chk("A1-8 …and does NOT list the hidden, the untyped or the passport", !html.includes(`QA A1 hidden ${tag}`) && !html.includes(`QA A1 untyped ${tag}`) && !html.includes(`QA A1 passport ${tag}`))

  // search
  const s = await call(`/api/portal/search?q=${encodeURIComponent(`QA A1`)}&account_id=${UXIO}`, { cookie: client })
  const names = JSON.stringify(s.json)
  chk("A1-9 search names the visible document, not the hidden / untyped / passport", names.includes(`QA A1 visible ${tag}`) && !names.includes(`QA A1 hidden ${tag}`) && !names.includes(`QA A1 untyped ${tag}`) && !names.includes(`QA A1 passport ${tag}`), names.slice(0, 200))

  // services page related documents
  const { data: anySd } = await sb.from("service_deliveries").select("id").eq("account_id", UXIO).limit(1).maybeSingle()
  if (anySd?.id) {
    const sv = await call(`/api/portal/services/${anySd.id}`, { cookie: client })
    const svNames = JSON.stringify(sv.json)
    chk("A1-10 the services page does not name a hidden / untyped / passport stored document", sv.status === 200 && !svNames.includes(`QA A1 hidden ${tag}`) && !svNames.includes(`QA A1 untyped ${tag}`) && !svNames.includes(`QA A1 passport ${tag}`), `HTTP ${sv.status}`)
  }

  // the client's OWN upload to a company in the new storage: hidden until staff review it (like Drive), typed so it can be shown later
  const form = new FormData()
  form.set("file", new Blob([new Uint8Array(pdf(`own-${tag}`))], { type: "application/pdf" }), `QA A1 client own ${tag}.pdf`)
  form.set("account_id", UXIO); form.set("category", "1"); form.set("doc_type", "Client Upload")
  const own = await call("/api/portal/documents/upload", { cookie: client, form })
  chk("A1-11 the client's own upload is accepted", own.status === 200, `HTTP ${own.status} ${own.text.slice(0, 120)}`)
  const { data: ownRow } = await sb.from("documents").select("id, portal_visible, drive_file_id").eq("account_id", UXIO).ilike("file_name", `QA A1 client own ${tag}%`).maybeSingle()
  const ownFileId = String(ownRow?.drive_file_id ?? "").replace("store:", "")
  const { data: ownFile } = await sb.from("store_files").select("document_type, published").eq("id", ownFileId).maybeSingle()
  chk("A1-12 …saved in the new storage, HIDDEN until staff review (as on a Drive company) and typed", String(ownRow?.drive_file_id).startsWith("store:") && ownRow?.portal_visible === false && ownFile?.document_type === "other_document" && ownFile?.published === false, JSON.stringify({ ownRow, ownFile }))
  chk("A1-13 …the client cannot open it yet", ownRow?.id ? (await call(`/api/portal/documents/${ownRow.id}`, { cookie: client })).status === 404 : false)
  await sb.from("documents").update({ portal_visible: true }).eq("id", ownRow?.id)
  chk("A1-14 …and once staff show it, the client opens it and sees it listed", ownRow?.id ? (await call(`/api/portal/documents/${ownRow.id}`, { cookie: client })).status === 200 && (await listHtml()).includes(`QA A1 client own ${tag}`) : false)

  // clean up what this run made (hide everything; the sandbox test company keeps no leftovers visible)
  for (const x of [vis, hid, un, pers]) await sb.from("documents").update({ portal_visible: false }).eq("id", x.docId)
  if (ownRow?.id) await sb.from("documents").update({ portal_visible: false }).eq("id", ownRow.id)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
