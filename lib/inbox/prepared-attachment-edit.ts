/**
 * ADDING AND REMOVING FILES ON A FROZEN DRAFT — the rules, in one testable place.
 *
 * WHY THIS IS ALLOWED AT ALL. The freeze exists so the MODEL cannot change what
 * a human has read: what you confirm is what is sent. A staff member editing
 * their OWN draft before pressing Confirm is not that — they are the gate, and
 * they still have to press it afterwards. So the rule is narrower than "frozen":
 * the assistant cannot touch a frozen draft, and a person can only add or remove
 * FILES on their own, never the recipient, the subject or the text. Widening
 * this to the wording would hand back exactly the hole the freeze was built to
 * close, so it is refused here by simply not existing.
 *
 * Extracted and pure because today's three bug-hunter rounds all landed on the
 * same lesson: a rule that lives inside a route cannot be tested, and an
 * untested rule is wrong in ways nobody sees.
 */
import { isValidWorkerUploadPath } from "@/lib/ai-agent/attachment-reader"
import { MAX_EMAIL_ATTACHMENT_FILES } from "@/lib/inbox/email-attachment-staging"
import { MAX_OUTBOUND_ATTACHMENT_BYTES } from "@/lib/inbox/worker-email-send"
import { formatBytes } from "@/lib/inbox/sendable-attachment"

/** One file as it is stored on a frozen draft. */
export interface FrozenAttachment {
  path: string
  name: string
  content_type?: string
  size?: number
  origin?: string
  warning?: string
  owner_label?: string
  owner_key?: string
  copied?: boolean
}

export type EditResult =
  | { ok: true; attachments: FrozenAttachment[]; removed?: FrozenAttachment }
  | { ok: false; reason: string; status: number }

/**
 * DOES THIS DRAFT BELONG TO THIS PERSON?
 *
 * The owner is stored as "<surface>:<who>" — and `who` is NOT the same kind of
 * thing on every surface: the Inbox, the client panel and the sidebar record an
 * EMAIL, while Team Chat records the sender's DISPLAY NAME. Comparing on email
 * alone therefore locks a person out of their own card in Team Chat, which is
 * precisely the screen this editing was asked for. So the caller passes every
 * identity the current user answers to, and a match on any of them is a match.
 */
export function isOwnDraft(rowActor: string | null | undefined, identities: Array<string | null | undefined>): boolean {
  const who = String(rowActor ?? "")
    .split(":")
    .slice(1)
    .join(":")
    .trim()
    .toLowerCase()
  // No recorded owner means nobody can claim it — fail closed rather than let
  // an unattributed draft be edited by whoever happens to be looking at it.
  if (!who) return false
  return identities.some((i) => {
    const mine = String(i ?? "").trim().toLowerCase()
    return mine.length > 0 && mine === who
  })
}

/** Who may edit, and when. Anything else is refused before a byte moves. */
export function checkEditable(
  row: { status?: string | null; actor?: string | null; kind?: string | null },
  /** Every identity the current user answers to — their email AND their team display name. */
  identities: Array<string | null | undefined>,
): { ok: true } | { ok: false; reason: string; status: number } {
  if (row.kind !== "email") {
    return { ok: false, reason: "Only an email draft can carry files.", status: 400 }
  }
  if (row.status !== "pending") {
    // Sent, cancelled or superseded: the payload is history now. Editing it
    // would either change what was already sent (it cannot) or resurrect a draft
    // the person deliberately dropped.
    return { ok: false, reason: "This draft is no longer waiting — nothing was changed.", status: 409 }
  }
  // OWN DRAFT ONLY. Conversations are shared — a team channel, an email thread,
  // a client — so without this a teammate could add a file to a draft you are
  // about to send, and the card you read would not be the email that left.
  if (!isOwnDraft(row.actor, identities)) {
    return { ok: false, reason: "This draft belongs to someone else.", status: 403 }
  }
  return { ok: true }
}

/**
 * Add a file the staff member just uploaded.
 *
 * `copied: true` on purpose — unlike a panel upload (which is the staff
 * member's own object, still on screen in their panel), this object exists ONLY
 * for this draft, so if the draft is cancelled or superseded the cleanup should
 * take it with it.
 */
export function addAttachment(
  current: FrozenAttachment[],
  file: { path: string; name: string; content_type?: string; size?: number },
): EditResult {
  if (!isValidWorkerUploadPath(file.path)) {
    return { ok: false, reason: "That upload could not be attached.", status: 400 }
  }
  if (current.some((a) => a.path === file.path)) {
    // Idempotent: a double-click on the picker must not attach the file twice.
    return { ok: true, attachments: current }
  }
  if (current.length + 1 > MAX_EMAIL_ATTACHMENT_FILES) {
    return {
      ok: false,
      reason: `That would be ${current.length + 1} files on one email — ${MAX_EMAIL_ATTACHMENT_FILES} is the most that will go in one go.`,
      status: 400,
    }
  }
  const total = current.reduce((n, a) => n + (a.size ?? 0), 0) + (file.size ?? 0)
  if (total > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: `That would make ${formatBytes(total)} of attachments — more than Gmail accepts on one email. Send it separately.`,
      status: 400,
    }
  }
  return {
    ok: true,
    attachments: [
      ...current,
      {
        path: file.path,
        name: file.name,
        content_type: file.content_type,
        size: file.size,
        origin: "you added this on the card",
        copied: true,
      },
    ],
  }
}

/** Remove one file by its POSITION — the same handle the card renders by. */
export function removeAttachment(current: FrozenAttachment[], index: number): EditResult {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    return { ok: false, reason: "That file is not on this draft.", status: 404 }
  }
  const removed = current[index]
  return { ok: true, attachments: current.filter((_, i) => i !== index), removed }
}
