/**
 * Inbox worker "send an email WITH an attachment" — prepare + confirm.
 *
 * The worker never sends a file directly. Flow:
 *   1. prepareWorkerEmailSend(): resolves the recipient (must be on the thread),
 *      resolves each attachment from the staff's THIS-TURN uploads (private
 *      bucket, never Drive, never an inbound-email file), enforces the outbound
 *      size limit, and freezes the whole payload in `worker_prepared_sends`
 *      (status='pending'). Returns a SERVER-AUTHORED confirmation line.
 *   2. The panel shows a Confirm/Cancel button built from that row.
 *   3. confirmWorkerEmailSend(): an explicit staff click re-validates everything
 *      and dispatches the frozen payload. The human — not the model — is gate 2.
 *
 * Text-only worker sends do NOT come through here; they send immediately with the
 * recipient pin. This path exists only for the file case.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { TD_MAILBOXES, checkRecipientsAllowed } from "@/lib/inbox/email-recipients"
import { buildRawEmail } from "@/lib/email/raw-mime"
import { isValidWorkerUploadPath, WORKER_UPLOAD_BUCKET } from "@/lib/ai-agent/attachment-reader"

/**
 * Outbound cap on the SUM of attachment bytes (raw, pre-base64). Gmail rejects a
 * message over ~25 MB and base64 inflates ~33%, so 18 MB of raw attachments
 * leaves headroom for the body + encoding. Distinct from the 20 MB READ cap.
 */
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 18 * 1024 * 1024

/** A prepared send older than this can't be confirmed — the draft has gone stale. */
export const PREPARED_SEND_TTL_MS = 30 * 60 * 1000

/** Per-file hard ceiling at confirm — actual downloaded bytes, not the declared size. */
export const MAX_OUTBOUND_PER_FILE_BYTES = MAX_OUTBOUND_ATTACHMENT_BYTES

/**
 * A failure that will ALWAYS fail (bad path, oversize bytes) — the row is
 * cancelled, not rolled back to pending, so it can't be retried forever.
 */
class TerminalSendError extends Error {}

/** One file the staff uploaded THIS turn that the worker may attach. */
export interface SendableUpload {
  ref: string
  path: string
  name: string
  contentType?: string
  size?: number
}

export interface PrepareInput {
  threadUuid: string
  gmailThreadId?: string | null
  mailbox: string
  replyToMessageId?: string | null
  /** Model-supplied recipient — validated against the pin here. */
  to: string
  subject: string
  body: string
  /** Refs the model asked to attach; resolved against `sendable`. */
  attachRefs: string[]
  /** The ONLY files attachable — this turn's staff uploads. */
  sendable: SendableUpload[]
  /** Addresses on the open thread; recipient must be one of these. */
  allowedRecipients: string[]
  actor: string
  /**
   * The recipient is being PROPOSED to a human, not asserted as already allowed.
   *
   * Set only when the executor has just refused this address against the pin and
   * is handing it to the staff member to confirm. It skips the allow-list check
   * here — the human's Confirm click is the gate — and NOTHING else: the payload
   * is still frozen, still single-use, still TTL'd, and the recipient in the row
   * is the one the human will see. The point is that what is confirmed is what is
   * sent; the previous flow re-ran the model after the click, so the message that
   * left was never the message that was approved.
   */
  proposedRecipient?: boolean
}

export type PrepareResult =
  | { ok: true; preparedId: string; message: string }
  | { ok: false; message: string }

const SENDERS: Record<string, { email: string; name: string }> = {
  "support@tonydurante.us": { email: "support@tonydurante.us", name: "Tony Durante" },
  "antonio.durante@tonydurante.us": { email: "antonio.durante@tonydurante.us", name: "Antonio Durante" },
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Resolve + validate + freeze. Does NOT send. Returns a confirmation string the
 * worker relays; the actual payload is in the DB row for the confirm endpoint.
 */
export async function prepareWorkerEmailSend(input: PrepareInput): Promise<PrepareResult> {
  // SUPERSEDE ANY EARLIER PENDING DRAFT ON THIS CONVERSATION.
  //
  // Drafting is iterative: "email Smit we'll file by Friday" … "no, say we need
  // his numbers first". Each pass freezes a row. On the panels the old card is
  // ephemeral, but in Team Chat it is a permanent chat message that stays amber
  // and clickable — so the superseded email could be dispatched half an hour
  // later, contradicting the one that was actually sent. Cancelling the older
  // rows here means the newest frozen payload is the only one that can leave, on
  // every surface. A card for a cancelled row now clicks through to an honest
  // "already cancelled" instead of a second real email.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from("worker_prepared_sends")
      .update({ status: "cancelled" })
      .eq("thread_uuid", input.threadUuid)
      .eq("status", "pending")
  } catch {
    // Best-effort: failing to supersede must never block preparing the new draft.
  }

  // Recipient must be on the thread (defence in depth — the executor also checks).
  const verdict = input.proposedRecipient
    ? ({ ok: true } as const)
    : checkRecipientsAllowed(input.to, input.allowedRecipients)
  if (verdict.ok === false) {
    return {
      ok: false,
      message: `❌ Can't send: ${verdict.rejected.join(", ")} is not on this email thread. You may only email people already on it.`,
    }
  }

  // Resolve each ref against the staff's uploads. A ref not in the set — or no
  // refs at all — is a hard refusal: the model can never attach anything else.
  // No attachments is FINE — a plain email is the ordinary case. It used to be a
  // hard refusal here, which is exactly why only attachment sends ever produced a
  // frozen, confirmable payload and text emails fell back to the re-run path.
  const resolved: SendableUpload[] = []
  for (const ref of input.attachRefs) {
    const hit = input.sendable.find((s) => s.ref === ref)
    if (!hit) {
      const avail = input.sendable.map((s) => `${s.ref} (${s.name})`).join(", ") || "none"
      return { ok: false, message: `❌ "${ref}" is not a file you attached to this message. Attachable now: ${avail}.` }
    }
    if (!isValidWorkerUploadPath(hit.path)) {
      return { ok: false, message: `❌ "${hit.name}" can't be attached (invalid upload).` }
    }
    resolved.push(hit)
  }

  // Outbound size guard — sum of raw bytes, before we build anything.
  const totalBytes = resolved.reduce((n, r) => n + (r.size ?? 0), 0)
  if (totalBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    return {
      ok: false,
      message: `❌ Too large to email: ${mb(totalBytes)} of attachments (max ${mb(MAX_OUTBOUND_ATTACHMENT_BYTES)}). Send it another way.`,
    }
  }

  // Freeze the exact payload the staff will confirm.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("worker_prepared_sends")
    .insert({
      thread_uuid: input.threadUuid,
      gmail_thread_id: input.gmailThreadId ?? null,
      mailbox: input.mailbox,
      reply_to_message_id: input.replyToMessageId ?? null,
      to_address: input.to,
      subject: input.subject,
      body: input.body,
      attachments: resolved.map((r) => ({ path: r.path, name: r.name, content_type: r.contentType, size: r.size })),
      actor: input.actor,
      status: "pending",
    })
    .select("id")
    .single()
  if (error || !data) {
    console.error("[worker-email-send] prepare insert failed:", error)
    return { ok: false, message: "❌ Couldn't prepare the email — please try again." }
  }

  const fileList = resolved.map((r) => `${r.name} (${mb(r.size ?? 0)})`).join(", ")
  return {
    ok: true,
    preparedId: data.id,
    message: resolved.length
      ? `Ready to send to ${input.to} with ${fileList} attached. Ask the staff member to press Confirm to send — I won't send it on my own.`
      : `Ready to send to ${input.to}. Ask the staff member to check the address and press Confirm — I won't send it on my own, and Confirm sends exactly this message.`,
  }
}

export type ConfirmResult =
  | { ok: true; gmailMessageId: string; to: string }
  | { ok: false; reason: string }

/**
 * Dispatch a prepared send after an explicit staff Confirm. Re-validates
 * everything and sends the FROZEN payload. Idempotent: a second confirm on an
 * already-sent row is refused (double-send guard).
 */
export async function confirmWorkerEmailSend(
  preparedId: string,
  actorEmail: string,
  /**
   * The mailbox the staff member chose on the Confirm card ("support" | "antonio").
   * Antonio, 2026-07-29: the card must also ask which of our addresses it goes out
   * from. Applied HERE, at confirm time, so the human's choice is what ships — and
   * the CALLER must have already checked that this staff member may send as it
   * (the route does, with the same mailbox gate used to read that inbox).
   */
  mailboxOverride?: "support" | "antonio",
): Promise<ConfirmResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Claim the row: pending → sent in one guarded update (TOCTOU + double-send).
  const { data: claimed } = await db
    .from("worker_prepared_sends")
    .update({
      status: "sent",
      resolved_at: new Date().toISOString(),
      ...(mailboxOverride
        ? { mailbox: mailboxOverride === "antonio" ? TD_MAILBOXES[1] : TD_MAILBOXES[0] }
        : {}),
    })
    .eq("id", preparedId)
    .eq("status", "pending")
    .select("*")
    .single()
  if (!claimed) {
    return { ok: false, reason: "This email was already sent or cancelled." }
  }

  // Staleness: a prepared send frozen long ago carries an out-of-date subject/body
  // (the client may have moved on). Refuse an old one rather than send a now-wrong
  // reply — mark it cancelled so it can't be retried. Nothing has been sent yet.
  if (claimed.created_at && Date.now() - new Date(claimed.created_at).getTime() > PREPARED_SEND_TTL_MS) {
    await db.from("worker_prepared_sends").update({ status: "cancelled", resolved_at: new Date().toISOString() }).eq("id", preparedId)
    return { ok: false, reason: "This draft is too old to send — ask the worker to prepare it again." }
  }

  try {
    const { gmailGet, gmailPost, getHeader } = await import("@/lib/gmail")
    const { plainTextToParagraphs } = await import("@/lib/operations/email")
    const { APP_BASE_URL } = await import("@/lib/config")

    const sender = SENDERS[claimed.mailbox] ?? SENDERS["support@tonydurante.us"]

    // Re-validate recipient is still on the thread (the thread may have changed
    // since prepare). Fail closed — never send to an address that dropped off.
    if (claimed.gmail_thread_id) {
      try {
        const thread = (await gmailGet(`/threads/${claimed.gmail_thread_id}`, { format: "metadata" }, sender.email)) as {
          messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }>
        }
        const { collectThreadRecipients } = await import("@/lib/inbox/email-recipients")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allowed = collectThreadRecipients((thread.messages ?? []) as any)
        if (checkRecipientsAllowed(claimed.to_address, allowed).ok === false) {
          await db.from("worker_prepared_sends").update({ status: "cancelled", resolved_at: new Date().toISOString() }).eq("id", preparedId)
          return { ok: false, reason: `${claimed.to_address} is no longer on this thread — send cancelled for safety.` }
        }
      } catch {
        // couldn't re-read — proceed on the frozen recipient, it was validated at prepare
      }
    }

    // Download each frozen attachment from the private bucket by PATH (service key).
    // A bad path or an oversize is a PERMANENT failure — mark cancelled (via
    // TerminalSendError below) so the row can't be retried forever.
    const files: Array<{ filename: string; contentType?: string; base64: string }> = []
    let totalBytes = 0
    for (const att of claimed.attachments as Array<{ path: string; name: string; content_type?: string; size?: number }>) {
      if (!isValidWorkerUploadPath(att.path)) throw new TerminalSendError(`invalid attachment path`)
      const { data, error } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).download(att.path)
      if (error || !data) throw new Error(`couldn't read ${att.name}`)
      const buf = Buffer.from(await data.arrayBuffer())
      // Enforce on ACTUAL bytes, per file AND cumulative, as we go — the declared
      // size at prepare is client-supplied and untrustworthy. Cancel (don't retry)
      // on oversize; a too-big file will always be too big.
      totalBytes += buf.length
      if (buf.length > MAX_OUTBOUND_PER_FILE_BYTES || totalBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
        throw new TerminalSendError(`attachments exceed the outbound size limit`)
      }
      files.push({ filename: att.name, contentType: att.content_type, base64: buf.toString("base64") })
    }
    // (per-file + cumulative caps already enforced inside the loop above)

    // Branded HTML — same shell the worker's text sends use.
    const signoff = sender.email.startsWith("antonio") ? "Antonio Durante" : "The Tony Durante LLC Team"
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<div style="text-align:center;padding:4px 0 18px 0;border-bottom:1px solid #e5e7eb;margin-bottom:24px">
<img src="${APP_BASE_URL}/images/tony-logos.png" alt="Tony Durante LLC — Your Way to Freedom" style="width:100%;max-width:540px;height:auto;display:inline-block" />
</div>
${plainTextToParagraphs(claimed.body)}
<p style="margin-top:24px">Best regards,<br />${signoff}</p>
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px">
<p style="margin:4px 0"><strong style="color:#1a1a1a">Tony Durante LLC</strong></p>
<p style="margin:4px 0"><a href="mailto:support@tonydurante.us" style="color:#2563eb;text-decoration:none">support@tonydurante.us</a></p>
</div>
</div>`

    // Threading headers. Strip CR/LF from the recipient before it enters a raw
    // header — the recipient pin already validates the addresses, this is the
    // belt-and-braces against header injection (subject is base64, so it's safe).
    const toHeader = String(claimed.to_address).replace(/[\r\n]/g, " ").trim()
    const headerLines = [
      `From: ${sender.name} <${sender.email}>`,
      `To: ${toHeader}`,
      `Subject: =?utf-8?B?${Buffer.from(claimed.subject).toString("base64")}?=`,
    ]
    let gmailThreadId: string | undefined
    if (claimed.reply_to_message_id) {
      try {
        const orig = (await gmailGet(
          `/messages/${claimed.reply_to_message_id}`,
          { format: "metadata", metadataHeaders: "Message-ID,References" },
          sender.email,
        )) as { threadId: string; payload: { headers: Array<{ name: string; value: string }> } }
        gmailThreadId = orig.threadId
        const msgId = getHeader(orig.payload.headers, "Message-ID")
        const refs = getHeader(orig.payload.headers, "References")
        if (msgId) {
          headerLines.push(`In-Reply-To: ${msgId}`)
          headerLines.push(`References: ${refs ? refs + " " : ""}${msgId}`)
        }
      } catch {
        /* send as new if the original can't be read */
      }
    }

    const stamp = Date.now()
    const raw = buildRawEmail(
      { headerLines, htmlBody: html, plainText: claimed.body, attachments: files },
      { outer: `outer_${stamp}`, alt: `alt_${stamp}` },
    )
    const payload: Record<string, unknown> = { raw }
    if (gmailThreadId) payload.threadId = gmailThreadId

    // ── POINT OF NO RETURN ─────────────────────────────────────────────────
    // The instant this resolves, the email HAS left. Nothing after it may roll
    // the row back to pending, or a retry would send the SAME email a second
    // time. Everything past here is best-effort bookkeeping in its own guard.
    const sent = (await gmailPost("/messages/send", payload, sender.email)) as { id?: string }
    const gmailMessageId = sent?.id ?? ""

    try {
      await db.from("worker_prepared_sends").update({ gmail_message_id: gmailMessageId }).eq("id", preparedId)
      const { logAction } = await import("@/lib/mcp/action-log")
      logAction({
        actor: actorEmail,
        action_type: "send",
        table_name: "gmail",
        summary: `Worker email WITH attachment sent to ${claimed.to_address}: "${String(claimed.subject).slice(0, 80)}" (${files.map((f) => f.filename).join(", ")})`,
      })
    } catch (bookkeepingErr) {
      // The send SUCCEEDED — never roll back. Just log the bookkeeping miss.
      console.error("[worker-email-send] post-send bookkeeping failed (email WAS sent):", bookkeepingErr)
    }

    return { ok: true, gmailMessageId, to: claimed.to_address }
  } catch (err) {
    // Reached ONLY on a failure BEFORE the send fired (resolve/download/build/
    // gmailPost-throw). A TERMINAL failure (bad path, oversize) will always fail
    // → cancel it so it can't be re-confirmed forever. A transient failure rolls
    // back to pending so the staff can retry.
    const terminal = err instanceof TerminalSendError
    await db
      .from("worker_prepared_sends")
      .update(terminal ? { status: "cancelled", resolved_at: new Date().toISOString() } : { status: "pending", resolved_at: null })
      .eq("id", preparedId)
      .eq("status", "sent")
    console.error("[worker-email-send] confirm/dispatch failed before send:", err)
    return { ok: false, reason: err instanceof Error ? err.message : "send failed" }
  }
}
