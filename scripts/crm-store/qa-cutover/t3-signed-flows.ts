/* eslint-disable no-console */
/**
 * Phase 3 QA t3 (bug-hunter rows 1, 3, 10, 11, 12, 14 + F idempotency): the signed-document webhooks for the fixture company
 * (switched). Each fixture row is created here with QA Test names (SANDBOX only). Run: npx tsx scripts/crm-store/qa-cutover/t3-signed-flows.ts
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { call, check, pdf, realPdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const tok = () => `qa-${randomBytes(6).toString("hex")}`

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const clientUx = await sessionCookie("clientUx")

  const rowsOf = async (account: string) => (await sb.from("documents").select("id, drive_file_id, portal_visible, document_type_name, service_delivery_id").eq("account_id", account).gt("created_at", t0)).data as Array<{ id: string; drive_file_id: string; portal_visible: boolean; document_type_name: string; service_delivery_id: string | null }>

  // ── row 1 + 3: SS-4 signed (internal) and the IRS package ────────────────────────────────────────────────
  // The Articles the IRS package merges: saved to the storage through the real staff upload (a real, parseable PDF).
  const staff = await sessionCookie("staff")
  const artPath = `qa-cutover/${Date.now()}-QA Test Articles.pdf`
  await sb.storage.from("onboarding-uploads").upload(artPath, await realPdf("articles"), { contentType: "application/pdf", upsert: true })
  const art = await call("/api/crm/admin-actions/upload-account-document", { cookie: staff, json: { account_id: UX, storage_path: artPath, file_name: "QA Test Articles.pdf", mime_type: "application/pdf", document_type: "Articles of Organization", category: "Company" } })
  check("0 Articles saved to the storage for the IRS package", art.status === 200 && String((art.json as { driveFileId?: string } | null)?.driveFileId).startsWith("store:"), `HTTP ${art.status} ${art.text.slice(0, 120)}`)
  const ss4Token = tok()
  const ss4Ins = await sb.from("ss4_applications").insert({ token: ss4Token, access_code: "123456", company_name: "QA Test Cutover LLC", account_id: UX, contact_id: UX_CONTACT, entity_type: "SMLLC", responsible_party_name: "QA Test", status: "signed", state_of_formation: "Florida" }).select("id").single()
  if (ss4Ins.error) { console.log("      fixture ss4 insert failed:", ss4Ins.error.message); return }
  const ss4Id = ss4Ins.data.id as string
  await sb.storage.from("signed-ss4").upload(`${ss4Token}/signed.pdf`, await realPdf("signed ss4"), { contentType: "application/pdf", upsert: true })
  const r1 = await call("/api/ss4-signed", { json: { ss4_id: ss4Id, token: ss4Token } })
  const steps = ((r1.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? [])
  check("1a SS-4 webhook accepted", r1.status === 200, `HTTP ${r1.status} ${r1.text.slice(0, 120)}`)
  const upload = steps.find((s) => s.step === "drive_upload")
  check("1b the signed SS-4 was saved to the new storage (not Drive)", upload?.status === "ok" && /new storage/.test(upload?.detail ?? ""), JSON.stringify(upload))
  const { data: ss4Row } = await sb.from("ss4_applications").select("pdf_signed_drive_id").eq("id", ss4Id).single()
  check("1c pdf_signed_drive_id is a pointer", String(ss4Row?.pdf_signed_drive_id).startsWith("store:"), `pdf_signed_drive_id=${ss4Row?.pdf_signed_drive_id}`)
  let docs = await rowsOf(UX)
  const ss4Doc = docs.find((d) => d.document_type_name === "Form SS-4 (Signed)")
  check("1d the CRM row is INTERNAL (never shown to the client)", !!ss4Doc && ss4Doc.portal_visible === false && ss4Doc.drive_file_id.startsWith("store:"), JSON.stringify(ss4Doc))
  if (ss4Doc) {
    const byId = await call(`/api/portal/documents/${ss4Doc.id}`, { cookie: clientUx })
    check("1e the client gets 404 for the signed SS-4 by id", byId.status === 404, `HTTP ${byId.status}`)
  }
  console.log(`      (info) SS-4 steps: ${steps.map((s) => `${s.step}:${s.status}`).join(", ")}`)
  const pkg = steps.find((s) => s.step === "irs_package")
  console.log(`      (info) IRS package: ${JSON.stringify(pkg)}`)
  check("3a the IRS package was built and saved to the new storage", pkg?.status === "ok" && /new storage/.test(pkg?.detail ?? ""), JSON.stringify(pkg))
  docs = await rowsOf(UX)
  const pk = docs.find((d) => d.document_type_name === "SS-4 + Articles (IRS Package)")
  check("3b the IRS package row is internal and points into the storage", !!pk && pk.portal_visible === false && pk.drive_file_id.startsWith("store:"), JSON.stringify(pk))
  if (pk) {
    const byId = await call(`/api/portal/documents/${pk.id}`, { cookie: clientUx })
    check("3c the client gets 404 for the IRS package", byId.status === 404, `HTTP ${byId.status}`)
  }
  // retry the webhook: a new version of the same file, never a second row
  const before = (await rowsOf(UX)).filter((d) => /SS-4/.test(d.document_type_name)).length
  await call("/api/ss4-signed", { json: { ss4_id: ss4Id, token: ss4Token } })
  const after = (await rowsOf(UX)).filter((d) => /SS-4/.test(d.document_type_name)).length
  check("F webhook retry creates no second SS-4 row", after === before, `rows ${before} → ${after}`)

  // ── row 10: lease signed ──────────────────────────────────────────────────────────────────────────────────
  const leaseToken = tok()
  const leaseIns = await sb.from("lease_agreements").insert({ token: leaseToken, access_code: "123456", account_id: UX, tenant_company: "Uxio Test LLC", tenant_contact_name: "QA Test", tenant_email: "qa-test@example.test", effective_date: "2026-10-12", term_start_date: "2026-10-12", term_end_date: "2027-10-11", term_months: 12, contract_year: 2026, monthly_rent: 100, suite_number: "3D-499", status: "signed", pdf_storage_path: `${leaseToken}/lease-signed.pdf`, premises_address: "QA Test address" }).select("id").single()
  if (leaseIns.error) {
    console.log("      fixture lease insert failed:", leaseIns.error.message)
  } else {
    await sb.storage.from("signed-leases").upload(`${leaseToken}/lease-signed.pdf`, pdf("signed lease"), { contentType: "application/pdf", upsert: true })
    const r = await call("/api/lease-signed", { json: { lease_id: leaseIns.data.id, token: leaseToken, code: "123456" } })
    const rs = ((r.json as { results?: Array<{ step: string; status: string; detail?: string }> } | null)?.results ?? [])
    const up = rs.find((s) => s.step === "drive_upload")
    check("10a lease webhook: the signed lease went to the new storage", r.status === 200 && up?.status === "ok" && /new storage/.test(up?.detail ?? ""), `HTTP ${r.status} ${JSON.stringify(up)}`)
    const leaseDoc = (await rowsOf(UX)).find((d) => d.document_type_name === "Lease Agreement")
    check("10b lease row: pointer, visible to the client", !!leaseDoc && leaseDoc.drive_file_id.startsWith("store:") && leaseDoc.portal_visible === true, JSON.stringify(leaseDoc))
    if (leaseDoc) {
      const o = await call(`/api/portal/documents/${leaseDoc.id}`, { cookie: clientUx })
      check("10c the client opens the signed lease", o.status === 200 && o.bytes.length > 10, `HTTP ${o.status}`)
    }
    const b = (await rowsOf(UX)).filter((d) => d.document_type_name === "Lease Agreement").length
    await call("/api/lease-signed", { json: { lease_id: leaseIns.data.id, token: leaseToken, code: "123456" } })
    const a = (await rowsOf(UX)).filter((d) => d.document_type_name === "Lease Agreement").length
    check("F lease webhook retry: still one row", a === b, `rows ${b} → ${a}`)
  }

  // ── Q3: nothing of this run points at a Drive id ─────────────────────────────────────────────────────────
  const stray = (await rowsOf(UX)).filter((d) => !d.drive_file_id.startsWith("store:"))
  check("Q3 no document of this run points at a Drive id", stray.length === 0, JSON.stringify(stray))
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
