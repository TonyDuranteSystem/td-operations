/**
 * Own-Inbox capture writer (dev_task 01800da8) — pull one message's full body +
 * attachments into our local store.
 *
 * Council fixes baked in:
 *  - RETRY on 429/5xx (withGmailRetry): the backfill of ~27,700 msgs + attachments
 *    WILL brush Gmail's quota; a bare throw + cursor-advance = permanent silent
 *    gap. Retry with backoff first; only a durable failure marks capture_status
 *    'error' (which the reconciler/backfill will revisit — never silently skip).
 *  - capture_status='complete' is written LAST, only after raw MIME AND every
 *    attachment object are confirmed stored (captureStatus()). local-first reads
 *    must fall back to live Gmail unless status='complete'.
 *  - INSERT-ONCE: a message already 'complete' is skipped — a label-only change
 *    never re-downloads bytes (avoids TOAST churn + quota burn).
 *  - Attachment bytes go to an OPAQUE path (never the sender filename).
 *  - IO is dependency-injected so the orchestration is unit-testable without
 *    Gmail or a live bucket (sandbox has neither).
 */
import {
  extractAttachments,
  extractInlineImages,
  extractBodyWithType,
  decodeBase64Url,
  type GmailAPIMessage,
} from "@/lib/gmail"
import {
  bodyStoragePath,
  attachmentStoragePath,
  captureStatus,
  assertMailbox,
  type Mailbox,
} from "./paths"

export const EMAIL_CONTENT_BUCKET = "email-content"

/** Parse the HTTP status out of a gmail helper error ("Gmail API 429: ..."). */
export function gmailErrorStatus(err: unknown): number | null {
  const m = /Gmail (?:API|attachment) (\d{3})/.exec(
    err instanceof Error ? err.message : String(err),
  )
  return m ? parseInt(m[1], 10) : null
}

/** Retry a Gmail call on 429 / 5xx with exponential backoff. Other errors (and
 *  a final exhausted retry) rethrow so the caller records a durable failure. */
export async function withGmailRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number
    baseDelayMs?: number
    sleep?: (ms: number) => Promise<void>
    /** [0,1) jitter source; injectable for deterministic tests. Default Math.random. */
    rand?: () => number
  } = {},
): Promise<T> {
  const retries = opts.retries ?? 4
  const base = opts.baseDelayMs ?? 500
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const rand = opts.rand ?? Math.random
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = gmailErrorStatus(err)
      const retryable = status === 429 || (status !== null && status >= 500)
      if (!retryable || attempt === retries) throw err
      // Exponential backoff with HALF-jitter — parallel workers that 429 at the
      // same tick must NOT retry in lockstep (thundering herd worsens a throttle).
      const backoff = base * 2 ** attempt
      await sleep(backoff / 2 + rand() * (backoff / 2))
    }
  }
  throw lastErr
}

export interface AttachmentSpec {
  gmail_attachment_id: string
  filename: string | null
  mime_type: string | null
  storage_path: string
  is_inline: boolean
  content_id: string | null
}

/**
 * PURE: map a full message payload to the set of attachment objects to store.
 * Merges real attachments (have a filename) with inline images (have a
 * Content-ID), keyed by Gmail's attachment id so each byte-blob is stored once.
 * Paths are opaque (never the sender filename).
 */
export function planAttachments(
  payload: GmailAPIMessage["payload"],
  mailbox: string,
  messageId: string,
): AttachmentSpec[] {
  assertMailbox(mailbox)
  const byId = new Map<string, AttachmentSpec>()

  for (const a of extractAttachments(payload)) {
    byId.set(a.attachmentId, {
      gmail_attachment_id: a.attachmentId,
      filename: a.filename || null,
      mime_type: a.mimeType || null,
      storage_path: attachmentStoragePath(mailbox, messageId, a.attachmentId),
      is_inline: false,
      content_id: null,
    })
  }
  for (const img of extractInlineImages(payload)) {
    const existing = byId.get(img.attachmentId)
    if (existing) {
      existing.is_inline = true
      existing.content_id = img.contentId
    } else {
      byId.set(img.attachmentId, {
        gmail_attachment_id: img.attachmentId,
        filename: null,
        mime_type: img.mimeType || null,
        storage_path: attachmentStoragePath(mailbox, messageId, img.attachmentId),
        is_inline: true,
        content_id: img.contentId,
      })
    }
  }
  return Array.from(byId.values())
}

// ── Orchestration (dependency-injected IO) ───────────────────────────────────

export interface CaptureDeps {
  /** Gmail GET (endpoint, params, asUser) — e.g. the real gmailGet. */
  gmailGet: (endpoint: string, params?: Record<string, string>, asUser?: string) => Promise<any>
  /** Download one attachment's bytes. */
  getAttachment: (messageId: string, attachmentId: string, asUser?: string) => Promise<{ data: Buffer; size: number }>
  /** Upload bytes to the content bucket at `path`. */
  putObject: (path: string, bytes: Buffer, contentType: string) => Promise<void>
  /** 'complete' | 'error' | 'pending' | null (not captured yet). */
  getStatus: (mailbox: Mailbox, messageId: string) => Promise<string | null>
  upsertAttachment: (row: AttachmentSpec & { mailbox: Mailbox; message_id: string; thread_id: string; size_bytes: number }) => Promise<void>
  upsertContent: (row: {
    mailbox: Mailbox; message_id: string; thread_id: string; body_path: string
    body_text: string; has_attachments: boolean; attachment_count: number
    capture_status: "complete" | "pending"; captured_at: string
  }) => Promise<void>
  markError: (mailbox: Mailbox, messageId: string, threadId: string, message: string) => Promise<void>
  gmailUser: string
  now: () => string
}

export type CaptureResult =
  | { status: "skipped" }
  | { status: "complete"; attachments: number }
  | { status: "error"; error: string }

/** Capture ONE message's body + attachments into the local store. Idempotent:
 *  a message already 'complete' is skipped (insert-once). */
export async function captureMessageContent(
  args: { mailbox: Mailbox; messageId: string; threadId: string },
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const { mailbox, messageId, threadId } = args
  assertMailbox(mailbox)

  if ((await deps.getStatus(mailbox, messageId)) === "complete") {
    return { status: "skipped" }
  }

  try {
    // ONE Gmail get per message (format:full) — headers, body, and attachment
    // IDs all come from this single call. A second format:raw get was a 2x quota
    // tax (council 2026-08-01). Throws on failure → caught below → markError.
    const full = (await withGmailRetry(() =>
      deps.gmailGet(`/messages/${messageId}`, { format: "full" }, deps.gmailUser),
    )) as GmailAPIMessage

    // Rendered HTML body → bucket. Storing an EMPTY body is valid (attachment-only
    // email); a FETCH failure would have thrown above, so reaching here + a
    // successful upload is a real "body stored" signal (not the old >=0 tautology).
    const { body: bodyHtml } = extractBodyWithType(full.payload)
    const bodyPath = bodyStoragePath(mailbox, messageId)
    await deps.putObject(bodyPath, Buffer.from(bodyHtml ?? "", "utf-8"), "text/html; charset=utf-8")

    // Plain-ish body text for later full-text search (search index is a later leg).
    const bodyText = safeBodyText(full.payload)

    const specs = planAttachments(full.payload, mailbox, messageId)
    let stored = 0
    for (const spec of specs) {
      const att = await withGmailRetry(() =>
        deps.getAttachment(messageId, spec.gmail_attachment_id, deps.gmailUser),
      )
      await deps.putObject(spec.storage_path, att.data, spec.mime_type || "application/octet-stream")
      await deps.upsertAttachment({ ...spec, mailbox, message_id: messageId, thread_id: threadId, size_bytes: att.size })
      stored++
    }

    const status = captureStatus({ bodyStored: true, attachmentsExpected: specs.length, attachmentsStored: stored })
    if (status !== "complete") {
      // Shouldn't happen (loop stores all or throws), but never lie about completeness.
      throw new Error(`capture incomplete: ${stored}/${specs.length} attachments`)
    }
    await deps.upsertContent({
      mailbox, message_id: messageId, thread_id: threadId, body_path: bodyPath,
      body_text: bodyText, has_attachments: specs.length > 0, attachment_count: specs.length,
      capture_status: "complete", captured_at: deps.now(),
    })
    return { status: "complete", attachments: specs.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.markError(mailbox, messageId, threadId, message)
    return { status: "error", error: message }
  }
}

/** Extract a plain-text-ish body for search. HTML tags stripped crudely; the
 *  dedicated search leg will refine this. Never throws. */
export function safeBodyText(payload: GmailAPIMessage["payload"]): string {
  try {
    const direct = payload.body?.data ? decodeBase64Url(payload.body.data) : ""
    const fromParts = (payload.parts || [])
      .map((p) => (p.body?.data ? decodeBase64Url(p.body.data) : ""))
      .join("\n")
    const raw = `${direct}\n${fromParts}`
    return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100_000)
  } catch {
    return ""
  }
}
