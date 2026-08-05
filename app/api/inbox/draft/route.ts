import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { gmailGet, gmailPost, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import { buildReplyMime } from "@/lib/inbox/reply-mime"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import {
  buildSignature,
  hasSignature,
  parseSignatureVariant,
  signatureFromName,
  signatureSenderForAddress,
  DEFAULT_REPLY_SIGNATURE_VARIANT,
} from "@/lib/email/signature"

export const dynamic = "force-dynamic"

/**
 * Save a typed reply as a REAL Gmail draft, threaded to the conversation.
 *
 * Exists because the reply composer had no way to park a half-written reply
 * (Antonio's production QA, 2026-08-05): leaving the thread meant losing the
 * text. The draft lands in the mailbox's own Drafts folder — visible both in
 * Gmail and in the Inbox sidebar's Drafts view — so it can be finished and
 * sent from anywhere.
 *
 * The chosen signature is BAKED INTO the draft body: a draft may well be
 * finished and sent from Gmail's own UI, where our send path never runs, so
 * deferring the signature to send time would silently drop it.
 *
 * Deliberately TEXT-ONLY: staged upload attachments are not carried (the
 * staging area's files are transient and a silent partial save is worse than
 * a refusal). The UI disables Save draft while files are staged.
 */
export async function POST(req: NextRequest) {
  try {
    // Staff gate — a portal CLIENT has a login; this writes into TD mailboxes.
    const denied = await requireStaffRoute()
    if (denied) return denied

    const { conversationId, message, mailbox, signature_variant } =
      (await req.json()) as {
        conversationId?: string
        message?: string
        mailbox?: string
        signature_variant?: string
      }

    if (!conversationId?.startsWith("gmail:") || !message?.trim()) {
      return NextResponse.json(
        { error: "conversationId (gmail) and message are required" },
        { status: 400 }
      )
    }

    // Same admin-only gate as reply/compose: antonio@ is his PERSONAL mailbox.
    if (!(await checkMailboxAccess(mailbox))) {
      return NextResponse.json(
        { error: "Not authorized for this mailbox" },
        { status: 403 }
      )
    }

    // Thread IDs are mailbox-scoped: fetch AND save through the mailbox the
    // user is viewing, exactly like the reply route.
    const asUser =
      mailbox === "antonio"
        ? "antonio.durante@tonydurante.us"
        : "support@tonydurante.us"

    const threadId = conversationId.replace("gmail:", "")
    const thread = (await gmailGet(
      `/threads/${threadId}`,
      { format: "metadata", metadataHeaders: "From,Subject,Message-ID,References" },
      asUser
    )) as { messages: GmailAPIMessage[] }

    const lastMsg = thread.messages[thread.messages.length - 1]
    const from = getHeader(lastMsg.payload.headers, "From")
    const subject = getHeader(lastMsg.payload.headers, "Subject")
    const messageId = getHeader(lastMsg.payload.headers, "Message-ID")
    const references = getHeader(lastMsg.payload.headers, "References")

    const signatureSender = signatureSenderForAddress(asUser)
    const signatureVariant = parseSignatureVariant(
      signature_variant,
      DEFAULT_REPLY_SIGNATURE_VARIANT
    )
    const signature = hasSignature(signatureVariant)
      ? buildSignature({
          sender: signatureSender,
          variant: signatureVariant,
          includeSignoff: false,
        })
      : undefined

    // Same builder as the real reply — the draft IS the reply, minus the
    // send. No quoted history: Gmail appends the quote itself when the draft
    // is opened in its own composer, and doubling it reads broken.
    const raw = buildReplyMime({
      asUser,
      replyTo: from,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      inReplyTo: messageId,
      references,
      message,
      lastBody: "",
      lastDate: "",
      lastFrom: from,
      signature,
      fromName: signatureFromName(signatureSender),
    })

    const result = (await gmailPost(
      "/drafts",
      { message: { raw: Buffer.from(raw).toString("base64url"), threadId } },
      asUser
    )) as { id: string; message?: { id: string } }

    return NextResponse.json({ success: true, draftId: result.id })
  } catch (error) {
    console.error("Save draft error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save draft" },
      { status: 500 }
    )
  }
}
