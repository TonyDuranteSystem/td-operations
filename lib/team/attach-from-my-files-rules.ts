/**
 * Attach a file from Antonio's My files › "From Claude" to a Claude post in Team Chat / TD Talk — the PURE rules (dev job f34c915d).
 * No database, no network: every decision that can be made from the request alone is made here, so it is unit-tested without a stack.
 * The server halves are `readMyFileForChat` (lib/crm-store/my-files-access.ts) and `attachMyFilesToChat` (lib/team/attach-from-my-files.ts).
 *
 * Posture: this turns a PRIVATE file into a link that opens without a login (the chat attachment bucket is public, exactly like the
 * paperclip uploads). So the caller must NAME the file by its id, only the owner may do it, only files inside "From Claude" qualify,
 * and the same type block-list as the paperclip applies.
 */
import { randomUUID } from "crypto"
import { getExtension, validateChatAttachment } from "@/lib/portal/chat-attachment"
import type { ChatAttachment } from "@/lib/types"

/** One file's cap. The bucket allows 100 MB, but the bytes are held in memory while they are copied, so Claude's route stays small. */
export const MY_FILES_CHAT_MAX_BYTES = 20 * 1024 * 1024
export const MY_FILES_CHAT_MAX_MB = 20
/** Same as the TD Talk composer (CHAT_ATTACHMENT_MAX_COUNT in lib/team/attachment.ts). */
export const CHAT_MAX_ATTACHMENTS = 5

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What a caller may put in one attachment slot of team_chat_send. Exactly one of `url` / `my_files_file_id`. */
export interface AttachmentRef {
  url?: unknown
  my_files_file_id?: unknown
  name?: unknown
  mime_type?: unknown
  size?: unknown
}

export type SplitRefs =
  | { ok: true; links: ChatAttachment[]; fileIds: string[] }
  | { ok: false; error: string }

/**
 * Sort the attachment slots into ready links (a url already on our storage) and My files ids to be copied.
 * Refuses: too many, a slot with both or neither source, a url without a name, a bad or repeated file id.
 * Order of the links is kept; the copied files are appended after them by the caller.
 */
export function splitAttachmentRefs(refs: ReadonlyArray<AttachmentRef> | null | undefined): SplitRefs {
  const list = refs ?? []
  if (list.length > CHAT_MAX_ATTACHMENTS) return { ok: false, error: `At most ${CHAT_MAX_ATTACHMENTS} attachments per message.` }
  const links: ChatAttachment[] = []
  const fileIds: string[] = []
  for (const a of list) {
    const hasUrl = typeof a?.url === "string" && a.url.trim().length > 0
    const hasFile = a?.my_files_file_id !== undefined && a?.my_files_file_id !== null && a?.my_files_file_id !== ""
    if (hasUrl && hasFile) return { ok: false, error: "Each attachment takes EITHER a url OR a my_files_file_id, not both." }
    if (!hasUrl && !hasFile) return { ok: false, error: "Each attachment needs a url or a my_files_file_id." }
    if (hasFile) {
      const id = typeof a.my_files_file_id === "string" ? a.my_files_file_id.trim() : ""
      if (!UUID.test(id)) return { ok: false, error: "my_files_file_id must be a file id taken from my_files_list." }
      const key = id.toLowerCase()
      if (fileIds.includes(key)) return { ok: false, error: "The same My files file is listed twice." }
      fileIds.push(key)
      continue
    }
    const name = typeof a.name === "string" ? a.name.trim() : ""
    if (!name) return { ok: false, error: "Each attachment needs a name." }
    links.push({
      url: (a.url as string).trim(),
      name,
      ...(typeof a.mime_type === "string" && a.mime_type ? { mime_type: a.mime_type } : {}),
      ...(typeof a.size === "number" && Number.isFinite(a.size) ? { size: a.size } : {}),
    })
  }
  if (links.length + fileIds.length > CHAT_MAX_ATTACHMENTS) return { ok: false, error: `At most ${CHAT_MAX_ATTACHMENTS} attachments per message.` }
  return { ok: true, links, fileIds }
}

/**
 * Is `folderId` the drop folder or inside it? `chain` is the folder and its parents, nearest first (the caller walks the real tree).
 * An empty chain, or no drop folder id, is "no" — never "yes by default".
 */
export function inDropFolder(chain: ReadonlyArray<string>, dropFolderId: string | null | undefined): boolean {
  if (!dropFolderId || chain.length === 0) return false
  return chain.some((id) => id === dropFolderId)
}

/**
 * Extra types refused on THIS path only, on top of the paperclip's block-list: other kinds of active content that a browser can run
 * or hand to the system when opened from a public link (bug-hunt on PR #960, dev job f34c915d). The paperclip's own list is shared with
 * the client portal and stays as it is.
 */
const EXTRA_BLOCKED_EXTENSIONS = new Set(["svgz", "xsl", "xslt", "mht", "mhtml", "hta", "swf", "lnk"])
const EXTRA_BLOCKED_MIME_TYPES = new Set(["text/xml", "application/xml", "text/xsl", "application/xslt+xml", "application/x-shockwave-flash"])

/**
 * The file itself, before any byte is read: a real size, within Claude's cap, and a type that may live on a public chat link
 * (the paperclip's block-list: web pages, scripts, programs, plus the extra types above). Returns a plain refusal, or null when allowed.
 * It runs twice on the way in: on the RECORDED size/type first, and again on the bytes and the type that will actually be stored.
 */
export function checkMyFileForChat(file: { name: string; size: unknown; mimeType: string | null }): string | null {
  const size = Number(file.size)
  if (file.size === null || file.size === undefined || !Number.isFinite(size) || size < 0) {
    return `"${file.name}": its size could not be verified, so it was not attached.`
  }
  if (size === 0) return `"${file.name}" is empty, so it was not attached.`
  if (size > MY_FILES_CHAT_MAX_BYTES) {
    return `"${file.name}" is ${(size / 1048576).toFixed(1)} MB — too big to attach from here (limit ${MY_FILES_CHAT_MAX_MB} MB). Attach it by hand with the paperclip.`
  }
  const blocked = validateChatAttachment(file.name, size, file.mimeType ?? "")
  if (blocked) return `"${file.name}": ${blocked}`
  const ext = getExtension(file.name)
  const mime = (file.mimeType ?? "").split(";")[0].trim().toLowerCase()
  if (EXTRA_BLOCKED_EXTENSIONS.has(ext) || EXTRA_BLOCKED_MIME_TYPES.has(mime)) {
    return `"${file.name}": this kind of file can't be sent in chat for security reasons.`
  }
  return null
}

/** A safe lower-case extension for the stored object name ("pdf"); "bin" when there is none. */
export function safeExtension(fileName: string): string {
  const raw = (fileName.split(".").length > 1 ? fileName.split(".").pop() : "") ?? ""
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
}

/**
 * Where the copy lives: the public `assets` bucket, under `team-chat/` like every Team Chat attachment. The chat is not known before the
 * post is resolved, so the folder is `claude` (nothing reads these paths back; the message row carries the full link).
 */
export function chatObjectPath(fileName: string, id: string = randomUUID()): string {
  return `team-chat/claude/${id}.${safeExtension(fileName)}`
}

/** The MIME type the copy is stored with: the file's own when it has one, else application/octet-stream. */
export function copyContentType(mimeType: string | null | undefined): string {
  const m = (mimeType ?? "").split(";")[0].trim().toLowerCase()
  return m || "application/octet-stream"
}
