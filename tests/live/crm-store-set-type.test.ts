/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ TYPE" rows), not business writes */
/**
 * CRM Store — "Set type" + the label questions, LIVE against the SANDBOX database (no Drive).
 * A company with two people and its new storage; files labelled wrongly are corrected: a "passport" filed as an
 * Operating Agreement goes to the person (same file), a company letter in a person's storage goes to the company,
 * a staff-only type is hidden, a return the client sees asks "filed copy?"; labels 2+ records use become questions,
 * the answers are read by the move, and "Re-check types" gives a moved file its type and brings its record over.
 *   npx vitest run --config vitest.crm-store-live.config.ts tests/live/crm-store-set-type.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const tag = Date.now()
const g: Record<string, string> = {}
let actor = ""

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
async function folder(ownerId: string, kind: string): Promise<string> {
  const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
  return folderOfKind(ownerId, kind)
}
/** a stored file + its CRM record (visible or not) */
async function file(ownerId: string, kind: string, name: string, type: string | null, label: string | null, visible: boolean, extra: Record<string, unknown> = {}): Promise<{ fileId: string; rowId: string }> {
  const { saveBytesToStore } = await import("@/lib/crm-store/writer")
  const w = await saveBytesToStore({ ownerId, folderId: await folder(ownerId, kind), name, mimeType: "application/pdf", bytes: await pdf(`${name} ${tag} ${Math.random()}`), callerKey: `zz-type:${tag}:${name}`, contentChanged: true, documentType: type, published: false, actor })
  const rowId = await insert("documents", { drive_file_id: `store:${w.fileId}`, file_name: name, account_id: g.account, document_type_name: label, category: 1, portal_visible: false, status: "classified", ...extra })
  if (visible) {
    const { setClientVisibility } = await import("@/lib/crm-store/browse")
    await setClientVisibility(w.fileId, true, actor)
  }
  return { fileId: w.fileId, rowId }
}
const sf = async (id: string) => (await db.from("store_files").select("owner_id, folder_id, document_type, published, filing_status, store_folders!store_files_folder_id_fkey(kind)").eq("id", id).single()).data
const row = async (id: string) => (await db.from("documents").select("drive_file_id, document_type_name, category, contact_id, account_id, portal_visible").eq("id", id).single()).data

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  const { data: u } = await db.from("store_events").select("actor").not("actor", "is", null).limit(1).single()
  actor = u.actor
  g.account = await insert("accounts", { company_name: `ZZ TYPE LLC ${tag}`, status: "Active", state_of_formation: "WY" })
  g.mario = await insert("contacts", { first_name: "Zz", last_name: `Mario ${tag}`, full_name: `ZZ TYPE Mario ${tag}`, email: `zz-type-m-${tag}@example.test` })
  g.anna = await insert("contacts", { first_name: "Zz", last_name: `Anna ${tag}`, full_name: `ZZ TYPE Anna ${tag}`, email: `zz-type-a-${tag}@example.test` })
  for (const c of [g.mario, g.anna]) {
    const { error } = await db.from("account_contacts").insert({ account_id: g.account, contact_id: c })
    if (error) throw new Error(error.message)
  }
  const { data: ownerId, error: oErr } = await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: g.account })
  if (oErr) throw new Error(oErr.message)
  const { error: tErr } = await db.rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: "company_standard", p_root_name: `ZZ TYPE LLC ${tag}` })
  if (tErr) throw new Error(tErr.message)
  g.company = ownerId
}, 120_000)

describe("Set type — correcting wrong labels (live sandbox)", () => {
  it("a passport labelled Operating Agreement: asks whose, then the SAME file moves to that person, still visible, record follows", async () => {
    const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
    const f = await file(g.company, "company", "Scan 1.pdf", "operating_agreement", "Operating Agreement", true)
    let q: unknown = null
    try { await setStoreFileType({ fileId: f.fileId, typeSlug: "passport", actorId: actor }) } catch (e) { q = e instanceof SetTypeQuestionError ? e.question : e }
    expect(q).toMatchObject({ kind: "person" })
    expect((q as { people: { contactId: string }[] }).people.map((p) => p.contactId).sort()).toEqual([g.mario, g.anna].sort())
    expect((await sf(f.fileId)).document_type).toBe("operating_agreement") // nothing changed when asked
    const r = await setStoreFileType({ fileId: f.fileId, typeSlug: "passport", actorId: actor, personContactId: g.mario })
    expect(r.movedTo).toMatch(/.+/)
    const after = await sf(f.fileId)
    const { data: owner } = await db.from("store_owners").select("kind, contact_id").eq("id", after.owner_id).single()
    expect(owner).toEqual({ kind: "person", contact_id: g.mario })
    expect(after).toMatchObject({ document_type: "passport", published: true })
    expect(after.store_folders.kind).toBe("personal")
    expect(await row(f.rowId)).toMatchObject({ drive_file_id: `store:${f.fileId}`, document_type_name: "Passport", category: 2, contact_id: g.mario, portal_visible: true })
    g.marioOwner = after.owner_id
  }, 120_000)

  it("a company letter in a person's storage moves to the company page it is opened from, record follows", async () => {
    const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
    const f = await file(g.marioOwner, "personal", "Letter IRS.pdf", "passport", "Passport", false, { contact_id: g.mario, category: 2 })
    // from the person's own page: asks which company (or keep)
    let q: unknown = null
    try { await setStoreFileType({ fileId: f.fileId, typeSlug: "ein_letter_irs", actorId: actor }) } catch (e) { q = e instanceof SetTypeQuestionError ? e.question : e }
    expect(q).toMatchObject({ kind: "company", companies: [{ ownerId: g.company }] })
    // from the company page: that company is the answer
    await setStoreFileType({ fileId: f.fileId, typeSlug: "ein_letter_irs", actorId: actor, viewingOwnerId: g.company })
    const after = await sf(f.fileId)
    expect(after.owner_id).toBe(g.company)
    expect(after.store_folders.kind).toBe("company")
    expect(await row(f.rowId)).toMatchObject({ document_type_name: "EIN Letter (IRS)", category: 1, contact_id: null, account_id: g.account })
  }, 120_000)

  it("\"keep\" leaves a company type in the person's storage; a staff-only type hides a visible file", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const k = await file(g.marioOwner, "personal", "Keep me.pdf", "passport", "Passport", false, { contact_id: g.mario, category: 2 })
    await setStoreFileType({ fileId: k.fileId, typeSlug: "office_lease", actorId: actor, companyOwnerId: "keep" })
    expect((await sf(k.fileId)).owner_id).toBe(g.marioOwner)
    const s = await file(g.company, "company", "Summary.pdf", "operating_agreement", "Operating Agreement", true)
    const r = await setStoreFileType({ fileId: s.fileId, typeSlug: "formation_summary", actorId: actor })
    expect(r.visible).toBe(false)
    expect((await sf(s.fileId)).published).toBe(false)
    expect((await row(s.rowId)).portal_visible).toBe(false)
  }, 120_000)

  it("a return the client sees: asks 'filed copy?' — 'hide' hides it as a draft, 'filed' keeps it visible and filed", async () => {
    const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
    const a = await file(g.company, "company", "Return A.pdf", "operating_agreement", "Operating Agreement", true)
    let q: unknown = null
    try { await setStoreFileType({ fileId: a.fileId, typeSlug: "form_1120", actorId: actor }) } catch (e) { q = e instanceof SetTypeQuestionError ? e.question : e }
    expect(q).toMatchObject({ kind: "filed" })
    await setStoreFileType({ fileId: a.fileId, typeSlug: "form_1120", actorId: actor, filedAnswer: "hide" })
    expect(await sf(a.fileId)).toMatchObject({ document_type: "form_1120", published: false, filing_status: "draft" })
    const b = await file(g.company, "company", "Return B.pdf", "operating_agreement", "Operating Agreement", true)
    await setStoreFileType({ fileId: b.fileId, typeSlug: "form_1120", actorId: actor, filedAnswer: "filed" })
    expect(await sf(b.fileId)).toMatchObject({ document_type: "form_1120", published: true, filing_status: "filed" })
    // a filed return keeps its type
    await expect(setStoreFileType({ fileId: b.fileId, typeSlug: "operating_agreement", actorId: actor })).rejects.toThrow(/filed and frozen/)
  }, 120_000)

  it("a type needing TWO answers (Form 1040-NR on a company file the client sees): whose, then filed? — both kept, lands in the person's tax folder", async () => {
    const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
    const f = await file(g.company, "company", "NR return.pdf", "operating_agreement", "Operating Agreement", true)
    const ask = async (extra: Record<string, unknown>) => { try { await setStoreFileType({ fileId: f.fileId, typeSlug: "form_1040_nr", actorId: actor, ...extra }); return null } catch (e) { if (e instanceof SetTypeQuestionError) return e.question; throw e } }
    expect(await ask({})).toMatchObject({ kind: "person" })
    expect(await ask({ personContactId: g.anna })).toMatchObject({ kind: "filed" })
    expect(await ask({ personContactId: g.anna, filedAnswer: "filed" })).toBeNull()
    const after = await sf(f.fileId)
    expect(after).toMatchObject({ document_type: "form_1040_nr", published: true, filing_status: "filed" })
    expect(["person_tax_year", "person_tax"]).toContain(after.store_folders.kind)
    expect(await row(f.rowId)).toMatchObject({ contact_id: g.anna, category: 2, portal_visible: true })
  }, 120_000)

  it("a personal type on a file already in a person's storage gives its record that person (never an unresolved personal document)", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const f = await file(g.marioOwner, "personal", "ID scan.pdf", "office_lease", "Office Lease", false, { contact_id: null, category: 1 })
    await setStoreFileType({ fileId: f.fileId, typeSlug: "passport", actorId: actor })
    expect(await row(f.rowId)).toMatchObject({ contact_id: g.mario, category: 2 })
  }, 120_000)

  it("a return goes into ITS year folder (the record's tax year), never whichever year folder comes first", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const { ensurePersonOwner } = await import("@/lib/crm-store/formation-pilot")
    const { createTaxYear } = await import("@/lib/crm-store/structure")
    const annaOwner = await ensurePersonOwner(g.anna, `ZZ TYPE Anna ${tag}`)
    const tax = await folder(annaOwner, "person_tax")
    await createTaxYear(tax, "2022", actor)
    const y2024 = await createTaxYear(tax, "2024", actor)
    const f = await file(g.company, "company", "NR 2024.pdf", "operating_agreement", "Operating Agreement", false, { tax_year: 2024 })
    await setStoreFileType({ fileId: f.fileId, typeSlug: "form_1040_nr", actorId: actor, personContactId: g.anna })
    const after = (await db.from("store_files").select("folder_id, period_year").eq("id", f.fileId).single()).data
    expect(after).toEqual({ folder_id: y2024.id, period_year: 2024 })
  }, 120_000)

  it("a file the client sees in a person's storage is never moved into a company without asking (co-members would see it)", async () => {
    const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
    const f = await file(g.marioOwner, "personal", "Statement Mario.pdf", "passport", "Passport", true, { contact_id: g.mario, category: 2 })
    let q: unknown = null
    try { await setStoreFileType({ fileId: f.fileId, typeSlug: "office_lease", actorId: actor, viewingOwnerId: g.company }) } catch (e) { q = e instanceof SetTypeQuestionError ? e.question : e }
    expect(q).toMatchObject({ kind: "company", clientSees: true })
    expect((await sf(f.fileId)).owner_id).toBe(g.marioOwner)
  }, 120_000)

  it("only the company's live people are offered (a former member is not)", async () => {
    const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
    const gone = await insert("contacts", { first_name: "Zz", last_name: `Gone ${tag}`, full_name: `ZZ TYPE Gone ${tag}`, email: `zz-type-g-${tag}@example.test` })
    const { error } = await db.from("account_contacts").insert({ account_id: g.account, contact_id: gone, ended_at: new Date().toISOString() })
    if (error) throw new Error(error.message)
    const f = await file(g.company, "company", "Who.pdf", "operating_agreement", "Operating Agreement", false)
    let q: { people?: { contactId: string }[] } | null = null
    try { await setStoreFileType({ fileId: f.fileId, typeSlug: "passport", actorId: actor }) } catch (e) { q = e instanceof SetTypeQuestionError ? e.question as never : null }
    expect(q?.people?.map((x) => x.contactId)).not.toContain(gone)
    await expect(setStoreFileType({ fileId: f.fileId, typeSlug: "passport", actorId: actor, personContactId: gone })).rejects.toThrow(/not in this company/)
  }, 120_000)
})

describe("label questions + the move's Re-check (live sandbox)", () => {
  const label = `ZZ Label ${tag}`
  it("a label on 2+ records becomes ONE question; a one-off label is never asked", async () => {
    await insert("documents", { drive_file_id: `zz-drive-a-${tag}`, file_name: "a.pdf", account_id: g.account, document_type_name: label, category: 1, portal_visible: false, status: "classified" })
    const { queueTypeName, scanUnknownTypeNames, listTypeQuestions } = await import("@/lib/crm-store/type-names")
    expect(await queueTypeName(label, { from: "test" })).toBe(false) // one record only
    await insert("documents", { drive_file_id: `zz-drive-b-${tag}`, file_name: "b.pdf", account_id: g.account, document_type_name: label, category: 1, portal_visible: true, status: "classified" })
    await scanUnknownTypeNames(actor)
    await scanUnknownTypeNames(actor) // twice: still one question
    const qs = (await listTypeQuestions()).filter((q) => q.label === label)
    expect(qs).toHaveLength(1)
    expect(qs[0].records).toBe(2)
    g.question = qs[0].id
  }, 120_000)

  it("the answer ('same as Office Lease') is read by the move; Re-check gives the moved file its type and brings its visible record over", async () => {
    const { answerTypeQuestion, typeNameAnswers } = await import("@/lib/crm-store/type-names")
    await answerTypeQuestion(g.question, { kind: "same", typeSlug: "office_lease" }, actor)
    expect((await typeNameAnswers()).get(label.toLowerCase())).toBe("office_lease")
    await expect(answerTypeQuestion(g.question, { kind: "reject" }, actor)).rejects.toThrow(/already answered/)
    // a finished move that stored "b.pdf" without a type, its visible record left on Drive (Needs a type)
    const { saveBytesToStore } = await import("@/lib/crm-store/writer")
    const w = await saveBytesToStore({ ownerId: g.company, folderId: await folder(g.company, "correspondence"), name: "b.pdf", mimeType: "application/pdf", bytes: await pdf(`b ${tag}`), callerKey: `zz-type:${tag}:moved-b`, contentChanged: true, documentType: null, published: false, actor })
    const run = await insert("store_import_runs", { account_id: g.account, owner_id: g.company, drive_folder_id: `zz-${tag}`, status: "done", started_by: actor })
    const item = await insert("store_import_items", { run_id: run, source: "drive", source_id: `zz-drive-b-${tag}`, drive_path: ["5. Correspondence"], name: "b.pdf", status: "done", store_file_id: w.fileId, reason: "The client could see this but it has no type — its CRM record still opens from Drive until it gets one (Needs a type).", repointed: [] })
    const { recheckRunTypes, runView } = await import("@/lib/crm-store/drive-import")
    expect(await recheckRunTypes(run, actor)).toEqual({ typed: 1, needAnswer: 0, stillUnknown: 0, failed: 0 })
    expect((await sf(w.fileId))).toMatchObject({ document_type: "office_lease", published: true })
    const { data: rec } = await db.from("documents").select("drive_file_id, document_type_name, portal_visible").eq("drive_file_id", `store:${w.fileId}`).single()
    expect(rec).toEqual({ drive_file_id: `store:${w.fileId}`, document_type_name: "Office Lease", portal_visible: true })
    const { data: it } = await db.from("store_import_items").select("reason, repointed").eq("id", item).single()
    expect(it.reason).not.toMatch(/Needs a type/)
    expect(it.repointed).toEqual([expect.objectContaining({ drive_file_id: `zz-drive-b-${tag}` })]) // Undo can put it back
    expect((await runView(run)).report?.waitingForType ?? []).toHaveLength(0)
  }, 120_000)

  it("Undo of that move puts the record back on Drive AND back to what it said before (label, category)", async () => {
    const { undoDriveImport } = await import("@/lib/crm-store/drive-import")
    const { data: it } = await db.from("store_import_items").select("run_id").eq("source_id", `zz-drive-b-${tag}`).single()
    expect((await undoDriveImport(it.run_id, actor)).status).toBe("rolled_back")
    const { data: back } = await db.from("documents").select("drive_file_id, document_type_name, category").eq("drive_file_id", `zz-drive-b-${tag}`).single()
    expect(back).toEqual({ drive_file_id: `zz-drive-b-${tag}`, document_type_name: label, category: 1 })
  }, 120_000)

  /** a finished move that stored a file WITHOUT a type while the client sees its record on Drive */
  async function driveLeft(name: string): Promise<{ fileId: string; rowId: string; driveId: string }> {
    const { saveBytesToStore } = await import("@/lib/crm-store/writer")
    const driveId = `zz-drive-${name.replace(/\W/g, "")}-${tag}`
    const w = await saveBytesToStore({ ownerId: g.company, folderId: await folder(g.company, "correspondence"), name, mimeType: "application/pdf", bytes: await pdf(`${name} ${tag}`), callerKey: `zz-type:${tag}:left-${name}`, contentChanged: true, documentType: null, published: false, actor })
    const rowId = await insert("documents", { drive_file_id: driveId, file_name: name, account_id: g.account, category: 5, portal_visible: true, status: "classified" })
    const run = await insert("store_import_runs", { account_id: g.account, owner_id: g.company, drive_folder_id: `zz-${tag}-${name}`, status: "done", started_by: actor })
    await insert("store_import_items", { run_id: run, source: "drive", source_id: driveId, drive_path: ["5. Correspondence"], name, status: "done", store_file_id: w.fileId, reason: "The client could see this but it has no type — its CRM record still opens from Drive until it gets one (Needs a type).", repointed: [] })
    return { fileId: w.fileId, rowId, driveId }
  }

  it("a Drive-left visible file given a RETURN type asks 'filed copy?' (the client sees it); 'hide' → store and record both hidden, never a visible draft", async () => {
    const { setStoreFileType, SetTypeQuestionError } = await import("@/lib/crm-store/set-type")
    const x = await driveLeft("Left return.pdf")
    let q: unknown = null
    try { await setStoreFileType({ fileId: x.fileId, typeSlug: "form_1120", actorId: actor }) } catch (e) { q = e instanceof SetTypeQuestionError ? e.question : e }
    expect(q).toMatchObject({ kind: "filed" })
    await setStoreFileType({ fileId: x.fileId, typeSlug: "form_1120", actorId: actor, filedAnswer: "hide" })
    expect(await sf(x.fileId)).toMatchObject({ published: false, filing_status: "draft" })
    expect(await row(x.rowId)).toMatchObject({ drive_file_id: `store:${x.fileId}`, portal_visible: false })
  }, 120_000)

  it("a Drive-left visible file given a STAFF-ONLY type: record hidden with the store (the portal never lists it)", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const x = await driveLeft("Left summary.pdf")
    const r = await setStoreFileType({ fileId: x.fileId, typeSlug: "formation_summary", actorId: actor })
    expect(r.visible).toBe(false)
    expect(await row(x.rowId)).toMatchObject({ drive_file_id: `store:${x.fileId}`, portal_visible: false })
    expect((await sf(x.fileId)).published).toBe(false)
  }, 120_000)

  it("two tabs setting the type of the same Drive-left file at once: one record on the store, one ledger entry, nothing reverted", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const x = await driveLeft("Left twice.pdf")
    const res = await Promise.allSettled([
      setStoreFileType({ fileId: x.fileId, typeSlug: "office_lease", actorId: actor }),
      setStoreFileType({ fileId: x.fileId, typeSlug: "office_lease", actorId: actor }),
    ])
    expect(res.some((r) => r.status === "fulfilled")).toBe(true)
    expect(await row(x.rowId)).toMatchObject({ drive_file_id: `store:${x.fileId}`, portal_visible: true })
    expect((await sf(x.fileId)).published).toBe(true)
    const { data: it } = await db.from("store_import_items").select("repointed").eq("source_id", x.driveId).single()
    expect(it.repointed.filter((r: { id: string }) => r.id === x.rowId)).toHaveLength(1)
  }, 120_000)

  it("a hidden record the move listed that staff edited since is never removed to make room: both stay, staff told", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const x = await driveLeft("Left listed.pdf")
    // the move had listed the stored copy (hidden) — and staff worked on that listing since
    const listed = await insert("documents", { drive_file_id: `store:${x.fileId}`, file_name: "Left listed.pdf", account_id: g.account, category: 5, portal_visible: false, status: "classified", created_at: new Date(Date.now() - 3_600_000).toISOString() })
    await db.from("store_import_items").update({ repointed: [{ id: listed, drive_file_id: `store:${x.fileId}`, drive_link: null, created: true }] }).eq("source_id", x.driveId)
    const r = await setStoreFileType({ fileId: x.fileId, typeSlug: "office_lease", actorId: actor })
    expect(r.notes.join(" ")).toMatch(/changed since the move/)
    expect((await db.from("documents").select("id").eq("id", listed).maybeSingle()).data).toEqual({ id: listed })
    expect(await row(x.rowId)).toMatchObject({ drive_file_id: x.driveId, portal_visible: true })
  }, 120_000)

  it("a file's own record that shows a file the storage keeps hidden is lined up (a staff-only type hides both)", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const f = await file(g.company, "company", "Mismatch.pdf", "operating_agreement", "Operating Agreement", false)
    await db.from("documents").update({ portal_visible: true }).eq("id", f.rowId) // the mismatch an old path left
    await setStoreFileType({ fileId: f.fileId, typeSlug: "formation_summary", actorId: actor })
    expect((await sf(f.fileId)).published).toBe(false)
    expect((await row(f.rowId)).portal_visible).toBe(false)
  }, 120_000)

  it("a Drive-left visible file whose new home can't show it yet (Needs review) keeps opening from Drive — the client keeps it", async () => {
    const { setStoreFileType } = await import("@/lib/crm-store/set-type")
    const { markNeedsReview } = await import("@/lib/crm-store/structure")
    const x = await driveLeft("Left letter.pdf")
    await markNeedsReview(x.fileId, "test", actor)
    const r = await setStoreFileType({ fileId: x.fileId, typeSlug: "office_lease", actorId: actor })
    expect(r.notes.join(" ")).toMatch(/still opens from Drive/)
    expect(await row(x.rowId)).toMatchObject({ drive_file_id: x.driveId, portal_visible: true })
    const { data: it } = await db.from("store_import_items").select("repointed, reason").eq("source_id", x.driveId).single()
    expect(it.repointed).toEqual([])
    expect(it.reason).toMatch(/Needs a type/) // still listed as waiting
  }, 120_000)
})
