/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ MOVE" rows + a TEST-Drive pilot folder), not business writes */
/**
 * CRM Store — "Move this company to the new storage", LIVE against the SANDBOX database and the TEST Shared Drive.
 * Builds a pilot company folder in the TEST Drive (5 folders, sub-folders, a year folder, a member-named folder,
 * a file at the top, an unknown folder, a duplicate passport), CRM rows for some files (visible / hidden, one kept
 * in Supabase Storage), then moves it in small batches, checks every placement + visibility + parity + the backup
 * record, refuses a second move, undoes it, and proves a folder outside the TEST Drive is refused.
 *   npx vitest run --config vitest.crm-store-live.config.ts tests/live/crm-store-drive-import.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"

import { supabaseAdmin } from "@/lib/supabase-admin"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const TEST_DRIVE = "0ABz0eJKly9bkUk9PVA"
const PROD_DRIVE = "0AOLZHXSfKUMHUk9PVA"
const tag = Date.now()

async function pdf(text: string): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  d.addPage([612, 792]).drawText(text, { x: 50, y: 740, size: 11, font: f })
  return Buffer.from(await d.save())
}
async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(row).select("id").single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data.id as string
}

const fx: Record<string, string> = {}
let actor = ""
let runId = ""

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  process.env.GOOGLE_DRIVE_LIVE = "1"
  process.env.GOOGLE_SHARED_DRIVE_ID = TEST_DRIVE
  process.env.STORE_TEST_DRIVE_ID = TEST_DRIVE
  const { data: u } = await db.from("store_events").select("actor").not("actor", "is", null).limit(1).single()
  actor = u.actor
  const drive = await import("@/lib/google-drive")
  const mk = async (parent: string, name: string) => ((await drive.createFolder(parent, name)) as { id: string }).id
  const up = async (parent: string, name: string, text: string) => ((await drive.uploadBinaryToDrive(name, await pdf(text), "application/pdf", parent)) as { id: string }).id
  // the pilot company folder in the TEST Drive
  const top = await mk(TEST_DRIVE, `ZZ MOVE Co ${tag}`)
  const company = await mk(top, "1. Company"), contacts = await mk(top, "2. Contacts"), tax = await mk(top, "3. Tax")
  await mk(top, "4. Banking")
  const corr = await mk(top, "5. Correspondence"), old = await mk(top, "Old stuff")
  const bank = await mk(company, "Bank letters"), y2024 = await mk(tax, "2024")
  const annaFolder = await mk(contacts, `ZZ MOVE Anna ${tag}`)
  const passportText = `ZZ MOVE passport Mario ${tag}`
  fx.articles = await up(company, "Articles.pdf", `articles ${tag}`)
  fx.bankLetter = await up(bank, "Letter.pdf", `bank letter ${tag}`)
  fx.passport = await up(contacts, "Passport Mario.pdf", passportText)
  fx.passportCopy = await up(contacts, "Passport Mario copy.pdf", passportText) // identical bytes
  fx.annaId = await up(annaFolder, "ID card.pdf", `anna id ${tag}`)
  fx.ret = await up(y2024, "Form 1120 2024.pdf", `return 2024 ${tag}`)
  fx.corrLetter = await up(corr, "IRS letter.pdf", `irs ${tag}`)
  fx.loose = await up(top, "Loose note.pdf", `loose ${tag}`)
  fx.oldNote = await up(old, "Old note.pdf", `old ${tag}`)
  fx.slashName = await up(corr, "Statement 01/2024.pdf", `slash ${tag}`)
  fx.top = top
  // the sandbox company + two members
  fx.account = await insert("accounts", { company_name: `ZZ MOVE LLC ${tag}`, status: "Active", state_of_formation: "WY", drive_folder_id: top })
  fx.mario = await insert("contacts", { first_name: "Zz", last_name: `Mario ${tag}`, full_name: `ZZ MOVE Mario ${tag}`, email: `zz-move-m-${tag}@example.test` })
  fx.anna = await insert("contacts", { first_name: "Zz", last_name: `Anna ${tag}`, full_name: `ZZ MOVE Anna ${tag}`, email: `zz-move-a-${tag}@example.test` })
  for (const c of [fx.mario, fx.anna]) {
    const { error } = await db.from("account_contacts").insert({ account_id: fx.account, contact_id: c })
    if (error) throw new Error(error.message)
  }
  // CRM rows (the old list): articles visible, Mario's passport visible, the return hidden with its year
  const legacy = async (slug: string) => (await db.from("catalog_entries").select("metadata").eq("catalog_id", "storage_document_types").eq("slug", slug).single()).data.metadata.legacy_document_type_id as number
  fx.rowArticles = await insert("documents", { drive_file_id: fx.articles, file_name: "Articles.pdf", account_id: fx.account, document_type_id: await legacy("articles_of_organization"), document_type_name: "Articles of Organization", category: 1, portal_visible: true, status: "classified" })
  fx.rowPassport = await insert("documents", { drive_file_id: fx.passport, file_name: "Passport Mario.pdf", account_id: fx.account, contact_id: fx.mario, document_type_id: await legacy("passport"), document_type_name: "Passport", category: 2, portal_visible: true, status: "classified" })
  // a file the client could see that has NO type (106 such rows exist in production)
  fx.rowUntyped = await insert("documents", { drive_file_id: fx.oldNote, file_name: "Old note.pdf", account_id: fx.account, category: 5, portal_visible: true, status: "classified" })
  fx.rowReturn = await insert("documents", { drive_file_id: fx.ret, file_name: "Form 1120 2024.pdf", account_id: fx.account, document_type_id: await legacy("form_1120"), document_type_name: "Form 1120", category: 3, portal_visible: false, tax_year: 2024, status: "classified" })
  // a row whose bytes are in Supabase Storage (a Drive walk never finds it)
  const sp = `crm-uploads/zz-move-${tag}/bank-statement.pdf`
  const { error: sErr } = await db.storage.from("onboarding-uploads").upload(sp, await pdf(`statement ${tag}`), { contentType: "application/pdf" })
  if (sErr) throw new Error(sErr.message)
  fx.storagePointer = `storage:onboarding-uploads/${sp}`
  fx.rowStorage = await insert("documents", { drive_file_id: fx.storagePointer, file_name: "bank-statement.pdf", account_id: fx.account, document_type_name: "Bank Statement", category: 4, portal_visible: true, status: "classified", mime_type: "application/pdf" })
}, 240_000)

describe("move a company from Drive to the new storage — live sandbox + TEST Drive", () => {
  it("scans every Drive file (all levels) + the row kept in Supabase Storage into the ledger", async () => {
    const { startDriveImport } = await import("@/lib/crm-store/drive-import")
    const v = await startDriveImport(fx.account, actor)
    runId = v.id
    expect(v.status).toBe("moving")
    expect(v.counts.total).toBe(11) // 10 Drive files + 1 storage row
    expect(v.ownerId).toBeTruthy()
    // a second start resumes the same run
    expect((await startDriveImport(fx.account, actor)).id).toBe(runId)
  }, 120_000)

  it("moves in small batches until done — two batches at once (two tabs) never move the same file", async () => {
    const { continueDriveImport } = await import("@/lib/crm-store/drive-import")
    // two batches in parallel: each claims its own files
    const [a, b] = await Promise.all([continueDriveImport(runId, actor, { files: 3, ms: 60_000 }), continueDriveImport(runId, actor, { files: 3, ms: 60_000 })])
    expect([a.status, b.status]).toEqual(["moving", "moving"])
    let v = await continueDriveImport(runId, actor, { files: 3, ms: 60_000 })
    for (let i = 0; i < 10 && v.status === "moving"; i++) v = await continueDriveImport(runId, actor, { files: 3, ms: 60_000 })
    expect(v.status, JSON.stringify(v.report?.failed)).toBe("done")
    expect(v.counts).toMatchObject({ total: 11, pending: 0, working: 0, failed: 0, merged: 1, done: 10 })
    // no file stored twice by the parallel batches
    const { data: its } = await db.from("store_import_items").select("store_file_id, status").eq("run_id", runId).eq("status", "done")
    expect(new Set(its.map((x: { store_file_id: string }) => x.store_file_id)).size).toBe(10)
    expect(v.report?.parityOk).toBe(true)
    expect(v.report?.fromStorage).toBe(1)
  }, 300_000)

  it("every file landed in the right place with the same client visibility, rows re-pointed in place", async () => {
    const { data: items } = await db.from("store_import_items").select("*").eq("run_id", runId)
    const by = (id: string) => items.find((x: { source_id: string }) => x.source_id === id)
    expect(by(fx.articles).landed_in).toBe("1. Company")
    expect(by(fx.bankLetter).landed_in).toBe("1. Company › Bank letters")
    expect(by(fx.ret).landed_in).toBe("3. Tax › 2024")
    expect(by(fx.corrLetter).landed_in).toBe("5. Correspondence")
    expect(by(fx.oldNote).landed_in).toBe("5. Correspondence › Old stuff")
    expect(by(fx.slashName).landed_in).toBe("5. Correspondence")
    expect((await db.from("store_files").select("name").eq("id", by(fx.slashName).store_file_id).single()).data.name).toBe("Statement 01-2024.pdf")
    // visible but untyped: copied, yet its record keeps opening from Drive (the portal never serves an untyped stored file)
    expect((await db.from("documents").select("drive_file_id, portal_visible").eq("id", fx.rowUntyped).single()).data).toEqual({ drive_file_id: fx.oldNote, portal_visible: true })
    expect(by(fx.oldNote).reason).toMatch(/no type/)
    expect(by(fx.loose).landed_in).toBe("5. Correspondence")
    expect(by(fx.loose).reason).toMatch(/top of the company's Drive folder/)
    // personal: Mario by his row, Anna by her member-named folder, the copy kept once
    const ownerOf = async (fileId: string) => (await db.from("store_files").select("owner_id, store_owners(kind, contact_id)").eq("id", fileId).single()).data.store_owners
    expect(await ownerOf(by(fx.passport).store_file_id)).toEqual({ kind: "person", contact_id: fx.mario })
    expect(await ownerOf(by(fx.annaId).store_file_id)).toEqual({ kind: "person", contact_id: fx.anna })
    // the two identical passports: one kept in Mario's storage, the other recorded as merged into it
    expect([by(fx.passport).status, by(fx.passportCopy).status].sort()).toEqual(["done", "merged"])
    expect(by(fx.passportCopy).store_file_id).toBe(by(fx.passport).store_file_id)
    const passportRow = (await db.from("documents").select("drive_file_id, portal_visible").eq("id", fx.rowPassport).single()).data
    expect(passportRow).toEqual({ drive_file_id: `store:${by(fx.passport).store_file_id}`, portal_visible: true })
    // rows re-pointed in place, visibility unchanged
    const row = async (id: string) => (await db.from("documents").select("drive_file_id, drive_link, portal_visible").eq("id", id).single()).data
    const art = await row(fx.rowArticles)
    expect(art.drive_file_id).toBe(`store:${by(fx.articles).store_file_id}`)
    expect(art.drive_link).toBe(`/api/documents/${fx.rowArticles}/preview`)
    expect(art.portal_visible).toBe(true)
    expect((await row(fx.rowReturn)).portal_visible).toBe(false)
    expect((await row(fx.rowStorage)).drive_file_id).toMatch(/^store:/)
    // the store says the same as the rows; a hidden return is a draft with its year; the top file needs review
    const sf = async (id: string) => (await db.from("store_files").select("published, filing_status, period_year, needs_review_at, document_type").eq("id", id).single()).data
    expect((await sf(by(fx.articles).store_file_id)).published).toBe(true)
    expect(await sf(by(fx.ret).store_file_id)).toMatchObject({ published: false, filing_status: "draft", period_year: 2024, document_type: "form_1120" })
    expect((await sf(by(fx.loose).store_file_id)).needs_review_at).not.toBeNull()
    // a file with no row gets one hidden row (the CRM list shows it)
    const created = by(fx.corrLetter).repointed.find((r: { created?: boolean }) => r.created)
    expect(created).toBeTruthy()
    expect((await row(created.id)).portal_visible).toBe(false)
  })

  it("the backup knows each imported Drive original holds exactly these bytes (it will never re-copy them)", async () => {
    const { data: items } = await db.from("store_import_items").select("source_id, store_file_id, sha256, status").eq("run_id", runId).eq("source", "drive").eq("status", "done")
    for (const it of items) {
      const { data: ref } = await db.from("store_external_refs").select("external_id, status, backed_up_sha256").eq("object_kind", "file").eq("object_id", it.store_file_id).eq("direction", "import").single()
      expect(ref).toEqual({ external_id: it.source_id, status: "ok", backed_up_sha256: it.sha256 })
      const { data: ok } = await db.rpc("store_backup_file_ok", { p_file_id: it.store_file_id })
      expect(ok).toBe(true)
    }
    const { data: state } = await db.from("store_backup_state").select("switched_at").eq("owner_id", (await db.from("store_import_runs").select("owner_id").eq("id", runId).single()).data.owner_id).single()
    expect(state.switched_at).not.toBeNull()
  })

  it("Drive was never changed, and a second move of the same company is refused", async () => {
    const drive = await import("@/lib/google-drive")
    const page = await drive.listFolderPageAnyDrive(fx.top)
    expect(page.files.map((f) => f.name).sort()).toEqual(["1. Company", "2. Contacts", "3. Tax", "4. Banking", "5. Correspondence", "Loose note.pdf", "Old stuff"].sort())
    const { startDriveImport } = await import("@/lib/crm-store/drive-import")
    await expect(startDriveImport(fx.account, actor)).rejects.toThrow(/already been moved/)
  })

  it("undo puts every CRM record back on its Drive file, removes the rows the move listed, trashes the moved files — but keeps one staff changed", async () => {
    const { undoDriveImport } = await import("@/lib/crm-store/drive-import")
    const { data: items } = await db.from("store_import_items").select("*").eq("run_id", runId)
    // staff save a new version of the IRS letter after the move
    const irs = items.find((x: { source_id: string }) => x.source_id === fx.corrLetter)
    const { data: irsFile } = await db.from("store_files").select("owner_id, folder_id, name, caller_key").eq("id", irs.store_file_id).single()
    const { saveBytesToStore } = await import("@/lib/crm-store/writer")
    const w2 = await saveBytesToStore({ ownerId: irsFile.owner_id, folderId: irsFile.folder_id, name: irsFile.name, mimeType: "application/pdf", bytes: await pdf(`irs v2 ${tag}`), callerKey: irsFile.caller_key, contentChanged: true, actor })
    expect(w2.status).toBe("versioned")
    const v = await undoDriveImport(runId, actor)
    expect(v.status).toBe("rolled_back")
    const row = async (id: string) => (await db.from("documents").select("drive_file_id, portal_visible").eq("id", id).maybeSingle()).data
    expect((await row(fx.rowArticles)).drive_file_id).toBe(fx.articles)
    expect((await row(fx.rowPassport)).drive_file_id).toBe(fx.passport)
    expect((await row(fx.rowStorage)).drive_file_id).toBe(fx.storagePointer)
    expect((await row(fx.rowArticles)).portal_visible).toBe(true)
    const created = items.flatMap((it: { repointed: Array<{ id: string; created?: boolean }> }) => it.repointed.filter((r) => r.created).map((r) => r.id))
    expect(created.length).toBeGreaterThan(0)
    for (const id of created) expect(await row(id)).toBeNull()
    const fileIds = items.filter((it: { status: string; source_id: string }) => it.status === "done" && it.source_id !== fx.corrLetter).map((it: { store_file_id: string }) => it.store_file_id)
    const { data: files } = await db.from("store_files").select("state").in("id", fileIds)
    expect(files.every((f: { state: string }) => f.state === "trashed")).toBe(true)
    // the file staff changed is kept, and said so
    expect((await db.from("store_files").select("state").eq("id", irs.store_file_id).single()).data.state).toBe("live")
    const { data: runRow } = await db.from("store_import_runs").select("report").eq("id", runId).single()
    expect(JSON.stringify(runRow.report.problems)).toMatch(/changed since the move — kept/)
    const { count } = await db.from("store_external_refs").select("id", { count: "exact", head: true }).in("object_id", fileIds).eq("direction", "import")
    expect(count).toBe(0)
  }, 240_000)

  it("after an undo the company can be moved again", async () => {
    const { startDriveImport, continueDriveImport, undoDriveImport } = await import("@/lib/crm-store/drive-import")
    let v = await startDriveImport(fx.account, actor)
    expect(v.id).not.toBe(runId)
    for (let i = 0; i < 10 && v.status === "moving"; i++) v = await continueDriveImport(v.id, actor, { files: 25, ms: 120_000 })
    expect(v.status, JSON.stringify(v.report?.failed)).toBe("done")
    expect(v.counts.failed).toBe(0)
    expect((await db.from("documents").select("drive_file_id").eq("id", fx.rowArticles).single()).data.drive_file_id).toMatch(/^store:/)
    expect((await undoDriveImport(v.id, actor)).status).toBe("rolled_back")
  }, 300_000)

  it("outside production a Drive folder that is not in the TEST Drive is refused (sandbox companies point at real folders)", async () => {
    const acc = await insert("accounts", { company_name: `ZZ MOVE Real ${tag}`, status: "Active", state_of_formation: "WY", drive_folder_id: PROD_DRIVE })
    const { startDriveImport } = await import("@/lib/crm-store/drive-import")
    await expect(startDriveImport(acc, actor)).rejects.toThrow(/not in the TEST Drive/)
    const { count } = await db.from("store_owners").select("id", { count: "exact", head: true }).eq("account_id", acc)
    expect(count).toBe(0)
  }, 60_000)
})

// ───────────────────────────── round 2 (bug-hunter): merge onto an untyped copy, retries, failures, undo re-run
describe("move — identical copies with and without a type, a retried file, a failed file, an undo run twice", () => {
  const g: Record<string, string> = {}
  beforeAll(async () => {
    const drive = await import("@/lib/google-drive")
    const mk = async (parent: string, name: string) => ((await drive.createFolder(parent, name)) as { id: string }).id
    const up = async (parent: string, name: string, text: string) => ((await drive.uploadBinaryToDrive(name, await pdf(text), "application/pdf", parent)) as { id: string }).id
    const top = await mk(TEST_DRIVE, `ZZ MOVE2 Co ${tag}`)
    const contacts = await mk(top, "2. Contacts"), corr = await mk(top, "5. Correspondence")
    // processed in name order: the untyped copy first, then the typed + visible one with the same bytes
    g.aCopy = await up(contacts, "A copy.pdf", `ZZ MOVE2 passport ${tag}`)
    g.bPassport = await up(contacts, "B passport.pdf", `ZZ MOVE2 passport ${tag}`)
    // two identical untyped copies, the second visible to the client
    g.cNote = await up(contacts, "C note.pdf", `ZZ MOVE2 note ${tag}`)
    g.dNote = await up(contacts, "D note.pdf", `ZZ MOVE2 note ${tag}`)
    g.eId = await up(contacts, "E id.pdf", `ZZ MOVE2 id ${tag}`)
    g.letter = await up(corr, "Letter.pdf", `ZZ MOVE2 letter ${tag}`)
    g.letter2 = await up(corr, "Letter two.pdf", `ZZ MOVE2 letter two ${tag}`)
    g.account = await insert("accounts", { company_name: `ZZ MOVE2 LLC ${tag}`, status: "Active", state_of_formation: "WY", drive_folder_id: top })
    g.person = await insert("contacts", { first_name: "Zz", last_name: `Solo ${tag}`, full_name: `ZZ MOVE2 Solo ${tag}`, email: `zz-move2-${tag}@example.test` })
    const { error } = await db.from("account_contacts").insert({ account_id: g.account, contact_id: g.person })
    if (error) throw new Error(error.message)
    const legacy = (await db.from("catalog_entries").select("metadata").eq("catalog_id", "storage_document_types").eq("slug", "passport").single()).data.metadata.legacy_document_type_id as number
    g.rowB = await insert("documents", { drive_file_id: g.bPassport, file_name: "B passport.pdf", account_id: g.account, contact_id: g.person, document_type_id: legacy, document_type_name: "Passport", category: 2, portal_visible: true, status: "classified" })
    g.rowD = await insert("documents", { drive_file_id: g.dNote, file_name: "D note.pdf", account_id: g.account, contact_id: g.person, category: 2, portal_visible: true, status: "classified" })
  }, 240_000)

  it("a typed, visible copy merged onto an untyped copy gives it its type; two untyped copies keep the visible record on Drive", async () => {
    const { startDriveImport, continueDriveImport } = await import("@/lib/crm-store/drive-import")
    let v = await startDriveImport(g.account, actor)
    g.run = v.id
    // one file per batch → the claim order (folder, then name) decides: the untyped copy is stored first
    for (let i = 0; i < 20 && v.status === "moving"; i++) v = await continueDriveImport(v.id, actor, { files: 1, ms: 120_000 })
    expect(v.status, JSON.stringify(v.report?.failed)).toBe("done")
    const { data: items } = await db.from("store_import_items").select("*").eq("run_id", g.run)
    const by = (id: string) => items.find((x: { source_id: string }) => x.source_id === id)
    // A (untyped) kept, B merged into it: A now says Passport, B's record opens it and stays visible
    expect(by(g.aCopy).status).toBe("done")
    expect(by(g.bPassport).status).toBe("merged")
    expect(by(g.bPassport).store_file_id).toBe(by(g.aCopy).store_file_id)
    expect((await db.from("store_files").select("document_type").eq("id", by(g.aCopy).store_file_id).single()).data.document_type).toBe("passport")
    expect((await db.from("documents").select("drive_file_id, portal_visible").eq("id", g.rowB).single()).data).toEqual({ drive_file_id: `store:${by(g.aCopy).store_file_id}`, portal_visible: true })
    // C and D both untyped, D visible: D's record keeps opening from Drive, listed as waiting for a type
    expect(by(g.dNote).status).toBe("merged")
    expect((await db.from("documents").select("drive_file_id, portal_visible").eq("id", g.rowD).single()).data).toEqual({ drive_file_id: g.dNote, portal_visible: true })
    expect(v.report?.waitingForType.map((x) => x.name)).toContain("D note.pdf")
  }, 300_000)

  it("a personal file that runs again (a batch that died after saving) recognises its own copy — never 'merged into itself'", async () => {
    const { continueDriveImport } = await import("@/lib/crm-store/drive-import")
    const { data: before } = await db.from("store_import_items").select("id, store_file_id").eq("run_id", g.run).eq("source_id", g.eId).single()
    await db.from("store_import_runs").update({ status: "moving" }).eq("id", g.run)
    await db.from("store_import_items").update({ status: "pending" }).eq("id", before.id)
    const v = await continueDriveImport(g.run, actor, { files: 25, ms: 120_000 })
    expect(v.status).toBe("done")
    const { data: after } = await db.from("store_import_items").select("status, store_file_id").eq("id", before.id).single()
    expect(after).toEqual({ status: "done", store_file_id: before.store_file_id })
  }, 120_000)

  it("undo also trashes a file saved before a failure, and a second undo pass drops import records of files already in the trash", async () => {
    const { undoDriveImport } = await import("@/lib/crm-store/drive-import")
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    const { data: items } = await db.from("store_import_items").select("id, source_id, store_file_id").eq("run_id", g.run)
    const failedOne = items.find((x: { source_id: string }) => x.source_id === g.letter)
    const trashedOne = items.find((x: { source_id: string }) => x.source_id === g.letter2)
    // a failure after the save: the ledger keeps the file id
    await db.from("store_import_items").update({ status: "failed", reason: "test: failed after the save" }).eq("id", failedOne.id)
    // an undo that stopped half-way already trashed this one (its import record is still there)
    await deleteStoreFile(trashedOne.store_file_id, actor)
    await db.from("store_import_runs").update({ status: "undoing" }).eq("id", g.run)
    const v = await undoDriveImport(g.run, actor)
    expect(v.status).toBe("rolled_back")
    expect((await db.from("store_files").select("state").eq("id", failedOne.store_file_id).single()).data.state).toBe("trashed")
    const { count } = await db.from("store_external_refs").select("id", { count: "exact", head: true }).in("object_id", [failedOne.store_file_id, trashedOne.store_file_id]).eq("direction", "import")
    expect(count).toBe(0)
    expect((await db.from("documents").select("drive_file_id").eq("id", g.rowB).single()).data.drive_file_id).toBe(g.bPassport)
  }, 240_000)
})
