import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The hand-over of a client's chat file to the Storage screen (lib/crm-store/chat-file-handoff.ts; dev job fb49265a, Antonio 2026-11-09).
 * Pure rules (type from the name, safe file name, the list of files) and the two server lookups with every dependency replaced.
 * What is proved: the file always comes from the SAVED message, only from the chat's own folder, the right storage is named for a company
 * chat and for a person's own thread, and a refusal never produces a link.
 */

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefgh.supabase.co"
  return {
    loadMessage: vi.fn(),
    ownerForAccount: vi.fn(),
    ownerForContact: vi.fn(),
    rows: { accounts: { company_name: "Acme LLC" } as Record<string, unknown> | null, contacts: { full_name: "Jane Sample" } as Record<string, unknown> | null },
    signed: vi.fn(),
  }
})

vi.mock("@/lib/crm-store/save-from-chat", () => ({ loadMessage: h.loadMessage }))
vi.mock("@/lib/crm-store/browse", () => ({ storeOwnerForAccountOrThrow: h.ownerForAccount, storeOwnerForContactOrThrow: h.ownerForContact }))
vi.mock("@/lib/config", () => ({ PORTAL_BASE_URL: "https://portal.example.test" }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: "accounts" | "contacts") => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.rows[table], error: null }) }) }) }),
    storage: { from: () => ({ createSignedUrl: h.signed }) },
  },
}))

import { handoffFileName, handoffItems, handoffMime, readHandoffTarget, redactTaxNumberInName, signChatFile, HANDOFF_LINK_SECONDS } from "@/lib/crm-store/chat-file-handoff"

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const CONTACT = "22222222-2222-4222-8222-222222222222"
const OTHER = "33333333-3333-4333-8333-333333333333"
const urlIn = (dir: string, file = "a.pdf") => `https://abcdefgh.supabase.co/storage/v1/object/public/assets/chat-attachments/${dir}/${file}`

function message(over: Partial<{ account_id: string | null; contact_id: string | null; attachments: unknown }> = {}) {
  return { row: { id: "44444444-4444-4444-8444-444444444444", account_id: ACCOUNT, contact_id: null, attachments: [{ url: urlIn(ACCOUNT), name: "Q3 report.xlsx", size: 2048, mime_type: "application/octet-stream" }], attachment_url: null, attachment_name: null, deleted_at: null, ...over } }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.rows.accounts = { company_name: "Acme LLC" }
  h.rows.contacts = { full_name: "Jane Sample" }
  h.ownerForAccount.mockResolvedValue("owner-company")
  h.ownerForContact.mockResolvedValue("owner-person")
  h.signed.mockResolvedValue({ data: { signedUrl: "https://abcdefgh.supabase.co/storage/v1/object/sign/assets/x?token=t" }, error: null })
})

describe("handoffMime", () => {
  it("keeps a specific claim", () => expect(handoffMime("Application/PDF", "x.bin")).toBe("application/pdf"))
  it("uses the extension when the claim is empty or generic", () => {
    expect(handoffMime(null, "Q3.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    expect(handoffMime("application/octet-stream", "data.csv")).toBe("text/csv")
    expect(handoffMime("", "scan.jpeg")).toBe("image/jpeg")
  })
  it("falls back to a plain binary type", () => {
    expect(handoffMime(undefined, "mystery")).toBe("application/octet-stream")
    expect(handoffMime("", "file.weird")).toBe("application/octet-stream")
  })
})

describe("handoffFileName", () => {
  it("drops any folder part and control characters", () => {
    expect(handoffFileName("../../etc/passwd", 0)).toBe("passwd")
    expect(handoffFileName("C:\\Users\\x\\bank\u0000 statement.pdf", 0)).toBe("bank statement.pdf")
  })
  it("never returns an empty name", () => {
    expect(handoffFileName("", 2)).toBe("Attachment 3")
    expect(handoffFileName(null, 0)).toBe("Attachment 1")
    expect(handoffFileName("   ", 0)).toBe("Attachment 1")
  })
  it("keeps spaces and accents, caps the length", () => {
    expect(handoffFileName("Résumé  final.pdf", 0)).toBe("Résumé final.pdf")
    expect(handoffFileName("a".repeat(500) + ".pdf", 0).length).toBe(200)
  })
})

describe("tax numbers and dots in a client's file name", () => {
  it("replaces a tax number written into the name (the real incident name)", () => {
    expect(redactTaxNumberInName("NAME---123-45-6789-itin.pdf")).toBe("NAME---xxx-xx-xxxx-itin.pdf")
    expect(redactTaxNumberInName("123.45.6789 letter.pdf")).toBe("xxx-xx-xxxx letter.pdf")
    expect(redactTaxNumberInName("123_45_6789.pdf")).toBe("xxx-xx-xxxx.pdf")
    expect(redactTaxNumberInName("EIN 12-3456789.pdf")).toBe("EIN xx-xxxxxxx.pdf")
    expect(redactTaxNumberInName("ITIN 123456789.pdf")).toBe("ITIN xxxxxxxxx.pdf")
  })
  it("leaves ordinary names alone — screenshot names, dates, phone-like and long numbers", () => {
    for (const n of ["Screenshot_20261108_141245.png", "Screenshot 2026-11-08 at 14.12.45.png", "IMG_1234.jpg", "Bank statement October.pdf", "2026-11-08.pdf", "invoice 12345678.pdf", "scan 1234567890123.pdf"]) {
      expect(redactTaxNumberInName(n)).toBe(n)
    }
  })
  it("handoffFileName applies it and also collapses runs of dots", () => {
    expect(handoffFileName("NAME---123-45-6789-itin.pdf", 0)).toBe("NAME---xxx-xx-xxxx-itin.pdf")
    expect(handoffFileName("Statement..pdf", 0)).toBe("Statement.pdf")
    expect(handoffFileName("a...b....pdf", 0)).toBe("a.b.pdf")
    expect(handoffFileName("Screenshot_20261108_141245.png", 0)).toBe("Screenshot_20261108_141245.png")
  })
  it("the name listed for a file and the name handed over agree", () => {
    const items = handoffItems([{ url: urlIn(ACCOUNT, "a.pdf"), name: "NAME---123-45-6789-itin.pdf" }])
    expect(items[0].name).toBe("NAME---xxx-xx-xxxx-itin.pdf")
  })
})

describe("handoffItems", () => {
  it("keeps the message's own order and marks a voice note", () => {
    const items = handoffItems([
      { url: urlIn(ACCOUNT, "a.pdf"), name: "a.pdf", size: 10, mime_type: "application/pdf" },
      { url: urlIn(ACCOUNT, "v.m4a"), name: "note.m4a", size: null, mime_type: "audio/mp4" },
      { url: urlIn(ACCOUNT, "c.csv"), name: "c.csv" },
    ])
    expect(items.map((i) => [i.index, i.voice])).toEqual([[0, false], [1, true], [2, false]])
    expect(items[0]).toMatchObject({ name: "a.pdf", size: 10, mimeType: "application/pdf" })
    expect(items[2]).toMatchObject({ size: null, mimeType: "text/csv" })
  })
  it("lists at most ten", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ url: urlIn(ACCOUNT, `f${i}.pdf`), name: `f${i}.pdf` }))
    expect(handoffItems(many)).toHaveLength(10)
  })
})

describe("readHandoffTarget", () => {
  it("names the company's storage for a company chat", async () => {
    h.loadMessage.mockResolvedValue(message())
    const t = await readHandoffTarget("m")
    expect(t).toMatchObject({ ok: true, scope: "company", accountId: ACCOUNT, ownerId: "owner-company", label: "Acme LLC" })
    expect(h.ownerForAccount).toHaveBeenCalledWith(ACCOUNT)
    expect(h.ownerForContact).not.toHaveBeenCalled()
    expect((t as { items: Array<{ mimeType: string }> }).items[0].mimeType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  })
  it("names the person's own storage in a person's thread (no company)", async () => {
    h.loadMessage.mockResolvedValue(message({ account_id: null, contact_id: CONTACT, attachments: [{ url: urlIn(CONTACT), name: "passport.jpg" }] }))
    const t = await readHandoffTarget("m")
    expect(t).toMatchObject({ ok: true, scope: "person", contactId: CONTACT, ownerId: "owner-person", label: "Jane Sample" })
    expect(h.ownerForAccount).not.toHaveBeenCalled()
  })
  it("says so when there is no storage yet (and makes none)", async () => {
    h.loadMessage.mockResolvedValue(message())
    h.ownerForAccount.mockResolvedValue(null)
    expect(await readHandoffTarget("m")).toMatchObject({ ok: true, ownerId: null })
  })
  it("refuses a message with no files or with no company and no person", async () => {
    h.loadMessage.mockResolvedValue(message({ attachments: [] }))
    expect(await readHandoffTarget("m")).toMatchObject({ ok: false, status: 404 })
    h.loadMessage.mockResolvedValue(message({ account_id: null, contact_id: null }))
    expect(await readHandoffTarget("m")).toMatchObject({ ok: false, status: 404 })
  })
  it("passes a message failure through unchanged", async () => {
    h.loadMessage.mockResolvedValue({ ok: false, status: 410, error: "That message was deleted." })
    expect(await readHandoffTarget("m")).toEqual({ ok: false, status: 410, error: "That message was deleted." })
  })
  it("turns a failed storage lookup into a plain error, not an empty 'no storage'", async () => {
    h.loadMessage.mockResolvedValue(message())
    h.ownerForAccount.mockRejectedValue(new Error("Could not check where this company's files are kept."))
    expect(await readHandoffTarget("m")).toEqual({ ok: false, status: 500, error: "Could not check where this company's files are kept." })
  })
})

describe("signChatFile", () => {
  it("gives a short-lived link for a file in the chat's own folder", async () => {
    h.loadMessage.mockResolvedValue(message())
    const f = await signChatFile("m", 0)
    expect(f).toMatchObject({ ok: true, name: "Q3 report.xlsx", size: 2048, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    expect(h.signed).toHaveBeenCalledWith(`chat-attachments/${ACCOUNT}/a.pdf`, HANDOFF_LINK_SECONDS)
  })
  it("works for a person's own thread folder", async () => {
    h.loadMessage.mockResolvedValue(message({ account_id: null, contact_id: CONTACT, attachments: [{ url: urlIn(CONTACT, "p.png"), name: "p.png" }] }))
    expect(await signChatFile("m", 0)).toMatchObject({ ok: true, mimeType: "image/png" })
  })
  it("refuses a link into ANOTHER company's folder without signing anything", async () => {
    h.loadMessage.mockResolvedValue(message({ attachments: [{ url: urlIn(OTHER), name: "theirs.pdf" }] }))
    expect(await signChatFile("m", 0)).toMatchObject({ ok: false, status: 403 })
    expect(h.signed).not.toHaveBeenCalled()
  })
  it("refuses a url that is not our chat storage", async () => {
    h.loadMessage.mockResolvedValue(message({ attachments: [{ url: "https://evil.example.test/chat-attachments/x/y.pdf", name: "y.pdf" }] }))
    expect(await signChatFile("m", 0)).toMatchObject({ ok: false, status: 400 })
    expect(h.signed).not.toHaveBeenCalled()
  })
  it("refuses an attachment that is not there", async () => {
    h.loadMessage.mockResolvedValue(message())
    expect(await signChatFile("m", 5)).toMatchObject({ ok: false, status: 404 })
  })
  it("says so when the storage cannot sign", async () => {
    h.loadMessage.mockResolvedValue(message())
    h.signed.mockResolvedValue({ data: null, error: { message: "nope" } })
    expect(await signChatFile("m", 0)).toMatchObject({ ok: false, status: 502 })
  })
})
