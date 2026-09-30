/**
 * LIVE (sandbox): the store reads what is INSIDE a file — a PDF by its words (not its name), a HEIC photo after
 * conversion — and the word-by-word comparison tells two near-identical leases apart. ZZ fixtures only.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const tag = Date.now()

async function pdf(lines: string[]): Promise<Buffer> {
  const d = await PDFDocument.create({ updateMetadata: false })
  const f = await d.embedFont(StandardFonts.Helvetica)
  const page = d.addPage([612, 792])
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 740 - i * 18, size: 11, font: f }))
  return Buffer.from(await d.save())
}
const LEASE = ["RENT OFFICE AGREEMENT", "This Virtual Office Agreement is effective as of 03/10/2024 between Tony Durante LLC and ZZ TENANT LLC.", "Rent is 150 dollars per month.", "Title Owner Tenant By Signature Mario Cerbone"]
const ids: Record<string, string> = {}
async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(row).select("id").single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data.id as string
}

beforeAll(async () => {
  const p = { id: await insert("contacts", { first_name: "Zz", last_name: `Read ${tag}`, full_name: `ZZ READ Person ${tag}`, email: `zz-read-${tag}@example.test` }) }
  const { ensurePersonOwner, folderOfKind } = await import("@/lib/crm-store/formation-pilot")
  const owner = await ensurePersonOwner(p.id, `ZZ READ Person ${tag}`)
  const folder = await folderOfKind(owner, "personal")
  const { saveBytesToStore } = await import("@/lib/crm-store/writer")
  const save = async (key: string, name: string, mimeType: string, bytes: Buffer) => {
    ids[key] = (await saveBytesToStore({ ownerId: owner, folderId: folder, name, mimeType, bytes, callerKey: `zz-read:${tag}:${key}`, contentChanged: true })).fileId
  }
  await save("cert", "Resolution.pdf", "application/pdf", await pdf(["CERTIFICATE OF FORMATION OF ZZ Test Company LLC", "State of Delaware Secretary of State Division of Corporations", "FIRST: The name of the limited liability company is ZZ Test Company LLC"]))
  await save("leaseA", "Office Lease.pdf", "application/pdf", await pdf(LEASE))
  await save("leaseB", "Office Lease.pdf", "application/pdf", await pdf(LEASE.map((l) => l.replace("Title Owner", "AS A2 Title Owner"))))
  await save("leaseC", "Office Lease.pdf", "application/pdf", await pdf(LEASE))
  await save("heic", "Unclassified.HEIC", "application/octet-stream", readFileSync("tests/fixtures/tiny.heic"))
}, 240_000)

describe("reading inside stored files", () => {
  it("a PDF called 'Resolution' is recognised by its words as a Certificate of Formation", async () => {
    const { readStoreFileContent } = await import("@/lib/crm-store/read-content")
    const r = await readStoreFileContent(ids.cert)
    expect(r.problem).toBeNull()
    expect(r.suggestedType).toBe("Articles of Organization")
  }, 120_000)

  it("a HEIC photo is converted and sent to the reader without failing (this one has no words)", async () => {
    const { readStoreFileContent } = await import("@/lib/crm-store/read-content")
    const r = await readStoreFileContent(ids.heic)
    expect(r.converted).toBe(true)
    expect(r.problem).toMatch(/No words|do not match/)
  }, 120_000)

  it("two leases that differ only by signature marks are told apart; a true re-save is identical", async () => {
    const { readStoreFileContent } = await import("@/lib/crm-store/read-content")
    const { compareTexts } = await import("@/lib/crm-store/content-compare")
    const [a, b, c] = await Promise.all([ids.leaseA, ids.leaseB, ids.leaseC].map((i) => readStoreFileContent(i)))
    expect(a.text.trim().length).toBeGreaterThan(50)
    const ab = compareTexts(a.text, b.text)
    expect(ab.identical).toBe(false)
    expect(ab.differences.flatMap((d) => d.onlyInB).join(" ")).toMatch(/AS/)
    expect(compareTexts(a.text, c.text).identical).toBe(true)
  }, 180_000)
})
