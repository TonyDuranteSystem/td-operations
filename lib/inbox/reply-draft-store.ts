/**
 * The reply draft safety net (dev job bbc70ff8, step 2c) — the part that decides what is stored and what comes back.
 *
 * WHY: a reply in progress lives only in the page. A refresh, a crash, an accidental browser Back (or an iPhone
 * swipe-back while the pop-up is open) throws it away. This keeps a copy in the TAB's sessionStorage (it is gone
 * when the tab closes, and never shared with another tab or another person on the same computer) and offers it
 * back — never silently.
 *
 * RULES (decided with the council):
 *  - Stored as a PROPOSAL: restored only when the person presses "Restore", into an empty editor.
 *  - Everything coming back is re-validated here (the storage is just a string anyone can edit): style through
 *    parseRichStyle, recipients through the address check, the HTML only ever enters the editor, whose schema
 *    drops anything it does not allow, and the text is re-derived from it.
 *  - Cleared on every successful send or Gmail-draft save, and on Discard.
 *  - `sendStartedAt` is written the moment a send begins and removed if it fails: a draft that still carries it
 *    after a reload means the send may have gone out, and the person is told to check Sent before sending again.
 *  - Never throws: storage can be full, blocked (private window) or missing — then there is simply no safety net.
 *  - Attachments are not kept (a file is an upload to our storage); only how many there were, so the bar can say so.
 */

import { parseRichStyle, richHtmlToText, type RichStyle } from '@/lib/inbox/rich-text'
import { SIGNATURE_VARIANTS } from '@/lib/email/signature'

export const REPLY_DRAFT_VERSION = 2
/** A stored reply older than this is not offered back — it is no longer the thing the person was answering. */
export const REPLY_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Bigger than any real reply; keeps one pasted document from filling the tab's storage. */
export const REPLY_DRAFT_MAX_HTML_CHARS = 200_000

const QUOTE_MODES = ['message', 'thread', 'none'] as const
const REPLY_MODES = ['reply', 'replyAll'] as const
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type StoredQuoteMode = (typeof QUOTE_MODES)[number]

export interface StoredReplyDraft {
  v: typeof REPLY_DRAFT_VERSION
  html: string
  style: RichStyle
  target: { messageId: string; sender: string; mode: (typeof REPLY_MODES)[number] } | null
  to: string[]
  quoteMode: StoredQuoteMode
  signatureVariant: string
  attachmentCount: number
  savedAt: number
  sendStartedAt?: number
}

/** The minimal slice of the Storage interface this uses — so tests can pass a plain object. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function replyDraftKey(mailbox: string | undefined, conversationId: string): string {
  return `td.replyDraft.v${REPLY_DRAFT_VERSION}:${mailbox === 'antonio' ? 'antonio' : 'support'}:${conversationId}`
}

/** The tab's sessionStorage, or null when the browser refuses access (reading the property itself can throw). */
export function getDraftStorage(): DraftStorage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

/** What the composer hands in; the store adds the version and the time. */
export type ReplyDraftInput = Omit<StoredReplyDraft, 'v' | 'savedAt'>

/**
 * Save. An empty reply (no words) removes the stored copy instead — there is nothing to protect. Returns whether
 * a copy is stored afterwards; never throws.
 */
export function saveReplyDraft(storage: DraftStorage | null, key: string, input: ReplyDraftInput, now: number): boolean {
  if (!storage) return false
  try {
    if (!richHtmlToText(input.html).trim() || input.html.length > REPLY_DRAFT_MAX_HTML_CHARS) {
      storage.removeItem(key)
      return false
    }
    const draft: StoredReplyDraft = { ...input, v: REPLY_DRAFT_VERSION, savedAt: now }
    storage.setItem(key, JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

export function clearReplyDraft(storage: DraftStorage | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    /* nothing to clear */
  }
}

/**
 * Read back, fully re-validated. Returns null for anything missing, malformed, from another version, older than
 * 24 hours, empty, or oversize — and removes an expired or corrupt entry so it is not re-read forever.
 */
export function loadReplyDraft(storage: DraftStorage | null, key: string, now: number): StoredReplyDraft | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  const drop = (): null => {
    clearReplyDraft(storage, key)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return drop()
  }
  if (!parsed || typeof parsed !== 'object') return drop()
  const d = parsed as Record<string, unknown>
  if (d.v !== REPLY_DRAFT_VERSION) return drop()
  if (typeof d.html !== 'string' || d.html.length > REPLY_DRAFT_MAX_HTML_CHARS) return drop()
  if (typeof d.savedAt !== 'number' || !Number.isFinite(d.savedAt)) return drop()
  if (now - d.savedAt > REPLY_DRAFT_MAX_AGE_MS || d.savedAt > now + 60_000) return drop()
  if (!richHtmlToText(d.html).trim()) return drop()

  let target: StoredReplyDraft['target'] = null
  if (d.target && typeof d.target === 'object') {
    const t = d.target as Record<string, unknown>
    if (
      typeof t.messageId === 'string' &&
      t.messageId &&
      typeof t.sender === 'string' &&
      (REPLY_MODES as readonly unknown[]).includes(t.mode)
    ) {
      target = { messageId: t.messageId, sender: t.sender, mode: t.mode as (typeof REPLY_MODES)[number] }
    }
  }
  const to = Array.isArray(d.to)
    ? d.to.filter((a): a is string => typeof a === 'string' && EMAIL_RE.test(a) && a.length <= 320).slice(0, 50)
    : []
  const quoteMode = (QUOTE_MODES as readonly unknown[]).includes(d.quoteMode) ? (d.quoteMode as StoredQuoteMode) : 'message'
  const signatureVariant =
    typeof d.signatureVariant === 'string' && (SIGNATURE_VARIANTS as readonly string[]).includes(d.signatureVariant)
      ? d.signatureVariant
      : ''
  const attachmentCount =
    typeof d.attachmentCount === 'number' && Number.isFinite(d.attachmentCount) && d.attachmentCount > 0
      ? Math.min(Math.floor(d.attachmentCount), 99)
      : 0
  const sendStartedAt =
    typeof d.sendStartedAt === 'number' && Number.isFinite(d.sendStartedAt) ? d.sendStartedAt : undefined

  return {
    v: REPLY_DRAFT_VERSION,
    html: d.html,
    style: parseRichStyle(d.style),
    target,
    to,
    quoteMode,
    signatureVariant,
    attachmentCount,
    savedAt: d.savedAt,
    ...(sendStartedAt !== undefined && { sendStartedAt }),
  }
}

/** Plain-language line for the restore bar. */
export function describeStoredDraft(draft: StoredReplyDraft, now: number): string {
  const mins = Math.max(0, Math.round((now - draft.savedAt) / 60_000))
  const when = mins < 1 ? 'a moment ago' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
  const files = draft.attachmentCount > 0 ? ` Re-attach the ${draft.attachmentCount} file${draft.attachmentCount > 1 ? 's' : ''} you had added.` : ''
  if (draft.sendStartedAt !== undefined) {
    return `A reply you were sending (${when}) may or may not have gone out. Check Sent before you send it again.${files}`
  }
  return `You have an unsent reply to this email from ${when}.${files}`
}
