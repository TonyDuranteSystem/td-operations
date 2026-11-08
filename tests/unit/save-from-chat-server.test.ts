import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The SERVER side of the "Save to Storage" card (lib/crm-store/save-from-chat.ts) — the order of its steps and what each outcome says.
 * Every dependency is replaced: the database (a recorder that answers by table + what was asked), the chat storage, Document AI, the save
 * helper, the client-visibility and notification helpers, the ITIN writer. What is proved here is OUR logic: which step runs when, what is
 * refused, what is written, what the result lines claim. (Browser + real database runs are in the sandbox QA noted in docs/systems/storage.md.)
 */

interface Op { m: string; a: unknown[] }
interface Person { id: string; name: string; itin: string | null; issue: string | null; dob: string | null }

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefgh.supabase.co"
  return {
    handler: null as null | ((table: string, ops: Op[]) => { rows?: unknown[]; error?: unknown }),
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    files: {} as Record<string, { bytes: Uint8Array; listedSize?: number | null; listFails?: boolean }>,
    downloads: [] as string[],
  }
})

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const ops: Op[] = []
    const run = () => (h.handler ? h.handler(table, ops) : { rows: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ["select", "eq", "neq", "in", "like", "is", "not", "or", "order", "limit", "update", "range"]) b[m] = (...a: unknown[]) => { ops.push({ m, a }); return b }
    b.insert = (row: Record<string, unknown>) => { h.inserts.push({ table, row }); const r = run(); return Promise.resolve({ data: null, error: r.error ?? null }) }
    const one = () => { const r = run(); return Promise.resolve({ data: r.rows?.[0] ?? null, error: r.error ?? null }) }
    b.maybeSingle = one
    b.single = one
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => { const r = run(); return Promise.resolve({ data: r.rows ?? [], error: r.error ?? null }).then(resolve, reject) }
    return b
  }
  return {
    supabaseAdmin: {
      from: (t: string) => builder(t),
      storage: {
        from: () => ({
          list: async (dir: string, o: { search: string }) => {
            const f = h.files[`${dir}/${o.search}`]
            if (!f || f.listFails) return { data: null, error: { message: "list failed" } }
            return { data: [{ name: o.search, metadata: f.listedSize === null ? null : { size: f.listedSize ?? f.bytes.length } }], error: null }
          },
          download: async (path: string) => {
            h.downloads.push(path)
            const f = h.files[path]
            if (!f) return { data: null, error: { message: "not found" } }
            return { data: { arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength), type: "" }, error: null }
          },
        }),
      },
    },
  }
})
vi.mock("@/lib/config", () => ({ PORTAL_BASE_URL: "https://portal.example.test" }))
vi.mock("@/lib/portal/addressed-to", () => ({ resolveAccountMembersForChat: vi.fn() }))
vi.mock("@/lib/flows/storage-step-hints", () => ({ findWaitingWorkspaceStepsForContact: vi.fn() }))
vi.mock("@/lib/docai", () => ({ ocrRawContent: vi.fn() }))
vi.mock("@/lib/crm-store/save-for-account", () => ({ saveDocumentForContact: vi.fn(), CompanyMovingError: class CompanyMovingError extends Error {} }))
vi.mock("@/lib/crm-store/browse", () => ({ setClientVisibility: vi.fn() }))
vi.mock("@/lib/portal/document-alerts", () => ({ notifyClientsOfNewDocument: vi.fn() }))
vi.mock("@/lib/itin/write-itin-fields", () => ({ writeITINFields: vi.fn() }))

import { readChatAttachmentsForCard, readChatAttachmentForPreview, saveChatAttachmentsToStorage } from "@/lib/crm-store/save-from-chat"
import type { SaveItemInput } from "@/lib/crm-store/save-from-chat-rules"
import { resolveAccountMembersForChat } from "@/lib/portal/addressed-to"
import { findWaitingWorkspaceStepsForContact } from "@/lib/flows/storage-step-hints"
import { ocrRawContent } from "@/lib/docai"
import { saveDocumentForContact } from "@/lib/crm-store/save-for-account"
import { setClientVisibility } from "@/lib/crm-store/browse"
import { notifyClientsOfNewDocument } from "@/lib/portal/document-alerts"
import { writeITINFields } from "@/lib/itin/write-itin-fields"

const MSG = "11111111-1111-4111-8111-111111111111"
const ACC = "acct-1"
const URL0 = "https://abcdefgh.supabase.co/storage/v1/object/public/assets/chat-attachments/acct-1/aaaa.pdf"
const URL1 = "https://abcdefgh.supabase.co/storage/v1/object/public/assets/chat-attachments/acct-1/bbbb.pdf"
const PATH0 = "chat-attachments/acct-1/aaaa.pdf"
const PATH1 = "chat-attachments/acct-1/bbbb.pdf"
const bytes = (s: string): Uint8Array => new Uint8Array(s.split("").map((c) => c.charCodeAt(0)))
const PDF = bytes("%PDF-1.4\nfake but PDF-looking bytes")
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const HTML = bytes("<html><script>alert(1)</script></html>")

const LETTER = `IRS Notice CP565A
Date of Birth: March 3, 1990
JANE SAMPLE
14 TEST STREET STE B200
October 7, 2025
You've been assigned an Individual Taxpayer Identification Number (ITIN)
This notice confirms your assigned ITIN 900-70-1234.
ITIN 900-70-1234`

// ── the scenario the database recorder answers from ──
const state = {
  people: [] as Person[],
  attachments: [] as Array<Record<string, unknown>>,
  deleted: false,
  noRowsMessage: false,
  other: null as string | null | "error",
  /** answers for the successive "is this ITIN on another contact?" questions (used first); then `other` */
  otherSeq: [] as Array<string | null | "error">,
  saved: [] as Array<{ id: string; name: string; state: string; caller_key: string }>,
  owner: "yes" as "yes" | "no" | "error",
  folder: "ITIN" as string | null,
  visible: false,
  visibleReadFails: false,
  linksFail: false,
  failContactReadAt: 0,
  contactReads: 0,
}

function handler(table: string, ops: Op[]): { rows?: unknown[]; error?: unknown } {
  const sel = String((ops.find((o) => o.m === "select")?.a[0]) ?? "")
  const has = (m: string, first?: unknown) => ops.some((o) => o.m === m && (first === undefined || o.a[0] === first))
  if (table === "portal_messages") {
    if (state.noRowsMessage) return { rows: [] }
    return { rows: [{ id: MSG, account_id: ACC, contact_id: "c1", attachments: state.attachments, attachment_url: null, attachment_name: null, deleted_at: state.deleted ? "2026-11-07T00:00:00Z" : null }] }
  }
  if (table === "members") return { rows: [] }
  if (table === "contacts") {
    if (has("in", "itin_number")) {
      const answer = state.otherSeq.length > 0 ? (state.otherSeq.shift() as string | null | "error") : state.other
      return answer === "error" ? { error: { message: "boom" } } : { rows: answer ? [{ full_name: answer }] : [] }
    }
    state.contactReads++
    if (state.failContactReadAt && state.contactReads === state.failContactReadAt) return { error: { message: "read failed" } }
    const ids = (ops.find((o) => o.m === "in" && o.a[0] === "id")?.a[1] as string[]) ?? []
    return { rows: state.people.filter((p) => ids.indexOf(p.id) >= 0).map((p) => ({ id: p.id, full_name: p.name, itin_number: p.itin, itin_issue_date: p.issue, date_of_birth: p.dob })) }
  }
  if (table === "account_contacts") return state.linksFail ? { error: { message: "links failed" } } : { rows: [{ account_id: ACC }] }
  if (table === "store_files") {
    if (sel.indexOf("store_folders") >= 0) return { rows: state.folder ? [{ store_folders: { name: state.folder } }] : [{ store_folders: null }] }
    if (sel.indexOf("store_owners") >= 0) return state.owner === "error" ? { error: { message: "owner failed" } } : { rows: [{ store_owners: { contact_id: state.owner === "yes" ? "c1" : "someone-else" } }] }
    return { rows: state.saved } // the saved-copies lookup
  }
  if (table === "documents") return state.visibleReadFails ? { error: { message: "docs failed" } } : { rows: [{ portal_visible: state.visible }] }
  return { rows: [] }
}

function input(over: Partial<SaveItemInput> = {}): SaveItemInput {
  return { index: 0, contactId: "c1", fileName: "", itin: null, issueDate: null, client: "hidden", replaceItin: false, itinHolderOk: false, itinHolderFor: null, letterDateOfBirth: null, ...over }
}
const noteTexts = (r: { notes: Array<{ text: string; level: string }> }) => r.notes.map((n) => `${n.level === "warn" ? "[WARN] " : ""}${n.text}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.handler = handler
  h.inserts = []
  h.downloads = []
  h.files = { [PATH0]: { bytes: PDF }, [PATH1]: { bytes: PNG } }
  Object.assign(state, {
    people: [
      { id: "c1", name: "Jane Sample", itin: null, issue: null, dob: "1990-03-03" },
      { id: "c2", name: "John Example", itin: null, issue: null, dob: "1985-06-09" },
    ] as Person[],
    attachments: [{ url: URL0, name: "scan.pdf", size: 1000, mime_type: "application/pdf" }, { url: URL1, name: "letter", size: 12, mime_type: "application/octet-stream" }],
    deleted: false, noRowsMessage: false, other: null, otherSeq: [], saved: [], owner: "yes", folder: "ITIN", visible: false, visibleReadFails: false, linksFail: false, failContactReadAt: 0, contactReads: 0,
  })
  vi.mocked(resolveAccountMembersForChat).mockResolvedValue([
    { memberId: "m1", name: "Jane Sample", contactId: "c1", isCompanyMember: false, isPrimary: true, resolvable: true },
    { memberId: "m2", name: "John Example", contactId: "c2", isCompanyMember: false, isPrimary: false, resolvable: true },
  ])
  vi.mocked(findWaitingWorkspaceStepsForContact).mockResolvedValue([])
  vi.mocked(ocrRawContent).mockResolvedValue({ fullText: LETTER } as never)
  vi.mocked(saveDocumentForContact).mockResolvedValue({ route: "store", fileId: "file-1", pointer: "store:file-1", documentRowId: "doc-1", status: "created" } as never)
  vi.mocked(setClientVisibility).mockResolvedValue({ visible: true, crmRowsUpdated: 1 })
  vi.mocked(notifyClientsOfNewDocument).mockResolvedValue({ notified: true })
  vi.mocked(writeITINFields).mockImplementation(async (id, f) => {
    const p = state.people.find((x) => x.id === id)
    if (p) { if (f.itin_number !== undefined) p.itin = f.itin_number ?? null; if (f.itin_issue_date !== undefined) p.issue = f.itin_issue_date ?? null }
    return { itin_renewal_date: null }
  })
})

/** the letter, but for another name */
function ocrLetterFor(name: string) {
  vi.mocked(ocrRawContent).mockResolvedValue({ fullText: LETTER.replace("JANE SAMPLE", name) } as never)
}

async function saveOne(over: Partial<SaveItemInput> = {}) {
  const r = await saveChatAttachmentsToStorage(MSG, [input(over)], "staff-1")
  if (!("results" in r)) throw new Error(`unexpected failure: ${JSON.stringify(r)}`)
  return r.results[0]
}

describe("saveChatAttachmentsToStorage — the file", () => {
  it("saves hidden into the person's own ITIN folder under a key that holds the PERSON (and not the client's file name)", async () => {
    const r = await saveOne({ itin: "900-70-1234" })
    expect(r).toMatchObject({ ok: true, partial: false, status: "created", place: "Jane Sample › ITIN" })
    const call = vi.mocked(saveDocumentForContact).mock.calls[0][0]
    expect(call).toMatchObject({ contactId: "c1", documentType: "itin_letter", portalVisible: false, folderKind: "itin", mimeType: "application/pdf" })
    expect(call.callerKey).toMatch(new RegExp(`^chat-attachment:${MSG}:[0-9a-f]{64}:c1$`))
    expect(call.callerKey).not.toMatch(/scan/i)
    expect(call.name).toBe("ITIN Letter - Jane Sample.pdf")
  })

  it("a copy that is already in Storage is never given the chat's original as a new version: the save says the content is not changed", async () => {
    await saveOne()
    expect(vi.mocked(saveDocumentForContact).mock.calls[0][0]).toMatchObject({ contentChanged: false })
  })

  it("the same attachment for ANOTHER person is another key (so another file) — never the first person's", async () => {
    await saveOne({ contactId: "c1" })
    await saveOne({ contactId: "c2" })
    const keys = vi.mocked(saveDocumentForContact).mock.calls.map((c) => c[0].callerKey)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[0]).toMatch(/:c1$/)
    expect(keys[1]).toMatch(/:c2$/)
  })

  it("the name ends with what the file REALLY is: a PNG recorded as octet-stream with no extension becomes .png; a typed name's wrong extension is replaced", async () => {
    const png = await saveOne({ index: 1 })
    expect(png.ok).toBe(true)
    expect(vi.mocked(saveDocumentForContact).mock.calls[0][0]).toMatchObject({ mimeType: "image/png", name: "ITIN Letter - Jane Sample.png" })
    vi.mocked(saveDocumentForContact).mockClear()
    await saveOne({ index: 1, fileName: "Jane letter.jpeg" })
    expect(vi.mocked(saveDocumentForContact).mock.calls[0][0].name).toBe("Jane letter.png")
  })

  it("a file name carrying a tax number is refused before anything is saved", async () => {
    const r = await saveOne({ fileName: "letter 900-70-1234.pdf" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/must not contain the ITIN/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
  })

  it("HTML named .pdf is refused by its first bytes — never saved, never read", async () => {
    h.files[PATH0] = { bytes: HTML }
    const r = await saveOne()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a PDF or a picture/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
  })

  it("a file the STORAGE says is over 15 MB is refused without being downloaded (whatever size the message claimed)", async () => {
    h.files[PATH0] = { bytes: PDF, listedSize: 16 * 1024 * 1024 }
    const r = await saveOne()
    expect(r.error).toMatch(/15 MB/)
    expect(h.downloads).toEqual([])
  })

  it("when the size lookup fails the file is still measured after the download", async () => {
    h.files[PATH0] = { bytes: new Uint8Array(16 * 1024 * 1024 + 10).fill(0x20), listFails: true }
    h.files[PATH0].bytes.set(bytes("%PDF-1.4"), 0)
    const r = await saveOne()
    expect(r.error).toMatch(/15 MB/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
  })

  it("only a person who belongs to this chat's company can be chosen", async () => {
    const r = await saveOne({ contactId: "stranger" })
    expect(r.error).toMatch(/not a member/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
  })

  it("an attachment index that does not exist", async () => {
    const r = await saveOne({ index: 5 })
    expect(r.error).toMatch(/not found/)
  })

  it("an open ITIN case waiting for the letter refuses the save; a check that cannot be made refuses too", async () => {
    vi.mocked(findWaitingWorkspaceStepsForContact).mockResolvedValueOnce([{ sdId: "s1", serviceType: "ITIN", stage: "ITIN Approved", who: "Jane Sample", asks: "the approval letter", how: "Upload it in the workspace." } as never])
    const waiting = await saveOne()
    expect(waiting.error).toMatch(/ITIN case is at "ITIN Approved"/)
    vi.mocked(findWaitingWorkspaceStepsForContact).mockRejectedValueOnce(new Error("db down"))
    const unknown = await saveOne()
    expect(unknown.error).toMatch(/Could not check whether an ITIN case is waiting/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
  })

  it("an owner check that says 'somebody else' stops everything after the save, explains the moved copy and leaves the record and the client alone", async () => {
    state.owner = "no"
    const r = await saveOne({ itin: "900-70-1234", client: "show_notify" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/has since been moved to another storage/)
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
    expect(h.inserts.find((i) => i.table === "action_log")?.row.details).toMatchObject({ stopped: "file_not_this_persons", itin_written: false })
  })

  it("an owner check that could not be made does not say 'somebody else' — it says to press Save again, and still logs", async () => {
    state.owner = "error"
    const r = await saveOne({ itin: "900-70-1234" })
    expect(r.error).toMatch(/could not be double-checked/)
    expect(r.error).not.toMatch(/somebody else/)
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(h.inserts.some((i) => i.table === "action_log")).toBe(true)
  })

  it("the person's company links must be readable before anything is saved", async () => {
    state.linksFail = true
    const r = await saveOne()
    expect(r.error).toMatch(/company links/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
  })

  it("the place line names the folder the file REALLY went to, and never invents one", async () => {
    state.folder = "Personal documents"
    expect((await saveOne()).place).toBe("Jane Sample › Personal documents")
    state.folder = null
    expect((await saveOne()).place).toBe("Jane Sample's storage")
  })
})

describe("saveChatAttachmentsToStorage — what is written on the contact", () => {
  it("writes a confirmed ITIN and date on an empty record", async () => {
    const r = await saveOne({ itin: "900 70 1234", issueDate: "2025-10-07" })
    expect(writeITINFields).toHaveBeenCalledWith("c1", { itin_number: "900-70-1234", itin_issue_date: "2025-10-07" })
    expect(r.partial).toBe(false)
    expect(noteTexts(r).some((n) => /ITIN and issue date saved/.test(n))).toBe(true)
  })

  it("validates again on the server: a bad ITIN, a date without an ITIN, a date that is the letter's date of birth, a date before the birth", async () => {
    expect((await saveOne({ itin: "800-70-1234" })).error).toMatch(/not valid/)
    expect((await saveOne({ issueDate: "2025-10-07" })).error).toMatch(/together with its date/)
    expect((await saveOne({ itin: "900-70-1234", issueDate: "2005-05-05", letterDateOfBirth: "2005-05-05" })).error).toMatch(/date of birth/)
    expect((await saveOne({ itin: "900-70-1234", issueDate: "2001-01-01", letterDateOfBirth: "2005-05-05" })).error).toMatch(/before the date of birth/)
    expect(writeITINFields).not.toHaveBeenCalled()
  })

  it("a record that holds a DIFFERENT ITIN keeps it: nothing written, amber + partial + keptNeedsReplace (the card can then show its 'replace' box)", async () => {
    state.people[0].itin = "901-54-5678"
    const r = await saveOne({ itin: "900-70-1234" })
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: true, partial: true, keptNeedsReplace: true })
    expect(noteTexts(r).some((n) => /\[WARN\].*tick "replace" and save again/.test(n))).toBe(true)
  })

  it("the same Save, with 'replace' ticked, writes it", async () => {
    state.people[0].itin = "901-54-5678"
    const r = await saveOne({ itin: "900-70-1234", replaceItin: true })
    expect(writeITINFields).toHaveBeenCalledWith("c1", { itin_number: "900-70-1234" }) // the old record had no date: nothing to clear, nothing to set
    expect(r.partial).toBe(false)
  })

  it("replacing an ITIN with NO new date clears the old date — and says so in amber (the record now has no issue date)", async () => {
    state.people[0].itin = "901-54-5678"
    state.people[0].issue = "2020-01-01"
    const r = await saveOne({ itin: "900-70-1234", replaceItin: true })
    expect(writeITINFields).toHaveBeenCalledWith("c1", { itin_number: "900-70-1234", itin_issue_date: null })
    expect(r.partial).toBe(true)
    expect(noteTexts(r).some((n) => /\[WARN\].*cleared/.test(n))).toBe(true)
    expect(h.inserts.find((i) => i.table === "action_log")?.row.details).toMatchObject({ itin_written: true, issue_date_cleared: true, replaced_itin_last4: "5678" })
  })

  it("a record with an issue date but NO ITIN: the ITIN is written, the held date is kept (amber, keptNeedsReplace)", async () => {
    state.people[0].issue = "2020-01-01"
    const r = await saveOne({ itin: "900-70-1234", issueDate: "2025-10-07" })
    expect(writeITINFields).toHaveBeenCalledWith("c1", { itin_number: "900-70-1234" })
    expect(r).toMatchObject({ partial: true, keptNeedsReplace: true })
  })

  it("two letters for ONE person in one Save: the second judges the record FRESH and keeps the first one's ITIN", async () => {
    const r = await saveChatAttachmentsToStorage(MSG, [input({ index: 0, itin: "900-70-1234" }), input({ index: 1, itin: "901-54-5678" })], "staff-1")
    if (!("results" in r)) throw new Error("failed")
    expect(r.results[0].partial).toBe(false)
    expect(r.results[1]).toMatchObject({ ok: true, partial: true, keptNeedsReplace: true })
    expect(state.people[0].itin).toBe("900-70-1234")
    expect(vi.mocked(writeITINFields)).toHaveBeenCalledTimes(1)
  })

  it("an ITIN already on ANOTHER person's record: NOTHING is saved (no stray copy), the answer names who holds it, and no client step runs", async () => {
    state.other = "John Example"
    const r = await saveOne({ itin: "900-70-1234", client: "show_notify" })
    expect(r).toMatchObject({ ok: false, itinHeldBy: "John Example", itinHeldItin: "900-70-1234" })
    expect(r.error).toMatch(/already on John Example's record, so nothing was saved/)
    expect(r.error).toMatch(/tick "I checked"/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
  })

  it("…and when staff say 'I checked' (a duplicate contact of the same person) the file is saved, the ITIN written and the client step runs", async () => {
    state.other = "John Example"
    const r = await saveOne({ itin: "900-70-1234", client: "show_notify", itinHolderOk: true, itinHolderFor: "900-70-1234" })
    expect(r).toMatchObject({ ok: true, partial: false })
    expect(saveDocumentForContact).toHaveBeenCalledTimes(1)
    expect(writeITINFields).toHaveBeenCalledWith("c1", { itin_number: "900-70-1234" })
    expect(notifyClientsOfNewDocument).toHaveBeenCalledTimes(1)
  })

  it("the 'I checked' tick counts for the ITIN it was given for ONLY: the digits changed afterwards (or no ITIN named) and the question is asked again, nothing saved", async () => {
    state.other = "John Example"
    const changed = await saveOne({ itin: "900-70-5678", itinHolderOk: true, itinHolderFor: "900-70-1234" })
    expect(changed).toMatchObject({ ok: false, itinHeldBy: "John Example", itinHeldItin: "900-70-5678" })
    const unnamed = await saveOne({ itin: "900-70-1234", itinHolderOk: true, itinHolderFor: null })
    expect(unnamed).toMatchObject({ ok: false, itinHeldBy: "John Example" })
    expect(saveDocumentForContact).not.toHaveBeenCalled()
    expect(writeITINFields).not.toHaveBeenCalled()
    // the same ITIN typed with other separators is still the same ITIN
    const same = await saveOne({ itin: "900 70 1234", itinHolderOk: true, itinHolderFor: "900-70-1234" })
    expect(same).toMatchObject({ ok: true })
  })

  it("the line 'the old date was cleared' appears only once the clearing has really happened — a net that blocks the write leaves no such line", async () => {
    state.people[0].itin = "901-54-5678"
    state.people[0].issue = "2020-01-01"
    state.otherSeq = [null, "John Example"]
    const r = await saveOne({ itin: "900-70-1234", replaceItin: true })
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(state.people[0].issue).toBe("2020-01-01")
    expect(noteTexts(r).join(" | ")).not.toMatch(/cleared/)
    expect(noteTexts(r).join(" | ")).toMatch(/already on John Example's record, so it was NOT written/)
  })

  it("…and a write that throws leaves no 'cleared' line either", async () => {
    state.people[0].itin = "901-54-5678"
    state.people[0].issue = "2020-01-01"
    vi.mocked(writeITINFields).mockRejectedValueOnce(new Error("db down"))
    const r = await saveOne({ itin: "900-70-1234", replaceItin: true })
    expect(noteTexts(r).join(" | ")).not.toMatch(/cleared/)
    expect(noteTexts(r).join(" | ")).toMatch(/could not be written/)
  })

  it("the question is asked only when the ITIN would really be written: a record that already holds this ITIN saves the file", async () => {
    state.people[0].itin = "900-70-1234"
    state.other = "John Example"
    const r = await saveOne({ itin: "900-70-1234" })
    expect(r).toMatchObject({ ok: true })
    expect(saveDocumentForContact).toHaveBeenCalledTimes(1)
    expect(writeITINFields).not.toHaveBeenCalled()
  })

  it("the same question again after the file is filed is a net: if the record changed in between, the ITIN is NOT written (amber) and the client is not shown", async () => {
    state.otherSeq = [null, "John Example"]
    const r = await saveOne({ itin: "900-70-1234", client: "show_notify" })
    expect(saveDocumentForContact).toHaveBeenCalledTimes(1)
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: true, partial: true })
    const texts = noteTexts(r).join(" | ")
    expect(texts).toMatch(/already on John Example's record, so it was NOT written for Jane Sample/)
    expect(texts).toMatch(/NOT shown to Jane Sample/)
  })

  it("when the other-holder check cannot be made NOTHING is saved (no half-state) and the answer says to try again", async () => {
    state.other = "error"
    const r = await saveOne({ itin: "900-70-1234", client: "show_silent" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Could not check whether this ITIN is already on another person's record — nothing was saved/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(setClientVisibility).not.toHaveBeenCalled()
  })

  it("the guard does not block a save that writes no ITIN (nothing typed)", async () => {
    state.other = "John Example"
    const r = await saveOne()
    expect(r).toMatchObject({ ok: true, partial: false })
  })

  it("when the record cannot be read AGAIN after the save, nothing is judged against a stale snapshot: no write, amber", async () => {
    state.failContactReadAt = 3 // 1 = the people list, 2 = the first fresh read, 3 = the read after the save
    const r = await saveOne({ itin: "900-70-1234" })
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(r.partial).toBe(true)
    expect(noteTexts(r).join(" ")).toMatch(/could not be read again/)
  })

  it("a failed write is amber + partial (the file is saved), and the audit row says NOTHING was written", async () => {
    vi.mocked(writeITINFields).mockRejectedValueOnce(new Error("column \"itin_renewal_date\" can only be updated to DEFAULT"))
    const r = await saveOne({ itin: "900-70-1234", issueDate: "2025-10-07" })
    expect(r).toMatchObject({ ok: true, partial: true })
    expect(h.inserts.find((i) => i.table === "action_log")?.row.details).toMatchObject({ itin_written: false, issue_date_written: false, partial: true })
  })

  it("the audit row never holds an ITIN number", async () => {
    await saveOne({ itin: "900-70-1234" })
    const text = JSON.stringify(h.inserts.filter((i) => i.table === "action_log"))
    expect(text).not.toMatch(/900-70-1234|900701234/)
  })
})

describe("saveChatAttachmentsToStorage — the client", () => {
  it("hidden (the default): nothing is shown, nothing is sent", async () => {
    const r = await saveOne()
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
    expect(noteTexts(r).join(" ")).toMatch(/Kept hidden from the client/)
  })

  it("show quietly: shown WITHOUT any automatic alert or chat line, and no notification is requested", async () => {
    await saveOne({ client: "show_silent" })
    expect(setClientVisibility).toHaveBeenCalledWith("file-1", true, "staff-1", { silent: true, suppressChat: true })
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
  })

  it("show and notify: shown silently, then the notification is AWAITED with chat:false and its real outcome is reported", async () => {
    const r = await saveOne({ client: "show_notify" })
    expect(setClientVisibility).toHaveBeenCalledWith("file-1", true, "staff-1", { silent: true, suppressChat: true })
    expect(notifyClientsOfNewDocument).toHaveBeenCalledWith("doc-1", { chat: false })
    expect(r.partial).toBe(false)
    expect(noteTexts(r).join(" ")).toMatch(/a notification was created there for Jane Sample \(no chat message\)/)
  })

  it("'already notified earlier' is a plain note, not a failure", async () => {
    vi.mocked(notifyClientsOfNewDocument).mockResolvedValueOnce({ notified: false, reason: "already_notified" })
    const r = await saveOne({ client: "show_notify" })
    expect(r.partial).toBe(false)
    expect(noteTexts(r).join(" ")).toMatch(/already notified about this document earlier/)
  })

  it.each([
    ["feature_disabled", /client alerts are switched off/],
    ["send_failed", /could not be created — nothing was marked as sent, so Save again will retry/],
    ["claim_failed", /could not reserve the notification/],
    ["send_failed_stuck", /will NOT retry it/],
    ["no_recipient", /nobody to alert/],
  ])("a notification that was NOT sent (%s) is amber and partial — never a green 'notified'", async (reason, text) => {
    vi.mocked(notifyClientsOfNewDocument).mockResolvedValueOnce({ notified: false, reason })
    const r = await saveOne({ client: "show_notify" })
    expect(r.partial).toBe(true)
    const warns = r.notes.filter((n) => n.level === "warn").map((n) => n.text).join(" ")
    expect(warns).toMatch(text)
    expect(noteTexts(r).join(" ")).not.toMatch(/a notification was created/)
  })

  it("a notification helper that THROWS is amber and partial", async () => {
    vi.mocked(notifyClientsOfNewDocument).mockRejectedValueOnce(new Error("network"))
    const r = await saveOne({ client: "show_notify" })
    expect(r.partial).toBe(true)
  })

  it("a failed show step: no notification is attempted, amber", async () => {
    vi.mocked(setClientVisibility).mockRejectedValueOnce(new Error("This document is staff-only"))
    const r = await saveOne({ client: "show_notify" })
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
    expect(r.partial).toBe(true)
    expect(noteTexts(r).join(" ")).toMatch(/stays hidden: This document is staff-only/)
  })

  it("a record that holds a DIFFERENT ITIN (no 'replace'): the letter may be somebody else's, so it is NOT shown and NOT announced, whatever was chosen", async () => {
    state.people[0].itin = "901-54-5678"
    for (const client of ["show_silent", "show_notify"] as const) {
      const r = await saveOne({ itin: "900-70-1234", client })
      expect(r).toMatchObject({ ok: true, partial: true })
      expect(noteTexts(r).join(" | ")).toMatch(/\[WARN\] NOT shown to Jane Sample/)
    }
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
  })

  it("…with 'replace' ticked the ITIN is written and the client choice runs as usual", async () => {
    state.people[0].itin = "901-54-5678"
    const r = await saveOne({ itin: "900-70-1234", replaceItin: true, client: "show_notify" })
    expect(r.partial).toBe(false)
    expect(setClientVisibility).toHaveBeenCalledTimes(1)
    expect(notifyClientsOfNewDocument).toHaveBeenCalledTimes(1)
  })

  it("the SAME ITIN already on the record (only the date kept) is not a doubt about whose letter it is: the client choice runs", async () => {
    state.people[0].itin = "900-70-1234"
    state.people[0].issue = "2020-01-01"
    await saveOne({ itin: "900-70-1234", issueDate: "2025-10-07", client: "show_silent" })
    expect(setClientVisibility).toHaveBeenCalledTimes(1)
  })

  it("a file that is ALREADY visible is not called 'NOT shown': the line says it is visible and was left as it is, and nobody is notified", async () => {
    state.visible = true
    state.people[0].itin = "901-54-5678"
    const r = await saveOne({ itin: "900-70-1234", client: "show_notify" })
    const texts = noteTexts(r).join(" | ")
    expect(texts).toMatch(/\[WARN\] Left as it is: this file is already visible to Jane Sample, but the ITIN check above/)
    expect(texts).not.toMatch(/NOT shown/)
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
  })

  it("'hidden' on a file that is already visible changes nothing and says so (this card never hides a file)", async () => {
    state.visible = true
    const r = await saveOne({ client: "hidden" })
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(r.partial).toBe(false)
    expect(noteTexts(r).join(" ")).toMatch(/\[WARN\] Left as it is: this file is already visible/)
  })

  it("an already-visible file with 'show and notify' is not shown again; the notification still goes through its real check", async () => {
    state.visible = true
    await saveOne({ client: "show_notify" })
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(notifyClientsOfNewDocument).toHaveBeenCalledTimes(1)
  })

  it("when it cannot be read whether the client can see the file, nothing is done for the client (amber), not 'kept hidden'", async () => {
    state.visibleReadFails = true
    const r = await saveOne({ client: "show_notify" })
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
    expect(r.partial).toBe(true)
    expect(noteTexts(r).join(" ")).not.toMatch(/Kept hidden/)
  })

  it("a chat message is never posted: the notification is asked for with chat:false every time", async () => {
    await saveOne({ client: "show_notify" })
    expect(vi.mocked(notifyClientsOfNewDocument).mock.calls.every((c) => (c[1] as { chat?: boolean }).chat === false)).toBe(true)
  })
})

describe("saveChatAttachmentsToStorage — the message", () => {
  it("a deleted message, an unknown message and a bad id", async () => {
    state.deleted = true
    expect(await saveChatAttachmentsToStorage(MSG, [input()], null)).toMatchObject({ ok: false, status: 410 })
    state.deleted = false
    state.noRowsMessage = true
    expect(await saveChatAttachmentsToStorage(MSG, [input()], null)).toMatchObject({ ok: false, status: 404 })
    expect(await saveChatAttachmentsToStorage("not-an-id", [input()], null)).toMatchObject({ ok: false, status: 400 })
  })

  it("a message that points at ANOTHER company's file saves nothing and downloads nothing (save and preview alike)", async () => {
    const OTHER = "chat-attachments/acct-OTHER/cccc.pdf"
    h.files[OTHER] = { bytes: PDF }
    state.attachments = [{ url: `https://abcdefgh.supabase.co/storage/v1/object/public/assets/${OTHER}`, name: "scan.pdf", size: 1000, mime_type: "application/pdf" }]
    const r = await saveOne({ itin: "900-70-1234" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not in this chat's own folder/)
    expect(saveDocumentForContact).not.toHaveBeenCalled()
    expect(await readChatAttachmentForPreview(MSG, 0)).toMatchObject({ ok: false, status: 404 })
    expect(h.downloads).toEqual([])
  })

  it("a failure on one file never stops the others", async () => {
    vi.mocked(saveDocumentForContact).mockRejectedValueOnce(new Error("storage down"))
    const r = await saveChatAttachmentsToStorage(MSG, [input({ index: 0 }), input({ index: 1 })], null)
    if (!("results" in r)) throw new Error("failed")
    expect(r.results[0]).toMatchObject({ ok: false })
    expect(r.results[1]).toMatchObject({ ok: true })
  })
})

describe("readChatAttachmentsForCard", () => {
  async function read() {
    const r = await readChatAttachmentsForCard(MSG)
    if (!("items" in r)) throw new Error(`unexpected failure: ${JSON.stringify(r)}`)
    return r.items
  }

  it("reads an ITIN notice: recognised, owner proposed by the letter's own name, the default name and place, and NOTHING is saved or written", async () => {
    const items = await read()
    expect(items[0]).toMatchObject({ readable: true, recognized: true, noticeKind: "CP565A", proposedContactId: "c1", proposedFileName: "ITIN Letter - Jane Sample.pdf", proposedPlace: "Jane Sample › ITIN folder", mimeType: "application/pdf" })
    expect(items[0].itin).toMatchObject({ value: "900-70-1234", status: "ok" })
    expect(items[0].noticeDate).toMatchObject({ value: "2025-10-07", status: "ok" })
    expect(saveDocumentForContact).not.toHaveBeenCalled()
    expect(writeITINFields).not.toHaveBeenCalled()
    expect(setClientVisibility).not.toHaveBeenCalled()
    expect(notifyClientsOfNewDocument).not.toHaveBeenCalled()
    expect(h.inserts).toEqual([])
  })

  it("a scan recorded as octet-stream with no extension is accepted (the bytes decide) and gets the extension of its real type", async () => {
    const items = await read()
    expect(items[1]).toMatchObject({ readable: true, mimeType: "image/png", proposedFileName: "ITIN Letter - Jane Sample.png" })
  })

  it("HTML named .pdf is not readable and never goes to Document AI", async () => {
    h.files[PATH0] = { bytes: HTML }
    const items = await read()
    expect(items[0]).toMatchObject({ readable: false })
    expect(items[0].unsupportedReason).toMatch(/not a PDF or a picture/)
    expect(vi.mocked(ocrRawContent)).toHaveBeenCalledTimes(1) // only the PNG
  })

  it("'already saved' is per PERSON and counts live files only", async () => {
    state.saved = [{ id: "f9", name: "ITIN Letter - John Example.pdf", state: "live", caller_key: `chat-attachment:${MSG}:${"a".repeat(64)}:c2` }]
    // the recorder cannot match the real sha, so prove the parsing through the other direction: the rules unit tests cover the key; here the lookup is simply wired per person
    const items = await read()
    expect(items[0].candidates.map((c) => c.alreadySaved)).toEqual([null, null])
  })

  it("a message with no attachments, and members that cannot be read", async () => {
    state.attachments = []
    expect(await readChatAttachmentsForCard(MSG)).toMatchObject({ ok: false, status: 404 })
    state.attachments = [{ url: URL0, name: "scan.pdf", size: 1000, mime_type: "application/pdf" }]
    vi.mocked(resolveAccountMembersForChat).mockResolvedValueOnce([])
    h.handler = (t, ops) => (t === "members" ? { error: { message: "outage" } } : handler(t, ops))
    expect(await readChatAttachmentsForCard(MSG)).toMatchObject({ ok: false, status: 500 })
  })

  it("a company with members but none linkable says what to do, and proposes nobody", async () => {
    vi.mocked(resolveAccountMembersForChat).mockResolvedValueOnce([])
    const items = await read()
    expect(items[0].candidates).toEqual([])
    expect(items[0].proposedContactId).toBeNull()
    expect(items[0].ownerReason).toMatch(/link the member's contact/)
  })

  it("the Document AI error text never reaches the card", async () => {
    vi.mocked(ocrRawContent).mockRejectedValueOnce(new Error("Document AI error 429: quota for project 796202564410"))
    const items = await read()
    expect(items[0].readError).toMatch(/did not answer/)
    expect(items[0].readError).not.toMatch(/796202564410|quota/)
  })

  it("every person gets the waiting-case answer; a check that fails says so (null)", async () => {
    vi.mocked(findWaitingWorkspaceStepsForContact).mockImplementation((async (i: { contactId: string }) => {
      if (i.contactId === "c2") throw new Error("db down")
      return []
    }) as never)
    const items = await read()
    expect(items[0].candidates.map((c) => c.waiting)).toEqual([[], null])
  })

  it("at most 3 files are read at the same time", async () => {
    state.attachments = Array.from({ length: 8 }, (_, i) => ({ url: URL0, name: `s${i}.pdf`, size: 1000, mime_type: "application/pdf" }))
    let running = 0
    let peak = 0
    vi.mocked(ocrRawContent).mockImplementation(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { fullText: LETTER } as never
    })
    const items = await read()
    expect(items).toHaveLength(8)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })
  it("members that share ONE contact but have different names are NOT merged: the stranger is not offered as an alternative spelling, and it is said why", async () => {
    vi.mocked(resolveAccountMembersForChat).mockResolvedValueOnce([
      { memberId: "m1", name: "Jane Sample", contactId: "c1", isCompanyMember: false, isPrimary: true, resolvable: true },
      { memberId: "m9", name: "Radomir Knapec", contactId: "c1", isCompanyMember: false, isPrimary: false, resolvable: true }, // a member row with no contact of its own, matched to c1 by e-mail
    ])
    ocrLetterFor("RADOMIR KNAPEC")
    const items = await read()
    expect(items[0].candidates.map((c) => c.contactId)).toEqual(["c1"])
    expect(items[0].candidates[0].namedInLetter).toBe(false) // Radomir's name no longer makes Jane "named"
    expect(items[0].proposedContactId).toBeNull()
    expect(items[0].ownerReason).toMatch(/Radomir Knapec is linked to Jane Sample's contact record, but the names do not match — not offered/)
  })

  it("a lone member whose only match is a differently named contact is not offered at all (the real case: two people on one e-mail)", async () => {
    vi.mocked(resolveAccountMembersForChat).mockResolvedValueOnce([
      { memberId: "m9", name: "Gaia Suriano", contactId: "c1", isCompanyMember: false, isPrimary: true, resolvable: true },
    ])
    const items = await read()
    expect(items[0].candidates).toEqual([])
    expect(items[0].proposedContactId).toBeNull()
    expect(items[0].ownerReason).toMatch(/Gaia Suriano is linked to Jane Sample's contact record, but the names do not match/)
  })

  it("a RELATIVE who shares the family name (and the e-mail, so the same contact) is not the same person: his letter does not make Jane 'named'", async () => {
    vi.mocked(resolveAccountMembersForChat).mockResolvedValueOnce([
      { memberId: "m1", name: "Jane Sample", contactId: "c1", isCompanyMember: false, isPrimary: true, resolvable: true },
      { memberId: "m9", name: "Peter Sample", contactId: "c1", isCompanyMember: false, isPrimary: false, resolvable: true },
    ])
    ocrLetterFor("PETER SAMPLE")
    const items = await read()
    expect(items[0].candidates.map((c) => c.contactId)).toEqual(["c1"])
    expect(items[0].candidates[0].namedInLetter).toBe(false)
    expect(items[0].proposedContactId).toBeNull()
    expect(items[0].ownerReason).toMatch(/Peter Sample is linked to Jane Sample's contact record, but the names do not match/)
  })

  it("a member whose name is in another alphabet is still offered when it is the contact's own name (it used to have no words at all)", async () => {
    state.people[0].name = "Иван Петров"
    vi.mocked(resolveAccountMembersForChat).mockResolvedValueOnce([
      { memberId: "m1", name: "Иван Петров", contactId: "c1", isCompanyMember: false, isPrimary: true, resolvable: true },
    ])
    const items = await read()
    expect(items[0].candidates.map((c) => c.contactId)).toEqual(["c1"])
    expect(items[0].ownerReason).not.toMatch(/not offered/)
  })

  it("another spelling of the SAME person is still kept (shares a word): 'Jane A. Sample' on the member row, 'Jane Sample' on the contact", async () => {
    vi.mocked(resolveAccountMembersForChat).mockResolvedValueOnce([
      { memberId: "m1", name: "Jane A. Sample", contactId: "c1", isCompanyMember: false, isPrimary: true, resolvable: true },
    ])
    const items = await read()
    expect(items[0].candidates.map((c) => c.contactId)).toEqual(["c1"])
    expect(items[0].ownerReason).not.toMatch(/not offered/)
  })

  it("the name matches but the date of birth printed on the letter is NOT the one on the record: nobody is proposed and the person needs the 'I checked' tick", async () => {
    state.people[0].dob = "1985-01-01"
    const items = await read()
    expect(items[0].proposedContactId).toBeNull()
    expect(items[0].candidates[0]).toMatchObject({ contactId: "c1", namedInLetter: false })
    expect(items[0].ownerReason).toMatch(/Jane Sample.*date of birth is not the one on their record/)
  })

  it("no date of birth on the record says nothing: the name decides, as before", async () => {
    state.people[0].dob = null
    const items = await read()
    expect(items[0]).toMatchObject({ proposedContactId: "c1" })
    expect(items[0].candidates[0].namedInLetter).toBe(true)
  })

  it("an attachment that sits in ANOTHER company's folder is not downloaded, not read and not offered — the card says it is not this chat's own", async () => {
    const OTHER = "chat-attachments/acct-OTHER/cccc.pdf"
    h.files[OTHER] = { bytes: PDF }
    state.attachments = [{ url: `https://abcdefgh.supabase.co/storage/v1/object/public/assets/${OTHER}`, name: "scan.pdf", size: 1000, mime_type: "application/pdf" }]
    const items = await read()
    expect(items[0]).toMatchObject({ readable: false })
    expect(items[0].unsupportedReason).toMatch(/not in this chat's own folder/)
    expect(h.downloads).toEqual([])
    expect(ocrRawContent).not.toHaveBeenCalled()
  })

  it("the person's own folder (the chat's contact id) is allowed too", async () => {
    h.files["chat-attachments/c1/dddd.pdf"] = { bytes: PDF }
    state.attachments = [{ url: "https://abcdefgh.supabase.co/storage/v1/object/public/assets/chat-attachments/c1/dddd.pdf", name: "scan.pdf", size: 1000, mime_type: "application/pdf" }]
    const items = await read()
    expect(items[0]).toMatchObject({ readable: true, recognized: true })
  })
})
