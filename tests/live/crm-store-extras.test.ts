/* eslint-disable no-restricted-syntax -- sandbox-only live-test fixtures ("ZZ EXTRA" rows), not business writes */
/**
 * CRM Store — filters, file details, folder zip (logged), dragged-folder structure. LIVE against the SANDBOX.
 *   npx vitest run --config vitest.crm-store-live.config.ts
 */
import { describe, it, expect, beforeAll, vi } from "vitest"
import { NextRequest } from "next/server"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { unzipSync } from "fflate"

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
async function upload(body: Record<string, unknown>) {
  const name = String(body.fileName)
  const path = `crm-uploads/store-staging/zz-extra-${tag}/${Math.random().toString(36).slice(2)}_${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`
  const { error } = await db.storage.from("onboarding-uploads").upload(path, await pdf(`${name} ${Math.random()}`), { contentType: "application/pdf", upsert: true })
  if (error) throw new Error(error.message)
  const { POST } = await import("@/app/api/crm-store/browse/upload/route")
  const r = await POST(post({ mimeType: "application/pdf", storagePath: path, ...body }))
  const j = await r.json()
  if (r.status !== 200) throw new Error(JSON.stringify(j))
  return j as { fileId: string }
}
const fx = { account: "", owner: "", company1: "", tax: "", admin: null as FakeUser | null }

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(SANDBOX_REF)).toBe(true)
  process.env.SANDBOX_MODE = "1"
  const all: FakeUser[] = []
  for (let page = 1; page <= 50; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 })
    all.push(...((data?.users ?? []) as FakeUser[]))
    if ((data?.users ?? []).length < 200) break
  }
  const a = all.find((u) => u.email?.toLowerCase() === "antonio.durante@tonydurante.us")!
  fx.admin = { id: a.id, email: a.email, app_metadata: a.app_metadata }
  currentUser = fx.admin
  const { data: acc, error } = await db.from("accounts").insert({ company_name: `ZZ EXTRA LLC ${tag}`, status: "Active", state_of_formation: "WY" }).select("id").single()
  if (error) throw new Error(error.message)
  fx.account = acc.id
  fx.owner = (await db.rpc("store_ensure_owner", { p_kind: "company", p_ref: fx.account })).data
  await db.rpc("store_apply_template", { p_owner_id: fx.owner, p_template_slug: "company_standard", p_root_name: `ZZ EXTRA LLC ${tag}` })
  const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
  fx.company1 = await folderOfKind(fx.owner, "company")
  fx.tax = await folderOfKind(fx.owner, "tax")
}, 180_000)

describe("filters, details, zip, dragged folders — live sandbox", () => {
  it("filters list the matching files across ALL the storage's folders, each with where it lives", async () => {
    const shown = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: "Shown.pdf", documentType: "articles_of_organization", visible: true })
    const review = await upload({ ownerId: fx.owner, folderId: fx.tax, fileName: "Check me.pdf", documentType: "irs_notice", visible: false, needsReview: "check it" })
    const { GET } = await import("@/app/api/crm-store/browse/filter/route")
    const s = (await (await GET(get(`http://x/api/crm-store/browse/filter?owner=${fx.owner}&kind=shown`))).json()).files as { id: string; where: string }[]
    expect(s.map((f) => f.id)).toEqual([shown.fileId])
    expect(s[0].where).toBe("1. Company")
    const r = (await (await GET(get(`http://x/api/crm-store/browse/filter?owner=${fx.owner}&kind=review`))).json()).files as { id: string; where: string }[]
    expect(r.map((f) => f.id)).toEqual([review.fileId])
    expect(r[0].where).toBe("3. Tax")
    expect((await GET(get(`http://x/api/crm-store/browse/filter?owner=${fx.owner}&kind=bogus`))).status).toBe(400)
  })

  it("the details panel says what the file is, who uploaded it, whether the client sees it, and every version", async () => {
    const up = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: "Detail.pdf", documentType: "business_license", visible: true })
    await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: "Detail.pdf", documentType: "business_license", visible: true })
    const { GET } = await import("@/app/api/crm-store/browse/file/[id]/details/route")
    const d = await (await GET(get("http://x"), { params: { id: up.fileId } })).json()
    expect(d).toMatchObject({ name: "Detail.pdf", where: "1. Company", typeName: "Business License", clientCanSee: true, listed: true, sharedWithStaff: null })
    expect(d.versions.length).toBe(2)
    expect(d.createdBy).toBeTruthy()
  })

  it("a folder downloads as a zip with its sub-folders, and the download is recorded", async () => {
    const { ensureFolderPath } = await import("@/lib/crm-store/extras")
    const sub = await ensureFolderPath(fx.company1, ["Deeds", "2020"], fx.admin!.id)
    await upload({ ownerId: fx.owner, folderId: sub.id, fileName: "Deed.pdf", documentType: "business_license", visible: false })
    const { GET } = await import("@/app/api/crm-store/browse/folder/[id]/zip/route")
    const r = await GET(get("http://x"), { params: { id: fx.company1 } })
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("application/zip")
    const names = Object.keys(unzipSync(new Uint8Array(await r.arrayBuffer())))
    expect(names).toEqual(expect.arrayContaining(["Shown.pdf", "Detail.pdf", "Deeds/2020/Deed.pdf"]))
    const { data: ev } = await db.from("store_events").select("details").eq("folder_id", fx.company1).eq("event", "zip_downloaded")
    expect(ev?.length).toBeGreaterThan(0)
  })

  it("a dragged folder's path is made once and reused; bad names and '2. Contacts' are refused", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/folder/[id]/ensure-path/route")
    const a = await (await POST(post({ path: ["Scans", "Old"] }), { params: { id: fx.tax } })).json()
    const b = await (await POST(post({ path: ["scans", "old"] }), { params: { id: fx.tax } })).json()
    expect(a.id).toBeTruthy()
    expect(b.id).toBe(a.id)
    expect((await POST(post({ path: ["a/b"] }), { params: { id: fx.tax } })).status).toBe(400)
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const contacts = await folderOfKind(fx.owner, "contacts")
    expect((await (await POST(post({ path: ["X"] }), { params: { id: contacts } })).json()).error).toMatch(/Contacts/)
  })

  it("a dropped folder '2024/W2s' onto Tax: '2024' becomes a real tax-year folder; the files below still count as Tax; the very top is refused", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/folder/[id]/ensure-path/route")
    const r = await (await POST(post({ path: ["2024", "W2s"] }), { params: { id: fx.tax } })).json()
    expect(r.kind).toBe("tax_year") // effective kind of W2s = the year folder above it
    const { data: year } = await db.from("store_folders").select("kind, template_slug").eq("parent_id", fx.tax).eq("name", "2024").is("trashed_at", null).single()
    expect(year).toEqual({ kind: "tax_year", template_slug: null })
    const again = await (await POST(post({ path: ["2024", "W2s"] }), { params: { id: fx.tax } })).json()
    expect(again.id).toBe(r.id)
    const plain = await (await POST(post({ path: ["Receipts"] }), { params: { id: fx.tax } })).json()
    expect(plain.kind).toBe("tax") // a staff folder under Tax → the upload still asks which year
    const { data: root } = await db.from("store_folders").select("id").eq("owner_id", fx.owner).is("parent_id", null).single()
    expect((await (await POST(post({ path: ["X"] }), { params: { id: root.id } })).json()).error).toMatch(/fixed folders/)
    expect((await (await POST(post({ path: Array.from({ length: 21 }, (_, n) => `L${n}`) }), { params: { id: fx.tax } })).json()).error).toMatch(/20 levels/)
  })

  it("the zip is checked first (an empty folder answers with a message), and a group Show refuses a personal document", async () => {
    const { GET } = await import("@/app/api/crm-store/browse/folder/[id]/zip/route")
    const { folderOfKind } = await import("@/lib/crm-store/formation-pilot")
    const banking = await folderOfKind(fx.owner, "banking")
    const empty = await GET(get("http://x/zip?check=1"), { params: { id: banking } })
    expect(empty.status).toBe(400)
    expect((await empty.json()).error).toMatch(/no files/)
    const ok = await GET(get("http://x/zip?check=1"), { params: { id: fx.company1 } })
    expect((await ok.json()).ok).toBe(true)
    // a person's passport, shown as a group → refused; from its own button → fine
    const { ensurePersonOwner } = await import("@/lib/crm-store/formation-pilot")
    const { data: c } = await db.from("contacts").insert({ first_name: "Zz", last_name: `EXTRA ${tag}`, full_name: `ZZ Person EXTRA ${tag}`, email: `zz-extra-${tag}@example.test` }).select("id").single()
    await db.from("account_contacts").insert({ account_id: fx.account, contact_id: c.id })
    const po = await ensurePersonOwner(c.id, `ZZ Person EXTRA ${tag}`)
    const personal = await folderOfKind(po, "personal")
    const pp = await upload({ ownerId: po, folderId: personal, fileName: "Passport.pdf", documentType: "passport", visible: false })
    const vis = await import("@/app/api/crm-store/browse/file/[id]/visibility/route")
    const g = await vis.POST(post({ visible: true, group: true }), { params: { id: pp.fileId } })
    expect((await g.json()).error).toMatch(/one by one/)
    const one = await vis.POST(post({ visible: true }), { params: { id: pp.fileId } })
    expect(one.status, JSON.stringify(await one.clone().json())).toBe(200)
  })

  it("a download that can't be recorded is refused", async () => {
    const { logZipDownload } = await import("@/lib/crm-store/extras")
    await expect(logZipDownload("00000000-0000-4000-8000-000000000000", 1, 1, fx.admin!.id)).rejects.toThrow(/not found/i)
  })

  it("a file saved in a staff folder under a year folder gets that year (Tax › 2024 › Bank → 2024)", async () => {
    const { POST } = await import("@/app/api/crm-store/browse/folder/[id]/ensure-path/route")
    const r = await (await POST(post({ path: ["2024", "Bank"] }), { params: { id: fx.tax } })).json()
    const up = await upload({ ownerId: fx.owner, folderId: r.id, fileName: "Statement.pdf", documentType: "irs_notice", visible: false })
    const { data } = await db.from("store_files").select("period_year").eq("id", up.fileId).single()
    expect(data.period_year).toBe(2024)
    const plain = await upload({ ownerId: fx.owner, folderId: fx.company1, fileName: "NoYear.pdf", documentType: "business_license", visible: false })
    const { data: d2 } = await db.from("store_files").select("period_year").eq("id", plain.fileId).single()
    expect(d2.period_year).toBeNull()
  })
})
