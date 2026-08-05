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
import {
  buildSignature,
  signatureFromName,
  signatureSenderForAddress,
  SIGNATURE_MAILBOX_ADDRESSES,
  DEFAULT_SIGNATURE_VARIANT,
} from "@/lib/email/signature"
import { isValidWorkerUploadPath, WORKER_UPLOAD_BUCKET } from "@/lib/ai-agent/attachment-reader"
import { MAX_EMAIL_ATTACHMENT_FILES } from "@/lib/inbox/email-attachment-staging"
import {
  discardCopies,
  materializeSendable,
  SendableRefusal,
  type MaterializedAttachment,
  type SendableFile,
} from "@/lib/inbox/sendable-attachment"
import type { PreparedSendKind } from "@/lib/inbox/prepared-send-vocabulary"

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

/**
 * One file the staff uploaded THIS turn that the worker may attach.
 *
 * @deprecated Kept as an alias so existing callers keep compiling. The real
 * shape now lives in `lib/inbox/sendable-attachment.ts` and carries a `source`
 * (a panel upload, a file posted in the conversation, …) plus its provenance.
 */
export type SendableUpload = SendableFile

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
  /** The ONLY files attachable — what this surface offered the worker THIS turn. */
  sendable: SendableFile[]
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

// Display names come from lib/email/signature.ts so the From line agrees with
// the signature block at the bottom of the message.
const SENDERS: Record<string, { email: string; name: string }> = {
  [SIGNATURE_MAILBOX_ADDRESSES.support]: {
    email: SIGNATURE_MAILBOX_ADDRESSES.support,
    name: signatureFromName("support"),
  },
  [SIGNATURE_MAILBOX_ADDRESSES.antonio]: {
    email: SIGNATURE_MAILBOX_ADDRESSES.antonio,
    name: signatureFromName("antonio"),
  },
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Cancel this actor's EARLIER pending drafts of the SAME KIND on this conversation,
 * keeping the row just frozen.
 *
 * Drafting is iterative: "email Smit we'll file by Friday" … "no, say we need his
 * numbers first"; and on the portal card the Reformulate button makes that a
 * first-class loop. Each pass freezes a row. On the panels the old card is ephemeral,
 * but in Team Chat it is a permanent chat message that stays amber and clickable — so
 * a superseded draft could be dispatched half an hour later, contradicting the one
 * actually sent. Cancelling the older rows means the newest frozen payload is the only
 * one that can leave, on every surface, and a click on a dead card gets an honest
 * "already cancelled" instead of a second real send.
 *
 * SCOPED TO THE ACTOR. In Team Chat the conversation id is the whole CHANNEL, so a
 * blanket cancel would kill a teammate's un-confirmed card the moment anyone else
 * drafted. Redrafting is per-person.
 *
 * SCOPED TO THE KIND — added 2026-07-31 with the portal path, and this one is load
 * bearing. Antonio's flagship flow is BOTH at once: Luca replies to the bank by email
 * AND tells the client on the portal, on the same email thread. Kind-agnostic
 * superseding makes that impossible — the portal freeze silently cancels the pending
 * email, no card ever refuses, and the reply to the bank is simply never sent. The
 * cost of scoping is that "actually, send it as a portal message instead" leaves the
 * email draft pending; that card, if confirmed, sends an email the staff member did
 * write and then changed their mind about. Losing a message they DID intend to send is
 * the worse failure, so the scope wins. (The two reviewers split on this: the
 * Bug-Hunter called kind-agnostic supersede a blocker, the AI-Architect wanted it kept
 * kind-agnostic. Antonio's flow decides it.)
 *
 * RUNS AFTER THE NEW ROW IS INSERTED, never before. Superseding first means a prepare
 * that then fails validation — a bad attachment ref, an oversize file, an insert error
 * — has already destroyed the draft the staff member and the worker spent five turns
 * agreeing, with nothing pending and no card left to explain where it went.
 */
export async function supersedeEarlierDrafts(opts: {
  threadUuid: string
  actor: string
  kind: PreparedSendKind
  keepId: string
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: killed } = await (supabaseAdmin as any)
      .from("worker_prepared_sends")
      .update({ status: "cancelled", resolved_at: new Date().toISOString() })
      .eq("thread_uuid", opts.threadUuid)
      .eq("actor", opts.actor)
      .eq("kind", opts.kind)
      .eq("status", "pending")
      .neq("id", opts.keepId)
      .select("attachments")
    // A superseded draft's copies can never be sent — drop them. Only OUR copies
    // (a panel upload belongs to the staff member's own screen). Redrafting five
    // times otherwise leaves five sets of client documents in the bucket forever.
    for (const row of (killed ?? []) as Array<{ attachments?: Array<{ path?: string; copied?: boolean }> }>) {
      await discardCopies(row.attachments)
    }
  } catch {
    // Best-effort: failing to supersede must never fail a draft that IS frozen.
  }
}

/**
 * Resolve + validate + freeze. Does NOT send. Returns a confirmation string the
 * worker relays; the actual payload is in the DB row for the confirm endpoint.
 */
export async function prepareWorkerEmailSend(input: PrepareInput): Promise<PrepareResult> {
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

  // Resolve each ref against what this surface OFFERED this turn. A ref not in
  // the set — or no refs at all — is a hard refusal: the model can never attach
  // anything else, and it never names a path, a bucket or a URL.
  // No attachments is FINE — a plain email is the ordinary case. It used to be a
  // hard refusal here, which is exactly why only attachment sends ever produced a
  // frozen, confirmable payload and text emails fell back to the re-run path.
  //
  // Each resolved file is MATERIALIZED to real bytes in the private bucket here,
  // BEFORE the row is frozen, so the payload the human confirms is the payload
  // that leaves — see the header of `sendable-attachment.ts`. A refusal at this
  // point (unreadable, oversize) destroys nothing: no row exists yet, so the
  // worker can simply re-prepare without that file on the next turn.
  // SEVERAL FILES ON ONE EMAIL IS THE ORDINARY CASE and always has been — the
  // loop below resolves every ref the worker named. The only bound is the same
  // one the manual composer already applies: "email them all of Acme's 2025
  // documents" would otherwise fetch forty files inside a single request and
  // die on the function timeout, which reads to the staff member as the feature
  // being broken rather than as too large an ask.
  if (input.attachRefs.length > MAX_EMAIL_ATTACHMENT_FILES) {
    return {
      ok: false,
      message: `❌ That's ${input.attachRefs.length} files on one email — ${MAX_EMAIL_ATTACHMENT_FILES} is the most that will go in one go. Send them in two emails, or say which ones matter.`,
    }
  }
  const resolved: MaterializedAttachment[] = []
  let materializedBytes = 0
  for (const ref of input.attachRefs) {
    const hit = input.sendable.find((s) => s.ref === ref)
    if (!hit) {
      const avail = input.sendable.map((s) => `${s.ref} (${s.name})`).join(", ") || "none"
      return { ok: false, message: `❌ "${ref}" is not a file you can attach here. Attachable now: ${avail}.` }
    }
    let file: MaterializedAttachment
    try {
      // The remaining budget, not the whole cap — three 8 MB files must not each
      // pass a per-file check and then blow the total.
      file = await materializeSendable(hit, MAX_OUTBOUND_ATTACHMENT_BYTES - materializedBytes)
    } catch (err) {
      // Whatever was already copied for THIS draft is now unreachable — no row
      // will ever reference it. Drop it rather than leaving client documents
      // accumulating in the bucket for a send that never happened.
      await discardCopies(resolved)
      if (err instanceof SendableRefusal) return { ok: false, message: `❌ ${err.message}` }
      console.error("[worker-email-send] materialize failed:", err)
      return { ok: false, message: `❌ "${hit.name}" couldn't be prepared for sending — please try again.` }
    }
    materializedBytes += file.size ?? 0
    if (materializedBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      await discardCopies([...resolved, file])
      return {
        ok: false,
        message: `❌ Too large to email: ${mb(materializedBytes)} of attachments (Gmail's limit is what binds here, ~${mb(MAX_OUTBOUND_ATTACHMENT_BYTES)} of files). I can send it without the largest one.`,
      }
    }
    resolved.push(file)
  }

  // AN EMAIL THAT MIXES TWO CLIENTS' FILES. No single file's own warning can see
  // this — each one is individually fine, and on a screen with no client pinned
  // (the Inbox, a team channel) the per-file mismatch check cannot fire at all.
  // Comparing the owners of what is actually going out works on every surface,
  // which is the point: the flagship flow for this feature is replying to an
  // accountant from the Inbox with a client's document attached.
  // Compared by CLIENT KEY, not by name: a company and the person behind it have
  // different names and are the same client, so comparing labels would flag
  // "the company's articles + the owner's ITIN letter" — an everyday, correct
  // email — as a mix. And the note goes only on the files that HAVE an owner: a
  // staff member does not need to be told that the PDF they dropped in
  // themselves thirty seconds ago belongs to somebody else.
  const owned = resolved.filter((r) => r.ownerKey)
  const distinctClients = new Set(owned.map((r) => r.ownerKey))
  if (distinctClients.size > 1) {
    const names = Array.from(new Set(owned.map((r) => r.ownerLabel).filter((o): o is string => Boolean(o))))
    const note = `⚠️ These files belong to different clients (${names.join(", ")}). Check that is deliberate before you send.`
    for (const r of owned) r.warning = r.warning ? `${r.warning} ${note}` : note
  }

  // Freeze the exact payload the staff will confirm.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("worker_prepared_sends")
    .insert({
      thread_uuid: input.threadUuid,
      kind: "email",
      gmail_thread_id: input.gmailThreadId ?? null,
      mailbox: input.mailbox,
      reply_to_message_id: input.replyToMessageId ?? null,
      to_address: input.to,
      subject: input.subject,
      body: input.body,
      attachments: resolved.map((r) => ({
        path: r.path,
        name: r.name,
        content_type: r.content_type,
        size: r.size,
        // Provenance travels with the frozen file so the Confirm card can say
        // where each one came from. A filename alone cannot be checked.
        origin: r.origin,
        // And the loud line, when there is one (someone else's document, or one
        // we hold back from clients). Antonio's rule is warn-never-block, which
        // only works if the warning survives all the way to the card.
        warning: r.warning,
        // Whose file it is, and whether the object is a copy WE made — the
        // latter is what makes cleanup safe (a panel upload must never be
        // deleted out from under the staff member's own panel).
        owner_label: r.ownerLabel,
        copied: r.copied,
      })),
      actor: input.actor,
      status: "pending",
    })
    .select("id")
    .single()
  if (error || !data) {
    // No row will ever reference these copies — drop them rather than leave
    // client documents in the bucket for a draft that does not exist.
    await discardCopies(resolved)
    console.error("[worker-email-send] prepare insert failed:", error)
    return { ok: false, message: "❌ Couldn't prepare the email — please try again." }
  }

  await supersedeEarlierDrafts({ threadUuid: input.threadUuid, actor: input.actor, kind: "email", keepId: data.id })

  // "(0.0 MB)" is a lie when no size is known — say nothing rather than zero.
  const fileList = resolved.map((r) => (typeof r.size === "number" ? `${r.name} (${mb(r.size)})` : r.name)).join(", ")
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
    // Expiry is the routine way a draft dies (30 minutes), so this is the most
    // common orphan of all.
    await discardCopies(claimed.attachments as Array<{ path?: string; copied?: boolean }>)
    return { ok: false, reason: "This draft is too old to send — ask the worker to prepare it again." }
  }

  try {
    const { gmailGet, gmailPost, getHeader } = await import("@/lib/gmail")
    const { plainTextToParagraphs } = await import("@/lib/operations/email")

    const sender =
      SENDERS[claimed.mailbox] ?? SENDERS[SIGNATURE_MAILBOX_ADDRESSES.support]

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
          await discardCopies(claimed.attachments as Array<{ path?: string; copied?: boolean }>)
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

    // Branded HTML — same shell the worker's text sends use. This block and
    // the one in lib/ai-agent/tools.ts were byte-identical copies of a
    // hand-rolled banner + sign-off + footer; both now call the single
    // definition in lib/email/signature.ts. Sign-off stays ON here: the
    // model writes no closing of its own.
    const signature = buildSignature({
      sender: signatureSenderForAddress(sender.email),
      variant: DEFAULT_SIGNATURE_VARIANT,
    })
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
${plainTextToParagraphs(claimed.body)}
${signature.html}
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
      // Both halves signed — an HTML-only signature is the drift the shared
      // module exists to prevent (bug hunter, 2026-08-05): plain-text readers
      // got an unsigned message, and html/text divergence scores with filters.
      {
        headerLines,
        htmlBody: html,
        plainText: `${claimed.body}\n\n${signature.text}`,
        attachments: files,
      },
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
    // ONLY on a terminal failure. A transient one rolls the row back to pending
    // so the staff member can retry — deleting its bytes would make every retry
    // fail for a reason nobody could see.
    if (terminal) await discardCopies(claimed.attachments as Array<{ path?: string; copied?: boolean }>)
    console.error("[worker-email-send] confirm/dispatch failed before send:", err)
    return { ok: false, reason: err instanceof Error ? err.message : "send failed" }
  }
}

/* ------------------------------------------------------------------------- *
 * WHICH FROZEN ROW BELONGS TO THIS TURN
 *
 * A conversation is SHARED. In Team Chat `thread_uuid` is the whole channel; on
 * the Inbox and client-chat panels it is the email thread / the client, and two
 * staff can have that same screen open. So "the newest pending row on this
 * conversation" is not this turn's row — under two overlapping turns it pairs one
 * person's answer with the OTHER person's frozen email, and the second draft never
 * gets a card at all (it dies at its TTL, silently).
 *
 * The row records WHO froze it, and every surface attributes its actor per staff
 * member. So the pairing rule is: this actor's pending rows, minus the ones that
 * were already pending when the turn began. That is exactly the set this turn
 * created, and it is the same scope prepareWorkerEmailSend supersedes on — so the
 * two can never disagree about whose draft is whose.
 *
 * Two turns by the SAME person overlapping is already handled upstream: the second
 * freeze supersedes the first, so only one row of theirs is ever pending.
 * ------------------------------------------------------------------------- */

/**
 * A frozen draft, as the surfaces render it on the card.
 *
 * `to_address` / `subject` are NULLABLE and that is deliberate, not sloppiness: a
 * PORTAL draft has neither (the database refuses to store them — see the
 * `worker_prepared_sends_kind_shape` constraint). Typing them as `string` was a lie the
 * moment the portal kind existed, and the lie is what lets a surface render a portal
 * draft as "Email <nothing>" with a mailbox picker. Every consumer must branch on
 * `kind` first; the nullability is what makes the compiler force that.
 */
export interface FrozenDraft {
  id: string
  kind: PreparedSendKind
  to_address: string | null
  subject: string | null
  body: string | null
  /**
   * The files that will actually go out.
   *
   * `content_type` and `origin` are carried so the card can render the FILE —
   * an image as the image, anything else as a tile you can click open — and say
   * where it came from. A card that prints a filename and nothing else asks the
   * human to approve a string; with sources wider than "the file you just
   * dropped in", the string is the one thing they can no longer verify.
   *
   * `path` is deliberately NOT here: the storage location never leaves the
   * server. The card addresses a file by its INDEX in this array.
   */
  attachments: Array<{ name: string; size?: number; content_type?: string; origin?: string; warning?: string }>
  /** Portal only — the client the staff member will confirm this against, if the worker proposed one. */
  proposed_account_id?: string | null
  proposed_contact_id?: string | null
  /** Portal only — the language the staff member picked on the card ("en" | "it"). */
  draft_locale?: string | null
}

/**
 * Ids of THIS actor's drafts that were already pending before the turn ran.
 *
 * `known: false` means the lookup failed and this turn's draft cannot be told
 * apart from an older one. Callers must then suppress the card rather than risk
 * showing a stale (or someone else's) draft — no card is the safe direction.
 */
export async function snapshotPendingPreparedIds(
  threadUuid: string,
  actor: string,
): Promise<{ ids: Set<string>; known: boolean }> {
  const ids = new Set<string>()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("worker_prepared_sends")
      .select("id")
      .eq("thread_uuid", threadUuid)
      .eq("actor", actor)
      .eq("status", "pending")
    if (error) return { ids, known: false }
    for (const r of (data ?? []) as Array<{ id: string }>) ids.add(r.id)
    return { ids, known: true }
  } catch {
    return { ids, known: false }
  }
}

/**
 * The draft THIS turn froze, or null. Oldest-first among the actor's own new rows:
 * a turn can only freeze one (the executor's per-turn latch), so this is that one.
 */
export async function findPreparedFrozenThisTurn(
  threadUuid: string,
  actor: string,
  prior: { ids: Set<string>; known: boolean },
): Promise<FrozenDraft | null> {
  if (!prior.known) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("worker_prepared_sends")
    .select("id, kind, to_address, subject, body, attachments, proposed_account_id, proposed_contact_id, draft_locale")
    .eq("thread_uuid", threadUuid)
    .eq("actor", actor)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
  if (error) throw new Error(error.message)
  const row = ((data ?? []) as FrozenDraft[]).find((r) => !prior.ids.has(r.id))
  if (!row) return null
  // Strip the storage path, keep everything the card must render. Widening this
  // map is what makes the tiles real — the previous narrow map is exactly how a
  // card can show NOTHING while the frozen row carries files.
  return {
    ...row,
    attachments: (row.attachments ?? []).map((a) => ({
      name: a.name,
      size: a.size,
      content_type: a.content_type,
      origin: a.origin,
      warning: a.warning,
    })),
  }
}

/**
 * Cancel whatever this turn froze — for the failure paths, where the draft would
 * otherwise sit pending with no card ever rendered for it.
 *
 * Actor-scoped for the same reason as the pairing: an unscoped cancel would kill a
 * teammate's live, un-confirmed draft because their row happens to share the
 * conversation and postdate this turn's snapshot.
 */
export async function cancelPreparedFrozenThisTurn(
  threadUuid: string,
  actor: string,
  prior: { ids: Set<string>; known: boolean },
): Promise<void> {
  if (!prior.known) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data } = await db
      .from("worker_prepared_sends")
      .select("id, attachments")
      .eq("thread_uuid", threadUuid)
      .eq("actor", actor)
      .eq("status", "pending")
    const rows = ((data ?? []) as Array<{ id: string; attachments?: Array<{ path?: string; copied?: boolean }> }>)
      .filter((r) => !prior.ids.has(r.id))
    if (!rows.length) return
    // Discard from what the guarded UPDATE actually cancelled, NOT from the
    // SELECT: a row claimed by a concurrent confirm in between would otherwise
    // have its bytes deleted out from under a send that is still running, and
    // the retry after that failure could never succeed.
    const { data: cancelled } = await db
      .from("worker_prepared_sends")
      .update({ status: "cancelled" })
      .in("id", rows.map((r) => r.id))
      .eq("status", "pending")
      .select("attachments")
    for (const r of (cancelled ?? []) as Array<{ attachments?: Array<{ path?: string; copied?: boolean }> }>) {
      await discardCopies(r.attachments)
    }
  } catch {
    // Best-effort — this runs on an error path already.
  }
}
