/**
 * Save a client's CHAT ATTACHMENTS into the storage — the server side of the "Save to Storage" card in Portal Chats
 * (dev job fb49265a; Antonio 2026-11-07: Peter Papik sent his own ITIN letter and Radomir Knapec's in one message).
 *
 * Two steps, both staff-only, both started from a SAVED chat message (the browser never sends a url or bytes):
 *  - `readChatAttachmentsForCard`: for every attachment — read the file (Document AI), recognise an IRS ITIN notice, read its ITIN /
 *    notice date by label (lib/itin/read-itin-letter.ts), say whose it is (only the member the letter NAMES — never the sender),
 *    where it would go (that person's ITIN folder), what the contact already holds, whether an ITIN case is waiting for it and whether
 *    it was already saved for each person. It saves and changes nothing.
 *  - `saveChatAttachmentsToStorage`: for what staff confirmed — the file goes into the person's own storage (ITIN folder), HIDDEN;
 *    the contact's ITIN / issue date are written only for values staff confirmed and never over what the record holds right now
 *    without a "replace"; the client is shown / notified ONLY as chosen (default: nothing). Never a chat line (a personal paper).
 * Bug-hunt fixes (2026-11-07): the saved file's identity includes the PERSON (and not the client's file name); the real bytes (size and
 * first bytes) are checked, not the client's claim; the contact's record is read fresh for every file; the notification is awaited so the
 * result lines say what really happened.
 * The pure rules and the card's shapes live in ./save-from-chat-rules.ts.
 */
import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PORTAL_BASE_URL } from "@/lib/config"
import { readItinLetter, formatItin, isValidItin, checkIssueDate, normalizeLetterText, namesCouldBeSamePerson } from "@/lib/itin/read-itin-letter"
import {
  assetsPathOfUrl, attachmentDirAllowed, candidateNamedIn, chatAttachmentsOf, chatSaveCallerKey, chatSaveKeyPrefix, claimedSizeProblem, contactOfChatSaveKey, decideItinWrite, defaultLetterName,
  extForMime, fileNameHasTaxNumber, MAX_CARD_ITEMS, proposeOwner, READABLE_MAX_BYTES, sniffReadableMime, visibilityPlan, withoutKnownExtension,
  type CardCandidate, type CardItem, type CardResponse, type ChatAttachment, type OwnerCandidate, type ResultNote, type SaveItemInput, type SaveItemResult,
} from "./save-from-chat-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* / newer tables are not in the generated types
const db = () => supabaseAdmin as any

export interface Failure { ok: false; status: number; error: string }
const fail = (status: number, error: string): Failure => ({ ok: false, status, error })

const RAW_TEXT_LIMIT = 20000
/** How many attachments are read (downloaded + OCR) at the same time — a message may carry ten big files. */
const READ_CONCURRENCY = 3

/** Loads a module once, however many files are read at the same time (a failed load is not remembered, so the next read tries again). */
function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => {
    if (!p) p = load().catch((e) => { p = null; throw e })
    return p
  }
}
const docai = loadOnce(() => import("@/lib/docai"))
const stepHints = loadOnce(() => import("@/lib/flows/storage-step-hints"))
export const ITIN_LETTER_TYPE = "itin_letter"

interface MessageRow {
  id: string
  account_id: string | null
  contact_id: string | null
  attachments: unknown
  attachment_url: string | null
  attachment_name: string | null
  deleted_at: string | null
}

async function loadMessage(messageId: string): Promise<{ row: MessageRow } | Failure> {
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) return fail(400, "That is not a message id.")
  const { data, error } = await db().from("portal_messages").select("id, account_id, contact_id, attachments, attachment_url, attachment_name, deleted_at").eq("id", messageId).maybeSingle()
  if (error) return fail(500, "Could not read the message — please try again.")
  if (!data) return fail(404, "That message was not found.")
  if (data.deleted_at) return fail(410, "That message was deleted.")
  return { row: data as MessageRow }
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const tooBig = () => new Error("The file is over 15 MB — too big to read here.")

/**
 * The bytes of one attachment, taken from OUR chat storage by the path the saved message points at. The client's own claims about the
 * file (size, type) are NOT trusted: the real size is asked of the storage BEFORE the download, and the first bytes decide what it is.
 */
async function fetchAttachment(att: ChatAttachment, chat: MessageRow): Promise<{ bytes: Buffer; mime: string }> {
  const path = assetsPathOfUrl(att.url, process.env.NEXT_PUBLIC_SUPABASE_URL || "", PORTAL_BASE_URL)
  if (!path) throw new Error("This attachment is not in our chat storage, so it cannot be saved from here.")
  // the chat send only checks that a link is on our storage: a link into ANOTHER company's folder must never be read or filed from this chat
  if (!attachmentDirAllowed(path, { accountId: chat.account_id, contactId: chat.contact_id })) throw new Error("This attachment is not in this chat's own folder, so it cannot be saved from here.")
  const slash = path.lastIndexOf("/")
  try {
    const { data: listed } = await supabaseAdmin.storage.from("assets").list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 5 })
    const real = (listed ?? []).find((f) => f.name === path.slice(slash + 1))
    const size = Number((real?.metadata as { size?: number } | null | undefined)?.size)
    if (Number.isFinite(size) && size > READABLE_MAX_BYTES) throw tooBig()
  } catch (e) {
    if (e instanceof Error && e.message === tooBig().message) throw e
    // the size lookup failing is not fatal: the bytes are measured after the download as well
  }
  const { data, error } = await supabaseAdmin.storage.from("assets").download(path)
  if (error || !data) throw new Error("The file could not be fetched from the chat storage — please try again.")
  const bytes = Buffer.from(await data.arrayBuffer())
  if (bytes.length > READABLE_MAX_BYTES) throw tooBig()
  const mime = sniffReadableMime(bytes)
  if (!mime) throw new Error("This file is not a PDF or a picture (its content does not match what it claims to be), so it cannot be read here.")
  return { bytes, mime }
}

interface Person extends OwnerCandidate {
  dateOfBirth: string | null
  itin: string | null
  issueDate: string | null
}

interface PeopleResult {
  people: Person[]
  scope: "company" | "person"
  /** members that resolved (by email) to a contact with a DIFFERENT name: not offered, said in plain words next to the owner choice */
  notOffered: string[]
}

async function readContacts(ids: string[]): Promise<Map<string, { full_name: string | null; itin_number: string | null; itin_issue_date: string | null; date_of_birth: string | null }>> {
  const { data, error } = await db().from("contacts").select("id, full_name, itin_number, itin_issue_date, date_of_birth").in("id", ids)
  if (error) throw new Error("Could not read the members' records — please try again.")
  const out = new Map<string, { full_name: string | null; itin_number: string | null; itin_issue_date: string | null; date_of_birth: string | null }>()
  for (const c of (data ?? []) as Array<{ id: string; full_name: string | null; itin_number: string | null; itin_issue_date: string | null; date_of_birth: string | null }>) out.set(c.id, c)
  return out
}

/** The people this chat's attachments can belong to: the company's INDIVIDUAL members that resolve to a contact — or, in a person's own thread, that person. */
async function loadPeople(row: MessageRow): Promise<PeopleResult> {
  const byContact = new Map<string, { name: string; alt: string[] }>()
  const unlinked: string[] = []
  if (row.account_id) {
    const { resolveAccountMembersForChat } = await import("@/lib/portal/addressed-to")
    const options = await resolveAccountMembersForChat(row.account_id)
    for (const o of options) {
      if (o.isCompanyMember) continue
      // a person member with no contact of their own (and no e-mail that points to exactly one contact) cannot be offered: say so instead of leaving them out silently
      if (!o.resolvable || !o.contactId) { if (o.name) unlinked.push(o.name); continue }
      const prev = byContact.get(o.contactId)
      if (prev) { if (o.name && prev.alt.indexOf(o.name) === -1) prev.alt.push(o.name) } else byContact.set(o.contactId, { name: o.name, alt: [] })
    }
    if (byContact.size === 0) {
      // the members helper answers "nobody" for a database error too: tell an outage apart from a company with no linkable member
      const { error } = await db().from("members").select("id", { count: "exact", head: true }).eq("account_id", row.account_id)
      if (error) throw new Error("Could not read the company's members — please try again.")
    }
  } else if (row.contact_id) {
    byContact.set(row.contact_id, { name: "", alt: [] })
  }
  const ids = Array.from(byContact.keys())
  const scope = row.account_id ? "company" : "person"
  const notOffered: string[] = []
  if (unlinked.length > 0) notOffered.push(`${unlinked.join(", ")} ${unlinked.length === 1 ? "has" : "have"} no contact record linked to the member row — not offered; link the member's contact first.`)
  if (ids.length === 0) return { people: [], scope, notOffered }
  const contacts = await readContacts(ids)
  const people: Person[] = []
  for (const id of ids) {
    const c = contacts.get(id)
    if (!c) continue
    const m = byContact.get(id) as { name: string; alt: string[] }
    const memberNames = [m.name, ...m.alt].filter(Boolean)
    // A member is linked to a contact by id — or, when the member row has no contact, by EMAIL. Two people who share an email would be
    // taken for one: a member who is not a spelling of the contact's own name is NOT that contact (never offered as them, never an alternative spelling).
    // A family name alone is not enough — a wife and a husband share one, and one e-mail.
    const same = c.full_name ? memberNames.filter((n) => namesCouldBeSamePerson(n, c.full_name)) : memberNames
    const other = c.full_name ? memberNames.filter((n) => !namesCouldBeSamePerson(n, c.full_name)) : []
    if (other.length > 0) notOffered.push(`${other.join(", ")} is linked to ${c.full_name}'s contact record, but the names do not match — not offered; fix the member's contact link first.`)
    if (memberNames.length > 0 && same.length === 0) continue
    const name = c.full_name || same[0] || "Member"
    people.push({ contactId: id, name, altNames: same.filter((n) => n !== name), dateOfBirth: c.date_of_birth ?? null, itin: c.itin_number ?? null, issueDate: c.itin_issue_date ?? null })
  }
  return { people, scope, notOffered }
}

/** One person's record as it is RIGHT NOW (every file is judged against a fresh read, never a snapshot taken when the Save began). */
async function freshRecordOf(contactId: string): Promise<{ itin: string | null; issueDate: string | null; dateOfBirth: string | null }> {
  const c = (await readContacts([contactId])).get(contactId)
  if (!c) throw new Error("That person's record could not be read — nothing was saved.")
  return { itin: c.itin_number ?? null, issueDate: c.itin_issue_date ?? null, dateOfBirth: c.date_of_birth ?? null }
}

type WaitingStep = NonNullable<CardCandidate["waiting"]>[number]

/** The open ITIN cases waiting for this letter, for one person. null = it could not be checked (the save is then refused, never let through). */
async function waitingFor(contactId: string): Promise<WaitingStep[] | null> {
  try {
    const { findWaitingWorkspaceStepsForContact } = await stepHints()
    const steps = await findWaitingWorkspaceStepsForContact({ contactId, documentType: ITIN_LETTER_TYPE, folderKind: "itin" })
    return steps.map((s) => ({ sdId: s.sdId, serviceType: s.serviceType, stage: s.stage, who: s.who, asks: s.asks, how: s.how }))
  } catch (e) {
    console.warn("[save-from-chat] could not check for a waiting workspace step:", e instanceof Error ? e.message : String(e))
    return null
  }
}

function waitingSentence(w: WaitingStep): string {
  return `${w.who}'s ${w.serviceType} case is at "${w.stage}" and is waiting for ${w.asks}.${w.how ? ` In the workspace: ${w.how}` : ""} Use the workspace for this letter — it closes the case and tells the client; saving it here would not.`
}

function sha256Of(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex") }

/** For ONE attachment (message + bytes): which people already have it saved. */
async function savedPerPerson(messageId: string, sha: string): Promise<Map<string, { fileId: string; name: string; state: string }>> {
  const out = new Map<string, { fileId: string; name: string; state: string }>()
  const { data, error } = await db().from("store_files").select("id, name, state, caller_key").like("caller_key", `${chatSaveKeyPrefix(messageId, sha)}%`).eq("state", "live").limit(50)
  if (error) console.warn("[save-from-chat] could not look up earlier copies of this attachment:", error.message)
  for (const f of (data ?? []) as Array<{ id: string; name: string; state: string; caller_key: string }>) {
    const who = contactOfChatSaveKey(f.caller_key, messageId, sha)
    if (who && !out.has(who)) out.set(who, { fileId: f.id, name: f.name, state: f.state })
  }
  return out
}

function emptyItem(row: MessageRow, att: ChatAttachment, index: number): CardItem {
  return {
    index, name: att.name, size: att.size ?? null, mimeType: att.mime_type ?? null,
    previewUrl: `/api/crm-store/save-from-chat/preview?messageId=${encodeURIComponent(row.id)}&index=${index}`,
    readable: true, unsupportedReason: null, readError: null, recognized: false, noticeKind: null,
    itin: null, noticeDate: null, dateOfBirth: null, nameOnLetter: null, problems: [], rawText: null,
    candidates: [], proposedContactId: null, ownerReason: "", proposedFileName: defaultLetterName(null, att.name), proposedPlace: null,
  }
}

async function buildItem(row: MessageRow, att: ChatAttachment, index: number, pr: PeopleResult): Promise<CardItem> {
  const item = emptyItem(row, att, index)
  const tooBigClaim = claimedSizeProblem(att.size)
  if (tooBigClaim) return { ...item, readable: false, unsupportedReason: tooBigClaim }

  let bytes: Buffer
  let mime: string
  try {
    ({ bytes, mime } = await fetchAttachment(att, row))
  } catch (e) {
    return { ...item, readable: false, unsupportedReason: e instanceof Error ? e.message : "The file could not be fetched." }
  }
  item.mimeType = mime
  // the default name ends with what the file REALLY is, not with whatever the client's file name said
  item.proposedFileName = defaultLetterName(null, `x${extForMime(mime)}`)
  const saved = await savedPerPerson(row.id, sha256Of(bytes)).catch(() => new Map<string, { fileId: string; name: string; state: string }>())

  let text = ""
  try {
    const { ocrRawContent } = await docai()
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    text = (await ocrRawContent(ab, mime, att.name)).fullText ?? ""
  } catch (e) {
    console.error("[save-from-chat] the reading service failed:", e instanceof Error ? e.message : String(e))
    item.readError = "The reading service did not answer — if this is an ITIN letter, type the details from the picture, or open the card again in a moment."
  }
  item.rawText = text ? normalizeLetterText(text).slice(0, RAW_TEXT_LIMIT) : null

  const reading = text ? readItinLetter(text) : null
  if (reading) {
    item.recognized = reading.isItinNotice
    item.noticeKind = reading.noticeKind
    item.itin = reading.itin
    item.noticeDate = reading.noticeDate
    item.dateOfBirth = reading.dateOfBirth
    item.nameOnLetter = reading.nameOnLetter
    item.problems = reading.problems
  }

  const people = pr.people
  // the date of birth printed on the letter, whatever its status: it only ever makes the choice STRICTER (a mismatch asks for a tick), never looser
  const letterDob = reading?.dateOfBirth?.value ?? null
  const owner = text ? proposeOwner(people, text, pr.scope, letterDob) : { contactId: null, named: [] as string[], reason: people.length === 0 ? proposeOwner(people, "", pr.scope).reason : "Choose whose letter this is." }
  const waitingList = await Promise.all(people.map((p) => waitingFor(p.contactId)))
  item.candidates = people.map((p, i) => ({
    contactId: p.contactId, name: p.name, namedInLetter: !!text && candidateNamedIn(text, p, letterDob),
    existingItin: p.itin, existingIssueDate: p.issueDate, alreadySaved: saved.get(p.contactId) ?? null, waiting: waitingList[i],
  }))
  item.proposedContactId = owner.contactId
  item.ownerReason = pr.notOffered.length > 0 ? `${owner.reason} ${pr.notOffered.join(" ")}` : owner.reason
  const who = people.find((p) => p.contactId === owner.contactId)
  item.proposedFileName = defaultLetterName(who?.name ?? null, `x${extForMime(mime)}`)
  item.proposedPlace = who ? `${who.name} › ITIN folder` : null
  return item
}

/** Everything the card shows for one chat message. Reads and changes nothing. */
export async function readChatAttachmentsForCard(messageId: string): Promise<CardResponse | Failure> {
  const m = await loadMessage(messageId)
  if ("ok" in m) return m
  const atts = chatAttachmentsOf(m.row)
  if (atts.length === 0) return fail(404, "This message has no attachments.")
  let pr: PeopleResult
  try { pr = await loadPeople(m.row) } catch (e) { return fail(500, e instanceof Error ? e.message : "Could not read the members.") }
  const shown = atts.slice(0, MAX_CARD_ITEMS)
  const items = await mapLimit(shown, READ_CONCURRENCY, (a, i) => buildItem(m.row, a, i, pr))
  for (let i = MAX_CARD_ITEMS; i < atts.length; i++) {
    items.push({ ...emptyItem(m.row, atts[i], i), previewUrl: "", readable: false, unsupportedReason: `Only the first ${MAX_CARD_ITEMS} attachments are shown here.`, proposedFileName: "" })
  }
  return { ok: true, messageId: m.row.id, accountId: m.row.account_id, items }
}

/** One attachment's bytes for the card's preview (staff only; the route sets the headers). */
export async function readChatAttachmentForPreview(messageId: string, index: number): Promise<{ ok: true; bytes: Buffer; mime: string; name: string } | Failure> {
  const m = await loadMessage(messageId)
  if ("ok" in m) return m
  const att = chatAttachmentsOf(m.row)[index]
  if (!att) return fail(404, "That attachment was not found.")
  try {
    const f = await fetchAttachment(att, m.row)
    return { ok: true, bytes: f.bytes, mime: f.mime, name: att.name }
  } catch (e) {
    return fail(404, e instanceof Error ? e.message : "The file is not available.")
  }
}

/** Where the saved file really is, in words ("Jane Sample › ITIN"): the person's ITIN folder, or Personal documents when an older storage has none. */
async function placeOf(fileId: string, personName: string): Promise<string> {
  const { data } = await db().from("store_files").select("store_folders!inner(name)").eq("id", fileId).maybeSingle()
  const folder = (data?.store_folders as { name?: string } | null | undefined)?.name
  return folder ? `${personName} › ${folder}` : `${personName}'s storage`
}

/** The saved file must belong to the person it was saved for (a defence: the person is part of the file's key, so it always should). */
async function fileBelongsTo(fileId: string, contactId: string): Promise<"yes" | "no" | "unknown"> {
  const { data, error } = await db().from("store_files").select("store_owners!inner(contact_id)").eq("id", fileId).maybeSingle()
  if (error || !data) return "unknown" // a lookup that failed is not "somebody else's file"
  return (data.store_owners as { contact_id?: string | null } | null | undefined)?.contact_id === contactId ? "yes" : "no"
}

/** The name of ANOTHER contact whose record already holds this ITIN (a cheap net for a letter put on the wrong person); "error" when that could not be checked. */
async function otherHolderOfItin(itin: string, contactId: string): Promise<string | null | "error"> {
  // compared on the DIGITS: records hold the number as 999-99-9999, 999999999, "999 99 9999" and one older "999-999999" — a list of spellings would miss the next odd one
  const digits = itin.replace(/\D/g, "")
  const { data, error } = await db().from("contacts").select("full_name, itin_number").ilike("itin_number", `%${digits.slice(-4)}%`).neq("id", contactId).limit(50)
  if (error) return "error"
  const row = ((data ?? []) as Array<{ full_name: string | null; itin_number: string | null }>).find((r) => (r.itin_number ?? "").replace(/\D/g, "") === digits)
  return row ? (row.full_name || "another contact") : null
}

const last4 = (v: string | null): string | null => (v ? v.replace(/\D/g, "").slice(-4) || null : null)

async function saveOne(row: MessageRow, atts: ChatAttachment[], pr: PeopleResult, input: SaveItemInput, actorId: string | null): Promise<SaveItemResult> {
  const notes: ResultNote[] = []
  const ok = (text: string) => notes.push({ text, level: "ok" })
  const warn = (text: string) => notes.push({ text, level: "warn" })
  const refuse = (error: string): SaveItemResult => ({ index: input.index, ok: false, error, notes })
  const att = atts[input.index]
  if (!att) return refuse("That attachment was not found.")
  const person = pr.people.find((p) => p.contactId === input.contactId)
  if (!person) return refuse("That person is not a member of this chat's company — choose one of its members.")

  // the person's record as it is now: every check below (the date of birth, what is already held) uses THIS read
  let record: Awaited<ReturnType<typeof freshRecordOf>>
  try { record = await freshRecordOf(person.contactId) } catch (e) { return refuse(e instanceof Error ? e.message : "The record could not be read — nothing was saved.") }

  // what staff confirmed is checked again here (shape and sense), never trusted
  let itin: string | null = null
  if (input.itin) {
    if (!isValidItin(input.itin)) return refuse("The ITIN is not valid — it must look like 9XX-XX-XXXX with a valid middle (50–65, 70–88, 90–92, 94–99).")
    itin = formatItin(input.itin)
  }
  if (input.issueDate && !itin) return refuse("Enter the ITIN together with its date, or clear the date.")
  // "I checked: same person" was given for ONE ITIN — if the digits were changed after it, the tick counts for nothing
  const holderOk = input.itinHolderOk && !!itin && !!input.itinHolderFor && input.itinHolderFor.replace(/\D/g, "") === itin.replace(/\D/g, "")
  if (input.issueDate) {
    // against the date of birth the CRM holds AND the one the reader saw on this letter (the CRM's is often empty)
    for (const dob of [record.dateOfBirth, input.letterDateOfBirth]) {
      const d = checkIssueDate(input.issueDate, { dateOfBirth: dob })
      if (!d.ok) return refuse(`The notice date: ${d.reason}`)
    }
  }

  // an open ITIN case waits for this letter → it goes through that workspace (it closes the case and tells the client); never through here
  const waiting = await waitingFor(person.contactId)
  if (waiting === null) return refuse("Could not check whether an ITIN case is waiting for this letter — nothing was saved. Please try again.")
  if (waiting.length > 0) return refuse(waitingSentence(waiting[0]))

  // This ITIN is already on ANOTHER contact's record: the letter is probably on the wrong person. Asked BEFORE the file is filed (so a wrong pick
  // leaves no stray copy), and only when the ITIN would really be written. A duplicate contact of the same person is let through when staff say so.
  if (itin && !holderOk) {
    const early = decideItinWrite({ existingItin: record.itin, existingIssueDate: record.issueDate, newItin: itin, newDate: input.issueDate, replace: input.replaceItin })
    if (early.writeItin) {
      const holder = await otherHolderOfItin(itin, person.contactId)
      if (holder === "error") return refuse("Could not check whether this ITIN is already on another person's record — nothing was saved. Please try again.")
      if (holder) return { ...refuse(`This ITIN is already on ${holder}'s record, so nothing was saved. Check whose letter this is. If ${holder} and ${person.name} are the same person (two contact records), tick "I checked" and save again.`), itinHeldBy: holder, itinHeldItin: itin }
    }
  }

  const tooBigClaim = claimedSizeProblem(att.size)
  if (tooBigClaim) return refuse(tooBigClaim)
  let bytes: Buffer
  let mime: string
  try { ({ bytes, mime } = await fetchAttachment(att, row)) } catch (e) { return refuse(e instanceof Error ? e.message : "The file could not be fetched.") }

  // the name ends with what the file REALLY is (the client's file name can say anything)
  const realName = `x${extForMime(mime)}`
  const { cleanNewFileName } = await import("./names")
  let fileName: string
  try { fileName = cleanNewFileName(withoutKnownExtension(input.fileName.trim()) || defaultLetterName(person.name, realName).replace(/\.[A-Za-z0-9]+$/, ""), realName) } catch (e) { return refuse(e instanceof Error ? e.message : "Enter a file name.") }
  if (fileNameHasTaxNumber(fileName)) return refuse("The file name must not contain the ITIN or any tax number — use a name like \"ITIN Letter - Name\".")

  const { saveDocumentForContact, CompanyMovingError } = await import("./save-for-account")
  const { data: links, error: linksErr } = await db().from("account_contacts").select("account_id").eq("contact_id", person.contactId).limit(30)
  if (linksErr) return refuse("Could not read the person's company links — nothing was saved. Please try again.")
  const linkIds = ((links ?? []) as Array<{ account_id: string }>).map((l) => l.account_id)
  const linkedAccountId = linkIds.length === 1 ? linkIds[0] : null
  const callerKey = chatSaveCallerKey(row.id, sha256Of(bytes), person.contactId)
  let saved
  try {
    saved = await saveDocumentForContact({
      contactId: person.contactId, name: fileName, bytes, mimeType: mime, documentType: ITIN_LETTER_TYPE, callerKey,
      accountId: linkedAccountId, viaAccountId: row.account_id ?? linkedAccountId, contactName: person.name,
      portalVisible: false, actor: actorId, folderKind: "itin",
      // the key already says WHICH bytes these are (message + the file's fingerprint + the person): a copy that is already there is never
      // overwritten with the chat's original, even when staff have since put a newer version of it in Storage
      contentChanged: false,
      row: { document_type_name: "ITIN Letter", category: 2, category_name: "Contacts", status: "classified" },
    })
  } catch (e) {
    if (e instanceof CompanyMovingError) return refuse(e.message)
    return refuse(e instanceof Error ? e.message : "The file could not be saved.")
  }
  if (saved.route !== "store") return refuse("This person has no storage to receive the file — nothing was saved.")
  // nothing further is done to a file that is not this person's
  // what actually happened, written to the audit log at the end (or at an early stop): OUTCOMES, never intentions
  const done = { itinWritten: false, issueDateWritten: false, issueDateCleared: false }
  const logAudit = async (extra: Record<string, unknown> = {}) => {
    const { error: logErr } = await db().from("action_log").insert({
      actor: "crm-admin", action_type: "chat_attachment_saved_to_storage", table_name: "store_files", record_id: `store:${saved.fileId}`, account_id: row.account_id ?? linkedAccountId, contact_id: person.contactId,
      summary: `Chat attachment saved to Storage as ITIN Letter for ${person.name}`,
      details: { message_id: row.id, attachment_index: input.index, contact_id: person.contactId, status: saved.status, client: input.client, by: actorId, ...extra },
    })
    if (logErr) console.error("[save-from-chat] the audit log row could not be written:", logErr.message)
  }
  const belongs = await fileBelongsTo(saved.fileId, person.contactId)
  if (belongs === "no") {
    await logAudit({ stopped: "file_not_this_persons", itin_written: false, issue_date_written: false })
    return refuse(`A copy of this letter that was saved for ${person.name} has since been moved to another storage — nothing was changed on the record or for the client. Move it back, or move it to the trash in Storage, then save again.`)
  }
  if (belongs === "unknown") {
    await logAudit({ stopped: "owner_check_failed", itin_written: false, issue_date_written: false })
    return refuse("The file was saved, but its owner could not be double-checked, so nothing further was done. Press Save again.")
  }
  const place = await placeOf(saved.fileId, person.name)
  ok(saved.status === "unchanged" ? `Already in Storage — ${place}.` : `Saved in Storage — ${place} (hidden from the client until you show it).`)
  let partial = false
  /** the ITIN could not be cleared for this person (it is on another record, or that could not be checked): the letter is probably on the wrong person */
  let itinBlocked = false

  // the contact's ITIN fields: only what staff confirmed, judged against the record AS IT IS NOW, never over what it holds without "replace"
  let before: Awaited<ReturnType<typeof freshRecordOf>> | null = null
  try { before = await freshRecordOf(person.contactId) } catch { before = null }
  let decision: ReturnType<typeof decideItinWrite> = { writeItin: false, writeDate: false, clearDate: false, kept: false, note: null }
  if (!before) {
    // no stale fallback: judging against an old snapshot is exactly the overwrite the rule forbids
    partial = true
    warn("The file is saved, but the record could not be read again, so the ITIN was NOT written — press Save again to retry.")
  } else {
    decision = decideItinWrite({ existingItin: before.itin, existingIssueDate: before.issueDate, newItin: itin, newDate: input.issueDate, replace: input.replaceItin })
    // "kept, not written" is not a success: staff gave a value and it is NOT on the record — amber, and the card stays open so "replace" can be ticked.
    // The line about a CLEARED old date waits until the clearing has really happened (below): the write may be refused or fail.
    if (decision.note && !decision.clearDate) {
      if (decision.kept) { partial = true; warn(decision.note) } else ok(decision.note)
    }
    // The ITIN on this letter is not the one the record holds, and staff did not say "replace": the letter may belong to somebody else.
    // It is then never shown to — or announced to — the person it was filed under.
    if (itin && before.itin && !decision.writeItin && before.itin.replace(/\D/g, "") !== itin.replace(/\D/g, "")) itinBlocked = true
    // the same question again as a net (the record may have changed since the first answer); skipped when staff already said "I checked"
    if (decision.writeItin && itin && !holderOk) {
      const other = await otherHolderOfItin(itin, person.contactId)
      if (other === "error") {
        itinBlocked = true
        partial = true
        warn("The file is saved, but it could not be checked whether this ITIN is already on another person's record, so it was NOT written — press Save again to retry.")
      } else if (other) {
        itinBlocked = true
        partial = true
        warn(`This ITIN is already on ${other}'s record, so it was NOT written for ${person.name}. Check whose letter this is.`)
      }
    }
    if (!itinBlocked && (decision.writeItin || decision.writeDate || decision.clearDate)) {
      try {
        const { writeITINFields } = await import("@/lib/itin/write-itin-fields")
        const w = await writeITINFields(person.contactId, {
          ...(decision.writeItin ? { itin_number: itin } : {}),
          ...(decision.writeDate ? { itin_issue_date: input.issueDate } : decision.clearDate ? { itin_issue_date: null } : {}),
        })
        done.itinWritten = decision.writeItin
        done.issueDateWritten = decision.writeDate
        done.issueDateCleared = decision.clearDate && !decision.writeDate
        ok(`${decision.writeItin ? "ITIN" : "Issue date"}${decision.writeItin && decision.writeDate ? " and issue date" : ""} saved on ${person.name}'s record${w.itin_renewal_date ? ` (renewal ${w.itin_renewal_date})` : ""}.`)
        // the old date really is gone now: a to-do (the record has NO issue date), so amber — saving again with the new date fills it
        if (done.issueDateCleared && decision.note) { partial = true; warn(decision.note) }
      } catch (e) {
        partial = true
        warn(`The file is saved, but the ITIN could not be written on the record (${e instanceof Error ? e.message : "error"}) — you can press Save again to retry, or enter it on the contact.`)
      }
    } else if (!itin) {
      ok("No ITIN was entered, so the record was not changed.")
    }
  }

  // the client: shown / notified ONLY as chosen. A chat line is never posted — the company chat is read by every member.
  const plan = visibilityPlan(input.client)
  const { data: listed, error: listedErr } = await db().from("documents").select("portal_visible").eq("id", saved.documentRowId).maybeSingle()
  const wasVisible = listed?.portal_visible === true
  if (listedErr) {
    // not knowing whether the client can already see the file is not "hidden": say so and do nothing for the client
    partial = true
    warn("The file is saved, but it could not be read whether the client can see it, so nothing was done for the client — press Save again to retry.")
  } else if (plan.show && itinBlocked) {
    // the ITIN check says this letter may belong to somebody else: it must not be shown to — or announced to — the person it was filed under
    partial = true
    warn(wasVisible
      ? `Left as it is: this file is already visible to ${person.name}, but the ITIN check above says this letter may belong to somebody else. This card never hides a file — hide it in Storage if that is wrong. No notification was sent.`
      : `NOT shown to ${person.name}: the ITIN check above says this letter may belong to somebody else. Check whose letter it is first (or tick "replace" if the ITIN on the record is the wrong one).`)
  } else if (!plan.show) {
    if (wasVisible) warn(`Left as it is: this file is already visible to ${person.name}. This card never hides a file — hide it in Storage if that is wrong. No notification was sent.`)
    else ok("Kept hidden from the client. No notification was sent.")
  } else {
    let shownOk = wasVisible
    if (!wasVisible) {
      try {
        const { setClientVisibility } = await import("./browse")
        // always without the automatic alert: when a notification is wanted it is sent below and its real outcome is reported
        await setClientVisibility(saved.fileId, true, actorId, { silent: true, suppressChat: true })
        shownOk = true
      } catch (e) {
        partial = true
        warn(`Saved, but it stays hidden: ${e instanceof Error ? e.message : "it could not be shown to the client"}.`)
      }
    }
    if (shownOk && !plan.silent) {
      try {
        const { notifyClientsOfNewDocument } = await import("@/lib/portal/document-alerts")
        const n = await notifyClientsOfNewDocument(saved.documentRowId, { chat: false })
        if (n.notified) ok(`Shown in ${person.name}'s portal and a notification was created there for ${person.name} (no chat message). A short email summary may follow within a few minutes.`)
        else if (n.reason === "already_notified") ok(`Shown in ${person.name}'s portal. ${person.name} was already notified about this document earlier — nothing new was sent.`)
        else {
          partial = true
          const why: Record<string, string> = {
            feature_disabled: "client alerts are switched off", notify_disabled: "alerts are switched off for this document", not_visible: "the document is not visible",
            no_recipient: "there is nobody to alert", race_lost: "another request is already sending it", not_found: "the document record was not found",
            send_failed: "the notification could not be created — nothing was marked as sent, so Save again will retry", claim_failed: "the system could not reserve the notification — Save again will retry",
            send_failed_stuck: "the notification could not be created AND its \"notified\" mark could not be cleared, so Save again will NOT retry it — tell the developer, or tell the client in the chat yourself",
          }
          warn(`Shown in ${person.name}'s portal, but NO notification was sent — ${why[n.reason ?? ""] ?? "it was not sent"}.`)
        }
      } catch (e) {
        partial = true
        warn(`Shown in ${person.name}'s portal, but the notification failed (${e instanceof Error ? e.message : "error"}) — press Save again to retry.`)
      }
    } else if (shownOk) {
      ok(wasVisible ? `Already visible in ${person.name}'s portal — no notification sent.` : `Shown in ${person.name}'s portal — no notification sent.`)
    }
  }

  await logAudit({
    itin_written: done.itinWritten, issue_date_written: done.issueDateWritten, issue_date_cleared: done.issueDateCleared, kept_existing: decision.kept, itin_blocked: itinBlocked, partial,
    // what a replace overwrote, masked: enough to trace a mistake, never the number itself
    ...(done.itinWritten && before?.itin ? { replaced_itin_last4: last4(before.itin), replaced_issue_date: before.issueDate } : {}),
  })

  return { index: input.index, ok: true, partial, ...(decision.kept ? { keptNeedsReplace: true } : {}), fileId: saved.fileId, status: saved.status, place, notes }
}

/** Save what staff confirmed, one file at a time; a failure on one file never stops the others. */
export async function saveChatAttachmentsToStorage(messageId: string, inputs: SaveItemInput[], actorId: string | null): Promise<{ ok: true; results: SaveItemResult[] } | Failure> {
  const m = await loadMessage(messageId)
  if ("ok" in m) return m
  const atts = chatAttachmentsOf(m.row)
  let pr: PeopleResult
  try { pr = await loadPeople(m.row) } catch (e) { return fail(500, e instanceof Error ? e.message : "Could not read the members.") }
  const results: SaveItemResult[] = []
  for (const input of inputs) {
    try {
      results.push(await saveOne(m.row, atts, pr, input, actorId))
    } catch (e) {
      console.error("[save-from-chat] a file could not be saved:", e instanceof Error ? e.message : String(e))
      results.push({ index: input.index, ok: false, error: e instanceof Error ? e.message : "The file could not be saved.", notes: [] })
    }
  }
  return { ok: true, results }
}
