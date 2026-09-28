/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ SHARE" files), not business writes */
/**
 * CRM Store — My files shared by the owners + "Shared with staff" (Antonio 2026-09-28), LIVE against the SANDBOX.
 * Uses the sandbox's real logins: antonio.durante@ (primary owner), jodi@ (owner), support@ and luca@ (staff).
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
const get = (url = "http://x") => new NextRequest(url, { method: "GET" })

const who: Record<"antonio" | "jodi" | "support" | "luca", FakeUser> = {} as never
const fx = { area: "", share: "", other: "", fileA: "", fileB: "" }

async function upload(folderId: string, name: string) {
  currentUser = who.antonio
  const path = `crm-uploads/store-staging/zz-share-${tag}/${Math.random().toString(36).slice(2)}_${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`
  const { error } = await db.storage.from("onboarding-uploads").upload(path, await pdf(`${name} ${tag}`), { contentType: "application/pdf", upsert: true })
  if (error) throw new Error(error.message)
  const { POST } = await import("@/app/api/crm-store/browse/upload/route")
  const r = await POST(post({ ownerId: fx.area, folderId, storagePath: path, fileName: name, mimeType: "application/pdf", documentType: "receipt" }))
  const j = await r.json()
  if (r.status !== 200) throw new Error(JSON.stringify(j))
  return j.fileId as string
}

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  const all: FakeUser[] = []
  for (let page = 1; page <= 50; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 })
    all.push(...((data?.users ?? []) as FakeUser[]))
    if ((data?.users ?? []).length < 200) break
  }
  for (const [k, email] of [["antonio", "antonio.durante@tonydurante.us"], ["jodi", "jodi@tonydurante.us"], ["support", "support@tonydurante.us"], ["luca", "luca@tonydurante.us"]] as const) {
    const u = all.find((x) => x.email?.toLowerCase() === email)
    if (!u) throw new Error(`sandbox login ${email} missing`)
    who[k] = { id: u.id, email: u.email, app_metadata: u.app_metadata }
  }
  const { navigation } = await import("@/lib/crm-store/structure")
  const g = await navigation({ id: who.antonio.id, email: who.antonio.email }, true)
  fx.area = g.find((x) => x.key === "private")!.owners[0].id
  const { data: share } = await db.from("store_folders").select("id").eq("owner_id", fx.area).eq("kind", "staff_share").is("trashed_at", null).single()
  fx.share = share.id
  const { data: root } = await db.from("store_folders").select("id").eq("owner_id", fx.area).is("parent_id", null).single()
  fx.other = root.id
  fx.fileA = await upload(fx.share, `ZZ SHARE A ${tag}.pdf`)
  fx.fileB = await upload(fx.share, `ZZ SHARE B ${tag}.pdf`)
}, 180_000)

describe("owners' My files + Shared with staff — live sandbox", () => {
  it("Jodi (an owner) sees the SAME My files as Antonio; staff don't see My files at all", async () => {
    const { navigation } = await import("@/lib/crm-store/structure")
    const jodiNav = await navigation({ id: who.jodi.id, email: who.jodi.email }, true)
    expect(jodiNav.find((x) => x.key === "private")?.owners[0].id).toBe(fx.area)
    const lucaNav = await navigation({ id: who.luca.id, email: who.luca.email }, false)
    expect(lucaNav.some((x) => x.key === "private")).toBe(false)
    currentUser = who.jodi
    const { GET } = await import("@/app/api/crm-store/browse/folder/route")
    expect((await GET(get(`http://x/api/crm-store/browse/folder?owner=${fx.area}`))).status).toBe(200)
    currentUser = who.luca
    expect((await GET(get(`http://x/api/crm-store/browse/folder?owner=${fx.area}`))).status).toBe(404)
    expect((await GET(get(`http://x/api/crm-store/browse/folder?owner=${fx.area}&folder=${fx.share}`))).status).toBe(404)
  })

  it("the 'Shared with staff' folder is a fixed folder in My files, and its files start shared with nobody", async () => {
    const { data } = await db.from("store_folders").select("template_slug, parent_id, name").eq("id", fx.share).single()
    expect(data.template_slug).toBe("private_standard")
    expect(data.name).toBe("Shared with staff")
    const { folderContents } = await import("@/lib/crm-store/browse")
    const c = await folderContents(fx.area, fx.share)
    expect(c.files.find((f) => f.id === fx.fileA)?.sharedWith).toEqual([])
  })

  it("the tick list holds the staff logins and never an owner", async () => {
    currentUser = who.antonio
    const { GET } = await import("@/app/api/crm-store/browse/staff-logins/route")
    const logins = (await (await GET()).json()).logins as { userId: string }[]
    const ids = logins.map((l) => l.userId)
    expect(ids).toEqual(expect.arrayContaining([who.support.id, who.luca.id]))
    expect(ids).not.toContain(who.antonio.id)
    expect(ids).not.toContain(who.jodi.id)
    currentUser = who.luca
    expect((await GET()).status).toBe(404)
  })

  it("shared with support@ only: support opens it; Luca can't; nobody opens the unticked file; a staff login can't change the ticks", async () => {
    currentUser = who.jodi
    const shares = await import("@/app/api/crm-store/browse/file/[id]/shares/route")
    const r = await shares.POST(post({ userIds: [who.support.id] }), { params: { id: fx.fileA } })
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200)
    expect((await r.json()).sharedWith).toEqual([who.support.id])
    const file = await import("@/app/api/crm-store/browse/file/[id]/route")
    currentUser = who.support
    expect((await file.GET(get(), { params: { id: fx.fileA } })).status).toBe(200)
    expect((await file.GET(get(), { params: { id: fx.fileB } })).status).toBe(404)
    currentUser = who.luca
    expect((await file.GET(get(), { params: { id: fx.fileA } })).status).toBe(404)
    currentUser = who.support
    expect((await shares.POST(post({ userIds: [who.support.id, who.luca.id] }), { params: { id: fx.fileA } })).status).toBe(404)
    // read-only for staff: no rename / move / delete / versions / visibility through the shared file
    const rename = (await import("@/app/api/crm-store/browse/file/[id]/rename/route")).POST
    const del = (await import("@/app/api/crm-store/browse/file/[id]/delete/route")).POST
    const versions = (await import("@/app/api/crm-store/browse/file/[id]/versions/route")).GET
    expect((await rename(post({ name: "x" }), { params: { id: fx.fileA } })).status).toBe(404)
    expect((await del(post({}), { params: { id: fx.fileA } })).status).toBe(404)
    expect((await versions(get(), { params: { id: fx.fileA } })).status).toBe(404)
    const { data: ev } = await db.from("store_events").select("event, details").eq("file_id", fx.fileA).eq("event", "shared")
    expect(ev?.[0]?.details).toEqual({ staff_user: who.support.id })
  })

  it("support@'s Shared with me lists exactly the file ticked for them; Luca's is empty of it", async () => {
    currentUser = who.support
    const { GET } = await import("@/app/api/crm-store/browse/shared-with-me/route")
    const mine = (await (await GET()).json()).files as { id: string; where: string }[]
    expect(mine.map((f) => f.id)).toContain(fx.fileA)
    expect(mine.map((f) => f.id)).not.toContain(fx.fileB)
    expect(mine.find((f) => f.id === fx.fileA)?.where).toBe("Shared with staff")
    currentUser = who.luca
    expect(((await (await GET()).json()).files as { id: string }[]).map((f) => f.id)).not.toContain(fx.fileA)
  })

  it("the identical-file search never shows a staff member the owners' files", async () => {
    const { findIdenticalFiles } = await import("@/lib/crm-store/structure")
    const { data: v } = await db.from("store_files").select("store_file_versions!store_files_current_version_fk(sha256)").eq("id", fx.fileA).single()
    const sha = v.store_file_versions.sha256
    expect((await findIdenticalFiles(sha, { id: who.luca.id, ownerOnly: false })).map((h) => h.fileId)).not.toContain(fx.fileA)
    expect((await findIdenticalFiles(sha, { id: who.jodi.id, ownerOnly: true })).map((h) => h.fileId)).toContain(fx.fileA)
  })

  it("moved out of Shared with staff → nobody else can open it any more; sharing a file outside it is refused", async () => {
    const { moveStoreFile } = await import("@/lib/crm-store/file-actions")
    await moveStoreFile(fx.fileA, fx.other, who.antonio.id)
    const { data: left } = await db.from("store_file_shares").select("user_id").eq("file_id", fx.fileA)
    expect(left).toEqual([])
    const { canReadSharedFile, setFileShares } = await import("@/lib/crm-store/staff-share")
    expect(await canReadSharedFile(fx.fileA, who.support.id)).toBe(false)
    await expect(setFileShares(fx.fileA, [who.support.id], who.antonio.id)).rejects.toThrow(/Shared with staff first/)
    // an owner can't be ticked (they already see everything)
    await expect(setFileShares(fx.fileB, [who.jodi.id], who.antonio.id)).rejects.toThrow(/not a staff login/)
  })

  it("clean-up: the test files go to the trash", async () => {
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    await deleteStoreFile(fx.fileA, who.antonio.id)
    await deleteStoreFile(fx.fileB, who.antonio.id)
    const { data } = await db.from("store_files").select("state").in("id", [fx.fileA, fx.fileB])
    expect((data ?? []).every((f: { state: string }) => f.state === "trashed")).toBe(true)
  })
})
