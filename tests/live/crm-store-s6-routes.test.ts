/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ S6R" rows), not business writes */
/**
 * CRM Store slice 6 — LIVE route-level E2E against the SANDBOX (job 685467b5).
 *   npx vitest run --config vitest.crm-store-live.config.ts
 *
 * Calls the REAL route handlers (upload-document → advance → company creation, staff preview, portal
 * download, SS-4 signed, SS-4 fax panel, fax send, delete-document, Go Back) on the real sandbox
 * database and storage. Only the login is stood in for: the session reader returns a test staff member
 * or a test client (no passwords, no network login). Everything else runs as in production code.
 * Also: two wizard-submit runs at the same moment; a formation the WIZARD creates (no case at payment).
 * Fixtures are "ZZ S6R" rows; the pilot setting is restored at the end.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { NextRequest } from "next/server"

// ── the one stand-in: who is logged in ────────────────────────────────────────────────────────
type FakeUser = { id: string; email: string; app_metadata: Record<string, unknown> }
let currentUser: FakeUser | null = null
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) } }),
}))
vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: async () => (currentUser && currentUser.app_metadata.role !== "client" ? null : new Response("forbidden", { status: 403 })),
}))

import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const tag = Date.now()
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"

async function pdf(lines: string[], pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([612, 792])
    lines.forEach((l, j) => p.drawText(`${l} (p${i + 1})`, { x: 50, y: 740 - j * 16, size: 11, font: f }))
  }
  return Buffer.from(await d.save())
}
const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const get = (url: string) => new NextRequest(url, { method: "GET" })
async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(row).select("id").single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data.id as string
}
async function upload(bucket: string, path: string, bytes: Buffer) {
  const { error } = await db.storage.from(bucket).upload(path, bytes, { contentType: "application/pdf", upsert: true })
  if (error) throw new Error(`upload ${bucket}/${path}: ${error.message}`)
}

let staff: FakeUser
let settingBefore: string[] = []
const pilot = { contact: "", sd: "", account: "" }
const twin = { contact: "", sd: "" }

function answers(who: string, email: string, passportPath: string) {
  return {
    owner_first_name: who, owner_last_name: `S6R ${tag}`, owner_email: email, owner_phone: "+1 555 0101",
    owner_dob: "1981-02-03", owner_nationality: "Italy", owner_street: "Via Po 2", owner_city: "Torino",
    owner_state_province: "TO", owner_zip: "10100", owner_country: "Italy", owner_is_signer: true,
    entity_type: "SMLLC", state_of_formation: "WY", member_count: 0, business_purpose: "Consulting",
    llc_name_1: `ZZ S6R ${who} LLC ${tag}`, chosen_name_final: `ZZ S6R ${who} LLC ${tag}`, disclaimer_accepted: true,
    passport_owner: passportPath,
  }
}
async function buyerWithCase(who: string, withCase = true) {
  const contact = await insert("contacts", { first_name: who, last_name: `S6R ${tag}`, full_name: `ZZ ${who} S6R ${tag}`, email: `zz-s6r-${who.toLowerCase()}-${tag}@example.test` })
  const sd = withCase ? await insert("service_deliveries", {
    service_type: "Company Formation", service_name: `Company Formation - ZZ S6R ${who} ${tag}`,
    contact_id: contact, account_id: null, status: "active", stage: "Payment Confirmed", stage_order: 1,
  }) : ""
  const passportPath = `zz-s6r/${tag}/${who.toLowerCase()}/passport_owner.pdf`
  await upload("onboarding-uploads", passportPath, await pdf([`ZZ S6R ${who} passport — not real`]))
  const data = answers(who, `zz-s6r-${who.toLowerCase()}-${tag}@example.test`, passportPath)
  await insert("wizard_progress", { contact_id: contact, wizard_type: "formation", status: "submitted", data, ...(sd ? { service_delivery_id: sd } : {}) })
  return { contact, sd, data }
}
const job = (contactId: string, data: Record<string, unknown>) => ({
  id: randomUUID(), job_type: "formation_setup", status: "processing", attempts: 1, max_attempts: 3,
  payload: { token: `portal-zz-s6r-${tag}`, submission_id: null, contact_id: contactId, lead_id: null, submitted_data: data, source: "portal_wizard" },
})
async function setPilot(ids: string[]) {
  await db.from("app_settings").upsert({ key: "crm_store_pilot", value: { contact_ids: [...settingBefore, ...ids] }, updated_at: new Date().toISOString() })
}
const rows = async (filter: Record<string, unknown>) => ((await db.from("documents").select("id, drive_file_id, file_name, portal_visible, account_id, flow_stage, document_type_name").match(filter)).data ?? []) as Array<Record<string, string | boolean | null>>

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  delete process.env.GOOGLE_DRIVE_LIVE
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 })
  const admin = (list.users as Array<{ id: string; email: string; app_metadata: Record<string, unknown> }>).find((u) => u.app_metadata?.role === "admin")
  if (!admin) throw new Error("no sandbox admin auth user")
  staff = { id: admin.id, email: admin.email, app_metadata: { role: "admin" } }
  const { data: s } = await db.from("app_settings").select("value").eq("key", "crm_store_pilot").maybeSingle()
  settingBefore = ((s?.value as { contact_ids?: string[] } | null)?.contact_ids ?? []).filter((x) => typeof x === "string")
}, 60_000)

afterAll(async () => {
  await db.from("app_settings").upsert({ key: "crm_store_pilot", value: { contact_ids: settingBefore }, updated_at: new Date().toISOString() })
})

describe("wizard submit — the real job", () => {
  it("two runs at the SAME moment → one passport file, one CRM row, one summary", async () => {
    const b = await buyerWithCase("Pilot")
    pilot.contact = b.contact
    pilot.sd = b.sd
    await setPilot([b.contact])
    const t = await buyerWithCase("Twin")
    twin.contact = t.contact
    twin.sd = t.sd
    const { handleFormationSetup } = await import("@/lib/jobs/handlers/formation-setup")
    const [r1, r2] = await Promise.all([handleFormationSetup(job(b.contact, b.data) as never), handleFormationSetup(job(b.contact, b.data) as never)])
    expect(r1.steps.find((s) => s.name === "store_passport")?.status).toBe("ok")
    expect(r2.steps.find((s) => s.name === "store_passport")?.status).toBe("ok")
    const { data: owners } = await db.from("store_owners").select("id").eq("service_delivery_id", b.sd)
    expect(owners).toHaveLength(1)
    const { data: person } = await db.from("store_owners").select("id").eq("contact_id", b.contact)
    expect(person).toHaveLength(1)
    const { data: pf } = await db.from("store_files").select("id").eq("owner_id", person[0].id).eq("document_type", "passport")
    expect(pf).toHaveLength(1)
    expect(await rows({ drive_file_id: `store:${pf[0].id}` })).toHaveLength(1)
    const { data: sf } = await db.from("store_files").select("id").eq("owner_id", owners[0].id).eq("document_type", "formation_summary")
    expect(sf).toHaveLength(1)
    await handleFormationSetup(job(t.contact, t.data) as never) // the twin: today's path
    const { data: tw } = await db.from("store_owners").select("id").eq("service_delivery_id", t.sd)
    expect(tw ?? []).toHaveLength(0)
  }, 120_000)

  it("a formation the WIZARD creates (no case at payment): owner created after; the passport stays on today's path", async () => {
    const c = await buyerWithCase("Wizcase", false)
    await setPilot([pilot.contact, c.contact])
    const { handleFormationSetup } = await import("@/lib/jobs/handlers/formation-setup")
    const r = await handleFormationSetup(job(c.contact, c.data) as never)
    const sdStep = r.steps.find((s) => s.name === "service_delivery")
    expect(sdStep?.status).toBe("ok") // the job created the case
    expect(r.steps.some((s) => s.name === "store_passport")).toBe(false) // passport → today's Drive path (documented split)
    expect(r.steps.find((s) => s.name === "store_formation_summary")?.status).toBe("ok")
    const { data: sd } = await db.from("service_deliveries").select("id").eq("contact_id", c.contact).eq("service_type", "Company Formation").single()
    const { data: o } = await db.from("store_owners").select("kind").eq("service_delivery_id", sd.id).single()
    expect(o.kind).toBe("formation")
  }, 120_000)
})

describe("the workspace routes — real handlers, real database", () => {
  it("Articles upload at 'Filed with State' → saved in the store, company created, handed over, bucket copy removed", async () => {
    currentUser = staff
    await db.from("service_deliveries").update({ stage: "Filed with State", stage_order: 3 }).eq("id", pilot.sd)
    const path = `zz-s6r/${tag}/flow/Articles.pdf`
    await upload("onboarding-uploads", path, await pdf(["ARTICLES OF ORGANIZATION", `ZZ S6R Pilot LLC ${tag}`], 2))
    const { POST } = await import("@/app/api/flows/[id]/upload-document/route")
    const res = await POST(post(`http://localhost/api/flows/${pilot.sd}/upload-document`, {
      storage_path: path, file_name: "Articles.pdf", mime_type: "application/pdf", flow_stage: "Filed with State",
      formation_date: "2026-09-26", entity_type: "SMLLC", formation_state: "WY", folder: "1. Company",
    }), { params: { id: pilot.sd } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.driveFileId).toMatch(/^store:/)
    expect(body.advance?.materialization?.outcome).toMatch(/materialized/)
    pilot.account = body.advance.materialization.account_id
    const { data: owner } = await db.from("store_owners").select("id, kind, account_id").eq("service_delivery_id", pilot.sd).single()
    expect(owner.kind).toBe("company")
    expect(owner.account_id).toBe(pilot.account)
    const { data: gone } = await db.storage.from("onboarding-uploads").exists(path)
    expect(gone).toBe(false)
    const r = await rows({ drive_file_id: body.driveFileId })
    expect(r).toHaveLength(1)
    expect(r[0].account_id).toBe(pilot.account)
    const { data: acct } = await db.from("accounts").select("drive_folder_id").eq("id", pilot.account).single()
    expect(acct.drive_folder_id).toBeNull()
  }, 180_000)

  it("the twin through the SAME route → today's path (bucket pointer, no store)", async () => {
    currentUser = staff
    await db.from("service_deliveries").update({ stage: "Filed with State", stage_order: 3 }).eq("id", twin.sd)
    const path = `zz-s6r/${tag}/flow/twin-Articles.pdf`
    await upload("onboarding-uploads", path, await pdf(["ARTICLES twin"]))
    const { POST } = await import("@/app/api/flows/[id]/upload-document/route")
    const res = await POST(post(`http://localhost/api/flows/${twin.sd}/upload-document`, {
      storage_path: path, file_name: "Articles.pdf", mime_type: "application/pdf", flow_stage: "Filed with State",
      formation_date: "2026-09-26", entity_type: "SMLLC", formation_state: "WY",
    }), { params: { id: twin.sd } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.driveFileId).toBe(`storage:${path}`)
    const { data: o } = await db.from("store_owners").select("id").eq("service_delivery_id", twin.sd)
    expect(o ?? []).toHaveLength(0)
  }, 180_000)

  it("EIN Received: two DIFFERENT letters stay two files; the same name again is a version", async () => {
    currentUser = staff
    await db.from("service_deliveries").update({ stage: "EIN Received", stage_order: 8 }).eq("id", pilot.sd)
    const { POST } = await import("@/app/api/flows/[id]/upload-document/route")
    const send = async (name: string, text: string) => {
      const p = `zz-s6r/${tag}/flow/${randomUUID()}.pdf`
      await upload("onboarding-uploads", p, await pdf([text]))
      return (await POST(post(`http://localhost/api/flows/${pilot.sd}/upload-document`, { storage_path: p, file_name: name, mime_type: "application/pdf", flow_stage: "EIN Received", auto_advance: false }), { params: { id: pilot.sd } })).json()
    }
    const a = await send("CP575.pdf", "CP575")
    const b = await send("147C.pdf", "147C")
    const a2 = await send("CP575.pdf", "CP575 corrected")
    expect(a.driveFileId).not.toBe(b.driveFileId)
    expect(a2.driveFileId).toBe(a.driveFileId)
    const id = String(a.driveFileId).slice("store:".length)
    const { data: v } = await db.from("store_file_versions").select("id").eq("file_id", id)
    expect(v).toHaveLength(2)
  }, 180_000)

  it("staff preview serves the CURRENT store version", async () => {
    currentUser = staff
    const [row] = await rows({ service_delivery_id: pilot.sd, flow_stage: "Filed with State" })
    const { GET } = await import("@/app/api/documents/[id]/preview/route")
    const res = await GET(get(`http://localhost/api/documents/${row.id}/preview`), { params: { id: String(row.id) } })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("pdf")
    const bytes = Buffer.from(await res.arrayBuffer())
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2)
  }, 60_000)

  it("portal download as the CLIENT: summary refused; passport served as today", async () => {
    await db.from("account_contacts").upsert({ account_id: pilot.account, contact_id: pilot.contact, role: "Owner" }, { onConflict: "account_id,contact_id" })
    currentUser = { id: randomUUID(), email: "client@example.test", app_metadata: { role: "client", contact_id: pilot.contact } }
    const { GET } = await import("@/app/api/portal/documents/[id]/route")
    const { data: summaryRow } = await db.from("documents").select("id").eq("service_delivery_id", pilot.sd).eq("document_type_name", "Formation Summary").single()
    const r1 = await GET(get(`http://localhost/api/portal/documents/${summaryRow.id}`), { params: { id: summaryRow.id } })
    expect(r1.status).toBe(404)
    const { data: passRow } = await db.from("documents").select("id").eq("contact_id", pilot.contact).eq("document_type_name", "Passport").like("drive_file_id", "store:%").single()
    const r2 = await GET(get(`http://localhost/api/portal/documents/${passRow.id}`), { params: { id: passRow.id } })
    expect(r2.status).toBe(200)
  }, 60_000)

  it("SS-4 signed (the real route) → signed SS-4 + IRS package in the store; package = SS-4 page 1 + Articles", async () => {
    currentUser = null
    const token = `zz-s6r-ss4-${tag}`
    const ss4Id = await insert("ss4_applications", {
      token, company_name: `ZZ S6R Pilot LLC ${tag}`, state_of_formation: "WY", responsible_party_name: "Pilot S6R",
      account_id: pilot.account, contact_id: pilot.contact, status: "signed", entity_type: "SMLLC",
    })
    await upload("signed-ss4", `${token}/signed.pdf`, await pdf(["FORM SS-4 signed — ZZ"], 2))
    const { POST } = await import("@/app/api/ss4-signed/route")
    const res = await POST(post("http://localhost/api/ss4-signed", { ss4_id: ss4Id, token }))
    const body = await res.json()
    const steps = (body.results ?? body.steps ?? []) as Array<{ step: string; status: string; detail?: string }>
    expect(steps.find((s) => s.step === "signed_doc_store")?.status, JSON.stringify(steps)).toBe("ok")
    const pkg = steps.find((s) => s.step === "irs_package")
    expect(pkg?.detail, JSON.stringify(steps)).toMatch(/saved in the CRM Store.*3 pages/)
    const { data: pkgRow } = await db.from("documents").select("id, drive_file_id, portal_visible").eq("service_delivery_id", pilot.sd).eq("document_type_name", "SS-4 + Articles (IRS Package)").single()
    expect(pkgRow.drive_file_id).toMatch(/^store:/)
    expect(pkgRow.portal_visible).toBe(false)
    const { data: dup } = await db.from("documents").select("id").eq("service_delivery_id", pilot.sd).eq("document_type_name", "Form SS-4 (Signed)")
    expect(dup).toHaveLength(1) // no second (storage:) row next to the store one
  }, 180_000)

  it("SS-4 fax panel: the store package is faxable; pressing Send is refused outside production", async () => {
    currentUser = staff
    const { GET } = await import("@/app/api/flows/[id]/ss4-fax/route")
    const r = await (await GET(get(`http://localhost/api/flows/${pilot.sd}/ss4-fax`), { params: { id: pilot.sd } })).json()
    expect(r.package?.faxable).toBe(true)
    process.env.FAXAGE_USERNAME ||= "zz"; process.env.FAXAGE_PASSWORD ||= "zz"; process.env.FAXAGE_COMPANY ||= "zz"
    const { POST } = await import("@/app/api/tools/fax/send/route")
    const res = await POST(post("http://localhost/api/tools/fax/send", { document_id: r.package.document_id, faxno: "8552151627", account_id: pilot.account, service_delivery_id: pilot.sd, reason: "ZZ S6R route proof", confirm: true }))
    const body = await res.json()
    expect(res.status).not.toBe(200)
    // the file was read from the store and the send reached the hard block (not an earlier refusal)
    expect(JSON.stringify(body)).toMatch(/blocked outside production/i)
  }, 60_000)

  it("delete from the contact page is refused for a store file", async () => {
    currentUser = staff
    const [row] = await rows({ service_delivery_id: pilot.sd, flow_stage: "Filed with State" })
    const { POST } = await import("@/app/api/crm/admin-actions/delete-document/route")
    const res = await POST(post("http://localhost/api/crm/admin-actions/delete-document", { document_id: row.id }))
    expect(res.status).toBe(409)
    expect(await rows({ id: row.id })).toHaveLength(1)
  }, 60_000)

  it("Go Back (the real route) → the stage's store file goes to the store trash with the staff member; row removed", async () => {
    currentUser = staff
    const g = await buyerWithCase("Goback")
    await setPilot([pilot.contact, g.contact])
    const { handleFormationSetup } = await import("@/lib/jobs/handlers/formation-setup")
    await handleFormationSetup(job(g.contact, g.data) as never)
    await db.from("service_deliveries").update({ stage: "Filed with State", stage_order: 3 }).eq("id", g.sd)
    const path = `zz-s6r/${tag}/flow/goback.pdf`
    await upload("onboarding-uploads", path, await pdf(["ARTICLES wrong file"]))
    const { POST: UP } = await import("@/app/api/flows/[id]/upload-document/route")
    const up = await (await UP(post(`http://localhost/api/flows/${g.sd}/upload-document`, { storage_path: path, file_name: "Wrong.pdf", mime_type: "application/pdf", flow_stage: "Filed with State", auto_advance: false }), { params: { id: g.sd } })).json()
    expect(up.driveFileId).toMatch(/^store:/)
    await db.from("service_deliveries").update({ stage: "Articles Received", stage_order: 4 }).eq("id", g.sd)
    const { POST } = await import("@/app/api/flows/[id]/revert/route")
    const res = await POST(post(`http://localhost/api/flows/${g.sd}/revert`, {}), { params: { id: g.sd } })
    expect(res.status).toBe(200)
    const fileId = String(up.driveFileId).slice("store:".length)
    const { data: f } = await db.from("store_files").select("state, trashed_by").eq("id", fileId).single()
    expect(f.state).toBe("trashed")
    expect(f.trashed_by).toBe(staff.id)
    expect(await rows({ drive_file_id: up.driveFileId })).toHaveLength(0)

    // …and the corrected file re-uploaded under the SAME name is kept (a new file; the old stays in the trash)
    const path2 = `zz-s6r/${tag}/flow/goback-2.pdf`
    const corrected = await pdf(["ARTICLES corrected"])
    await upload("onboarding-uploads", path2, corrected)
    const up2 = await (await UP(post(`http://localhost/api/flows/${g.sd}/upload-document`, { storage_path: path2, file_name: "Wrong.pdf", mime_type: "application/pdf", flow_stage: "Filed with State", auto_advance: false }), { params: { id: g.sd } })).json()
    expect(up2.driveFileId).toMatch(/^store:/)
    expect(up2.driveFileId).not.toBe(up.driveFileId)
    const { readStoreFile } = await import("@/lib/crm-store/document-pointer")
    const got = await readStoreFile(String(up2.driveFileId).slice("store:".length))
    expect(got.bytes.equals(corrected)).toBe(true)
    // a third same-name upload is a VERSION of that new file
    const path3 = `zz-s6r/${tag}/flow/goback-3.pdf`
    await upload("onboarding-uploads", path3, await pdf(["ARTICLES corrected again"]))
    const up3 = await (await UP(post(`http://localhost/api/flows/${g.sd}/upload-document`, { storage_path: path3, file_name: "Wrong.pdf", mime_type: "application/pdf", flow_stage: "Filed with State", auto_advance: false }), { params: { id: g.sd } })).json()
    expect(up3.driveFileId).toBe(up2.driveFileId)
  }, 180_000)

  it("the Formation Summary cannot be emailed or faxed", async () => {
    currentUser = staff
    const { data: summaryRow } = await db.from("documents").select("id, drive_file_id, file_name").eq("service_delivery_id", pilot.sd).eq("document_type_name", "Formation Summary").single()
    const { POST } = await import("@/app/api/tools/fax/send/route")
    const res = await POST(post("http://localhost/api/tools/fax/send", { document_id: summaryRow.id, faxno: "8552151627", reason: "ZZ", confirm: true }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toMatch(/staff-only/)
  }, 60_000)
})
