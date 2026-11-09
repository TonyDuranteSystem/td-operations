/**
 * "Save to Storage" from Portal Chats, the second way (dev job fb49265a; Antonio 2026-11-09: "can I have the same identical card pop-up that
 * I have in storage instead of being limited?"). The chat button now opens the client's OWN Storage screen with the chat file already in its
 * upload bar — folder, whose document, type, name, "Show to client", tax year, filed / draft, same file, "a case is waiting" are all the
 * Storage upload's own questions, none of them re-built. This file is only the hand-over:
 *  - `readHandoffTarget`: whose storage the message belongs to (the company, or the person in a person's own thread) and the list of files;
 *  - `signChatFile`: a short-lived link to ONE attachment, so the browser can fetch the bytes itself (a big file never passes through a
 *    function response). The file is taken from the SAVED message — the browser never sends a url — and must sit in the chat's own folder.
 * Nothing is read by Document AI here, nothing is saved: saving happens in the Storage screen, by the person who presses Upload.
 * (The ITIN card in save-from-chat.ts is the other way: it READS an ITIN letter and fills the record.)
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PORTAL_BASE_URL } from "@/lib/config"
import { isVoiceAttachment } from "@/lib/portal/chat-voice"
import { assetsPathOfUrl, attachmentDirAllowed, chatAttachmentsOf, MAX_CARD_ITEMS, type ChatAttachment } from "./save-from-chat-rules"
import { loadMessage, type Failure } from "./save-from-chat"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accounts / contacts selects are loose here
const db = () => supabaseAdmin as any

const fail = (status: number, error: string): Failure => ({ ok: false, status, error })

/** How long the link to a chat file works (seconds). The browser fetches the bytes straight away. */
export const HANDOFF_LINK_SECONDS = 300

// ───────────────────────────── pure rules ─────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff", heic: "image/heic", heif: "image/heif",
  csv: "text/csv", txt: "text/plain", md: "text/markdown", rtf: "application/rtf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
}

/**
 * The type the Storage upload will be told. The chat records whatever the browser claimed (often empty, or application/octet-stream for a
 * spreadsheet): a specific claim is kept, otherwise the file name's extension decides, otherwise a plain binary type. It is only a label for
 * the screen — the Storage upload still works out what the file really is.
 */
export function handoffMime(claimed: string | null | undefined, fileName: string): string {
  const c = (claimed ?? "").trim().toLowerCase()
  if (c && c !== "application/octet-stream") return c
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(fileName)?.[1]?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

/**
 * A tax number written into a file name ("NAME---123-45-6789-itin.pdf" — the shape of a real incident file name; the number here is made up) is replaced by x's: names are listed,
 * searched, emailed and can be posted into the company chat, and a client's own file name often carries the ITIN. Only the NAME handed to
 * the Storage screen changes — the chat keeps the original, and the file's content is untouched. Screenshot names such as
 * "Screenshot_20261108_141245.png" are NOT touched (a date + time is not a tax number). Regex LITERALS on purpose (R115).
 */
export function redactTaxNumberInName(name: string): string {
  return name
    .replace(/(^|[^0-9])\d{3}[-. _]\d{2}[-. _]\d{4}(?![0-9])/g, "$1xxx-xx-xxxx")
    .replace(/(^|[^0-9])\d{2}[-. ]\d{7}(?![0-9])/g, "$1xx-xxxxxxx")
    .replace(/(^|[^0-9])\d{9}(?![0-9])/g, "$1xxxxxxxxx")
}

/**
 * A file name safe to show and to save: no folders, no control characters, no run of dots (the Storage upload refuses ".." in its staging
 * path, and a chat file cannot be renamed before it is handed over), no tax number, never empty.
 */
export function handoffFileName(name: string | null | undefined, index: number): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? ""
  const clean = redactTaxNumberInName(base.replace(/[\u0000-\u001f]/g, " ").replace(/\.{2,}/g, ".").replace(/\s+/g, " ").trim()).slice(0, 200)
  return clean || `Attachment ${index + 1}`
}

export interface HandoffItem {
  /** the same index the card, the preview and the save routes use (position in the message's attachment list) */
  index: number
  name: string
  size: number | null
  mimeType: string
  /** a voice note: the Storage screen is not offered for it */
  voice: boolean
}

/** The files of a message, in the order of `chatAttachmentsOf`, as the pop-up lists them. */
export function handoffItems(atts: ChatAttachment[]): HandoffItem[] {
  return atts.slice(0, MAX_CARD_ITEMS).map((a, index) => ({
    index,
    name: handoffFileName(a.name, index),
    size: typeof a.size === "number" && Number.isFinite(a.size) ? a.size : null,
    mimeType: handoffMime(a.mime_type, a.name ?? ""),
    voice: isVoiceAttachment({ url: a.url, name: a.name, mime_type: a.mime_type ?? undefined }),
  }))
}

// ───────────────────────────── server ─────────────────────────────

export interface HandoffTarget {
  ok: true
  messageId: string
  /** whose storage: the chat's company, or (in a person's own thread, no company) that person */
  scope: "company" | "person"
  accountId: string | null
  contactId: string | null
  /** that owner's id in the storage; null = it has no storage yet (the pop-up says so, nothing is made here) */
  ownerId: string | null
  /** the company's or the person's name, for the pop-up's title */
  label: string | null
  items: HandoffItem[]
  /** more files than the pop-up lists */
  moreThanListed: boolean
}

/** Whose storage a chat message belongs to and which files it carries. Reads only. */
export async function readHandoffTarget(messageId: string): Promise<HandoffTarget | Failure> {
  const m = await loadMessage(messageId)
  if ("ok" in m) return m
  const atts = chatAttachmentsOf(m.row)
  if (atts.length === 0) return fail(404, "This message has no attachments.")
  const accountId = m.row.account_id
  const contactId = m.row.contact_id
  if (!accountId && !contactId) return fail(404, "This message belongs to no company and no person, so there is no storage to save it in.")
  const scope: "company" | "person" = accountId ? "company" : "person"
  try {
    const browse = await import("./browse")
    const ownerId = accountId ? await browse.storeOwnerForAccountOrThrow(accountId) : await browse.storeOwnerForContactOrThrow(contactId as string)
    let label: string | null = null
    if (accountId) {
      const { data } = await db().from("accounts").select("company_name").eq("id", accountId).maybeSingle()
      label = (data?.company_name as string | null) ?? null
    } else {
      const { data } = await db().from("contacts").select("full_name").eq("id", contactId).maybeSingle()
      label = (data?.full_name as string | null) ?? null
    }
    return { ok: true, messageId: m.row.id, scope, accountId: accountId ?? null, contactId: contactId ?? null, ownerId, label, items: handoffItems(atts), moreThanListed: atts.length > MAX_CARD_ITEMS }
  } catch (e) {
    return fail(500, e instanceof Error && e.message ? e.message : "Could not check where this client's files are kept — please try again.")
  }
}

export interface SignedChatFile { ok: true; url: string; name: string; mimeType: string; size: number | null }

/** A short-lived link to ONE attachment of a saved message. The path comes from the message and must be in the chat's own folder. */
export async function signChatFile(messageId: string, index: number): Promise<SignedChatFile | Failure> {
  const m = await loadMessage(messageId)
  if ("ok" in m) return m
  const att = chatAttachmentsOf(m.row)[index]
  if (!att) return fail(404, "That attachment was not found.")
  const path = assetsPathOfUrl(att.url, process.env.NEXT_PUBLIC_SUPABASE_URL || "", PORTAL_BASE_URL)
  if (!path) return fail(400, "This attachment is not in our chat storage, so it cannot be saved from here.")
  // the chat send only checks that a link is on our storage: a link into ANOTHER company's folder must never be handed out from this chat
  if (!attachmentDirAllowed(path, { accountId: m.row.account_id, contactId: m.row.contact_id })) return fail(403, "This attachment is not in this chat's own folder, so it cannot be saved from here.")
  const { data, error } = await supabaseAdmin.storage.from("assets").createSignedUrl(path, HANDOFF_LINK_SECONDS)
  if (error || !data?.signedUrl) return fail(502, "The file could not be fetched from the chat storage — please try again.")
  const name = handoffFileName(att.name, index)
  return { ok: true, url: data.signedUrl, name, mimeType: handoffMime(att.mime_type, name), size: typeof att.size === "number" && Number.isFinite(att.size) ? att.size : null }
}
