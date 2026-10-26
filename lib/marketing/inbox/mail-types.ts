/** TD Marketing — the Inbox's shapes, shared by the server and the screens (types only; dev job 9aec66fa). */

export type Folder = "inbox" | "sent" | "drafts" | "starred"
export const FOLDERS: readonly Folder[] = ["inbox", "sent", "drafts", "starred"]
export const isFolder = (v: unknown): v is Folder => typeof v === "string" && (FOLDERS as readonly string[]).includes(v)

export interface ThreadRow {
  id: string
  subject: string
  /** who the row is about: the other side of the newest message (or "me" when only we wrote) */
  who: string
  snippet: string
  /** ISO time of the newest message */
  date: string
  unread: boolean
  count: number
}

export interface MailAttachment { messageId: string; attachmentId: string; filename: string; mimeType: string; size: number }

export interface MailMessage {
  id: string
  from: string
  fromEmail: string
  to: string
  cc: string
  /** only a draft carries its Bcc (a sent or received email never shows it) */
  bcc: string
  date: string
  subject: string
  /** sanitized HTML for a real HTML email; null when the email is plain text */
  html: string | null
  /** the plain text (also what the preview and the quote use) */
  text: string
  unread: boolean
  outbound: boolean
  attachments: MailAttachment[]
  /** headers a reply needs */
  messageIdHeader: string
  references: string
}

export interface MailThread { id: string; subject: string; messages: MailMessage[]; starred: boolean; draftId?: string }

export type ThreadAction = "read" | "unread" | "archive" | "trash" | "star" | "unstar"
export const THREAD_ACTIONS: readonly ThreadAction[] = ["read", "unread", "archive", "trash", "star", "unstar"]
export const isThreadAction = (v: unknown): v is ThreadAction => typeof v === "string" && (THREAD_ACTIONS as readonly string[]).includes(v)

export interface ThreadPage { rows: ThreadRow[]; nextPageToken: string | null }

export interface OutgoingFile { filename: string; contentType: string; /** base64 (standard) */ content: string }
