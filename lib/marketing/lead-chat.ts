/**
 * TD Marketing — the chat inside every lead (pure; dev job 9aec66fa, plan Addendum G). The rules only: what a message may contain, where an attached file may live, who is told,
 * what is unread, how a message is shown. No database and no network here; `lead-chat-server.ts` does the reading and writing. The screen itself is TD Talk's own
 * (TalkMessages / TalkComposer / TalkMessageSheet), fed with this chat's data, so a feature TD Talk gains later shows up here too.
 */
import { validateChatAttachment } from "@/lib/portal/chat-attachment"

export const BUCKET = "marketing-chat"
export const MESSAGE_MAX_CHARS = 5000
export const MAX_ATTACHMENTS = 5
/** a signed link to a file or voice note lives this long */
export const SIGNED_URL_SECONDS = 3600
/** The server hands out the SAME link for a file for this long (so a 4-second refresh does not sign every file again and the audio player is not reloaded)… */
export const URL_CACHE_SECONDS = 15 * 60
/** …and a window that stays open asks for fresh links after this long, so a link (at most URL_CACHE_SECONDS old when fetched) never reaches SIGNED_URL_SECONDS while on screen. */
export const URL_REFRESH_SECONDS = 30 * 60
/** the permission that opens the chat */
export const CHAT_PERMISSION = "chat" as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v)

export interface StoredAttachment {
  path: string
  name: string
  mime_type?: string
  size?: number
  flat?: boolean
  transcript?: unknown
}

/** The folder every file of one lead's chat lives in: <team id>/<lead id>/. */
export const folderFor = (teamId: string, leadId: string): string => `${teamId}/${leadId}/`

/** A file name safe to keep as the shown name: no path, no control characters, at most 120 characters. */
export function cleanFileName(name: unknown): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? ""
  // eslint-disable-next-line no-control-regex
  const s = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120)
  return s || "file"
}

/** The storage name for a new file: <team>/<lead>/<uuid>.<ext>, the extension kept short and plain. */
export function newObjectPath(teamId: string, leadId: string, fileName: string, uuid: string): string {
  const ext = (fileName.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  return `${folderFor(teamId, leadId)}${uuid}.${ext}`
}

/** An attachment path counts only when it is exactly one of OUR object names inside this lead's own folder (the path comes from the browser). */
export function isOwnObjectPath(path: unknown, teamId: string, leadId: string): path is string {
  if (typeof path !== "string") return false
  const prefix = folderFor(teamId, leadId)
  if (!path.startsWith(prefix)) return false
  return /^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(path.slice(prefix.length))
}

/** What a send may carry: text up to the limit (trimmed), and up to five attachments, each in this lead's own folder. Anything else is refused with a plain reason. */
export function checkSend(i: { message: unknown; attachments: unknown; teamId: string; leadId: string }):
  { ok: true; message: string; attachments: StoredAttachment[] } | { ok: false; error: string } {
  const message = typeof i.message === "string" ? i.message.trim() : ""
  if (message.length > MESSAGE_MAX_CHARS) return { ok: false, error: `Message too long (max ${MESSAGE_MAX_CHARS} characters).` }
  const raw = Array.isArray(i.attachments) ? i.attachments : i.attachments == null ? [] : null
  if (raw === null) return { ok: false, error: "The attachments are not valid." }
  if (raw.length > MAX_ATTACHMENTS) return { ok: false, error: `At most ${MAX_ATTACHMENTS} files per message.` }
  const attachments: StoredAttachment[] = []
  for (const a of raw as Array<Record<string, unknown>>) {
    if (!a || !isOwnObjectPath(a.path, i.teamId, i.leadId)) return { ok: false, error: "One of the files does not belong to this chat. Attach it again." }
    const mime = typeof a.mime_type === "string" ? a.mime_type.slice(0, 100) : undefined
    const size = typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? Math.round(a.size) : undefined
    // the same type and size policy as TD Talk's chat (executables and active content are refused; anything else is fine), checked HERE too: the browser's check is only a courtesy
    const refused = validateChatAttachment(cleanFileName(a.name), size ?? 0, mime ?? "")
    if (refused) return { ok: false, error: refused }
    // a voice note is recorded as an ordinary MP4 in the browser before it is sent, so it never needs the repair TD Talk gives older notes
    attachments.push({ path: a.path, name: cleanFileName(a.name), ...(mime ? { mime_type: mime } : {}), ...(size !== undefined ? { size } : {}), ...(mime?.startsWith("audio/") ? { flat: true } : {}) })
  }
  if (!message && attachments.length === 0) return { ok: false, error: "Write a message or attach a file." }
  return { ok: true, message, attachments }
}

/** The new text of an edit: trimmed, not empty, within the limit. */
export function checkEdit(text: unknown): { ok: true; message: string } | { ok: false; error: string } {
  const message = typeof text === "string" ? text.trim() : ""
  if (!message) return { ok: false, error: "message required" }
  if (message.length > MESSAGE_MAX_CHARS) return { ok: false, error: `Message too long (max ${MESSAGE_MAX_CHARS} characters).` }
  return { ok: true, message }
}

export const checkEmoji = (e: unknown): string | null => (typeof e === "string" && e.trim().length >= 1 && e.trim().length <= 16 ? e.trim() : null)

/** Only the author may edit a message; the author or the team owner may delete one (a deleted message leaves a note, never a gap). */
export function mayEdit(m: { sender_id: string; deleted_at: string | null }, userId: string): boolean {
  return m.sender_id === userId && !m.deleted_at
}
export function mayDelete(m: { sender_id: string }, userId: string, isOwner: boolean): boolean {
  return m.sender_id === userId || isOwner
}

export interface ChatMessageRow {
  id: string
  sender_id: string
  sender_name: string
  message: string
  attachments: StoredAttachment[] | null
  reply_to_id: string | null
  edited_at: string | null
  deleted_at: string | null
  created_at: string
  /** Only present once the pin migration has run. */
  pinned_at?: string | null
}
export interface ChatReaction { message_id: string; user_id: string; user_name: string; emoji: string }

/** A message as TD Talk's screen expects it: attachments get their signed link (`urlFor`), reactions are attached, a reply carries a preview of the quoted message, a deleted message loses its words. */
export function toTalkMessage(m: ChatMessageRow, byId: ReadonlyMap<string, ChatMessageRow>, reactions: readonly ChatReaction[], urlFor: (path: string) => string | null) {
  const deleted = !!m.deleted_at
  const quoted = m.reply_to_id ? byId.get(m.reply_to_id) : undefined
  return {
    id: m.id,
    sender_id: m.sender_id,
    sender_name: m.sender_name,
    message: deleted ? "" : m.message,
    created_at: m.created_at,
    edited_at: m.edited_at,
    deleted_at: m.deleted_at,
    pinned_at: m.pinned_at ?? null,
    reply_to_id: m.reply_to_id,
    reply_to_preview: quoted ? { id: quoted.id, message: quoted.deleted_at ? "" : quoted.message, sender_name: quoted.sender_name, deleted_at: quoted.deleted_at } : null,
    attachments: deleted ? null : (m.attachments ?? []).flatMap(a => { const url = urlFor(a.path); return url ? [{ ...a, url }] : [] }),
    reactions: reactions.filter(r => r.message_id === m.id).map(r => ({ emoji: r.emoji, reactor_id: r.user_id, reactor_name: r.user_name })),
  }
}

/** Unread = messages from other people, not deleted, newer than my read marker (no marker = everything from others). */
export function unreadCount(messages: ReadonlyArray<{ sender_id: string; created_at: string; deleted_at: string | null }>, userId: string, lastReadAt: string | null): number {
  return messages.filter(m => m.sender_id !== userId && !m.deleted_at && (!lastReadAt || m.created_at > lastReadAt)).length
}

/**
 * What a SETTER is told about how far the others have read: each read position is cut back to the newest message she can see that is not newer than it. Her ticks come out exactly the same
 * (a message she can see is "read" when the position reaches it, and the cut position reaches it too), but the position can no longer be the exact time of a message she may not see —
 * "Mark unread" puts a position one millisecond before a message, which would otherwise point at it.
 */
export function clampReadsToVisible<T extends { last_read_at: string }>(reads: readonly T[], visibleMessageTimes: readonly string[]): T[] {
  const times = visibleMessageTimes.map(t => new Date(t).getTime()).filter(Number.isFinite).sort((a, b) => a - b)
  return reads.map(r => {
    const at = new Date(r.last_read_at).getTime()
    let best: number | null = null
    for (const t of times) { if (t <= at) best = t; else break }
    return { ...r, last_read_at: best === null ? new Date(0).toISOString() : new Date(best).toISOString() }
  })
}

/**
 * Who is INVOLVED in a lead's chat: a person who may use the chat AND works the leads (marks or picks them) — the setter and the seller, not the ad person who only watches.
 * They are the ones the ticks wait for and the ones who are notified: a tick that waited for somebody who never opens these chats would never turn blue.
 */
export function isInvolved(permissions: readonly string[]): boolean {
  return permissions.includes(CHAT_PERMISSION) && (permissions.includes("leads.mark") || permissions.includes("leads.pick"))
}

/**
 * A setter: she works the first calls but picks no leads, hosts no calls and creates no payment links (the setter bundle). The owner and the seller are never "setter only".
 * In a lead's chat she sees only what she wrote and what names her with @ (27 Oct 2026, Antonio: "she sees her own chat with Rocco, not ours"): a message between Antonio and Rocco stays between them.
 */
export function isSetterOnly(permissions: readonly string[]): boolean {
  return permissions.includes("leads.worklist") && !permissions.includes("leads.pick") && !permissions.includes("calls.host") && !permissions.includes("payment_links.create")
}

/** Whether a setter may see this message: she wrote it, another setter wrote it, or it names her with @. */
export function visibleToSetter(m: { sender_id: string; mentions?: readonly string[] | null }, viewerId: string, setterIds: ReadonlySet<string>): boolean {
  return setterIds.has(m.sender_id) || (m.mentions ?? []).includes(viewerId)
}

/** Who is told about a new message: every active, involved team member except the sender. A setter is told only when the message names her (she does not see the others, so she is not notified of them). */
export function pushRecipients(members: ReadonlyArray<{ user_id: string; status?: string; permissions: readonly string[] }>, senderId: string, mentioned: readonly string[] = []): string[] {
  return Array.from(new Set(members
    .filter(m => m.user_id !== senderId && m.status !== "removed" && m.status !== "paused" && isInvolved(m.permissions))
    .filter(m => !isSetterOnly(m.permissions) || mentioned.includes(m.user_id))
    .map(m => m.user_id)))
}

/** The line shown in the Messages list and in a notification: the words, else what was attached. */
export function previewLine(m: { message: string; attachments: ReadonlyArray<{ mime_type?: string; name?: string }> | null; deleted_at: string | null }): string {
  if (m.deleted_at) return "This message was deleted"
  const text = m.message.trim().replace(/\s+/g, " ")
  if (text) return text.length > 90 ? `${text.slice(0, 89)}…` : text
  const a = m.attachments?.[0]
  if (!a) return ""
  if ((a.mime_type ?? "").startsWith("audio/")) return "Voice message"
  if ((a.mime_type ?? "").startsWith("image/")) return "Photo"
  return a.name || "File"
}

/** Where a tapped notification goes: the board with this lead's chat open. */
export const chatUrlFor = (leadId: string): string => `/marketing/board?chat=${leadId}`
