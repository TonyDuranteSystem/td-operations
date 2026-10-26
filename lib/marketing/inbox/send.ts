/**
 * TD Marketing — send an email, or save it as a draft, from the Inbox (server; dev job 9aec66fa). One function behind both routes, so the rules are written once: the answered message is read
 * from the mailbox (never trusted from the browser), the sender is ALWAYS the mailbox itself, attachments come only from this person's own staged files, a double press of Send sends once, and the
 * staged files are deleted after.
 */
import { composeMessage, type ComposeMode } from "@/lib/marketing/inbox/compose"
import { deleteStaged, loadStaged } from "@/lib/marketing/inbox/staging"
import type { MailDriver } from "@/lib/marketing/inbox/driver"
import type { InboxMailbox } from "@/lib/marketing/inbox/mailboxes"
import type { MailMessage } from "@/lib/marketing/inbox/mail-types"
import { buildSignature, parseSignatureVariant, type SignatureVariant } from "@/lib/email/signature"

const MODES: readonly ComposeMode[] = ["new", "reply", "replyAll", "forward"]
const ID = /^[A-Za-z0-9_-]{1,200}$/

/**
 * The signature for this email: the one the person picked next to Send (Full / Compact / none; new emails default to Full, answers to Compact - the CRM Inbox's own defaults), built by the shared
 * builder from the mailbox's saved name / title / phone. Nothing from the browser but the choice itself.
 */
export function signatureFor(box: InboxMailbox, mode: ComposeMode, picked: unknown): { html: string; text: string } | null {
  const raw = parseSignatureVariant(picked, mode === "new" ? "gala" : "text")
  const variant: SignatureVariant = raw === "hat" ? "gala" : raw // the portrait is Antonio's own; it is never offered here
  if (variant === "none") return null
  const sig = buildSignature({ sender: "support", variant, includeSignoff: false, identity: { name: box.signature_name, title: box.signature_title, phone: box.signature_phone, email: box.address } })
  return sig.html ? sig : null
}

export type SendResult = { ok: true; threadId?: string; draftId?: string } | { ok: false; error: string; status: number }

/** A Send the same person repeats within two minutes with the same key is refused (a double click, a retry): the first one already went. Per server instance, which covers the double click. */
const recent = new Map<string, number>()
export function firstTimeSeen(key: unknown, userId: string, now = Date.now()): boolean {
  if (typeof key !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(key)) return true
  recent.forEach((t, old) => { if (now - t > 120_000) recent.delete(old) })
  const k = `${userId}:${key}`
  if (recent.has(k)) return false
  recent.set(k, now)
  return true
}

export async function sendOrDraft(input: {
  teamId: string; userId: string; box: InboxMailbox; driver: MailDriver; body: Record<string, unknown>; draft: boolean
}): Promise<SendResult> {
  const { box, driver, body, draft } = input
  const mode: ComposeMode = MODES.includes(body.mode as ComposeMode) ? (body.mode as ComposeMode) : "new"
  const threadId = typeof body.threadId === "string" && ID.test(body.threadId) ? body.threadId : undefined
  if (mode !== "new" && !threadId) return { ok: false, error: "The email you are answering could not be found.", status: 400 }
  if (body.draftId !== undefined && body.draftId !== null && !(typeof body.draftId === "string" && ID.test(body.draftId))) return { ok: false, error: "That draft is not valid.", status: 400 }
  const draftId = typeof body.draftId === "string" ? body.draftId : undefined

  // the message being answered or forwarded: read from the mailbox, so the quoted text and the reply headers are the real ones
  let answered: MailMessage | undefined
  if (mode !== "new" && threadId) {
    const t = await driver.thread(box.address, threadId).catch(() => null)
    // never an unsent draft: it must not be quoted to the person (nor give its own id as the reply header)
    const real = (t?.messages ?? []).filter(m => !m.draft)
    answered = real.find(m => m.id === body.messageId) ?? real[real.length - 1]
    if (!answered) return { ok: false, error: "The email you are answering could not be found.", status: 400 }
  }

  const staged = draft ? { ok: true as const, files: [], paths: [] as string[] } : await loadStaged(input.teamId, input.userId, body.attachments)
  if (staged.ok === false) return { ok: false, error: staged.error, status: 400 }

  // an edited draft already holds its signature and the quoted original in its text: adding them again would double them
  const complete = body.complete === true
  const composed = composeMessage({
    from: box.address, to: body.to, cc: body.cc, bcc: body.bcc, subject: body.subject, messageHtml: body.messageHtml, message: body.message, style: body.style,
    signature: complete ? null : signatureFor(box, mode, body.signatureVariant), inReplyTo: mode === "forward" ? undefined : answered?.messageIdHeader, references: mode === "forward" ? undefined : answered?.references,
    quote: answered && !complete ? { from: answered.from, date: answered.date, text: answered.text } : null, attachments: staged.files, draft,
  })
  if (composed.ok === false) return { ok: false, error: composed.error, status: 400 }

  try {
    if (draft) {
      const r = await driver.saveDraft(box.address, composed.raw, mode === "forward" ? undefined : threadId, draftId)
      return { ok: true, draftId: r.draftId }
    }
    const sent = await driver.send(box.address, composed.raw, mode === "forward" ? undefined : threadId)
    // best effort: the email is already gone, so a failure here must not look like a failed send
    if (draftId) await driver.deleteDraft(box.address, draftId).catch(() => {})
    await deleteStaged(staged.paths)
    return { ok: true, threadId: sent.threadId }
  } catch (e) {
    console.error("[marketing] inbox send failed:", e instanceof Error ? e.message : e)
    return { ok: false, error: draft ? "The draft could not be saved. Please try again." : "The email could not be sent. Nothing was sent; try again.", status: 502 }
  }
}
