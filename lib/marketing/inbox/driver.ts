/**
 * TD Marketing — how the Inbox reaches a mailbox (dev job 9aec66fa). One small interface: the REAL driver talks to Gmail with the company's service key (the same key the CRM Inbox uses, one mailbox
 * at a time, always named by the caller's already-checked address); the FAKE driver is an in-memory mailbox for the private local test stack only (it refuses to start anywhere else), so the
 * browser tests never touch anybody's real mail. Callers must have passed `findOpenable` first: the driver itself trusts the address it is given.
 */
import { getGmailAttachment, gmailDelete, gmailGet, gmailPost, type GmailAPIMessage } from "@/lib/gmail"
import { allSettledBounded } from "@/lib/inbox/bounded-settled"
import { PAGE_SIZE, listParams, parseThreadFull, parseThreadRow } from "@/lib/marketing/inbox/parse"
import type { Folder, MailThread, ThreadAction, ThreadPage, ThreadRow } from "@/lib/marketing/inbox/mail-types"

export interface MailDriver {
  list(address: string, folder: Folder, q: string, pageToken: string | null): Promise<ThreadPage>
  thread(address: string, id: string): Promise<MailThread | null>
  act(address: string, id: string, action: ThreadAction): Promise<void>
  /** `raw` = the finished message, base64url. Returns the new message's ids. */
  send(address: string, raw: string, threadId?: string): Promise<{ id: string; threadId: string }>
  saveDraft(address: string, raw: string, threadId?: string, replaceDraftId?: string): Promise<{ draftId: string }>
  deleteDraft(address: string, draftId: string): Promise<void>
  attachment(address: string, messageId: string, attachmentId: string): Promise<Buffer>
  unread(address: string): Promise<number>
  /** Can the system open this mailbox? (used before an address is saved) */
  ping(address: string): Promise<{ ok: true } | { ok: false; error: string }>
}

const attachmentUrlFor = (address: string) => (messageId: string, attachmentId: string, mimeType: string) =>
  `/api/marketing/inbox/attachment?address=${encodeURIComponent(address)}&messageId=${encodeURIComponent(messageId)}&attachmentId=${encodeURIComponent(attachmentId)}&mimeType=${encodeURIComponent(mimeType)}&filename=inline`

const LABEL_CHANGES: Record<ThreadAction, { add?: string[]; remove?: string[] } | "trash"> = {
  read: { remove: ["UNREAD"] },
  unread: { add: ["UNREAD"] },
  archive: { remove: ["INBOX"] },
  star: { add: ["STARRED"] },
  unstar: { remove: ["STARRED"] },
  trash: "trash",
}

const realDriver: MailDriver = {
  async list(address, folder, q, pageToken) {
    const res = (await gmailGet("/threads", listParams(folder, q, pageToken), address)) as { threads?: Array<{ id: string }>; nextPageToken?: string }
    const ids = (res.threads ?? []).map(t => t.id)
    // Gmail allows about 25 thread reads a second: keep a page's worth under it (the CRM Inbox learned this the hard way, 2026-08-02)
    const settled = await allSettledBounded(ids, 8, id => gmailGet(`/threads/${id}`, { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] }, address))
    const rows: ThreadRow[] = settled.map((s, i) => s.status === "fulfilled"
      ? parseThreadRow(s.value as { id: string; messages?: GmailAPIMessage[] }, address)
      : { id: ids[i], subject: "(could not load this email)", who: "", snippet: "", date: new Date(0).toISOString(), unread: false, count: 0 })
    return { rows, nextPageToken: res.nextPageToken ?? null }
  },
  async thread(address, id) {
    let raw: { id: string; messages: GmailAPIMessage[] }
    try { raw = (await gmailGet(`/threads/${encodeURIComponent(id)}`, { format: "full" }, address)) as typeof raw } catch (e) {
      if (/Gmail API 404/.test(e instanceof Error ? e.message : "")) return null
      throw e
    }
    const t = parseThreadFull(raw, address, attachmentUrlFor(address))
    if (raw.messages.some(m => m.labelIds?.includes("DRAFT"))) {
      // the draft's id is only found by listing the drafts: up to 500 of them, a page at a time
      let pageToken: string | undefined
      for (let page = 0; page < 5 && !t.draftId; page++) {
        const drafts = (await gmailGet("/drafts", { maxResults: "100", ...(pageToken ? { pageToken } : {}) }, address).catch(() => ({}))) as { drafts?: Array<{ id: string; message?: { threadId?: string } }>; nextPageToken?: string }
        t.draftId = drafts.drafts?.find(d => d.message?.threadId === id)?.id
        pageToken = drafts.nextPageToken
        if (!pageToken) break
      }
    }
    return t
  },
  async act(address, id, action) {
    const change = LABEL_CHANGES[action]
    if (change === "trash") { await gmailPost(`/threads/${encodeURIComponent(id)}/trash`, {}, address); return }
    await gmailPost(`/threads/${encodeURIComponent(id)}/modify`, { addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] }, address)
  },
  async send(address, raw, threadId) {
    const r = (await gmailPost("/messages/send", { raw, ...(threadId ? { threadId } : {}) }, address)) as { id?: string; threadId?: string }
    return { id: r.id ?? "", threadId: r.threadId ?? threadId ?? "" }
  },
  async saveDraft(address, raw, threadId, replaceDraftId) {
    // the new draft first, the old one after: a failure in between must never leave the person with no draft at all
    const r = (await gmailPost("/drafts", { message: { raw, ...(threadId ? { threadId } : {}) } }, address)) as { id: string }
    if (replaceDraftId) await gmailDelete(`/drafts/${encodeURIComponent(replaceDraftId)}`, address).catch(() => {})
    return { draftId: r.id }
  },
  async deleteDraft(address, draftId) { await gmailDelete(`/drafts/${encodeURIComponent(draftId)}`, address) },
  async attachment(address, messageId, attachmentId) { return (await getGmailAttachment(messageId, attachmentId, address)).data },
  async unread(address) {
    const l = (await gmailGet("/labels/INBOX", {}, address)) as { threadsUnread?: number }
    return l.threadsUnread ?? 0
  },
  async ping(address) {
    try {
      const p = (await gmailGet("/profile", {}, address)) as { emailAddress?: string }
      return p.emailAddress?.toLowerCase() === address ? { ok: true } : { ok: false, error: "The system cannot open this mailbox." }
    } catch {
      return { ok: false, error: "The system cannot open this mailbox." }
    }
  },
}

/** The in-memory mailbox is allowed ONLY on the private local test stack: the switch AND a local database address AND not production. */
export function fakeMailAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARKETING_FAKE_MAIL === "1" && /127\.0\.0\.1|localhost/.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "") && env.NODE_ENV !== "production" && !env.VERCEL
}

let fakeSingleton: MailDriver | null = null

export async function getMailDriver(): Promise<MailDriver> {
  if (fakeMailAllowed()) {
    if (!fakeSingleton) fakeSingleton = (await import("@/lib/marketing/inbox/fake-driver")).createFakeDriver()
    return fakeSingleton
  }
  return realDriver
}

export { PAGE_SIZE }
