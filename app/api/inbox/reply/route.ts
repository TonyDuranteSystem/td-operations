import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { gmailPost, extractBody } from "@/lib/gmail"
import { buildReplyMime, type ReplyMimeAttachment } from "@/lib/inbox/reply-mime"
import { resolveReplyTarget, buildThreadQuotes, ReplyTargetError } from "@/lib/inbox/reply-target"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import {
  parseStagedAttachmentInputs,
  loadStagedEmailAttachments,
  deleteStagedEmailAttachments,
} from "@/lib/inbox/email-attachment-staging"
import {
  buildSignature,
  hasSignature,
  parseSignatureVariant,
  signatureFromName,
  signatureSenderForAddress,
  DEFAULT_REPLY_SIGNATURE_VARIANT,
} from "@/lib/email/signature"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  try {
    // Staff gate — middleware only guarantees "is logged in" for /api routes,
    // and a portal CLIENT has a login. Sends real mail through our mailboxes;
    // the 2026-07-21 invariant applies (council 2026-07-29).
    const denied = await requireStaffRoute()
    if (denied) return denied

    const body = await req.json()
    const { conversationId, message, channel, mailbox, signature_variant, messageId: targetMessageId, mode, to: toOverrideRaw, quoteMode: quoteModeRaw } = body as {
      conversationId: string
      message: string
      channel: "whatsapp" | "telegram" | "gmail"
      mailbox?: string
      /** "gala" | "hat" | "text". Replies default to text-only. */
      signature_variant?: string
      /** Which specific Gmail message this replies to — always sent by the
       *  current UI (explicit pick, or its own frozen default). Omitted only
       *  by an older client; see resolveReplyTarget's fallback. */
      messageId?: string
      mode?: "reply" | "replyAll"
      /** Staff edited the To field — replaces the resolved recipient(s) outright. */
      to?: string[]
      /** 'message' (default) | 'thread' | 'none' — how much to quote below the reply. */
      quoteMode?: string
    }
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const toOverride = Array.isArray(toOverrideRaw)
      ? toOverrideRaw.map((a) => String(a).trim().toLowerCase()).filter(Boolean)
      : undefined
    if (toOverride) {
      if (toOverride.length === 0) {
        return NextResponse.json({ error: "At least one recipient is required." }, { status: 400 })
      }
      const bad = toOverride.find((a) => !EMAIL_RE.test(a))
      if (bad) {
        return NextResponse.json({ error: `"${bad}" doesn't look like a valid email address.` }, { status: 400 })
      }
    }
    const quoteMode = quoteModeRaw === "thread" || quoteModeRaw === "none" ? quoteModeRaw : "message"

    if (!conversationId || !message) {
      return NextResponse.json(
        { error: "conversationId and message are required" },
        { status: 400 }
      )
    }

    // Staged file attachments (email only — the chat channels have their own
    // media pipeline and this route would silently drop the files otherwise).
    let stagedInputs: ReturnType<typeof parseStagedAttachmentInputs> = null
    try {
      stagedInputs = parseStagedAttachmentInputs((body as { attachments?: unknown }).attachments)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid attachments." },
        { status: 400 }
      )
    }
    const isGmail = channel === "gmail" || conversationId.startsWith("gmail:")
    if (stagedInputs && !isGmail) {
      return NextResponse.json(
        { error: "Attachments are only supported on email replies." },
        { status: 400 }
      )
    }

    if (!(await checkMailboxAccess(mailbox))) {
      return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
    }

    // ─── Gmail reply ─────────────────────────────────
    if (isGmail) {
      const threadId = conversationId.replace("gmail:", "")

      // Load staged attachments BEFORE any Gmail call — a missing/oversized
      // file must fail the whole reply up front, not after fetching the thread.
      let attachments: ReplyMimeAttachment[] | undefined
      if (stagedInputs) {
        try {
          const loaded = await loadStagedEmailAttachments(stagedInputs)
          attachments = loaded.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.content_type,
          }))
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Could not read an attachment." },
            { status: 400 }
          )
        }
      }

      // Thread IDs are mailbox-scoped: fetch AND send through the mailbox the
      // user is viewing, otherwise replies from antonio@ fail (thread not
      // found in support@) or go out from the wrong address.
      const asUser = mailbox === "antonio"
        ? "antonio.durante@tonydurante.us"
        : "support@tonydurante.us"

      // Resolve the ONE message this reply is actually answering — the
      // client's explicit pick, its own frozen default (skip our own
      // messages), or (older client only) the server's same default.
      // Every field below (recipient, subject, threading headers, quoted
      // body, Reply-All Cc list) comes from THIS message alone — never a
      // mix with the thread's literal newest message, which would reach
      // the right person but thread/quote incorrectly in Gmail.
      let target
      try {
        target = await resolveReplyTarget({ threadId, messageId: targetMessageId, mode, asUser, toOverride })
      } catch (err) {
        if (err instanceof ReplyTargetError) {
          return NextResponse.json({ error: err.message }, { status: err.status })
        }
        throw err
      }
      const { message: lastMsg, replyToAddresses, quotedFrom, subject, messageIdHeader: messageId, references, date: lastDate, cc } = target

      // Build RFC 2822 reply
      const replyTo = replyToAddresses.length === 1 ? replyToAddresses[0] : replyToAddresses
      const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`

      // Quoting is best-effort — never block the reply on it. 'thread' mode
      // pulls every OTHER message in the conversation (oldest-first); the
      // target message itself is excluded from that list since it's already
      // the single-message quote below/instead.
      let lastBody = ""
      let threadQuotes: Awaited<ReturnType<typeof buildThreadQuotes>> | undefined
      try {
        if (quoteMode === "thread") {
          threadQuotes = await buildThreadQuotes(threadId, asUser, lastMsg.id)
          lastBody = extractBody(lastMsg.payload).slice(0, 10000).trimEnd()
          threadQuotes.push({ from: quotedFrom, date: lastDate, body: lastBody })
        } else if (quoteMode === "message") {
          lastBody = extractBody(lastMsg.payload).slice(0, 10000).trimEnd()
        }
      } catch {
        lastBody = ""
        threadQuotes = undefined
      }

      // Gmail-parity MIME: multipart/alternative (plain + HTML), quoted
      // history, RFC 2047-encoded To/Subject. Pure builder — unit-tested in
      // tests/unit/reply-mime.test.ts.
      // The signature sits between the reply and the quoted history. Replies
      // default to TEXT ONLY so a portrait does not stack down a long thread
      // (Antonio, 2026-08-05); the composer can override per reply. The
      // sign-off is left off — the staff member writes their own closing.
      const signatureSender = signatureSenderForAddress(asUser)
      const signatureVariant = parseSignatureVariant(
        signature_variant,
        DEFAULT_REPLY_SIGNATURE_VARIANT
      )
      // On "none" the signature is omitted ENTIRELY rather than passed as an
      // empty pair — the MIME builder puts a blank-line separator around
      // whatever it is given, so an empty signature would still leave the
      // reply trailing two blank lines into the quoted history.
      const signature = hasSignature(signatureVariant)
        ? buildSignature({
            sender: signatureSender,
            variant: signatureVariant,
            includeSignoff: false,
          })
        : undefined

      const raw = buildReplyMime({
        asUser,
        replyTo,
        subject: replySubject,
        inReplyTo: messageId,
        references,
        message,
        lastBody,
        lastDate,
        lastFrom: quotedFrom,
        quoteMode,
        threadQuotes,
        attachments,
        signature,
        fromName: signatureFromName(signatureSender),
        cc,
      })
      const encodedRaw = Buffer.from(raw).toString("base64url")

      const result = await gmailPost("/messages/send", {
        raw: encodedRaw,
        threadId,
      }, asUser)

      // Send succeeded — clear the staged objects (best-effort; a failed send
      // above keeps them so a retry with the same paths still works).
      if (stagedInputs) {
        await deleteStagedEmailAttachments(stagedInputs.map((a) => a.path))
      }

      // Ensure thread stays in INBOX after reply (Gmail API may remove INBOX label)
      try {
        await gmailPost(`/threads/${threadId}/modify`, {
          addLabelIds: ['INBOX'],
        }, asUser)
      } catch {
        // Non-critical — thread was sent, just label may be wrong
      }

      return NextResponse.json({
        success: true,
        channel: "gmail",
        messageId: (result as { id?: string }).id,
      })
    }

    // ─── WhatsApp/Telegram via Edge Function ─────────
    // Get group info to find external_group_id
    const { supabaseAdmin } = await import("@/lib/supabase-admin")

    const { data: group } = await supabaseAdmin
      .from("messaging_groups")
      .select("external_group_id, channel_id")
      .eq("id", conversationId)
      .single()

    if (!group) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      )
    }

    const efUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-message`

    const response = await fetch(efUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        chat_id: group.external_group_id,
        message,
        channel_id: group.channel_id,
      }),
    })

    const result = await response.json()

    if (!response.ok) {
      return NextResponse.json(
        { error: "Send failed", details: result },
        { status: response.status }
      )
    }

    return NextResponse.json({
      success: true,
      channel: channel || "whatsapp",
      result,
    })
  } catch (error) {
    console.error("Inbox reply error:", error)
    return NextResponse.json(
      { error: "Failed to send reply" },
      { status: 500 }
    )
  }
}
