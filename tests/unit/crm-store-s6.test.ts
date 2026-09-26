/**
 * CRM Store slice 6 — the Formation pilot (job 685467b5). Pure parts; the live database behaviour is
 * proven by scripts/crm-store/s6-proofs.ts against the sandbox.
 */
import { describe, it, expect, vi } from "vitest"
import { createHash } from "crypto"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { pilotEnvironmentAllowed, contactListedInSetting, FORMATION_UPLOAD_TYPES, storeSafeFolderName } from "@/lib/crm-store/formation-pilot"
import { storePointer, parseStorePointer, isStorePointer, storeDocumentLink } from "@/lib/crm-store/document-pointer"
import { normalizeFormationPayloadForPdf, generateFormSummaryPDF, FORM_CONFIGS } from "@/lib/form-to-drive"
import { resolveArticlesPdf } from "@/lib/ss4/resolve-articles-pdf"

const SANDBOX_URL = "https://xjcxlmlpeywtwkhstjlw.supabase.co"
const PROD_URL = "https://ydzipybqeebtpcvsbtvs.supabase.co"
const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b"

describe("pilot switch — environment half", () => {
  it("only in the sandbox, never on the production database", () => {
    expect(pilotEnvironmentAllowed({ SANDBOX_MODE: "1", NEXT_PUBLIC_SUPABASE_URL: SANDBOX_URL })).toBe(true)
    expect(pilotEnvironmentAllowed({ SANDBOX_MODE: "1", NEXT_PUBLIC_SUPABASE_URL: PROD_URL })).toBe(false)
    expect(pilotEnvironmentAllowed({ SANDBOX_MODE: "1", EXPECTED_SUPABASE_REF: "ydzipybqeebtpcvsbtvs" })).toBe(false)
    expect(pilotEnvironmentAllowed({ NEXT_PUBLIC_SUPABASE_URL: SANDBOX_URL })).toBe(false)
    expect(pilotEnvironmentAllowed({ SANDBOX_MODE: "0", NEXT_PUBLIC_SUPABASE_URL: SANDBOX_URL })).toBe(false)
  })
})

describe("pilot switch — setting half", () => {
  it("a listed contact only", () => {
    expect(contactListedInSetting({ contact_ids: [ID] }, ID)).toBe(true)
    expect(contactListedInSetting({ contact_ids: ["other"] }, ID)).toBe(false)
  })
  it("anything malformed means nobody", () => {
    for (const v of [null, undefined, "x", 1, [], {}, { contact_ids: ID }, { contact_ids: [1, 2] }, { contact_ids: null }]) {
      expect(contactListedInSetting(v, ID)).toBe(false)
    }
    expect(contactListedInSetting({ contact_ids: [ID] }, null)).toBe(false)
    expect(contactListedInSetting({ contact_ids: [ID] }, "")).toBe(false)
  })
})

describe("formation upload stages → document types", () => {
  it("covers the three upload stages of the Company Formation workspace", () => {
    expect(FORMATION_UPLOAD_TYPES["Filed with State"]).toBe("articles_of_organization")
    expect(FORMATION_UPLOAD_TYPES["SS-4 Signed"]).toBe("fax_confirmation")
    expect(FORMATION_UPLOAD_TYPES["EIN Received"]).toBe("ein_letter_irs")
    expect(FORMATION_UPLOAD_TYPES["Payment Confirmed"]).toBeUndefined()
  })
})

describe("store: pointer", () => {
  it("round-trips a file id", () => {
    expect(storePointer(ID)).toBe(`store:${ID}`)
    expect(parseStorePointer(`store:${ID}`)).toBe(ID)
    expect(isStorePointer(`store:${ID}`)).toBe(true)
  })
  it("never mistakes the older storage: pointer or a Drive id for a store file", () => {
    expect(parseStorePointer(`storage:${ID}`)).toBeNull()
    expect(parseStorePointer("storage:flow-uploads/a/b.pdf")).toBeNull()
    expect(parseStorePointer("1AbCdEfGhIjKlMnOpQrStUvWxYz")).toBeNull()
    expect(parseStorePointer("store:not-a-uuid")).toBeNull()
    expect(parseStorePointer(null)).toBeNull()
    expect(() => storePointer("nope")).toThrow()
  })
  it("the CRM link is our own relative preview route, never a signed URL", () => {
    expect(storeDocumentLink(ID)).toBe(`/api/documents/${ID}/preview`)
  })
})

describe("SS-4 Articles resolver reads a store: pointer from the store — never from Drive", () => {
  it("store pointer → downloadStore; Drive and bucket are not touched", async () => {
    const downloadDrive = vi.fn(async () => Buffer.from("drive"))
    const downloadStorage = vi.fn(async () => Buffer.from("bucket"))
    const downloadStore = vi.fn(async () => Buffer.from("store"))
    const out = await resolveArticlesPdf({
      findArticlesDoc: async () => ({ drive_file_id: `store:${ID}`, file_name: "Articles.pdf" }),
      downloadDrive, downloadStorage, downloadStore,
    })
    expect(out?.toString()).toBe("store")
    expect(downloadStore).toHaveBeenCalledWith(ID)
    expect(downloadDrive).not.toHaveBeenCalled()
    expect(downloadStorage).not.toHaveBeenCalled()
  })
  it("a store pointer without a store reader resolves to null (never falls through to Drive)", async () => {
    const downloadDrive = vi.fn(async () => Buffer.from("drive"))
    const out = await resolveArticlesPdf({
      findArticlesDoc: async () => ({ drive_file_id: `store:${ID}`, file_name: "Articles.pdf" }),
      downloadDrive, downloadStorage: async () => null,
    })
    expect(out).toBeNull()
    expect(downloadDrive).not.toHaveBeenCalled()
  })
  it("the older storage: pointer still reads the bucket", async () => {
    const out = await resolveArticlesPdf({
      findArticlesDoc: async () => ({ drive_file_id: "storage:a/b.pdf", file_name: "Articles.pdf" }),
      downloadDrive: async () => null, downloadStorage: async (b, p) => Buffer.from(`${b}/${p}`),
    })
    expect(out?.toString()).toBe("onboarding-uploads/a/b.pdf")
  })
})

describe("formation summary — members fold keeps every answer", () => {
  const wizard = {
    owner_first_name: "Antonio", owner_last_name: "Durante", member_count: 2,
    member_0_member_first_name: "Maria", member_0_member_last_name: "Rossi", member_0_member_nationality: "Italy",
    member_0_member_dob: "1990-01-02", member_0_member_ownership_pct: 30, member_0_is_signer: false,
    member_1_member_first_name: "Luca", member_1_member_email: "l@example.com",
  }
  it("folds member_N_* into members_list with all fields, drops the flat keys", () => {
    const out = normalizeFormationPayloadForPdf(wizard)
    const list = out.members_list as Record<string, unknown>[]
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ first_name: "Maria", last_name: "Rossi", nationality: "Italy", dob: "1990-01-02", ownership_pct: 30, is_signer: false })
    expect(list[1]).toMatchObject({ first_name: "Luca", email: "l@example.com" })
    expect(Object.keys(out).some((k) => /^member_\d+_/.test(k))).toBe(false)
    expect(out.member_count).toBeUndefined()
    expect(out.owner_first_name).toBe("Antonio")
  })
  it("never hides data: no members → the payload is returned unchanged", () => {
    const single = { owner_first_name: "A", member_count: 0 }
    expect(normalizeFormationPayloadForPdf(single)).toEqual(single)
    const none = { owner_first_name: "A" }
    expect(normalizeFormationPayloadForPdf(none)).toEqual(none)
  })
  it("does not mutate its input", () => {
    const copy = JSON.parse(JSON.stringify(wizard))
    normalizeFormationPayloadForPdf(wizard)
    expect(wizard).toEqual(copy)
  })
  it("the formation layout places the wizard's own keys in sections (not only in Additional Information)", () => {
    const keys = FORM_CONFIGS.formation.sections.flatMap((s) => s.fields.map((f) => f.key))
    for (const k of ["owner_first_name", "owner_last_name", "owner_dob", "owner_nationality", "owner_street", "owner_country", "entity_type", "state_of_formation", "members_list"]) {
      expect(keys).toContain(k)
    }
    // legacy standalone-form keys still render
    for (const k of ["first_name", "street", "llc_name_1"]) expect(keys).toContain(k)
  })
})

describe("formation summary PDF — deterministic", () => {
  const data = normalizeFormationPayloadForPdf({ owner_first_name: "Antonio", owner_last_name: "Durante", llc_name_1: "Storage Pilot Test LLC", state_of_formation: "WY" })
  const meta = { token: "portal-x-2026", submittedAt: "2026-09-26T10:00:00Z", uploadCount: 0, deterministic: true }
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
  it("the same answers give the same bytes", async () => {
    const a = await generateFormSummaryPDF(FORM_CONFIGS.formation, data, meta)
    await new Promise((r) => setTimeout(r, 1100))
    const b = await generateFormSummaryPDF(FORM_CONFIGS.formation, data, meta)
    expect(sha(a)).toBe(sha(b))
  })
  it("changed answers give different bytes", async () => {
    const a = await generateFormSummaryPDF(FORM_CONFIGS.formation, data, meta)
    const b = await generateFormSummaryPDF(FORM_CONFIGS.formation, { ...data, owner_last_name: "Other" }, meta)
    expect(sha(a)).not.toBe(sha(b))
  })
})

describe("store folder names", () => {
  it("replaces what the store refuses, keeps the readable rest", () => {
    expect(storeSafeFolderName("A/B Trading LLC")).toBe("A-B Trading LLC")
    expect(storeSafeFolderName("Back\\slash  Co")).toBe("Back-slash Co")
    expect(storeSafeFolderName("Tab\tName")).toBe("Tab-Name")
    expect(storeSafeFolderName("   ")).toBe("Company")
    expect(storeSafeFolderName("x".repeat(300))).toHaveLength(255)
  })
})

describe("new-store browser labels", async () => {
  const { ownerLabel, ownerStatus } = await import("@/lib/crm-store/browse")
  it("names each owner the way staff know it", () => {
    expect(ownerLabel({ kind: "company", company: "Acme LLC", root: "x" })).toBe("Acme LLC")
    expect(ownerLabel({ kind: "person", person: "Maria Rossi" })).toBe("Maria Rossi")
    expect(ownerLabel({ kind: "formation", root: "Maria Rossi — company in formation" })).toBe("Maria Rossi — company in formation")
    expect(ownerLabel({ kind: "formation" })).toBe("Company being formed")
    expect(ownerLabel({ kind: "unfiled" })).toBe("Unfiled")
    expect(ownerLabel({ kind: "company", company: null, root: null })).toBe("Company")
  })
  it("status badge", () => {
    expect(ownerStatus("in_formation")).toBe("being formed")
    expect(ownerStatus("archived")).toBe("archived")
    expect(ownerStatus(null)).toBeNull()
  })
})

describe("OCR reads a store document from the store — never from Drive", async () => {
  const { ocrByPointer } = await import("@/lib/crm-store/ocr")
  const fake = (text: string) => ({ fullText: text, pages: [], pageCount: 1, fileName: "x", mimeType: "application/pdf", confidence: 0.9, documentPageCount: 1, windowStart: 1 })
  it("store: pointer → store bytes → OCR of those bytes", async () => {
    const ocrDrive = vi.fn(async () => fake("drive"))
    const readStore = vi.fn(async () => ({ bytes: Buffer.from("PDFBYTES"), mimeType: "application/pdf", name: "Passport.pdf" }))
    const ocrBytes = vi.fn(async (ab: ArrayBuffer) => fake(Buffer.from(ab).toString()))
    const r = await ocrByPointer(`store:${ID}`, { ocrDrive, readStore, ocrBytes })
    expect(r.fullText).toBe("PDFBYTES")
    expect(readStore).toHaveBeenCalledWith(ID)
    expect(ocrDrive).not.toHaveBeenCalled()
  })
  it("a Drive id still goes to Drive", async () => {
    const ocrDrive = vi.fn(async () => fake("drive"))
    const r = await ocrByPointer("1AbCdEfGh", { ocrDrive, readStore: vi.fn(), ocrBytes: vi.fn() } as never)
    expect(r.fullText).toBe("drive")
  })
  it("a malformed store: value is refused, not sent to Drive", async () => {
    const ocrDrive = vi.fn(async () => fake("drive"))
    await expect(ocrByPointer("store:not-a-uuid", { ocrDrive, readStore: vi.fn(), ocrBytes: vi.fn() } as never)).rejects.toThrow()
    expect(ocrDrive).not.toHaveBeenCalled()
  })
})

describe("contact merge vs the new store", async () => {
  const { storeMergeBlocker } = await import("@/lib/crm-store/merge-guard")
  const L = "loser", W = "winner"
  const deps = (ids: string[] | { error: string }) => ({ personOwners: async () => (Array.isArray(ids) ? { contactIds: ids } : ids) })
  it("both people have their own storage → refused in plain words", async () => {
    expect(await storeMergeBlocker(L, W, deps([L, W]))).toMatch(/Both contacts/)
  })
  it("only one (or neither) has storage → allowed", async () => {
    expect(await storeMergeBlocker(L, W, deps([L]))).toBeNull()
    expect(await storeMergeBlocker(L, W, deps([W]))).toBeNull()
    expect(await storeMergeBlocker(L, W, deps([]))).toBeNull()
  })
  it("cannot check → refused (fails closed)", async () => {
    expect(await storeMergeBlocker(L, W, deps({ error: "boom" }))).toMatch(/Could not check/)
  })
})
