/**
 * "Save a client's chat attachment into the storage" — the PURE rules and the shapes shared by the server and the card
 * (dev job fb49265a; Antonio 2026-11-07: the card that saves the two ITIN letters Peter sent for himself and Radomir).
 * No database, no network, safe in the browser — so the rules are unit-tested and the card can import the types.
 */
import { personNamedInText } from "@/lib/itin/read-itin-letter"

export interface ChatAttachment { url: string; name: string; size?: number | null; mime_type?: string | null }

/** What staff may choose for the client, per file. Default: nothing is shown and nothing is sent (Antonio: "the clients don't need any message for the ITIN"). */
export type ClientChoice = "hidden" | "show_silent" | "show_notify"
export const CLIENT_CHOICES: ReadonlyArray<{ key: ClientChoice; label: string }> = [
  { key: "hidden", label: "Keep it hidden from the client (nothing is sent)" },
  { key: "show_silent", label: "Show it in their portal — no notification" },
  { key: "show_notify", label: "Show it and notify them" },
]
export function parseClientChoice(v: unknown): ClientChoice {
  return v === "show_silent" || v === "show_notify" ? v : "hidden"
}
/** How a choice maps onto the existing show/hide step. A chat line is never posted for a personal paper (the company chat is read by every member). */
export function visibilityPlan(choice: ClientChoice): { show: boolean; silent: boolean } {
  return { show: choice !== "hidden", silent: choice === "show_silent" }
}

/**
 * The attachments of a chat message, exactly as the staff screen lists them: the `attachments` list, else the older single
 * `attachment_url`. Entries without a text url are dropped.
 */
export function chatAttachmentsOf(row: { attachments?: unknown; attachment_url?: string | null; attachment_name?: string | null }): ChatAttachment[] {
  if (Array.isArray(row.attachments) && row.attachments.length > 0) {
    const out: ChatAttachment[] = []
    for (const a of row.attachments as Array<Record<string, unknown>>) {
      if (a && typeof a.url === "string" && a.url) {
        out.push({ url: a.url, name: typeof a.name === "string" && a.name ? a.name : "Attachment", size: typeof a.size === "number" ? a.size : null, mime_type: typeof a.mime_type === "string" ? a.mime_type : null })
      }
    }
    return out
  }
  if (row.attachment_url) return [{ url: row.attachment_url, name: row.attachment_name || "Attachment", size: null, mime_type: null }]
  return []
}

/**
 * The object path inside the `assets` bucket for one of OUR chat-attachment urls — or null for anything else. The browser never sends a
 * url: the server takes it from the saved message and still insists on this shape (our own storage origin, the public/authenticated
 * object route of the `assets` bucket, a `chat-attachments/<dir>/<file>` path, no traversal), or the portal's own access-checked proxy
 * (`/api/portal/chat/attachment?path=chat-attachments/…`).
 */
export function assetsPathOfUrl(rawUrl: string, supabaseBaseUrl: string, portalBaseUrl: string): string | null {
  let u: URL
  try { u = new URL(rawUrl) } catch { return null }
  if (u.username || u.password || (u.protocol !== "https:" && u.protocol !== "http:")) return null
  const origin = (b: string): string | null => { try { return new URL(b.trim()).origin } catch { return null } }
  const clean = (p: string): string | null => {
    let path: string
    try { path = decodeURIComponent(p) } catch { return null }
    return /^chat-attachments\/[^/]+\/[^/]+$/.test(path) && path.indexOf("..") === -1 ? path : null
  }
  if (u.origin === origin(supabaseBaseUrl)) {
    const m = /^\/storage\/v1\/object\/(?:public|authenticated)\/assets\/(.+)$/.exec(u.pathname)
    return m ? clean(m[1]) : null
  }
  if (u.origin === origin(portalBaseUrl) && u.pathname === "/api/portal/chat/attachment") {
    return clean(u.searchParams.get("path") ?? "")
  }
  return null
}

/**
 * Whose folder a chat attachment sits in: the `<dir>` of `chat-attachments/<dir>/<file>` — the chat's company id, or the person's id in a
 * person's own thread (that is what the chat upload writes). A saved message may only point at ITS OWN chat's folder: the chat send only
 * checks that a link is on our storage, so a link to another company's file must not be readable (or filed) from here.
 */
export function attachmentDirAllowed(assetPath: string, chat: { accountId: string | null; contactId: string | null }): boolean {
  const dir = assetPath.split("/")[1]
  return !!dir && (dir === chat.accountId || dir === chat.contactId)
}

/** What the document can be read as by the OCR service in one request. */
export const READABLE_MAX_BYTES = 15 * 1024 * 1024

/**
 * A quick pre-check on the SIZE the client claimed (saves a download). The claimed TYPE is deliberately NOT checked here: a real scan is
 * often recorded as application/octet-stream or application/x-pdf, so the first bytes of the file (`sniffReadableMime`) decide what it is.
 */
export function claimedSizeProblem(size: number | null | undefined): string | null {
  return typeof size === "number" && size > READABLE_MAX_BYTES ? "The file is over 15 MB — too big to read here." : null
}

/** A staff-typed name without a trailing PDF / picture extension — the real one is added after (so "x.jpeg" over a JPEG becomes "x.jpg", never "x.jpeg.jpg"). */
export function withoutKnownExtension(name: string): string {
  return name.replace(/\.(pdf|jpe?g|png|gif|tiff?|bmp|webp)\s*$/i, "").trim()
}

/** The extension that matches what the file REALLY is (the client's file name can say anything). */
export function extForMime(mime: string): string {
  const map: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/tiff": ".tif", "image/bmp": ".bmp", "image/webp": ".webp" }
  return map[mime] ?? ".pdf"
}

/**
 * What the BYTES are, from their first bytes — the client's claimed type and size are only claims (the upload does not check them).
 * Returns the real mime type for a PDF or a picture the OCR service takes, else null.
 */
export function sniffReadableMime(bytes: Uint8Array): string | null {
  const b = (i: number) => (i < bytes.length ? bytes[i] : -1)
  const ascii = (from: number, text: string) => text.split("").every((c, k) => b(from + k) === c.charCodeAt(0))
  // the exact picture signatures first — a picture that merely CONTAINS the text "%PDF-" near its start is still a picture
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg"
  if (b(0) === 0x89 && ascii(1, "PNG\r\n")) return "image/png"
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif"
  if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2a && b(3) === 0) || (b(0) === 0x4d && b(1) === 0x4d && b(2) === 0 && b(3) === 0x2a)) return "image/tiff"
  if (ascii(0, "BM") && bytes.length > 14) return "image/bmp"
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp"
  // the PDF header may be preceded by a few bytes (the spec allows up to 1024 before "%PDF-")
  const head = Math.min(bytes.length, 1024)
  for (let i = 0; i + 5 <= head; i++) if (ascii(i, "%PDF-")) return "application/pdf"
  return null
}

/**
 * The same attachment saved twice FOR THE SAME PERSON is the same file: message + bytes + person. The person is part of the key because the
 * storage looks a key up across ALL owners — without it, saving the letter for the other member would "find" the first member's file and
 * report success while changing nothing. The client's file name is NOT in the key: it often carries the ITIN and keys are stored and logged.
 */
export function chatSaveCallerKey(messageId: string, sha256: string, contactId: string): string {
  return `chat-attachment:${messageId}:${sha256}:${contactId}`
}
/** The part every person's key for one attachment shares — to find "already saved for somebody else". */
export function chatSaveKeyPrefix(messageId: string, sha256: string): string {
  return `chat-attachment:${messageId}:${sha256}:`
}
/** The person (contact id) a chat-save key was made for; null for any other key. */
export function contactOfChatSaveKey(key: string | null | undefined, messageId: string, sha256: string): string | null {
  const prefix = chatSaveKeyPrefix(messageId, sha256)
  // a copy saved again after the first one was trashed carries ":after-trash:<file id>" — the person is the part before that
  return key && key.startsWith(prefix) ? key.slice(prefix.length).split(":")[0] || null : null
}

/** A clean default name — never the client's own file name, which often carries the ITIN ("NAME---903-61-8342-itin.pdf"). */
export function defaultLetterName(personName: string | null | undefined, originalName: string): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(originalName)?.[0] ?? ".pdf"
  const who = (personName ?? "").replace(/[\\/\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()
  return who ? `ITIN Letter - ${who}${ext}` : `ITIN Letter${ext}`
}

/** `altNames`: other spellings of the same person (the members list name next to the contact's own name). `dateOfBirth`: what the CRM holds (often empty). */
export interface OwnerCandidate { contactId: string; name: string; altNames?: string[]; dateOfBirth?: string | null }

/** Does the text carry this person's NAME (first and last word, under any spelling we hold)? Says nothing about the date of birth. */
function nameFoundIn(text: string, c: OwnerCandidate): boolean {
  return [c.name, ...(c.altNames ?? [])].some((n) => personNamedInText(text, n) === true)
}

/**
 * The date of birth the CRM holds and the one printed on the letter are both known and DIFFER — the letter is somebody else's (or one of the two
 * is wrong; either way a person must look). An unknown date on either side says nothing.
 */
export function dateOfBirthContradicts(crmDateOfBirth: string | null | undefined, letterDateOfBirth: string | null | undefined): boolean {
  return !!crmDateOfBirth && !!letterDateOfBirth && crmDateOfBirth !== letterDateOfBirth
}

/**
 * Does the text name this person? The name (first and last word) must be there AND, when the CRM date of birth and the letter's are both known,
 * they must agree — a name alone matches a middle name or a street ("Austin Jackson"), a date of birth does not.
 */
export function candidateNamedIn(text: string, c: OwnerCandidate, letterDateOfBirth?: string | null): boolean {
  return nameFoundIn(text, c) && !dateOfBirthContradicts(c.dateOfBirth, letterDateOfBirth)
}

/**
 * Whose letter is it? ONLY the members the letter itself names (first and last word of their name as whole words). One → proposed;
 * none or several → nothing proposed and a plain reason. The SENDER never decides: Peter sent his own letter and Radomir's.
 */
export function proposeOwner(candidates: OwnerCandidate[], letterText: string, scope: "company" | "person" = "company", letterDateOfBirth: string | null = null): { contactId: string | null; named: string[]; reason: string } {
  if (candidates.length === 0) {
    return { contactId: null, named: [], reason: scope === "person" ? "This chat has no person to file the letter under." : "No member of this company could be matched to a contact record, so there is nobody to file the letter under — link the member's contact first." }
  }
  const named = candidates.filter((c) => candidateNamedIn(letterText, c, letterDateOfBirth))
  if (named.length === 1) return { contactId: named[0].contactId, named: [named[0].contactId], reason: `The letter names ${named[0].name}.` }
  if (named.length === 0) {
    const wrongBirthday = candidates.filter((c) => nameFoundIn(letterText, c))
    if (wrongBirthday.length > 0) {
      return { contactId: null, named: [], reason: `The letter has ${wrongBirthday.map((c) => c.name).join(" / ")}'s name, but its date of birth is not the one on their record — choose whose it is, and tick that you checked.` }
    }
    return { contactId: null, named: [], reason: scope === "person" ? "This is one person's own chat, so only that person can be chosen — and the letter does not name them. For another person's letter, open the company's chat." : "The letter does not name any member of this company — choose whose it is." }
  }
  return { contactId: null, named: named.map((n) => n.contactId), reason: "The letter could belong to more than one member — choose whose it is." }
}

/** A tax / ID number in a file name ("NAME---903-61-8342-itin.pdf") is refused: names are listed, searched and sometimes shown. */
export function fileNameHasTaxNumber(name: string): boolean {
  // blanks, dashes, dots and underscores are all separators people use: 903-61-8342, 903.61.8342, 903_61_8342, 903 61 8342
  const flat = name.replace(/[\s._-]/g, "")
  return /\d{9,}/.test(flat) || /\b\d{3}[-._ ]?\d{2}[-._ ]?\d{4}\b/.test(name) || /\b\d{2}[-._ ]\d{7}\b/.test(name)
}

/**
 * What to write on the contact, given what is on the record RIGHT NOW. NEVER replaces an ITIN or an issue date silently:
 *  - nothing on the record → write the ITIN (and the date — unless the record already holds an issue date, which then needs "replace");
 *  - the same ITIN → fill a missing date, leave an equal date alone, change a different date only when staff agreed;
 *  - a different ITIN → write only when staff agreed; the OLD issue date belonged to the old ITIN, so when no new date comes with it
 *    the old date is CLEARED (never left next to the new number).
 */
export function decideItinWrite(i: { existingItin: string | null; existingIssueDate: string | null; newItin: string | null; newDate: string | null; replace: boolean }): { writeItin: boolean; writeDate: boolean; clearDate: boolean; /** staff's value was NOT written because the record already holds another one (a "replace" tick would write it) */ kept: boolean; note: string | null } {
  const none = { writeItin: false, writeDate: false, clearDate: false, kept: false }
  if (!i.newItin) return { ...none, note: null }
  const same = !!i.existingItin && i.existingItin.replace(/\D/g, "") === i.newItin.replace(/\D/g, "")
  if (!i.existingItin) {
    if (!i.newDate) return { ...none, writeItin: true, note: null }
    if (i.existingIssueDate && i.existingIssueDate !== i.newDate && !i.replace) {
      return { ...none, writeItin: true, kept: true, note: `The record already has the issue date ${i.existingIssueDate} — it was kept (tick "replace" and save again to change it).` }
    }
    return { ...none, writeItin: true, writeDate: true, note: null }
  }
  if (same) {
    if (!i.newDate) return { ...none, note: `The record already has this ITIN${i.existingIssueDate ? ` (issue date ${i.existingIssueDate})` : ""} — nothing to change.` }
    if (i.existingIssueDate === i.newDate) return { ...none, note: "The record already has this ITIN and issue date — nothing to change." }
    if (!i.existingIssueDate || i.replace) return { ...none, writeDate: true, note: null }
    return { ...none, kept: true, note: "The record already has this ITIN with a different issue date — it was kept (tick \"replace\" and save again to change it)." }
  }
  if (!i.replace) return { ...none, kept: true, note: "The record already has a different ITIN — it was kept (tick \"replace\" and save again to change it)." }
  if (i.newDate) return { ...none, writeItin: true, writeDate: true, note: null }
  return {
    ...none, writeItin: true, clearDate: !!i.existingIssueDate,
    note: i.existingIssueDate ? `The old issue date ${i.existingIssueDate} belonged to the old ITIN, so it was cleared — add the new notice date on the contact.` : null,
  }
}

/** Most attachments looked at or saved in one card. */
export const MAX_CARD_ITEMS = 10

// ───────────────────────────── the card's shapes ─────────────────────────────

export interface CardCandidate {
  contactId: string
  name: string
  /** the letter names this person (first + last word) */
  namedInLetter: boolean
  existingItin: string | null
  existingIssueDate: string | null
  /** THIS attachment is already saved for THIS person (the key includes the person) */
  alreadySaved: { fileId: string; name: string; state: string } | null
  /** open workspace steps that wait for this letter (an ITIN case) — Save is refused while there is one; null = could not be checked (also refused) */
  waiting: Array<{ sdId: string; serviceType: string; stage: string; who: string; asks: string; how: string }> | null
}

export interface CardField { value: string | null; status: "ok" | "unsure" | "missing"; evidence: string | null; note: string | null; others: string[] }

export interface CardItem {
  index: number
  name: string
  size: number | null
  mimeType: string | null
  previewUrl: string
  /** false = the file cannot be read here (type/size) — `unsupportedReason` says why */
  readable: boolean
  unsupportedReason: string | null
  /** the OCR itself failed (the file could still be saved by hand) */
  readError: string | null
  /** the text looks like an IRS ITIN notice */
  recognized: boolean
  noticeKind: string | null
  itin: CardField | null
  noticeDate: CardField | null
  dateOfBirth: CardField | null
  nameOnLetter: string | null
  problems: string[]
  /** the words the reader saw, for "show the text" (staff-only; not stored) */
  rawText: string | null
  candidates: CardCandidate[]
  proposedContactId: string | null
  ownerReason: string
  proposedFileName: string
  /** where it would go, in words: "Peter Papik › ITIN" */
  proposedPlace: string | null
}

export interface CardResponse { ok: true; messageId: string; accountId: string | null; items: CardItem[] }

export interface SaveItemInput {
  index: number
  contactId: string
  /** the name to save under (blank = the proposed default) */
  fileName: string
  itin: string | null
  issueDate: string | null
  client: ClientChoice
  /** staff agreed to replace an ITIN / issue date the contact already has */
  replaceItin: boolean
  /** staff checked that this ITIN, already on ANOTHER contact's record, really is this person's (a duplicate contact) — the answer to `itinHeldBy` */
  itinHolderOk: boolean
  /** the date of birth the READER saw on this letter — a second guard (the CRM's own date of birth is often empty). The card sends it only when it was read clearly. */
  letterDateOfBirth: string | null
}

export interface ResultNote { text: string; level: "ok" | "warn" }

export interface SaveItemResult {
  index: number
  ok: boolean
  /** the file is saved but a later step did not finish (ITIN not written, client not shown): shown in amber, and the file can be saved again to retry */
  partial?: boolean
  error?: string
  fileId?: string
  status?: string
  place?: string
  /** the server KEPT a value because the record holds another one — the card shows its "replace" box for this file even if its own snapshot of the record is out of date */
  keptNeedsReplace?: boolean
  /** NOTHING was saved: this ITIN is already on another contact's record (the name). The card asks "I checked" and saves again with `itinHolderOk`. */
  itinHeldBy?: string
  /** plain-words lines for the card: what was saved, what was written on the contact, what the client sees */
  notes: ResultNote[]
}

/** Parse the browser's save request into clean inputs (the server re-checks everything that matters). */
export function parseSaveItems(body: unknown): SaveItemInput[] | null {
  const raw = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CARD_ITEMS) return null
  const out: SaveItemInput[] = []
  const seen: Record<number, boolean> = {}
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r.contactId !== "string" || typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0 || r.index >= MAX_CARD_ITEMS) return null
    if (seen[r.index]) return null // one entry per attachment
    seen[r.index] = true
    out.push({
      index: r.index,
      contactId: r.contactId,
      fileName: typeof r.fileName === "string" ? r.fileName : "",
      itin: typeof r.itin === "string" && r.itin.trim() ? r.itin.trim() : null,
      issueDate: typeof r.issueDate === "string" && r.issueDate.trim() ? r.issueDate.trim() : null,
      client: parseClientChoice(r.client),
      replaceItin: r.replaceItin === true,
      itinHolderOk: r.itinHolderOk === true,
      letterDateOfBirth: typeof r.letterDateOfBirth === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.letterDateOfBirth) ? r.letterDateOfBirth : null,
    })
  }
  return out
}
