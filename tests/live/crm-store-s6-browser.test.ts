/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ S6B" rows), not business writes */
/**
 * CRM Store slice 6 — LIVE test of the in-CRM storage screens against the SANDBOX (job 685467b5).
 *   npx vitest run --config vitest.crm-store-live.config.ts
 *
 * Calls the REAL route handlers (owner-for-account, folder, file, upload, visibility) and the real
 * library on the real sandbox database + storage. Only the login is stood in for. Fixtures: a fresh
 * "ZZ S6B" company with two people, each with their own storage.
 */
import { describe, it, expect, beforeAll, vi } from "vitest"
import { NextRequest } from "next/server"
import { PDFDocument, StandardFonts } from "pdf-lib"

type FakeUser = { id: string; email: string; app_metadata: Record<string, unknown> }
let currentUser: FakeUser | null = null
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) } }),
}))

import { supabaseAdmin } from "@/lib/supabase-admin"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const tag = Date.now()
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"

async function pdf(text: string): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  d.addPage([612, 792]).drawText(text, { x: 50, y: 740, size: 11, font: f })
  return Buffer.from(await d.save())
}
const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const get = (url: string) => new NextRequest(url, { method: "GET" })
async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(row).select("id").single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data.id as string
}
async function stage(name: string, bytes: Buffer, type = "application/pdf") {
  const path = `crm-uploads/store-staging/zz-s6b-${tag}/${Math.random().toString(36).slice(2)}_${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`
  const { error } = await db.storage.from("onboarding-uploads").upload(path, bytes, { contentType: type, upsert: true })
  if (error) throw new Error(`stage: ${error.message}`)
  return path
}

/** a person's "Personal documents" as a company's "2. Contacts" shows it */
async function personalViaCompany(personOwner: string) {
  const { folderContents } = await import("@/lib/crm-store/browse")
  const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
  return folderContents(personOwner, await folderOfKind(personOwner, "personal"), { throughCompany: true })
}

const fx = { account: "", owner: "", company1: "", contactsFolder: "", personA: "", personB: "", ownerA: "", ownerB: "", passportA: "" }

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  // page through ALL auth users — the sandbox has more than one page, and the admin is not always on page 1
  const allUsers: Array<{ id: string; email: string; app_metadata: Record<string, unknown> }> = []
  for (let page = 1; page <= 50; page++) {
    const { data: pg } = await db.auth.admin.listUsers({ page, perPage: 200 })
    const batch = (pg?.users ?? []) as typeof allUsers
    allUsers.push(...batch)
    if (batch.length < 200) break
  }
  const list = { users: allUsers }
  const admin = (list.users as FakeUser[]).find((u) => u.app_metadata?.role === "admin")
  if (!admin) throw new Error("no sandbox admin auth user")
  currentUser = { id: admin.id, email: admin.email, app_metadata: { role: "admin" } }

  fx.account = await insert("accounts", { company_name: `ZZ S6B Browser LLC ${tag}`, status: "Active", state_of_formation: "WY" })
  const { data: owner, error: oErr } = await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: fx.account })
  if (oErr) throw new Error(oErr.message)
  fx.owner = owner
  const { error: tErr } = await db.rpc("store_apply_template", { p_owner_id: owner, p_template_slug: "company_standard", p_root_name: `ZZ S6B Browser LLC ${tag}` })
  if (tErr) throw new Error(tErr.message)
  const { folderOfKind, ensurePersonOwner, pilotSavePassport } = await import("@/lib/crm-store/formation-pilot")
  fx.company1 = await folderOfKind(owner, "company")
  fx.contactsFolder = await folderOfKind(owner, "contacts")
  for (const who of ["A", "B"] as const) {
    const c = await insert("contacts", { first_name: `Zz${who}`, last_name: `S6B ${tag}`, full_name: `ZZ ${who} S6B ${tag}`, email: `zz-s6b-${who.toLowerCase()}-${tag}@example.test` })
    { const { error } = await db.from("account_contacts").insert({ account_id: fx.account, contact_id: c }); if (error) throw new Error(error.message) }
    if (who === "A") fx.personA = c; else fx.personB = c
  }
  fx.ownerA = await ensurePersonOwner(fx.personA, `ZZ A S6B ${tag}`)
  fx.ownerB = await ensurePersonOwner(fx.personB, `ZZ B S6B ${tag}`)
  // member A's passport, saved exactly as the Formation pilot saves a member passport (row visible)
  const saved = await pilotSavePassport({
    contactId: fx.personA, personName: `ZZ A S6B ${tag}`, fileName: "passport_A.pdf", bytes: await pdf("ZZ A passport — not real"),
    mimeType: "application/pdf", companyAccountId: fx.account,
    row: { document_type_name: "Passport", category: 2, category_name: "Contacts", contact_id: fx.personA, account_id: fx.account, portal_visible: true },
  })
  if (saved.status !== "saved") throw new Error("passport not saved")
  fx.passportA = saved.fileId!
}, 120_000)

describe("new storage screens — live sandbox", () => {
  it("a new passport's storage flag matches its CRM row (both 'client can see')", async () => {
    const { data } = await db.from("store_files").select("published").eq("id", fx.passportA).single()
    expect(data.published).toBe(true)
  })

  it("company page: owner-for-account names the owner and the files its view shows (people's included)", async () => {
    const { GET } = await import("@/app/api/crm-store/browse/owner-for-account/route")
    const r = await GET(get(`http://x/api/crm-store/browse/owner-for-account?account=${fx.account}`))
    const j = await r.json()
    expect(j.ownerId).toBe(fx.owner)
    expect(j.shownFileIds).toContain(fx.passportA)
  })

  it("'2. Contacts' of the company: one branch per person (their own storage); A's branch shows the passport, named, with the badge the client really has", async () => {
    const { folderContents } = await import("@/lib/crm-store/browse")
    const c = await folderContents(fx.owner, fx.contactsFolder)
    expect(c.files).toEqual([]) // never copied into the company
    const a = c.people?.find((x) => x.contactId === fx.personA)
    expect(a?.ownerId).toBe(fx.ownerA)
    expect(a?.companies).toContain(`ZZ S6B Browser LLC ${tag}`)
    const p = (await personalViaCompany(fx.ownerA)).files.find((f) => f.id === fx.passportA)
    expect(p).toBeTruthy()
    expect(p!.personName).toBe(`ZZ A S6B ${tag}`)
    expect(p!.clientVisible).toBe(true)
    expect(p!.listed).toBe(true)
  })

  it("through a company, a person's ITIN and Tax folders are NOT shown (catalog), and opening one directly is refused", async () => {
    const { folderContents } = await import("@/lib/crm-store/browse")
    const rootVia = await folderContents(fx.ownerA, null, { throughCompany: true })
    expect(rootVia.folders.map((f) => f.kind).sort()).toEqual(["personal"])
    const own = await folderContents(fx.ownerA, null)
    expect(own.folders.map((f) => f.kind).sort()).toEqual(["itin", "person_tax", "personal"])
    const itin = own.folders.find((f) => f.kind === "itin")!
    await expect(folderContents(fx.ownerA, itin.id, { throughCompany: true })).rejects.toThrow(/person's own page/)
  })

  let uploadedId = ""
  it("upload → created, listed hidden, category Company; same name again → a NEW VERSION of the same file", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/upload/route")
    const s1 = await stage("Bank Letter.pdf", await pdf("v1"))
    const r1 = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s1, fileName: "Bank Letter.pdf", mimeType: "application/pdf", documentType: "articles_of_organization", visible: false }))
    const j1 = await r1.json()
    expect(r1.status).toBe(200)
    expect(j1.write).toBe("created")
    uploadedId = j1.fileId
    const { data: row } = await db.from("documents").select("portal_visible, category, account_id").eq("drive_file_id", `store:${uploadedId}`).single()
    expect(row).toMatchObject({ portal_visible: false, category: 1, account_id: fx.account })
    const { data: f } = await db.from("store_files").select("published").eq("id", uploadedId).single()
    expect(f.published).toBe(false)
    const s2 = await stage("Bank Letter.pdf", await pdf("v2"))
    const r2 = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s2, fileName: "Bank Letter.pdf", mimeType: "application/pdf", documentType: "articles_of_organization", visible: false }))
    const j2 = await r2.json()
    expect(j2.write).toBe("versioned")
    expect(j2.fileId).toBe(uploadedId)
  })

  it("same name as a file another flow saved (different key) → a new version of THAT file, not a '(2)' copy", async () => {
    const { savePilotFile } = await import("@/lib/crm-store/formation-pilot")
    const w = await savePilotFile({ ownerId: fx.owner, folderKind: "company", name: "Articles of Organization.pdf", bytes: await pdf("pilot"), mimeType: "application/pdf", documentType: "articles_of_organization", callerKey: `formation-upload:zz-s6b-${tag}` })
    const { POST } = await import("@/app/api/crm-store/browse/upload/route")
    const s = await stage("Articles of Organization.pdf", await pdf("corrected"))
    const r = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s, fileName: "Articles of Organization.pdf", mimeType: "application/pdf", documentType: "articles_of_organization" }))
    const j = await r.json()
    expect(j.write).toBe("versioned")
    expect(j.fileId).toBe(w.fileId)
  })

  it("a personal document cannot be uploaded into a company folder", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/upload/route")
    const s = await stage("pp.pdf", await pdf("pp"))
    const r = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s, fileName: "pp.pdf", mimeType: "application/pdf", documentType: "passport" }))
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/personal document/)
  })

  it("an upload from outside the staging area is refused", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/upload/route")
    const r = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: "flow-uploads/other.pdf", fileName: "x.pdf", mimeType: "application/pdf", documentType: "articles_of_organization" }))
    expect(r.status).toBe(400)
  })

  it("Show to client → CRM row AND storage visible; Hide → both hidden", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/file/[id]/visibility/route")
    const r1 = await POST(post("http://x", { visible: true }), { params: { id: uploadedId } })
    expect(r1.status).toBe(200)
    let row = (await db.from("documents").select("portal_visible").eq("drive_file_id", `store:${uploadedId}`).single()).data
    let f = (await db.from("store_files").select("published").eq("id", uploadedId).single()).data
    expect([row.portal_visible, f.published]).toEqual([true, true])
    const r2 = await POST(post("http://x", { visible: false }), { params: { id: uploadedId } })
    expect(r2.status).toBe(200)
    row = (await db.from("documents").select("portal_visible").eq("drive_file_id", `store:${uploadedId}`).single()).data
    f = (await db.from("store_files").select("published").eq("id", uploadedId).single()).data
    expect([row.portal_visible, f.published]).toEqual([false, false])
  })

  it("a staff-only file (Formation Summary) can never be shown", async () => {
    const { savePilotFile } = await import("@/lib/crm-store/formation-pilot")
    const w = await savePilotFile({ ownerId: fx.owner, folderKind: "company", name: `Formation Summary ${tag}.pdf`, bytes: await pdf("summary"), mimeType: "application/pdf", documentType: "formation_summary", callerKey: `formation-summary:zz-s6b-${tag}` })
    const { upsertStoreDocumentRow } = await import("@/lib/crm-store/formation-pilot")
    await upsertStoreDocumentRow(w.fileId, { file_name: w.name, account_id: fx.account, portal_visible: false, category: 1, category_name: "Company" })
    const { POST } = await import("@/app/api/crm-store/browse/file/[id]/visibility/route")
    const r = await POST(post("http://x", { visible: true }), { params: { id: w.fileId } })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/staff-only/)
    const { data } = await db.from("documents").select("portal_visible").eq("drive_file_id", `store:${w.fileId}`).single()
    expect(data.portal_visible).toBe(false)
  })

  it("a file with no CRM listing cannot be 'shown' (the portal could not show it)", async () => {
    const { savePilotFile } = await import("@/lib/crm-store/formation-pilot")
    const w = await savePilotFile({ ownerId: fx.owner, folderKind: "company", name: `Unlisted ${tag}.pdf`, bytes: await pdf("u"), mimeType: "application/pdf", documentType: "articles_of_organization", callerKey: `zz-s6b-unlisted:${tag}` })
    const { POST } = await import("@/app/api/crm-store/browse/file/[id]/visibility/route")
    const r = await POST(post("http://x", { visible: true }), { params: { id: w.fileId } })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/not listed/)
  })

  it("preview: a PDF opens inline; an HTML file is forced to download (never runs in the CRM)", async () => {
    const { GET } = await import("@/app/api/crm-store/browse/file/[id]/route")
    const r1 = await GET(get("http://x"), { params: { id: uploadedId } })
    expect(r1.headers.get("content-type")).toBe("application/pdf")
    expect(r1.headers.get("content-disposition")).toMatch(/^inline/)
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff")
    const { POST } = await import("@/app/api/crm-store/browse/upload/route")
    const s = await stage("page.html", Buffer.from("<script>alert(1)</script>"), "text/html")
    const up = await (await POST(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s, fileName: "page.html", mimeType: "text/html", documentType: "articles_of_organization" }))).json()
    const r2 = await GET(get("http://x"), { params: { id: up.fileId } })
    expect(r2.headers.get("content-type")).toBe("application/octet-stream")
    expect(r2.headers.get("content-disposition")).toMatch(/^attachment/)
  })

  it("a store-owned company never gets a Drive folder — whichever flow asks", async () => {
    const { assertNotStoreOwnedAccount } = await import("@/lib/crm-store/browse")
    await expect(assertNotStoreOwnedAccount(fx.account)).rejects.toThrow(/new CRM storage/)
    const { ensureCompanyFolder } = await import("@/lib/drive-folder-utils")
    await expect(ensureCompanyFolder(fx.account, `ZZ S6B Browser LLC ${tag}`, "Wyoming")).rejects.toThrow(/new CRM storage/)
  })

  it("the window after company creation: a store-owned formation case linked to the account also refuses Drive", async () => {
    const acc = await insert("accounts", { company_name: `ZZ S6B Window LLC ${tag}`, status: "Active", state_of_formation: "WY" })
    // real order: the case is store-owned while being formed, THEN the company is linked to it and the
    // hand-over does not happen (it failed) — the owner stays "formation"
    const sd = await insert("service_deliveries", { service_type: "Company Formation", service_name: `ZZ S6B window ${tag}`, contact_id: fx.personB, account_id: null, status: "active", stage: "Filed with State", stage_order: 2 })
    const { error } = await db.rpc("store_ensure_owner", { p_kind: "formation", p_ref: sd })
    expect(error).toBeNull()
    const { error: lErr } = await db.from("service_deliveries").update({ account_id: acc }).eq("id", sd)
    expect(lErr).toBeNull()
    const { data: o } = await db.from("store_owners").select("kind").eq("service_delivery_id", sd).single()
    expect(o.kind).toBe("formation")
    const { assertNotStoreOwnedAccount } = await import("@/lib/crm-store/browse")
    await expect(assertNotStoreOwnedAccount(acc)).rejects.toThrow(/hand-over/)
  })

  it("a flow refused a Drive folder (tax intake …) files the client's uploads into the store — passport to the person; a re-run makes no copies", async () => {
    const paths: string[] = []
    for (const n of ["bank_statement.pdf", "passport_owner.pdf"]) {
      const path = `zz-s6b/${tag}/${n}`
      const { error } = await db.storage.from("onboarding-uploads").upload(path, await pdf(n), { contentType: "application/pdf", upsert: true })
      if (error) throw new Error(error.message)
      paths.push(path)
    }
    const { saveUploadsToStoreForAccount } = await import("@/lib/crm-store/account-uploads")
    const r1 = await saveUploadsToStoreForAccount({ accountId: fx.account, flow: "tax-intake", paths, passportContact: { contactId: fx.personB, name: `ZZ B S6B ${tag}` } })
    expect(r1).toMatchObject({ saved: 2, failed: [] })
    const { data: inCompany } = await db.from("store_files").select("id, document_type, published, store_folders!inner(kind)").eq("owner_id", fx.owner).eq("name", "bank_statement.pdf")
    expect(inCompany).toHaveLength(1)
    expect(inCompany[0]).toMatchObject({ document_type: null, published: false })
    expect(inCompany[0].store_folders.kind).toBe("tax") // tax-return uploads land in "3. Tax", as today
    const { data: inPerson } = await db.from("store_files").select("id, document_type").eq("owner_id", fx.ownerB).eq("name", "passport_owner.pdf")
    expect(inPerson).toHaveLength(1)
    expect(inPerson[0].document_type).toBe("passport")
    const r2 = await saveUploadsToStoreForAccount({ accountId: fx.account, flow: "tax-intake", paths, passportContact: { contactId: fx.personB, name: `ZZ B S6B ${tag}` } })
    expect(r2.saved).toBe(2)
    const { data: again } = await db.from("store_files").select("id").eq("owner_id", fx.owner).eq("name", "bank_statement.pdf")
    expect(again).toHaveLength(1)
  }, 60_000)

  it("the ensureCompanyFolder refusal is recognisable as 'store-owned' by the flows", async () => {
    const { ensureCompanyFolder } = await import("@/lib/drive-folder-utils")
    const { isStoreOwnedRefusal } = await import("@/lib/crm-store/account-uploads")
    const err = await ensureCompanyFolder(fx.account, "x", "Wyoming").then(() => null, (e) => e)
    expect(isStoreOwnedRefusal(err)).toBe(true)
  })

  it("from the company's '2. Contacts' staff upload a person's passport: it lands in THAT person's own storage, listed with both links, and shows in '2. Contacts'", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/upload/route")
    const s1 = await stage("ID card.pdf", await pdf("id"))
    const r = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.contactsFolder, storagePath: s1, fileName: "ID card.pdf", mimeType: "application/pdf", documentType: "id_document", personContactId: fx.personA, visible: false }))
    const j = await r.json()
    expect(r.status, JSON.stringify(j)).toBe(200)
    const { data: f } = await db.from("store_files").select("owner_id").eq("id", j.fileId).single()
    expect(f.owner_id).toBe(fx.ownerA)
    const { data: row } = await db.from("documents").select("account_id, contact_id, category, portal_visible").eq("drive_file_id", `store:${j.fileId}`).single()
    expect(row).toMatchObject({ account_id: fx.account, contact_id: fx.personA, category: 2, portal_visible: false })
    const { folderContents } = await import("@/lib/crm-store/browse")
    const c = await folderContents(fx.owner, fx.contactsFolder)
    expect((await personalViaCompany(fx.ownerA)).files.map((x) => x.id)).toContain(j.fileId)
    expect(c.people?.map((x) => x.contactId)).toEqual(expect.arrayContaining([fx.personA, fx.personB]))
    // a company paper in "2. Contacts", and a person's document without saying whose, are refused
    const s2 = await stage("x.pdf", await pdf("x"))
    const r2 = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.contactsFolder, storagePath: s2, fileName: "x.pdf", mimeType: "application/pdf", documentType: "articles_of_organization", personContactId: fx.personA }))
    expect(r2.status).toBe(400)
    const s3 = await stage("y.pdf", await pdf("y"))
    const r3 = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.contactsFolder, storagePath: s3, fileName: "y.pdf", mimeType: "application/pdf", documentType: "passport" }))
    expect((await r3.json()).error).toMatch(/whose/)
  })

  it("a passport can NEVER be saved into a company folder — refused at the save step itself, nothing stored", async () => {
    const { savePilotFile } = await import("@/lib/crm-store/formation-pilot")
    await expect(savePilotFile({ ownerId: fx.owner, folderKind: "company", name: `misfiled passport ${tag}.pdf`, bytes: await pdf("pp"), mimeType: "application/pdf", documentType: "passport", callerKey: `zz-s6b-misfiled:${tag}` }))
      .rejects.toThrow(/personal document/)
    const { data } = await db.from("store_files").select("id").eq("owner_id", fx.owner).eq("name", `misfiled passport ${tag}.pdf`)
    expect(data).toHaveLength(0)
  })

  it("Go Back on a company that already exists KEEPS its stored file (and row) and says so; a formation-stage file is still trashed", async () => {
    const sd = await insert("service_deliveries", { service_type: "Company Formation", service_name: `ZZ S6B goback ${tag}`, contact_id: fx.personA, account_id: fx.account, status: "active", stage: "Articles Received", stage_order: 4 })
    const { savePilotFile, upsertStoreDocumentRow } = await import("@/lib/crm-store/formation-pilot")
    const w = await savePilotFile({ ownerId: fx.owner, folderKind: "company", name: `Filed Articles ${tag}.pdf`, bytes: await pdf("filed"), mimeType: "application/pdf", documentType: "articles_of_organization", callerKey: `zz-s6b-goback:${tag}` })
    await upsertStoreDocumentRow(w.fileId, { file_name: w.name, account_id: fx.account, service_delivery_id: sd, flow_stage: "Filed with State", portal_visible: false, category: 1, category_name: "Company" })
    const { revertServiceDelivery } = await import("@/lib/operations/service-delivery")
    const r = await revertServiceDelivery({ delivery_id: sd, actor: "zz-test", actor_user_id: currentUser!.id, notes: "zz test" })
    expect(r.success).toBe(true)
    expect(r.to_stage).toBe("Filed with State")
    expect((r.warnings ?? []).join(" ")).toMatch(/kept in the company's storage/)
    const { data: f } = await db.from("store_files").select("state").eq("id", w.fileId).single()
    expect(f.state).toBe("live")
    const { data: rows } = await db.from("documents").select("id").eq("drive_file_id", `store:${w.fileId}`)
    expect(rows).toHaveLength(1)
  })

  it("today's file actions on the new storage: rename (listing follows), move (category follows the folder), delete (store trash + listing removed)", async () => {
    const { POST: upload } = await import("@/app/api/crm-store/browse/upload/route")
    const s1 = await stage("Old Name.pdf", await pdf("ren"))
    const up = await (await upload(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s1, fileName: "Old Name.pdf", mimeType: "application/pdf", documentType: "articles_of_organization", visible: false }))).json()
    const { POST: rename } = await import("@/app/api/crm-store/browse/file/[id]/rename/route")
    const rn = await rename(post("http://x", { name: "New Name" }), { params: { id: up.fileId } })
    expect((await rn.json()).name).toBe("New Name.pdf") // the extension is kept
    let row = (await db.from("documents").select("file_name, category").eq("drive_file_id", `store:${up.fileId}`).single()).data
    expect(row.file_name).toBe("New Name.pdf")
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const banking = await folderOfKind(fx.owner, "banking")
    const { POST: move } = await import("@/app/api/crm-store/browse/file/[id]/move/route")
    const mv = await move(post("http://x", { folderId: banking }), { params: { id: up.fileId } })
    expect(mv.status).toBe(200)
    row = (await db.from("documents").select("file_name, category").eq("drive_file_id", `store:${up.fileId}`).single()).data
    expect(row.category).toBe(4)
    // a company document never into "2. Contacts"
    const bad = await move(post("http://x", { folderId: fx.contactsFolder }), { params: { id: up.fileId } })
    expect(bad.status).toBe(400)
    const { POST: del } = await import("@/app/api/crm-store/browse/file/[id]/delete/route")
    const d = await del(post("http://x", {}), { params: { id: up.fileId } })
    expect(d.status).toBe(200)
    const { data: f } = await db.from("store_files").select("state").eq("id", up.fileId).single()
    expect(f.state).toBe("trashed")
    const { data: gone } = await db.from("documents").select("id").eq("drive_file_id", `store:${up.fileId}`)
    expect(gone).toHaveLength(0)
  })

  it("a renamed file is never overwritten by a new upload with its OLD name; a deleted file's name can be used again", async () => {
    const { POST: upload } = await import("@/app/api/crm-store/browse/upload/route")
    const { POST: rename } = await import("@/app/api/crm-store/browse/file/[id]/rename/route")
    const { POST: del } = await import("@/app/api/crm-store/browse/file/[id]/delete/route")
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const banking = await folderOfKind(fx.owner, "banking")
    const a = await (await upload(post("http://x", { ownerId: fx.owner, folderId: banking, storagePath: await stage("scan.pdf", await pdf("jan")), fileName: "scan.pdf", mimeType: "application/pdf", documentType: "bank_statement", visible: false }))).json()
    await rename(post("http://x", { name: "Jan statement" }), { params: { id: a.fileId } })
    const b = await (await upload(post("http://x", { ownerId: fx.owner, folderId: banking, storagePath: await stage("scan.pdf", await pdf("feb")), fileName: "scan.pdf", mimeType: "application/pdf", documentType: "bank_statement", visible: false }))).json()
    expect(b.write).toBe("created")
    expect(b.fileId).not.toBe(a.fileId)
    const { data: jan } = await db.from("store_files").select("name, current_version_id").eq("id", a.fileId).single()
    expect(jan.name).toBe("Jan statement.pdf")
    await del(post("http://x", {}), { params: { id: b.fileId } })
    const c = await (await upload(post("http://x", { ownerId: fx.owner, folderId: banking, storagePath: await stage("scan.pdf", await pdf("feb2")), fileName: "scan.pdf", mimeType: "application/pdf", documentType: "bank_statement", visible: false }))).json()
    expect(c.write).toBe("created")
  }, 60_000)

  it("a prepared tax return / 5472 is a DRAFT: hidden from the client even with 'Show to client' ticked, and cannot be shown", async () => {
    const { POST: upload } = await import("@/app/api/crm-store/browse/upload/route")
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const tax = await folderOfKind(fx.owner, "tax")
    const j = await (await upload(post("http://x", { ownerId: fx.owner, folderId: tax, storagePath: await stage("5472.pdf", await pdf("draft")), fileName: `5472 ${tag}.pdf`, mimeType: "application/pdf", documentType: "form_5472" }))).json()
    expect(j.visible).toBe(false)
    const { data: f } = await db.from("store_files").select("published, filing_status").eq("id", j.fileId).single()
    expect(f).toMatchObject({ published: false, filing_status: "draft" })
    const { POST: vis } = await import("@/app/api/crm-store/browse/file/[id]/visibility/route")
    const r = await vis(post("http://x", { visible: true }), { params: { id: j.fileId } })
    expect(r.status).toBe(400)
  })

  it("upload is shown to the client straight away by default (as today) — never a staff-only type", async () => {
    const { POST: upload } = await import("@/app/api/crm-store/browse/upload/route")
    const s1 = await stage("Shared.pdf", await pdf("shared"))
    const j = await (await upload(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s1, fileName: "Shared.pdf", mimeType: "application/pdf", documentType: "operating_agreement" }))).json()
    expect(j.visible).toBe(true)
    const { data: row } = await db.from("documents").select("portal_visible").eq("drive_file_id", `store:${j.fileId}`).single()
    expect(row.portal_visible).toBe(true)
    const { data: f } = await db.from("store_files").select("published").eq("id", j.fileId).single()
    expect(f.published).toBe(true)
    const s2 = await stage("Summary.pdf", await pdf("sum"))
    const j2 = await (await upload(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s2, fileName: `Summary ${tag}.pdf`, mimeType: "application/pdf", documentType: "formation_summary" }))).json()
    expect(j2.visible).toBe(false)
  })

  it("the contact page's Delete on a new-storage document moves it to the store trash (no longer refused)", async () => {
    const { POST: upload } = await import("@/app/api/crm-store/browse/upload/route")
    const s1 = await stage("ToDelete.pdf", await pdf("del"))
    const j = await (await upload(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: s1, fileName: "ToDelete.pdf", mimeType: "application/pdf", documentType: "receipt", visible: false }))).json()
    const { data: row } = await db.from("documents").select("id").eq("drive_file_id", `store:${j.fileId}`).single()
    const { POST: delDoc } = await import("@/app/api/crm/admin-actions/delete-document/route")
    const r = await delDoc(post("http://x", { document_id: row.id }))
    const body = await r.json()
    expect(r.status, JSON.stringify(body)).toBe(200)
    const { data: f } = await db.from("store_files").select("state").eq("id", j.fileId).single()
    expect(f.state).toBe("trashed")
  })

  it("staff add a custom document type while uploading (today's Custom…) — company type from a company folder, personal from 2. Contacts; adding it again reuses it", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/types/route")
    const name = `ZZ Custom Letter ${tag}`
    const r1 = await (await POST(post("http://x", { name, folderKind: "correspondence" }))).json()
    expect(r1).toMatchObject({ created: true, personal: false })
    const r2 = await (await POST(post("http://x", { name, folderKind: "correspondence" }))).json()
    expect(r2).toMatchObject({ created: false, slug: r1.slug })
    const { data: e } = await db.from("catalog_entries").select("metadata").eq("catalog_id", "storage_document_types").eq("slug", r1.slug).single()
    expect(e.metadata).toMatchObject({ personal: false, legacy_category: 5, staff_only: false, custom: true })
    const { data: log } = await db.from("catalog_decision_log").select("action").eq("catalog_id", "storage_document_types").eq("action", "added").order("created_at", { ascending: false }).limit(1)
    expect(log?.[0]?.action).toBe("added")
    const p1 = await (await POST(post("http://x", { name: `ZZ Custom ID ${tag}`, folderKind: "contacts" }))).json()
    expect(p1.personal).toBe(true)
    const { POST: upload } = await import("@/app/api/crm-store/browse/upload/route")
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const corr = await folderOfKind(fx.owner, "correspondence")
    const u = await (await upload(post("http://x", { ownerId: fx.owner, folderId: corr, storagePath: await stage("c.pdf", await pdf("c")), fileName: "c.pdf", mimeType: "application/pdf", documentType: r1.slug, visible: false }))).json()
    expect(u.write).toBe("created")
  }, 60_000)

  it("every saved copy can be listed and opened — version 1 still returns the OLD content; an identical re-upload adds no version", async () => {
    const { POST: upload } = await import("@/app/api/crm-store/browse/upload/route")
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const corr = await folderOfKind(fx.owner, "correspondence")
    const one = await pdf(`first ${tag}`)
    const a = await (await upload(post("http://x", { ownerId: fx.owner, folderId: corr, storagePath: await stage("Letter.pdf", one), fileName: "Letter.pdf", mimeType: "application/pdf", documentType: "receipt", visible: false }))).json()
    const same = await (await upload(post("http://x", { ownerId: fx.owner, folderId: corr, storagePath: await stage("Letter.pdf", one), fileName: "Letter.pdf", mimeType: "application/pdf", documentType: "receipt", visible: false }))).json()
    expect(same.write).toBe("unchanged")
    const b = await (await upload(post("http://x", { ownerId: fx.owner, folderId: corr, storagePath: await stage("Letter.pdf", await pdf(`second ${tag}`)), fileName: "Letter.pdf", mimeType: "application/pdf", documentType: "receipt", visible: false }))).json()
    expect(b).toMatchObject({ write: "versioned", fileId: a.fileId })
    const { GET } = await import("@/app/api/crm-store/browse/file/[id]/versions/route")
    const list = (await (await GET(get(`http://x/api/crm-store/browse/file/${a.fileId}/versions`), { params: { id: a.fileId } })).json()).versions
    expect(list.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1])
    expect(list[0].current).toBe(true)
    const old = await GET(get(`http://x/api/crm-store/browse/file/${a.fileId}/versions?open=${list[1].id}`), { params: { id: a.fileId } })
    expect(Buffer.from(await old.arrayBuffer()).equals(one)).toBe(true)
  }, 60_000)

  it("merging two people who both have their own storage is refused in plain words", async () => {
    const { storeMergeBlocker } = await import("@/lib/crm-store/merge-guard")
    expect(await storeMergeBlocker(fx.personA, fx.personB)).toMatch(/Both contacts/)
  })
})
