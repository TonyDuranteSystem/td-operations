/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ TRASH" rows), not business writes */
/**
 * CRM Store — the trash screen and restore (Antonio "go" 2026-09-28), LIVE against the SANDBOX.
 *   npx vitest run --config vitest.crm-store-live.config.ts
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
const post = (body: unknown) => new NextRequest("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const get = (url: string) => new NextRequest(url, { method: "GET" })
async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(row).select("id").single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data.id as string
}
async function upload(body: Record<string, unknown>) {
  const name = String(body.fileName)
  const path = `crm-uploads/store-staging/zz-trash-${tag}/${Math.random().toString(36).slice(2)}_${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`
  const { error } = await db.storage.from("onboarding-uploads").upload(path, await pdf(`${name} ${Math.random()}`), { contentType: "application/pdf", upsert: true })
  if (error) throw new Error(error.message)
  const { POST } = await import("@/app/api/crm-store/browse/upload/route")
  const r = await POST(post({ mimeType: "application/pdf", storagePath: path, ...body }))
  const j = await r.json()
  if (r.status !== 200) throw new Error(JSON.stringify(j))
  return j as { fileId: string; visible: boolean }
}
const who: Record<"antonio" | "luca", FakeUser> = {} as never
const fx = { account: "", owner: "", company1: "", contacts: "", person: "", personOwner: "" }

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  const all: FakeUser[] = []
  for (let page = 1; page <= 50; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 })
    all.push(...((data?.users ?? []) as FakeUser[]))
    if ((data?.users ?? []).length < 200) break
  }
  for (const [k, email] of [["antonio", "antonio.durante@tonydurante.us"], ["luca", "luca@tonydurante.us"]] as const) {
    const u = all.find((x) => x.email?.toLowerCase() === email)
    if (!u) throw new Error(`sandbox login ${email} missing`)
    who[k] = { id: u.id, email: u.email, app_metadata: u.app_metadata }
  }
  currentUser = who.antonio
  const { folderOfKind, ensurePersonOwner } = await import("@/lib/crm-store/formation-pilot")
  fx.account = await insert("accounts", { company_name: `ZZ TRASH LLC ${tag}`, status: "Active", state_of_formation: "WY" })
  fx.owner = (await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: fx.account })).data
  await db.rpc("store_apply_template", { p_owner_id: fx.owner, p_template_slug: "company_standard", p_root_name: `ZZ TRASH LLC ${tag}` })
  fx.company1 = await folderOfKind(fx.owner, "company")
  fx.contacts = await folderOfKind(fx.owner, "contacts")
  fx.person = await insert("contacts", { first_name: "Zz", last_name: `TRASH ${tag}`, full_name: `ZZ Person TRASH ${tag}`, email: `zz-trash-${tag}@example.test` })
  { const { error } = await db.from("account_contacts").insert({ account_id: fx.account, contact_id: fx.person }); if (error) throw new Error(error.message) }
  fx.personOwner = await ensurePersonOwner(fx.person, `ZZ Person TRASH ${tag}`)
}, 180_000)

describe("trash + restore — live sandbox", () => {
  it("a shared file deleted, then restored: back in its folder, its CRM listing back with the SAME links, but HIDDEN from the client", async () => {
    const up = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: `Articles ${tag}.pdf`, documentType: "articles_of_organization", visible: true })
    expect(up.visible).toBe(true)
    const { data: before } = await db.from("documents").select("id, account_id, contact_id, category, document_type_name").eq("drive_file_id", `store:${up.fileId}`).single()
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    await deleteStoreFile(up.fileId, who.antonio.id)
    const { data: gone } = await db.from("documents").select("id").eq("drive_file_id", `store:${up.fileId}`)
    expect(gone).toEqual([])
    const { GET } = await import("@/app/api/crm-store/browse/trash/route")
    const t = await (await GET(get(`http://x/api/crm-store/browse/trash?owner=${fx.owner}`))).json()
    const b = t.batches.find((x: { items: { id: string }[] }) => x.items.some((i) => i.id === up.fileId))
    expect(b).toBeTruthy()
    expect(b.purgeAfter).toBeTruthy()
    const { POST } = await import("@/app/api/crm-store/browse/trash/restore/route")
    const r = await POST(post({ batchId: b.batchId }))
    const j = await r.json()
    expect(r.status, JSON.stringify(j)).toBe(200)
    expect(j.files).toBe(1)
    const { data: f } = await db.from("store_files").select("state, folder_id, published").eq("id", up.fileId).single()
    expect(f).toEqual({ state: "live", folder_id: fx.company1, published: false })
    const { data: after } = await db.from("documents").select("id, account_id, contact_id, category, document_type_name, portal_visible").eq("drive_file_id", `store:${up.fileId}`).single()
    expect(after).toEqual({ ...before, portal_visible: false })
  })

  it("a person's document (both links) comes back with both links, hidden", async () => {
    const up = await upload({ ownerId: fx.owner, folderId: fx.contacts, fileName: `Passport ${tag}.pdf`, documentType: "passport", personContactId: fx.person, visible: true })
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    await deleteStoreFile(up.fileId, who.antonio.id)
    const { trashForOwner, restoreFromTrash } = await import("@/lib/crm-store/trash")
    const b = (await trashForOwner(fx.personOwner)).find((x) => x.items.some((i) => i.id === up.fileId))!
    await restoreFromTrash(b.batchId, who.antonio.id, null)
    const { data: row } = await db.from("documents").select("account_id, contact_id, portal_visible").eq("drive_file_id", `store:${up.fileId}`).single()
    expect(row).toEqual({ account_id: fx.account, contact_id: fx.person, portal_visible: false })
  })

  it("a deleted folder comes back with its files; a name taken meanwhile is not overwritten (renamed)", async () => {
    const { createFolder, deleteFolder } = await import("@/lib/crm-store/structure")
    const f = await createFolder(fx.company1, `Old papers ${tag}`, who.antonio.id)
    const a = await upload({ ownerId: fx.owner, folderId: f.id, fileName: "Inside.pdf", documentType: "business_license", visible: false })
    await deleteFolder(f.id, who.antonio.id)
    await createFolder(fx.company1, `Old papers ${tag}`, who.antonio.id) // same name again, meanwhile
    const { trashForOwner, restoreFromTrash } = await import("@/lib/crm-store/trash")
    const b = (await trashForOwner(fx.owner)).find((x) => x.items.some((i) => i.id === f.id))!
    expect(b.files).toBe(1)
    const r = await restoreFromTrash(b.batchId, who.antonio.id, null)
    expect(r.folders).toBe(1)
    expect(r.renamed.length).toBe(1)
    const { data: back } = await db.from("store_files").select("state").eq("id", a.fileId).single()
    expect(back.state).toBe("live")
    const { data: row } = await db.from("documents").select("portal_visible").eq("drive_file_id", `store:${a.fileId}`).single()
    expect(row.portal_visible).toBe(false)
  })

  it("the folder a file came from is gone → the screen is asked where to put it; restoring into a chosen folder works", async () => {
    const { createFolder, deleteFolder } = await import("@/lib/crm-store/structure")
    const f = await createFolder(fx.company1, `Gone ${tag}`, who.antonio.id)
    const a = await upload({ ownerId: fx.owner, folderId: f.id, fileName: "Orphan.pdf", documentType: "business_license", visible: false })
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    await deleteStoreFile(a.fileId, who.antonio.id) // the file first…
    await deleteFolder(f.id, who.antonio.id) // …then its folder
    const { trashForOwner } = await import("@/lib/crm-store/trash")
    const b = (await trashForOwner(fx.owner)).find((x) => x.items.some((i) => i.id === a.fileId))!
    const { POST } = await import("@/app/api/crm-store/browse/trash/restore/route")
    const r1 = await POST(post({ batchId: b.batchId }))
    expect(r1.status).toBe(409)
    expect((await r1.json()).needsTarget).toBe(true)
    const r2 = await POST(post({ batchId: b.batchId, targetFolderId: fx.company1 }))
    expect(r2.status, JSON.stringify(await r2.clone().json())).toBe(200)
    const { data: back } = await db.from("store_files").select("state, folder_id").eq("id", a.fileId).single()
    expect(back).toEqual({ state: "live", folder_id: fx.company1 })
  })

  it("My files: staff can't read its trash or restore from it; a restored shared file is shared with nobody", async () => {
    const { navigation } = await import("@/lib/crm-store/structure")
    const area = (await navigation({ id: who.antonio.id, email: who.antonio.email }, true)).find((x) => x.key === "private")!.owners[0].id
    const { data: share } = await db.from("store_folders").select("id").eq("owner_id", area).eq("kind", "staff_share").is("trashed_at", null).single()
    const up = await upload({ ownerId: area, folderId: share.id, fileName: `ZZ TRASH shared ${tag}.pdf`, documentType: "receipt" })
    const { setFileShares } = await import("@/lib/crm-store/staff-share")
    await setFileShares(up.fileId, [who.luca.id], who.antonio.id)
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    await deleteStoreFile(up.fileId, who.antonio.id)
    const { trashForOwner } = await import("@/lib/crm-store/trash")
    const b = (await trashForOwner(area)).find((x) => x.items.some((i) => i.id === up.fileId))!
    currentUser = who.luca
    const { GET } = await import("@/app/api/crm-store/browse/trash/route")
    expect((await GET(get(`http://x/api/crm-store/browse/trash?owner=${area}`))).status).toBe(404)
    const { POST } = await import("@/app/api/crm-store/browse/trash/restore/route")
    expect((await POST(post({ batchId: b.batchId }))).status).toBe(404)
    currentUser = who.antonio
    expect((await POST(post({ batchId: b.batchId }))).status).toBe(200)
    const { data: ticks } = await db.from("store_file_shares").select("user_id").eq("file_id", up.fileId)
    expect(ticks).toEqual([])
    const { data: rows } = await db.from("documents").select("id").eq("drive_file_id", `store:${up.fileId}`)
    expect(rows).toEqual([]) // My files never has a CRM listing
    await deleteStoreFile(up.fileId, who.antonio.id)
  })
})
