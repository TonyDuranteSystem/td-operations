import { NextRequest, NextResponse } from "next/server"
import { gmailGet, gmailPost, getHeader, extractBody, type GmailAPIMessage } from "@/lib/gmail"
import { buildReplyMime } from "@/lib/inbox/reply-mime"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { conversationId, message, channel, mailbox } = body as {
      conversationId: string
      message: string
      channel: "whatsapp" | "telegram" | "gmail"
      mailbox?: string
    }

    if (!conversationId || !message) {
      return NextResponse.json(
        { error: "conversationId and message are required" },
        { status: 400 }
      )
    }

    if (!(await checkMailboxAccess(mailbox))) {
      return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
    }

    // ─── Gmail reply ─────────────────────────────────
    if (channel === "gmail" || conversationId.startsWith("gmail:")) {
      const threadId = conversationId.replace("gmail:", "")

      // Thread IDs are mailbox-scoped: fetch AND send through the mailbox the
      // user is viewing, otherwise replies from antonio@ fail (thread not
      // found in support@) or go out from the wrong address.
      const asUser = mailbox === "antonio"
        ? "antonio.durante@tonydurante.us"
        : "support@tonydurante.us"

      // Get the last message in thread to reply to (full — we quote its body)
      const thread = (await gmailGet(`/threads/${threadId}`, {
        format: "full",
      }, asUser)) as { messages: GmailAPIMessage[] }

      const lastMsg = thread.messages[thread.messages.length - 1]
      const from = getHeader(lastMsg.payload.headers, "From")
      const subject = getHeader(lastMsg.payload.headers, "Subject")
      const messageId = getHeader(lastMsg.payload.headers, "Message-ID")
      const references = getHeader(lastMsg.payload.headers, "References")
      const lastDate = getHeader(lastMsg.payload.headers, "Date")

      // Build RFC 2822 reply
      const replyTo = from // Reply to whoever sent last message
      const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`

      // Quoting is best-effort — never block the reply on it
      let lastBody = ""
      try {
        lastBody = extractBody(lastMsg.payload).slice(0, 10000).trimEnd()
      } catch {
        lastBody = ""
      }

      // Gmail-parity MIME: multipart/alternative (plain + HTML), quoted
      // history, RFC 2047-encoded To/Subject. Pure builder — unit-tested in
      // tests/unit/reply-mime.test.ts.
      const raw = buildReplyMime({
        asUser,
        replyTo,
        subject: replySubject,
        inReplyTo: messageId,
        references,
        message,
        lastBody,
        lastDate,
        lastFrom: from,
      })
      const encodedRaw = Buffer.from(raw).toString("base64url")

      const result = await gmailPost("/messages/send", {
        raw: encodedRaw,
        threadId,
      }, asUser)

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
