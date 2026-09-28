/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ STR" rows), not business writes */
/**
 * CRM Store — the STRUCTURE step (master plan Part 14 / #94), LIVE against the SANDBOX.
 *   npx vitest run --config vitest.crm-store-live.config.ts
 * Real route handlers + real library + real sandbox database and storage; only the login is stood in for.
 */
import { describe, it, expect, beforeAll, vi } from "vitest"
import { NextRequest } from "next/server"
import { createHash } from "crypto"
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
/** a made-up login id, the SAME every run — so the tests reuse one test "My files" area instead of adding one per run */
const TEST_OTHER_LOGIN = "00000000-0000-4000-8000-0000000051e5"

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
  const path = `crm-uploads/store-staging/zz-str-${tag}/${Math.random().toString(36).slice(2)}_${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`
  const { error } = await db.storage.from("onboarding-uploads").upload(path, bytes, { contentType: type, upsert: true })
  if (error) throw new Error(`stage: ${error.message}`)
  return path
}
async function upload(body: Record<string, unknown>, text = `zz ${Math.random()}`) {
  const { POST } = await import("@/app/api/crm-store/browse/upload/route")
  const name = String(body.fileName ?? "f.pdf")
  const r = await POST(post("http://x", { mimeType: "application/pdf", fileName: name, storagePath: await stage(name, await pdf(text)), ...body }))
  return { status: r.status, j: await r.json() }
}

const fx = { account: "", owner: "", closedAccount: "", closedOwner: "", company1: "", contacts: "", tax: "", banking: "", person: "", personOwner: "", business: "", adminId: "" }

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  const allUsers: FakeUser[] = []
  for (let page = 1; page <= 50; page++) {
    const { data: pg } = await db.auth.admin.listUsers({ page, perPage: 200 })
    const batch = (pg?.users ?? []) as FakeUser[]
    allUsers.push(...batch)
    if (batch.length < 200) break
  }
  const admins = allUsers.filter((u) => u.app_metadata?.role === "admin")
  if (admins.length < 1) throw new Error("no sandbox admin auth user")
  fx.adminId = admins[0].id
  currentUser = { id: fx.adminId, email: admins[0].email, app_metadata: { role: "admin" } }

  const { folderOfKind, ensurePersonOwner } = await import("@/lib/crm-store/formation-pilot")
  fx.account = await insert("accounts", { company_name: `ZZ STR Wyo LLC ${tag}`, status: "Active", state_of_formation: "WY" })
  fx.owner = (await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: fx.account })).data
  await db.rpc("store_apply_template", { p_owner_id: fx.owner, p_template_slug: "company_standard", p_root_name: `ZZ STR Wyo LLC ${tag}` })
  fx.closedAccount = await insert("accounts", { company_name: `ZZ STR Closed LLC ${tag}`, status: "Closed", state_of_formation: "Florida" })
  fx.closedOwner = (await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: fx.closedAccount })).data
  await db.rpc("store_apply_template", { p_owner_id: fx.closedOwner, p_template_slug: "company_standard", p_root_name: `ZZ STR Closed LLC ${tag}` })
  fx.company1 = await folderOfKind(fx.owner, "company")
  fx.contacts = await folderOfKind(fx.owner, "contacts")
  fx.tax = await folderOfKind(fx.owner, "tax")
  fx.banking = await folderOfKind(fx.owner, "banking")
  fx.person = await insert("contacts", { first_name: "Zz", last_name: `STR ${tag}`, full_name: `ZZ Person STR ${tag}`, email: `zz-str-${tag}@example.test` })
  { const { error } = await db.from("account_contacts").insert({ account_id: fx.account, contact_id: fx.person }); if (error) throw new Error(error.message) }
  fx.personOwner = await ensurePersonOwner(fx.person, `ZZ Person STR ${tag}`)
  const { ensureArea } = await import("@/lib/crm-store/structure")
  fx.business = await ensureArea("business", null)
}, 180_000)

describe("storage structure — live sandbox", () => {
  it("the left side: the company under its state (\"WY\" → Wyoming), the closed one under Closed / Cancelled, Business always there", async () => {
    const { navigation } = await import("@/lib/crm-store/structure")
    const g = await navigation({ id: fx.adminId }, false)
    const find = (id: string) => g.find((x) => x.owners.some((o) => o.id === id))?.key
    expect(find(fx.owner)).toBe("state:Wyoming")
    expect(find(fx.closedOwner)).toBe("closed")
    expect(find(fx.personOwner)).toBe("people")
    expect(g.find((x) => x.key === "business")?.owners[0]?.id).toBe(fx.business)
    expect(g.some((x) => x.key === "private")).toBe(false)
  })

  it("My files: only for the owner-only login, one per login, and it never opens for anyone else", async () => {
    const { navigation, ensureArea, assertOwnerAccess } = await import("@/lib/crm-store/structure")
    const mine = (await navigation({ id: fx.adminId }, true)).find((x) => x.key === "private")
    expect(mine?.owners).toHaveLength(1)
    // "another login": a made-up user id, so no real sandbox login gets a My files area from this test
    const other = await ensureArea("private", TEST_OTHER_LOGIN)
    expect(other).not.toBe(mine!.owners[0].id)
    expect((await navigation({ id: fx.adminId }, true)).flatMap((x) => x.owners).some((o) => o.id === other)).toBe(false)
    await expect(assertOwnerAccess(other, fx.adminId)).rejects.toThrow(/Not found/)
    const { GET } = await import("@/app/api/crm-store/browse/folder/route")
    const r = await GET(get(`http://x/api/crm-store/browse/folder?owner=${other}`))
    expect(r.status).toBe(404)
    const own = await GET(get(`http://x/api/crm-store/browse/folder?owner=${mine!.owners[0].id}`))
    expect(own.status).toBe(200)
  })

  let bankFolder = ""
  it("create a folder in Banking; the same name again (any case) is refused; bad names are refused before saving", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/folder/create/route")
    const r = await POST(post("http://x", { parentId: fx.banking, name: "  Bank of   America " }))
    const j = await r.json()
    expect(r.status, JSON.stringify(j)).toBe(200)
    expect(j.name).toBe("Bank of America")
    bankFolder = j.id
    const dup = await POST(post("http://x", { parentId: fx.banking, name: "bank of america" }))
    expect((await dup.json()).error).toMatch(/already exists/)
    const bad = await POST(post("http://x", { parentId: fx.banking, name: "a/b" }))
    expect((await bad.json()).error).toMatch(/can't contain/)
    const intoContacts = await POST(post("http://x", { parentId: fx.contacts, name: "X" }))
    expect((await intoContacts.json()).error).toMatch(/Contacts/)
  })

  it("the fixed folders are locked (rename / move / delete refused); a staff-made folder renames", async () => {
    const rename = (await import("@/app/api/crm-store/browse/folder/[id]/rename/route")).POST
    const move = (await import("@/app/api/crm-store/browse/folder/[id]/move/route")).POST
    const del = (await import("@/app/api/crm-store/browse/folder/[id]/delete/route")).POST
    expect((await (await rename(post("http://x", { name: "Banks" }), { params: { id: fx.banking } })).json()).error).toMatch(/fixed folders/)
    expect((await (await move(post("http://x", { toFolderId: fx.tax }), { params: { id: fx.banking } })).json()).error).toMatch(/fixed folders/)
    expect((await (await del(post("http://x", {}), { params: { id: fx.banking } })).json()).error).toMatch(/fixed folders/)
    const ok = await rename(post("http://x", { name: "BofA" }), { params: { id: bankFolder } })
    expect((await ok.json()).name).toBe("BofA")
  })

  it("move a folder: into another folder of the same storage yes; into its own sub-folder, into Contacts, or into another client no", async () => {
    const { createFolder, moveFolder } = await import("@/lib/crm-store/structure")
    const sub = await createFolder(bankFolder, "Statements", fx.adminId)
    await expect(moveFolder(bankFolder, sub.id, fx.adminId)).rejects.toThrow(/own sub-folders|inside itself/)
    await expect(moveFolder(bankFolder, fx.contacts, fx.adminId)).rejects.toThrow(/Contacts/)
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    await expect(moveFolder(bankFolder, await folderOfKind(fx.closedOwner, "banking"), fx.adminId)).rejects.toThrow(/same company/)
    expect((await moveFolder(bankFolder, fx.company1, fx.adminId)).parentName).toBe("1. Company")
    await moveFolder(bankFolder, fx.banking, fx.adminId)
  })

  let yearFolder = ""
  it("New tax year: a year folder in Tax only (four digits); it is a year folder, not locked", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/folder/[id]/tax-year/route")
    expect((await (await POST(post("http://x", { year: "2025" }), { params: { id: fx.banking } })).json()).error).toMatch(/inside a Tax folder/)
    expect((await (await POST(post("http://x", { year: "25" }), { params: { id: fx.tax } })).json()).error).toMatch(/four-digit/)
    const r = await POST(post("http://x", { year: "2025" }), { params: { id: fx.tax } })
    const j = await r.json()
    expect(r.status, JSON.stringify(j)).toBe(200)
    yearFolder = j.id
    const { data } = await db.from("store_folders").select("kind, template_slug").eq("id", yearFolder).single()
    expect(data).toEqual({ kind: "tax_year", template_slug: null })
  })

  it("a prepared return: 'filed' → filed, can be shown; 'draft' → draft, hidden; 'decide later' → hidden + Needs review; the year is saved; category Tax", async () => {
    const filed = await upload({ ownerId: fx.owner, folderId: yearFolder, fileName: "1120 filed.pdf", documentType: "form_1120", filingAnswer: "filed", periodYear: 2025 })
    expect(filed.status, JSON.stringify(filed.j)).toBe(200)
    expect(filed.j.visible).toBe(true)
    const draft = await upload({ ownerId: fx.owner, folderId: yearFolder, fileName: "1120 draft.pdf", documentType: "form_1120", filingAnswer: "draft", periodYear: 2025 })
    expect(draft.j.visible).toBe(false)
    const later = await upload({ ownerId: fx.owner, folderId: yearFolder, fileName: "1120 later.pdf", documentType: "form_1120", filingAnswer: "filed", needsReview: "Prepared return — filed or draft not decided yet" })
    expect(later.j.visible).toBe(false)
    const { data: rows } = await db.from("store_files").select("id, filing_status, period_year, needs_review_reason").in("id", [filed.j.fileId, draft.j.fileId, later.j.fileId])
    const by = Object.fromEntries((rows ?? []).map((r: { id: string }) => [r.id, r]))
    expect(by[filed.j.fileId]).toMatchObject({ filing_status: "filed", period_year: 2025, needs_review_reason: null })
    expect(by[draft.j.fileId]).toMatchObject({ filing_status: "draft", period_year: 2025 })
    expect(by[later.j.fileId]).toMatchObject({ filing_status: "draft", needs_review_reason: "Prepared return — filed or draft not decided yet" })
    const { data: crm } = await db.from("documents").select("category").eq("drive_file_id", `store:${filed.j.fileId}`).single()
    expect(crm.category).toBe(3)
    // the red chip, then "Mark reviewed" clears it
    const { folderContents } = await import("@/lib/crm-store/browse")
    expect((await folderContents(fx.owner, yearFolder)).files.find((f) => f.id === later.j.fileId)?.needsReview).toMatch(/not decided/)
    const { POST } = await import("@/app/api/crm-store/browse/file/[id]/reviewed/route")
    expect((await POST(post("http://x", {}), { params: { id: later.j.fileId } })).status).toBe(200)
    expect((await folderContents(fx.owner, yearFolder)).files.find((f) => f.id === later.j.fileId)?.needsReview).toBeNull()
  }, 60_000)

  it("a file in a staff-made sub-folder of Banking is listed as Banking (the nearest fixed folder), also after a move", async () => {
    const up = await upload({ ownerId: fx.owner, folderId: bankFolder, fileName: "Statement Jan.pdf", documentType: "bank_statement", visible: false })
    expect(up.status, JSON.stringify(up.j)).toBe(200)
    const { data: r1 } = await db.from("documents").select("category").eq("drive_file_id", `store:${up.j.fileId}`).single()
    expect(r1.category).toBe(4)
    const { moveStoreFile } = await import("@/lib/crm-store/file-actions")
    await moveStoreFile(up.j.fileId, yearFolder, fx.adminId)
    const { data: r2 } = await db.from("documents").select("category").eq("drive_file_id", `store:${up.j.fileId}`).single()
    expect(r2.category).toBe(3)
    await moveStoreFile(up.j.fileId, bankFolder, fx.adminId)
  })

  it("the exact same file is found wherever it is stored, with its place", async () => {
    const bytes = await pdf(`identical ${tag}`)
    const { POST } = await import("@/app/api/crm-store/browse/upload/route")
    const r = await POST(post("http://x", { ownerId: fx.owner, folderId: fx.company1, storagePath: await stage("Articles.pdf", bytes), fileName: "Articles.pdf", mimeType: "application/pdf", documentType: "articles_of_organization", visible: false }))
    const j = await r.json()
    const sha = createHash("sha256").update(bytes).digest("hex")
    const { GET } = await import("@/app/api/crm-store/browse/identical/route")
    const hits = (await (await GET(get(`http://x/api/crm-store/browse/identical?sha=${sha}`))).json()).files
    expect(hits).toEqual([expect.objectContaining({ fileId: j.fileId, name: "Articles.pdf", where: `ZZ STR Wyo LLC ${tag} › 1. Company` })])
    expect((await GET(get("http://x/api/crm-store/browse/identical?sha=nothex"))).status).toBe(400)
  })

  it("delete a folder whose files the client sees: the summary names them; hide first, then the folder and its files go to the trash as one batch and leave the CRM list", async () => {
    const shown = await upload({ ownerId: fx.owner, folderId: bankFolder, fileName: "Shown.pdf", documentType: "bank_statement", visible: true })
    expect(shown.j.visible).toBe(true)
    const { GET } = await import("@/app/api/crm-store/browse/folder/[id]/summary/route")
    const s = await (await GET(get("http://x"), { params: { id: bankFolder } })).json()
    expect(s.shown).toBe(1)
    expect(s.list[0]).toMatchObject({ id: shown.j.fileId, shown: true })
    const del = (await import("@/app/api/crm-store/browse/folder/[id]/delete/route")).POST
    const r = await del(post("http://x", { hide: "all" }), { params: { id: bankFolder } })
    const j = await r.json()
    expect(r.status, JSON.stringify(j)).toBe(200)
    expect(j.files).toBe(s.files)
    const { data: f } = await db.from("store_files").select("state, trash_batch_id, published").eq("id", shown.j.fileId).single()
    expect(f.state).toBe("trashed")
    expect(f.published).toBe(false)
    const { data: rows } = await db.from("documents").select("id").eq("drive_file_id", `store:${shown.j.fileId}`)
    expect(rows).toEqual([])
    const { data: fo } = await db.from("store_folders").select("trashed_at, trash_batch_id").eq("id", bankFolder).single()
    expect(fo.trashed_at).not.toBeNull()
    expect(fo.trash_batch_id).toBe(f.trash_batch_id)
  })

  it("Business: files are saved with no CRM row and can never be shown; a personal document is refused there", async () => {
    const { data: root } = await db.from("store_folders").select("id").eq("owner_id", fx.business).is("parent_id", null).single()
    const up = await upload({ ownerId: fx.business, folderId: root.id, fileName: `ZZ STR contract ${tag}.pdf`, documentType: "office_lease" })
    expect(up.status, JSON.stringify(up.j)).toBe(200)
    expect(up.j.visible).toBe(false)
    const { data: rows } = await db.from("documents").select("id").eq("drive_file_id", `store:${up.j.fileId}`)
    expect(rows).toEqual([])
    const { POST } = await import("@/app/api/crm-store/browse/file/[id]/visibility/route")
    expect((await (await POST(post("http://x", { visible: true }), { params: { id: up.j.fileId } })).json()).error).toMatch(/internal/)
    const pers = await upload({ ownerId: fx.business, folderId: root.id, fileName: "pp.pdf", documentType: "passport" })
    expect(pers.j.error).toMatch(/personal document/)
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    await deleteStoreFile(up.j.fileId, fx.adminId)
  })

  it("a person's folder reached through the company: an upload there keeps BOTH links (person + company)", async () => {
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const personal = await folderOfKind(fx.personOwner, "personal")
    const up = await upload({ ownerId: fx.personOwner, folderId: personal, fileName: "Proof.pdf", documentType: "proof_of_address", visible: false, viaCompanyOwnerId: fx.owner })
    expect(up.status, JSON.stringify(up.j)).toBe(200)
    const { data: row } = await db.from("documents").select("account_id, contact_id").eq("drive_file_id", `store:${up.j.fileId}`).single()
    expect(row).toEqual({ account_id: fx.account, contact_id: fx.person })
    // a company the person is NOT in is refused
    const bad = await upload({ ownerId: fx.personOwner, folderId: personal, fileName: "Proof2.pdf", documentType: "proof_of_address", viaCompanyOwnerId: fx.closedOwner })
    expect(bad.j.error).toMatch(/not linked/)
  })

  it("the questions come from the catalog (all nine asked by default)", async () => {
    const { GET } = await import("@/app/api/crm-store/browse/questions/route")
    const q = (await (await GET()).json()).questions
    for (const k of ["same_name_different_content", "identical_elsewhere", "closed_company_upload", "person_folder_from_company", "tax_year_missing", "prepared_tax_return", "move_visible_file", "folder_with_visible_files", "show_personal_data"]) {
      expect(q[k]?.enabled, k).toBe(true)
      expect(Object.keys(q[k].choices).length, k).toBeGreaterThan(1)
    }
  })

  it("the owner of a closed company is flagged closed for the upload question", async () => {
    const { folderContents } = await import("@/lib/crm-store/browse")
    expect((await folderContents(fx.closedOwner, null)).owner).toMatchObject({ closed: true, accountStatus: "Closed" })
    expect((await folderContents(fx.owner, null)).owner).toMatchObject({ closed: false, kind: "company" })
  })
  it("a REPLACED file follows this upload's answer: unticked hides a shared file; Decide later hides it and marks it red", async () => {
    const v1 = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: `Replace me ${tag}.pdf`, documentType: "operating_agreement", visible: true }, "v1")
    expect(v1.j.visible).toBe(true)
    const v2 = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: `Replace me ${tag}.pdf`, documentType: "operating_agreement", visible: false }, "v2")
    expect(v2.j.write).toBe("versioned")
    expect(v2.j.fileId).toBe(v1.j.fileId)
    expect(v2.j.visible).toBe(false)
    const { data: row } = await db.from("documents").select("portal_visible").eq("drive_file_id", `store:${v1.j.fileId}`).single()
    expect(row.portal_visible).toBe(false)
    const { data: f } = await db.from("store_files").select("published").eq("id", v1.j.fileId).single()
    expect(f.published).toBe(false)
    // shown again with a ticked replace, then "Decide later" on the next replace hides it
    const v3 = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: `Replace me ${tag}.pdf`, documentType: "operating_agreement", visible: true }, "v3")
    expect(v3.j.visible).toBe(true)
    const v4 = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: `Replace me ${tag}.pdf`, documentType: "operating_agreement", visible: true, needsReview: "check" }, "v4")
    expect(v4.j.visible).toBe(false)
    // a "Needs review" file cannot be shown until it is marked reviewed
    const { POST } = await import("@/app/api/crm-store/browse/file/[id]/visibility/route")
    expect((await (await POST(post("http://x", { visible: true }), { params: { id: v1.j.fileId } })).json()).error).toMatch(/Needs review/)
  })

  it("from a company page only the person's own documents go into their storage; a company paper there is refused", async () => {
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const personal = await folderOfKind(fx.personOwner, "personal")
    const bad = await upload({ ownerId: fx.personOwner, folderId: personal, fileName: "Stmt.pdf", documentType: "bank_statement", visible: true, viaCompanyOwnerId: fx.owner })
    expect(bad.status).toBe(400)
    expect(bad.j.error).toMatch(/own documents/)
    const itin = await folderOfKind(fx.personOwner, "itin")
    const bad2 = await upload({ ownerId: fx.personOwner, folderId: itin, fileName: "W7.pdf", documentType: "form_w_7", viaCompanyOwnerId: fx.owner })
    expect(bad2.j.error).toMatch(/person's own page/)
  })

  it("the company's file list never hides a person's ITIN / Tax file (it is not in the company's storage view)", async () => {
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const itin = await folderOfKind(fx.personOwner, "itin")
    const up = await upload({ ownerId: fx.personOwner, folderId: itin, fileName: `ITIN letter ${tag}.pdf`, documentType: "itin_letter", visible: false })
    expect(up.status, JSON.stringify(up.j)).toBe(200)
    const personal = await folderOfKind(fx.personOwner, "personal")
    const pp = await upload({ ownerId: fx.personOwner, folderId: personal, fileName: `Passport ${tag}.pdf`, documentType: "passport", visible: false })
    const { storeFilesShownForAccount } = await import("@/lib/crm-store/browse")
    const shown = await storeFilesShownForAccount(fx.account, fx.owner)
    expect(shown).toContain(pp.j.fileId)
    expect(shown).not.toContain(up.j.fileId)
  })

  it("a private area's folder can't be reached by naming another owner in the same request", async () => {
    const { ensureArea } = await import("@/lib/crm-store/structure")
    const other = await ensureArea("private", TEST_OTHER_LOGIN)
    const { data: root } = await db.from("store_folders").select("id").eq("owner_id", other).is("parent_id", null).single()
    const { GET } = await import("@/app/api/crm-store/browse/folder/route")
    expect((await GET(get(`http://x/api/crm-store/browse/folder?owner=${fx.owner}&folder=${root.id}`))).status).toBe(404)
    const { POST } = await import("@/app/api/crm-store/browse/folder/create/route")
    expect((await POST(post("http://x", { parentId: root.id, name: "x" }))).status).toBe(404)
  })

  it("a folder move that is refused hides nothing; a move with 'hide first' hides the visible files and moves", async () => {
    const { createFolder, moveFolder } = await import("@/lib/crm-store/structure")
    const a = await createFolder(fx.company1, `Move A ${tag}`, fx.adminId)
    await createFolder(fx.tax, `Move A ${tag}`, fx.adminId) // same name at the destination → refused
    const shown = await upload({ ownerId: fx.owner, folderId: a.id, fileName: "Visible.pdf", documentType: "business_license", visible: true })
    expect(shown.j.visible).toBe(true)
    await expect(moveFolder(a.id, fx.tax, fx.adminId, "all")).rejects.toThrow(/already has a folder/)
    const { data: still } = await db.from("documents").select("portal_visible").eq("drive_file_id", `store:${shown.j.fileId}`).single()
    expect(still.portal_visible).toBe(true)
    await moveFolder(a.id, fx.banking, fx.adminId, "all")
    const { data: after } = await db.from("documents").select("portal_visible, category").eq("drive_file_id", `store:${shown.j.fileId}`).single()
    expect(after).toEqual({ portal_visible: false, category: 4 })
  })

  it("a tax-year folder can only move inside a Tax folder", async () => {
    const { moveFolder } = await import("@/lib/crm-store/structure")
    await expect(moveFolder(yearFolder, fx.company1, fx.adminId)).rejects.toThrow(/tax-year folder/)
  })

  it("a person's tax-year folder: a non-personal paper there is listed as Tax (a personal type stays Contacts, as today)", async () => {
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const { createTaxYear } = await import("@/lib/crm-store/structure")
    const ptax = await folderOfKind(fx.personOwner, "person_tax")
    const y = await createTaxYear(ptax, "2024", fx.adminId)
    const up = await upload({ ownerId: fx.personOwner, folderId: y.id, fileName: "IRS notice.pdf", documentType: "irs_notice", periodYear: 2024 })
    expect(up.status, JSON.stringify(up.j)).toBe(200)
    const { data: row } = await db.from("documents").select("category").eq("drive_file_id", `store:${up.j.fileId}`).single()
    expect(row.category).toBe(3)
  })

  it("a filed return can't be replaced — the message says so in plain words", async () => {
    const r = await upload({ ownerId: fx.owner, folderId: yearFolder, fileName: "1120 filed.pdf", documentType: "form_1120", filingAnswer: "filed", periodYear: 2025 }, "another")
    expect(r.status).toBe(400)
    expect(r.j.error).toMatch(/filed and frozen|FILED document/)
  })
})
