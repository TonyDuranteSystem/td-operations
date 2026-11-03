/**
 * An applicant's passport, proof of address, ITIN letter and the answers PDF must NEVER be queued for the AI reader (File
 * Understanding) when they are saved in CRM Storage. Run the real archive step against a fake database and fake Storage writer,
 * and look at what it actually tells the writer — every save, not just one. (Bug hunter, 2026-11-03: the archive did not opt out.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  saves: [] as Record<string, unknown>[],
  removed: [] as string[][],
  files: [] as { key: string; name: string; path: string }[],
}))

vi.mock("@/lib/crm-store/structure", () => ({ ensureArea: async () => "owner-1" }))
vi.mock("@/lib/crm-store/writer", () => ({
  saveBytesToStore: async (input: Record<string, unknown>) => {
    h.saves.push(input)
    return { fileId: `file-${h.saves.length}` }
  },
}))
vi.mock("@/lib/bofa-intake/files", () => ({ readSubmissionFile: async () => Buffer.from("bytes") }))
vi.mock("@/lib/bofa-intake/summary-pdf", () => ({ buildSummaryPdf: async () => Buffer.from("pdf") }))
vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    let kind = "select"
    for (const f of ["select", "eq", "is", "limit", "not", "neq"]) b[f] = () => b
    b.update = () => { kind = "update"; return b }
    const result = () => {
      if (table === "bofa_intake_requests" && kind === "select") {
        return { data: { id: "req1", status: "completed", partner_name: null, label: "L", form_data: { full_name: "Jordan Smith" }, files: h.files, completed_at: "2026-11-03T10:00:00Z", store_archived_at: null, store_folder_id: null }, error: null }
      }
      if (table === "store_folders") return { data: { id: "root-1" }, error: null }
      return { data: null, error: null }
    }
    b.maybeSingle = () => Promise.resolve(result())
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej)
    return b
  }
  return {
    supabaseAdmin: {
      from: builder,
      rpc: async () => ({ data: "folder-1", error: null }),
      storage: { from: () => ({ remove: async (paths: string[]) => { h.removed.push(paths); return { error: null } } }) },
    },
  }
})

import { archiveSubmission } from "@/lib/bofa-intake/archive"

beforeEach(() => {
  h.saves = []
  h.removed = []
  h.files = [
    { key: "passport", name: "IMG_4521.HEIC", path: "t/passport/a" },
    { key: "proof_of_address", name: "bill.pdf", path: "t/proof_of_address/b" },
    { key: "itin_letter", name: "itin.pdf", path: "t/itin_letter/c" },
  ]
})

describe("archiving a bank application", () => {
  it("saves every document AND the answers PDF, and tells the writer to keep ALL of them away from the AI reader", async () => {
    const r = await archiveSubmission("req1")
    expect(r.ok).toBe(true)
    expect(h.saves).toHaveLength(4) // three documents + the answers PDF
    for (const s of h.saves) expect(s.skipAnalysis).toBe(true)
  })

  it("still converts an iPhone photo to a JPEG and still removes the temporary copies afterwards", async () => {
    await archiveSubmission("req1")
    const documents = h.saves.filter((s) => !String(s.callerKey).endsWith(":answers"))
    expect(documents).toHaveLength(3)
    for (const s of documents) expect(s.convertHeic).toBe(true)
    expect(h.removed).toEqual([["t/passport/a", "t/proof_of_address/b", "t/itin_letter/c"]])
  })

  it("keeps each save private to staff (not published) and keyed so a retry never duplicates", async () => {
    await archiveSubmission("req1")
    for (const s of h.saves) {
      expect(s.published).toBe(false)
      expect(String(s.callerKey)).toMatch(/^bofa:req1:/)
    }
  })
})
