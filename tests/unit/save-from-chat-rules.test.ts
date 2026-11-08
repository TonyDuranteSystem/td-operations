import { describe, it, expect } from "vitest"
import {
  assetsPathOfUrl, chatAttachmentsOf, chatSaveCallerKey, chatSaveKeyPrefix, contactOfChatSaveKey, decideItinWrite, defaultLetterName, fileNameHasTaxNumber,
  claimedSizeProblem, extForMime, parseClientChoice, parseSaveItems, proposeOwner, sniffReadableMime, visibilityPlan, withoutKnownExtension, MAX_CARD_ITEMS,
  attachmentDirAllowed, candidateNamedIn, dateOfBirthContradicts,
} from "@/lib/crm-store/save-from-chat-rules"

const SUPA = "https://abcdefgh.supabase.co"
const PORTAL = "https://portal.example.test"
const GOOD = `${SUPA}/storage/v1/object/public/assets/chat-attachments/1f7b255b-d204-44d4-a951-145aee11e273/06788bbf-85f2-4877-8768-668367f13680.pdf`

describe("assetsPathOfUrl — only OUR chat attachments, taken from the saved message", () => {
  it("accepts the public object url of the assets bucket", () => {
    expect(assetsPathOfUrl(GOOD, SUPA, PORTAL)).toBe("chat-attachments/1f7b255b-d204-44d4-a951-145aee11e273/06788bbf-85f2-4877-8768-668367f13680.pdf")
  })
  it("accepts the authenticated object route and the portal's own access-checked proxy", () => {
    expect(assetsPathOfUrl(GOOD.replace("/public/", "/authenticated/"), SUPA, PORTAL)).toMatch(/^chat-attachments\//)
    expect(assetsPathOfUrl(`${PORTAL}/api/portal/chat/attachment?path=chat-attachments/abc/def.pdf`, SUPA, PORTAL)).toBe("chat-attachments/abc/def.pdf")
  })
  it("refuses another origin, a look-alike host, credentials in the url, another bucket and other folders", () => {
    expect(assetsPathOfUrl("https://evil.example/storage/v1/object/public/assets/chat-attachments/a/b.pdf", SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl("https://abcdefgh.supabase.co.evil.tld/storage/v1/object/public/assets/chat-attachments/a/b.pdf", SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl("https://abcdefgh.supabase.co@evil.tld/storage/v1/object/public/assets/chat-attachments/a/b.pdf", SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl("https://u:p@abcdefgh.supabase.co/storage/v1/object/public/assets/chat-attachments/a/b.pdf", SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl(`${SUPA}/storage/v1/object/public/onboarding-uploads/chat-attachments/a/b.pdf`, SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl(`${SUPA}/storage/v1/object/public/assets/other-folder/a/b.pdf`, SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl("not a url", SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl("file:///etc/passwd", SUPA, PORTAL)).toBeNull()
  })
  it("refuses path traversal, including an encoded one, and a path that is not exactly dir/file", () => {
    expect(assetsPathOfUrl(`${SUPA}/storage/v1/object/public/assets/chat-attachments/a/..%2F..%2Fsecret.pdf`, SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl(`${SUPA}/storage/v1/object/public/assets/chat-attachments/../x/y.pdf`, SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl(`${SUPA}/storage/v1/object/public/assets/chat-attachments/a/b/c.pdf`, SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl(`${PORTAL}/api/portal/chat/attachment?path=chat-attachments/a/../b.pdf`, SUPA, PORTAL)).toBeNull()
    expect(assetsPathOfUrl(`${PORTAL}/api/other?path=chat-attachments/a/b.pdf`, SUPA, PORTAL)).toBeNull()
  })
  it("an empty base url never matches", () => {
    expect(assetsPathOfUrl(GOOD, "", PORTAL)).toBeNull()
  })
})

describe("chatAttachmentsOf — the same list the staff screen shows", () => {
  it("uses the attachments list, keeping name, size and type", () => {
    const r = chatAttachmentsOf({ attachments: [{ url: "u1", name: "a.pdf", size: 5, mime_type: "application/pdf" }, { url: "u2", name: "" }, { nope: 1 }, null] })
    expect(r).toEqual([{ url: "u1", name: "a.pdf", size: 5, mime_type: "application/pdf" }, { url: "u2", name: "Attachment", size: null, mime_type: null }])
  })
  it("falls back to the older single attachment", () => {
    expect(chatAttachmentsOf({ attachments: [], attachment_url: "u", attachment_name: "x.png" })).toEqual([{ url: "u", name: "x.png", size: null, mime_type: null }])
  })
  it("no attachments → empty", () => {
    expect(chatAttachmentsOf({})).toEqual([])
    expect(chatAttachmentsOf({ attachments: "nope" as unknown })).toEqual([])
  })
})

describe("claimedSizeProblem / extForMime — the claims are only a pre-check; the bytes decide", () => {
  it("only a claimed size over 15 MB is turned away early (the claimed TYPE is never a reason: a real scan is often octet-stream)", () => {
    expect(claimedSizeProblem(500_000)).toBeNull()
    expect(claimedSizeProblem(null)).toBeNull()
    expect(claimedSizeProblem(undefined)).toBeNull()
    expect(claimedSizeProblem(16 * 1024 * 1024)).toMatch(/15 MB/)
  })
  it("the extension follows the REAL type", () => {
    expect(extForMime("application/pdf")).toBe(".pdf")
    expect(extForMime("image/jpeg")).toBe(".jpg")
    expect(extForMime("image/png")).toBe(".png")
    expect(extForMime("image/tiff")).toBe(".tif")
    expect(extForMime("text/html")).toBe(".pdf") // never reached for a refused file; a safe default
  })
})

describe("names and keys", () => {
  it("the caller key is message + bytes + PERSON — two people never share a file, and the client's file name is not in it", () => {
    const a = chatSaveCallerKey("m1", "sha", "c1")
    expect(a).toBe(chatSaveCallerKey("m1", "sha", "c1"))
    expect(a).not.toBe(chatSaveCallerKey("m1", "sha", "c2")) // the other member: a different file, never "found" as the first one
    expect(a).not.toBe(chatSaveCallerKey("m2", "sha", "c1"))
    expect(a).not.toBe(chatSaveCallerKey("m1", "other", "c1"))
    expect(a).toBe("chat-attachment:m1:sha:c1")
  })
  it("the key prefix finds every person's copy of one attachment, and tells whose each is", () => {
    expect(chatSaveKeyPrefix("m1", "sha")).toBe("chat-attachment:m1:sha:")
    expect(contactOfChatSaveKey(chatSaveCallerKey("m1", "sha", "c9"), "m1", "sha")).toBe("c9")
    expect(contactOfChatSaveKey(chatSaveCallerKey("m1", "other", "c9"), "m1", "sha")).toBeNull()
    expect(contactOfChatSaveKey("gmail-attachment:m1:sha:c9", "m1", "sha")).toBeNull()
    expect(contactOfChatSaveKey(null, "m1", "sha")).toBeNull()
    // a copy saved again after the first was trashed: ":after-trash:<file id>" is not part of the person
    expect(contactOfChatSaveKey(`${chatSaveCallerKey("m1", "sha", "c9")}:after-trash:7c1f0d5e-0000-4000-8000-000000000001`, "m1", "sha")).toBe("c9")
    expect(contactOfChatSaveKey("chat-attachment:m1:sha:", "m1", "sha")).toBeNull()
  })
  it("the default name is clean — never the client's own name with the ITIN in it", () => {
    expect(defaultLetterName("Peter Papik", "PETER-PAPIK---903-61-8342-itin.pdf")).toBe("ITIN Letter - Peter Papik.pdf")
    expect(defaultLetterName("Jane / Doe", "scan.JPG")).toBe("ITIN Letter - Jane Doe.JPG")
    expect(defaultLetterName(null, "x.pdf")).toBe("ITIN Letter.pdf")
    expect(defaultLetterName("  ", "noext")).toBe("ITIN Letter.pdf")
  })
  it("a file name carrying a tax number is refused — with any separator", () => {
    expect(fileNameHasTaxNumber("PETER-PAPIK---903-61-8342-itin.pdf")).toBe(true)
    expect(fileNameHasTaxNumber("itin 903 61 8342.pdf")).toBe(true)
    expect(fileNameHasTaxNumber("itin 903.61.8342.pdf")).toBe(true)
    expect(fileNameHasTaxNumber("itin_903_61_8342.pdf")).toBe(true)
    expect(fileNameHasTaxNumber("EIN 12-3456789.pdf")).toBe(true)
    expect(fileNameHasTaxNumber("EIN 12.3456789.pdf")).toBe(true)
    expect(fileNameHasTaxNumber("scan903618342.pdf")).toBe(true)
    expect(fileNameHasTaxNumber("ITIN Letter - Peter Papik.pdf")).toBe(false)
    expect(fileNameHasTaxNumber("Lease 2026.pdf")).toBe(false)
    expect(fileNameHasTaxNumber("Invoice 2026-11-07.pdf")).toBe(false)
  })
})

describe("sniffReadableMime — what the BYTES are, not what the client claimed", () => {
  const bytes = (...n: number[]) => new Uint8Array(n)
  const text = (t: string) => new Uint8Array(t.split("").map((c) => c.charCodeAt(0)))
  it("recognises a PDF and the pictures the reading service takes", () => {
    expect(sniffReadableMime(text("%PDF-1.7\n..."))).toBe("application/pdf")
    expect(sniffReadableMime(text("\n\n  junk before the header\n%PDF-1.4\n..."))).toBe("application/pdf") // the PDF spec allows bytes before the header
    expect(sniffReadableMime(text(`${"x".repeat(1100)}%PDF-1.4`))).toBeNull() // …but only within the first 1024
    expect(sniffReadableMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0))).toBe("image/jpeg")
    expect(sniffReadableMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png")
    expect(sniffReadableMime(text("GIF89a......"))).toBe("image/gif")
    expect(sniffReadableMime(bytes(0x49, 0x49, 0x2a, 0x00, 1, 2))).toBe("image/tiff")
    expect(sniffReadableMime(bytes(0x4d, 0x4d, 0x00, 0x2a, 1, 2))).toBe("image/tiff")
    expect(sniffReadableMime(text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp")
    expect(sniffReadableMime(new Uint8Array([0x42, 0x4d, ...Array.from({ length: 20 }, () => 0)]))).toBe("image/bmp")
  })
  it("a picture that merely CONTAINS the text %PDF- near its start is still a picture (exact signatures win)", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ..."%PDF-1.4".split("").map((c) => c.charCodeAt(0))])
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ..."%PDF-1.4".split("").map((c) => c.charCodeAt(0))])
    expect(sniffReadableMime(png)).toBe("image/png")
    expect(sniffReadableMime(jpeg)).toBe("image/jpeg")
  })
  it("refuses HTML, scripts, SVG, zips, empty files and a short 'BM'", () => {
    expect(sniffReadableMime(text("<html><script>alert(1)</script>"))).toBeNull()
    expect(sniffReadableMime(text("<svg xmlns=\"http://www.w3.org/2000/svg\">"))).toBeNull()
    expect(sniffReadableMime(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull()
    expect(sniffReadableMime(new Uint8Array(0))).toBeNull()
    expect(sniffReadableMime(text("BM"))).toBeNull()
  })
})

describe("proposeOwner — the letter decides, never the sender", () => {
  const people = [{ contactId: "c1", name: "Jane Sample" }, { contactId: "c2", name: "John Example" }]
  it("proposes the one member the letter names", () => {
    expect(proposeOwner(people, "JANE SAMPLE 14 HUGHES STE").contactId).toBe("c1")
    expect(proposeOwner(people, "Full name JANE, SAMPLE").contactId).toBe("c1") // "Last, First" printing
    expect(proposeOwner(people, "JOHN EXAMPLE").contactId).toBe("c2")
  })
  it("a name garbled by the scan is NOT matched loosely (two members could differ by one letter) — it asks instead", () => {
    const r = proposeOwner(people, "JANE SAMPLEi 14 HUGHES STE")
    expect(r.contactId).toBeNull()
    expect(r.reason).toMatch(/choose/i)
  })
  it("uses another spelling we hold for the person", () => {
    expect(proposeOwner([{ contactId: "c1", name: "Janet Sample", altNames: ["Jane Sample"] }], "JANE SAMPLE").contactId).toBe("c1")
  })
  it("proposes nobody when the letter names nobody, or names more than one", () => {
    const none = proposeOwner(people, "SOMEBODY ELSE")
    expect(none.contactId).toBeNull()
    expect(none.reason).toMatch(/does not name/i)
    const both = proposeOwner(people, "JANE SAMPLE and JOHN EXAMPLE")
    expect(both.contactId).toBeNull()
    expect(both.named.sort()).toEqual(["c1", "c2"])
  })
  it("nobody to choose from → a plain reason that says what to do; a person's own chat says so", () => {
    expect(proposeOwner([], "JANE SAMPLE").reason).toMatch(/link the member's contact/i)
    expect(proposeOwner([], "JANE SAMPLE", "person").reason).toMatch(/no person/i)
    expect(proposeOwner([{ contactId: "c1", name: "Jane Sample" }], "SOMEBODY ELSE", "person").reason).toMatch(/one person's own chat/i)
  })
  it("a member with a one-word name is never proposed", () => {
    expect(proposeOwner([{ contactId: "c1", name: "Madonna" }], "MADONNA").contactId).toBeNull()
  })
})

describe("who the letter names — a name AND, when both are known, the date of birth", () => {
  const jane = { contactId: "c1", name: "Jane Sample", dateOfBirth: "1990-03-03" }
  it("the same name with a different date of birth is NOT 'named' — a name alone also matches a middle name or a street", () => {
    expect(candidateNamedIn("JANE SAMPLE", jane, "1990-03-03")).toBe(true)
    expect(candidateNamedIn("JANE SAMPLE", jane, "1985-01-01")).toBe(false)
  })
  it("an unknown date of birth on either side says nothing", () => {
    expect(candidateNamedIn("JANE SAMPLE", jane, null)).toBe(true)
    expect(candidateNamedIn("JANE SAMPLE", { ...jane, dateOfBirth: null }, "1985-01-01")).toBe(true)
    expect(dateOfBirthContradicts(null, "1985-01-01")).toBe(false)
    expect(dateOfBirthContradicts("1990-03-03", undefined)).toBe(false)
    expect(dateOfBirthContradicts("1990-03-03", "1990-03-03")).toBe(false)
    expect(dateOfBirthContradicts("1990-03-03", "1990-03-04")).toBe(true)
  })
  it("proposeOwner: a name match with a contradicting date of birth proposes nobody and says why; without a mismatch it proposes", () => {
    const people = [jane, { contactId: "c2", name: "John Example", dateOfBirth: "1985-06-09" }]
    expect(proposeOwner(people, "JANE SAMPLE", "company", "1990-03-03").contactId).toBe("c1")
    const r = proposeOwner(people, "JANE SAMPLE", "company", "1999-09-09")
    expect(r.contactId).toBeNull()
    expect(r.reason).toMatch(/Jane Sample.*date of birth is not the one on their record/)
    // the other member is still found when only one of the two contradicts
    expect(proposeOwner([jane, { contactId: "c3", name: "Jane Sample", dateOfBirth: "1999-09-09" }], "JANE SAMPLE", "company", "1999-09-09").contactId).toBe("c3")
  })
})

describe("attachmentDirAllowed — a chat only reads its OWN folder", () => {
  const chat = { accountId: "acct-1", contactId: "c-9" }
  it("the company's folder, or the person's own folder, is allowed", () => {
    expect(attachmentDirAllowed("chat-attachments/acct-1/a.pdf", chat)).toBe(true)
    expect(attachmentDirAllowed("chat-attachments/c-9/a.pdf", chat)).toBe(true)
  })
  it("another company's or person's folder is refused", () => {
    expect(attachmentDirAllowed("chat-attachments/acct-2/a.pdf", chat)).toBe(false)
    expect(attachmentDirAllowed("chat-attachments/unknown/a.pdf", chat)).toBe(false)
    expect(attachmentDirAllowed("chat-attachments//a.pdf", chat)).toBe(false)
  })
  it("a chat with no company or no person never matches the empty or missing id", () => {
    expect(attachmentDirAllowed("chat-attachments/acct-1/a.pdf", { accountId: null, contactId: null })).toBe(false)
    expect(attachmentDirAllowed("chat-attachments/acct-1/a.pdf", { accountId: null, contactId: "c-9" })).toBe(false)
  })
})

describe("client choice — default: nothing shown, nothing sent", () => {
  it("anything unknown is 'hidden'", () => {
    expect(parseClientChoice(undefined)).toBe("hidden")
    expect(parseClientChoice("show_everyone")).toBe("hidden")
    expect(parseClientChoice(true)).toBe("hidden")
    expect(parseClientChoice("show_silent")).toBe("show_silent")
    expect(parseClientChoice("show_notify")).toBe("show_notify")
  })
  it("maps onto show / silent", () => {
    expect(visibilityPlan("hidden")).toEqual({ show: false, silent: false })
    expect(visibilityPlan("show_silent")).toEqual({ show: true, silent: true })
    expect(visibilityPlan("show_notify")).toEqual({ show: true, silent: false })
  })
})

describe("decideItinWrite — never replaces what the record holds RIGHT NOW without 'replace'", () => {
  const base = { existingItin: null as string | null, existingIssueDate: null as string | null, newItin: "900-70-1234" as string | null, newDate: "2025-10-07" as string | null, replace: false }
  const none = { writeItin: false, writeDate: false, clearDate: false, kept: false }
  it("nothing on the record → write both", () => {
    expect(decideItinWrite(base)).toEqual({ writeItin: true, writeDate: true, clearDate: false, kept: false, note: null })
  })
  it("no new ITIN → write nothing", () => {
    expect(decideItinWrite({ ...base, newItin: null })).toEqual({ ...none, note: null })
  })
  it("no date entered → the ITIN only", () => {
    expect(decideItinWrite({ ...base, newDate: null })).toEqual({ writeItin: true, writeDate: false, clearDate: false, kept: false, note: null })
  })
  it("a record with an issue date but NO ITIN number: the ITIN is written, the existing date is KEPT (flagged 'kept') unless 'replace'", () => {
    const held = { ...base, existingIssueDate: "2020-01-01" }
    const kept = decideItinWrite(held)
    expect(kept).toMatchObject({ writeItin: true, writeDate: false, kept: true })
    expect(kept.note).toMatch(/already has the issue date 2020-01-01/)
    expect(decideItinWrite({ ...held, replace: true })).toEqual({ writeItin: true, writeDate: true, clearDate: false, kept: false, note: null })
    expect(decideItinWrite({ ...held, existingIssueDate: "2025-10-07" })).toEqual({ writeItin: true, writeDate: true, clearDate: false, kept: false, note: null }) // the same date: nothing is lost
  })
  it("the same ITIN: a missing date is filled, an equal date is left, a different date needs 'replace' (and is flagged 'kept')", () => {
    const same = { ...base, existingItin: "900-70-1234" }
    expect(decideItinWrite(same)).toEqual({ writeItin: false, writeDate: true, clearDate: false, kept: false, note: null })
    expect(decideItinWrite({ ...same, existingIssueDate: "2025-10-07" })).toMatchObject({ ...none })
    expect(decideItinWrite({ ...same, existingIssueDate: "2024-01-01" })).toMatchObject({ writeDate: false, kept: true })
    expect(decideItinWrite({ ...same, existingIssueDate: "2024-01-01", replace: true })).toMatchObject({ writeItin: false, writeDate: true, kept: false })
    expect(decideItinWrite({ ...same, existingItin: "900 70 1234", existingIssueDate: "2025-10-07" }).writeItin).toBe(false) // spelling does not matter
  })
  it("'already has this' outcomes are NOT 'kept' — nothing the staff member wanted was left unwritten", () => {
    const same = { ...base, existingItin: "900-70-1234", newDate: null }
    expect(decideItinWrite(same)).toMatchObject({ kept: false, note: "The record already has this ITIN — nothing to change." })
    expect(decideItinWrite({ ...same, existingIssueDate: "2025-10-07" })).toMatchObject({ kept: false, note: "The record already has this ITIN (issue date 2025-10-07) — nothing to change." })
    expect(decideItinWrite({ ...base, existingItin: "900-70-1234", existingIssueDate: "2025-10-07" })).toMatchObject({ kept: false })
  })
  it("a DIFFERENT ITIN is kept unless staff agreed — flagged 'kept', and the note says to tick replace and save again", () => {
    const other = { ...base, existingItin: "901-54-5678", existingIssueDate: "2020-01-01" }
    const kept = decideItinWrite(other)
    expect(kept).toMatchObject({ ...none, kept: true })
    expect(kept.note).toMatch(/tick "replace" and save again/)
    expect(decideItinWrite({ ...other, replace: true })).toEqual({ writeItin: true, writeDate: true, clearDate: false, kept: false, note: null })
  })
  it("replacing the ITIN with NO new date CLEARS the old date (it belonged to the old number) — never left beside the new one", () => {
    const r = decideItinWrite({ existingItin: "901-54-5678", existingIssueDate: "2020-01-01", newItin: "900-70-1234", newDate: null, replace: true })
    expect(r).toMatchObject({ writeItin: true, writeDate: false, clearDate: true, kept: false })
    expect(r.note).toMatch(/cleared/)
    // nothing to clear when the old record had no date
    expect(decideItinWrite({ existingItin: "901-54-5678", existingIssueDate: null, newItin: "900-70-1234", newDate: null, replace: true })).toEqual({ writeItin: true, writeDate: false, clearDate: false, kept: false, note: null })
  })
})

describe("parseSaveItems — the browser's request, cleaned", () => {
  const ok = { index: 0, contactId: "c1", fileName: " n.pdf ", itin: " 900-70-1234 ", issueDate: "2025-10-07", client: "show_silent", replaceItin: true, itinHolderOk: true, letterDateOfBirth: "1990-03-03" }
  it("cleans a good request", () => {
    expect(parseSaveItems({ items: [ok] })).toEqual([{ index: 0, contactId: "c1", fileName: " n.pdf ", itin: "900-70-1234", issueDate: "2025-10-07", client: "show_silent", replaceItin: true, itinHolderOk: true, letterDateOfBirth: "1990-03-03" }])
  })
  it("blank ITIN/date become null; an unknown client choice becomes hidden; replace needs an exact true; a bad letter date of birth is dropped", () => {
    const r = parseSaveItems({ items: [{ index: 1, contactId: "c2", itin: "  ", issueDate: "", client: "everyone", replaceItin: "yes", itinHolderOk: "yes", letterDateOfBirth: "05/05/1998" }] })
    expect(r).toEqual([{ index: 1, contactId: "c2", fileName: "", itin: null, issueDate: null, client: "hidden", replaceItin: false, itinHolderOk: false, letterDateOfBirth: null }])
  })
  it("refuses a missing list, an empty list, too many, a bad index, an index past the card's limit, the same attachment twice and a missing person", () => {
    expect(parseSaveItems(null)).toBeNull()
    expect(parseSaveItems({})).toBeNull()
    expect(parseSaveItems({ items: [] })).toBeNull()
    expect(parseSaveItems({ items: Array.from({ length: MAX_CARD_ITEMS + 1 }, (_, i) => ({ ...ok, index: i })) })).toBeNull()
    expect(parseSaveItems({ items: [{ ...ok, index: -1 }] })).toBeNull()
    expect(parseSaveItems({ items: [{ ...ok, index: 1.5 }] })).toBeNull()
    expect(parseSaveItems({ items: [{ ...ok, index: MAX_CARD_ITEMS }] })).toBeNull()
    expect(parseSaveItems({ items: [ok, { ...ok, contactId: "c2" }] })).toBeNull() // index 0 twice
    expect(parseSaveItems({ items: [{ ...ok, contactId: undefined }] })).toBeNull()
  })
  it("two DIFFERENT attachments in one request are fine", () => {
    expect(parseSaveItems({ items: [ok, { ...ok, index: 1, contactId: "c2" }] })).toHaveLength(2)
  })
})

describe("withoutKnownExtension — a typed file name never keeps a second, wrong extension", () => {
  it("drops one trailing picture/PDF extension (any case, trailing spaces) and nothing else", () => {
    expect(withoutKnownExtension("ITIN Letter - Jane.pdf")).toBe("ITIN Letter - Jane")
    expect(withoutKnownExtension("scan.JPEG ")).toBe("scan")
    expect(withoutKnownExtension("scan.tif")).toBe("scan")
    expect(withoutKnownExtension("notes.docx")).toBe("notes.docx")
    expect(withoutKnownExtension("a.pdf.png")).toBe("a.pdf")
    expect(withoutKnownExtension("no extension")).toBe("no extension")
  })
})
