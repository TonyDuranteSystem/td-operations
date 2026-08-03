/**
 * Own-Inbox content store — PURE path + completeness helpers (dev_task 01800da8).
 *
 * These are the DB-free, deterministic pieces the council flagged as must-get-
 * right and must-unit-test:
 *  - storage paths are built from the mailbox + Gmail's OWN opaque ids, NEVER the
 *    sender-supplied filename (which is attacker-controlled → path traversal on
 *    write). The display filename is stored as data on the row, not in the path.
 *  - a message is "complete" (safe for local-first reads) ONLY when the raw MIME
 *    and EVERY attachment are stored. This function is the single source of that
 *    truth; the capture writer flips capture_status='complete' from it, LAST.
 */
import { createHash } from "crypto"

export type Mailbox = "support" | "antonio"

const MAILBOXES: readonly Mailbox[] = ["support", "antonio"]

/** Gmail message/thread ids are hex-ish tokens. Fail closed on anything else so
 *  a malformed id can never escape its prefix in a storage path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function assertMailbox(mailbox: string): asserts mailbox is Mailbox {
  if (!MAILBOXES.includes(mailbox as Mailbox)) {
    throw new Error(`email-store: unknown mailbox "${mailbox}"`)
  }
}

function assertSafeId(kind: string, id: string): void {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(`email-store: unsafe ${kind} "${id}"`)
  }
}

/** Storage path for a message's rendered HTML body. `mailbox/<message_id>/body.html`. */
export function bodyStoragePath(mailbox: string, messageId: string): string {
  assertMailbox(mailbox)
  assertSafeId("message_id", messageId)
  return `${mailbox}/${messageId}/body.html`
}

/**
 * Storage path for one attachment. The path uses a HASH of Gmail's opaque
 * attachment id — never the sender filename — so a hostile filename like
 * `../../signed-contracts/x.pdf` can never place bytes outside the prefix.
 * `mailbox/<message_id>/att/<sha256(attId)[:32]>`.
 */
export function attachmentStoragePath(
  mailbox: string,
  messageId: string,
  gmailAttachmentId: string,
): string {
  assertMailbox(mailbox)
  assertSafeId("message_id", messageId)
  if (typeof gmailAttachmentId !== "string" || gmailAttachmentId.length === 0) {
    throw new Error("email-store: empty gmail_attachment_id")
  }
  const h = createHash("sha256").update(gmailAttachmentId).digest("hex").slice(0, 32)
  return `${mailbox}/${messageId}/att/${h}`
}

/**
 * The completeness rule. A message is fully captured only when its body object
 * was stored AND the number of attachment objects stored equals the number the
 * message actually has. `bodyStored` must be a REAL signal (the body upload
 * succeeded) — never a tautology; an attachment-only email has an empty body
 * that still stored successfully, which is complete. Returns the ledger status.
 */
export function captureStatus(input: {
  bodyStored: boolean
  attachmentsExpected: number
  attachmentsStored: number
}): "pending" | "complete" {
  const { bodyStored, attachmentsExpected, attachmentsStored } = input
  if (attachmentsExpected < 0 || attachmentsStored < 0) {
    throw new Error("email-store: negative attachment count")
  }
  const complete = bodyStored && attachmentsStored >= attachmentsExpected
  return complete ? "complete" : "pending"
}

/**
 * A Content-Type that object storage will actually accept.
 *
 * Senders put all sorts of junk in a MIME type — empty strings, stray
 * parameters (`application/pdf; name="x.pdf"`), non-ASCII filenames folded in,
 * even blank values. Supabase Storage rejects those outright ("Invalid
 * Content-Type header"), and because the capture stores every attachment before
 * marking a message complete, ONE bad label failed the WHOLE email: 218 messages
 * never got stored (2026-08-03). Normalise to the bare `type/subtype`, and fall
 * back to a generic binary type when it isn't a valid token.
 */
export function safeContentType(raw: string | null | undefined): string {
  const FALLBACK = "application/octet-stream"
  if (typeof raw !== "string") return FALLBACK
  // Drop parameters (";charset=...", ";name=...") and surrounding whitespace.
  const base = raw.split(";")[0]?.trim().toLowerCase() ?? ""
  // RFC 2045 token characters only, exactly one "/" separator.
  return /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(base) ? base : FALLBACK
}
