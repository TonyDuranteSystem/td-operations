/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * Phase 3 QA t10: the ITIN completion webhook (person-keyed) for a person of a switched company, a DBA document upload,
 * and the staff "show to client" rules for storage files. SANDBOX only. Needs the dev server on :3100.
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { call, check, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const staff = await sessionCookie("staff")
  const clientUx = await sessionCookie("clientUx")

  // ── ITIN completion webhook ────────────────────────────────────────────────────────────────────────────────
  const token = `qa-itin-${randomBytes(5).toString("hex")}`
  const submitted = { first_name: "QA", last_name: "Cutover", dob: "1990-01-01", gender: "Male", citizenship: "Italy", country_of_birth: "Italy", city_of_birth: "Rome", foreign_street: "Via QA 1", foreign_city: "Rome", foreign_zip: "00100", foreign_country: "Italy", passport_number: "QA123", passport_country: "Italy", passport_expiry: "2030-01-01", email: "qa-test@example.test" }
  const ins = await sb.from("itin_submissions").insert({ token, account_id: UX, contact_id: UX_CONTACT, status: "completed", submitted_data: submitted, upload_paths: [], language: "en", access_code: "123456", completed_at: new Date().toISOString() }).select("id").single()
  if (ins.error) console.log("      fixture itin insert failed:", ins.error.message)
  else {
    const r = await call("/api/itin-form-completed", { json: { submission_id: ins.data.id, token } })
    const steps = ((r.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? [])
    console.log(`      (info) steps: ${steps.map((s) => `${s.step}:${s.status}`).join(", ")}`)
    check("T1 ITIN completion accepted", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 160)}`)
    const save = steps.find((s) => s.step === "drive_save")
    check("T2 the data summary was saved (no error step)", save?.status === "ok", JSON.stringify(save))
    const gen = steps.find((s) => s.step === "docs_generated")
    check("T3 W-7 + 1040-NR + Schedule OI saved in the new storage", gen?.status === "ok" && /new storage/.test(gen?.detail ?? ""), JSON.stringify(gen))
    const { data: docs } = await sb.from("documents").select("id, drive_file_id, portal_visible, document_type_name, account_id, contact_id").eq("contact_id", UX_CONTACT).gt("created_at", t0)
    const itinDocs = (docs ?? []).filter((d: { document_type_name: string }) => /ITIN/.test(d.document_type_name))
    check("T4 three ITIN rows, all storage pointers, shown to the client as before", itinDocs.length === 3 && itinDocs.every((d: { drive_file_id: string; portal_visible: boolean }) => d.drive_file_id.startsWith("store:") && d.portal_visible === true), JSON.stringify(itinDocs))
    if (itinDocs[0]) check("T5 the client opens an ITIN document", (await call(`/api/portal/documents/${itinDocs[0].id}`, { cookie: clientUx })).status === 200, "")
    const { data: arch } = await sb.from("itin_submissions").select("drive_archived_at").eq("id", ins.data.id).single()
    console.log(`      (info) archive marker after the inline save: ${arch?.drive_archived_at ?? "not set yet (the durable job sets it)"}`)
  }

  // ── DBA document ───────────────────────────────────────────────────────────────────────────────────────────
  const { data: dbaSd } = await sb.from("service_deliveries").select("id").eq("account_id", UX).limit(1).maybeSingle()
  if (dbaSd) {
    const dba = await sb.from("dba_details").insert({ delivery_id: dbaSd.id, dba_name: "QA Test DBA", jurisdiction: "FL" }).select("id").single()
    if (dba.error) console.log("      fixture dba insert failed:", dba.error.message)
    else {
      const path = `qa-cutover/${Date.now()}-QA Test dba.pdf`
      await sb.storage.from("onboarding-uploads").upload(path, pdf("dba"), { contentType: "application/pdf", upsert: true })
      const r = await call(`/api/accounts/${UX}/dba/${dba.data.id}/upload-document`, { cookie: staff, json: { storage_path: path, file_name: "QA Test dba.pdf", mime_type: "application/pdf" } })
      check("D1 DBA document upload accepted", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 160)}`)
      const { data: drows } = await sb.from("documents").select("id, drive_file_id, portal_visible").eq("account_id", UX).eq("document_type_name", "DBA Application").gt("created_at", t0)
      check("D2 one row, a storage pointer, shown to the client", (drows ?? []).length === 1 && drows[0].drive_file_id.startsWith("store:") && drows[0].portal_visible === true, JSON.stringify(drows))
      if (drows?.[0]) check("D3 the client opens it", (await call(`/api/portal/documents/${drows[0].id}`, { cookie: clientUx })).status === 200, "")
    }
  }

  // ── staff "show to client" on storage files ────────────────────────────────────────────────────────────────
  const { saveDocumentForAccount } = await import("../../../lib/crm-store/save-for-account")
  const { updateDocument } = await import("../../../lib/operations/document")
  const mk = async (name: string, type: string | null) => {
    const r = await saveDocumentForAccount({ accountId: UX, name, bytes: Buffer.from(`${name} ${Date.now()}`), mimeType: "text/plain", folder: "correspondence", documentType: type, callerKey: `qa-t10-${name}-${Date.now()}`, portalVisible: false })
    if (r.route !== "store") throw new Error("expected a storage save")
    return r
  }
  const untyped = await mk("QA Test untyped share.txt", null)
  const refused = await updateDocument({ id: untyped.documentRowId, patch: { portal_visible: true }, clientAlert: false })
  check("S1 sharing an UNTYPED storage file is refused with a plain 'choose its type' message (no client 404 trap)", refused.success === false && /type/i.test(refused.error ?? ""), JSON.stringify(refused))
  const typed = await mk("QA Test typed share.txt", "other_document")
  const ok = await updateDocument({ id: typed.documentRowId, patch: { portal_visible: true }, clientAlert: false })
  check("S2 sharing a TYPED storage file works", ok.success === true, JSON.stringify(ok))
  const opened = await call(`/api/portal/documents/${typed.documentRowId}`, { cookie: clientUx })
  check("S3 …and the client then opens it", opened.status === 200, `HTTP ${opened.status}`)
  const hide = await updateDocument({ id: typed.documentRowId, patch: { portal_visible: false }, clientAlert: false })
  const closed = await call(`/api/portal/documents/${typed.documentRowId}`, { cookie: clientUx })
  check("S4 hiding it again closes it for the client at once", hide.success === true && closed.status === 404, `hide=${hide.success} HTTP ${closed.status}`)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
