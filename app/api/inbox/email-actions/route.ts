import { NextRequest, NextResponse } from "next/server"
import { gmailGet, gmailPost, getHeader, extractBody, type GmailAPIMessage } from "@/lib/gmail"

export const dynamic = "force-dynamic"

type EmailAction = "archive" | "star" | "unstar" | "trash" | "forward" | "mark_unread" | "move_to_label"

function resolveMailbox(mailbox?: string): string {
  return mailbox === 'antonio'
    ? 'antonio.durante@tonydurante.us'
    : 'support@tonydurante.us'
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { threadId, threadIds, action, forwardTo, labelId, bulk, mailbox } = body as {
      threadId?: string
      threadIds?: string[]
      action: EmailAction | 'mark_read'
      forwardTo?: string
      labelId?: string
      bulk?: boolean
      mailbox?: string
    }

    const asUser = resolveMailbox(mailbox)

    // Bulk operations
    if (bulk && threadIds?.length) {
      const results = await Promise.allSettled(
        threadIds.map(async (tid) => {
          if (action === 'trash') {
            await gmailPost(`/threads/${tid}/modify`, {
              addLabelIds: ["TRASH"],
              removeLabelIds: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"]
            }, asUser)
          } else if (action === 'archive') {
            await gmailPost(`/threads/${tid}/modify`, { removeLabelIds: ['INBOX'] }, asUser)
          } else if (action === 'mark_read') {
            const thread = (await gmailGet(`/threads/${tid}`, { format: 'minimal' }, asUser)) as { messages: Array<{ id: string }> }
            await Promise.all(
              thread.messages.map((m) =>
                gmailPost(`/messages/${m.id}/modify`, { removeLabelIds: ['UNREAD'] }, asUser)
              )
            )
          } else if (action === 'move_to_label' && labelId) {
            await gmailPost(`/threads/${tid}/modify`, { addLabelIds: [labelId] }, asUser)
          }
        })
      )
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      const failed = results.filter(r => r.status === 'rejected').length
      return NextResponse.json({ success: true, action, succeeded, failed, total: threadIds.length })
    }

    if (!threadId || !action) {
      return NextResponse.json(
        { error: "threadId and action are required" },
        { status: 400 }
      )
    }

    switch (action) {
      case "archive": {
        await gmailPost(`/threads/${threadId}/modify`, { removeLabelIds: ["INBOX"] }, asUser)
        return NextResponse.json({ success: true, action: "archived" })
      }

      case "star": {
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as { messages: Array<{ id: string }> }
        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, { addLabelIds: ["STARRED"] }, asUser)
          )
        )
        return NextResponse.json({ success: true, action: "starred" })
      }

      case "unstar": {
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as { messages: Array<{ id: string }> }
        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, { removeLabelIds: ["STARRED"] }, asUser)
          )
        )
        return NextResponse.json({ success: true, action: "unstarred" })
      }

      case "trash": {
        // Use modify instead of /trash endpoint — /trash is unreliable with Service Account DWD
        // Step 1: Remove from INBOX + add TRASH label via modify
        const modifyResult = await gmailPost(`/threads/${threadId}/modify`, {
          addLabelIds: ["TRASH"],
          removeLabelIds: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"]
        }, asUser) as { id?: string }

        // Step 2: Verify by fetching the thread and checking labels
        let verified = false
        try {
          const verifyThread = await gmailGet(`/threads/${threadId}`, { format: 'minimal' }, asUser) as {
            messages?: Array<{ labelIds?: string[] }>
          }
          const hasTrash = verifyThread.messages?.some(m => m.labelIds?.includes('TRASH'))
          const hasInbox = verifyThread.messages?.some(m => m.labelIds?.includes('INBOX'))
          verified = !!hasTrash && !hasInbox
          console.log(`[Inbox] Trash thread ${threadId}: TRASH=${hasTrash}, INBOX=${hasInbox}, verified=${verified}`)
        } catch {
          // Thread might not be accessible after trash — that's OK
          verified = true
        }

        return NextResponse.json({ success: true, action: "trashed", threadId: modifyResult.id, verified })
      }

      case "mark_unread": {
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as { messages: Array<{ id: string }> }
        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, { addLabelIds: ["UNREAD"] }, asUser)
          )
        )
        return NextResponse.json({ success: true, action: "marked_unread" })
      }

      case "move_to_label": {
        if (!labelId) {
          return NextResponse.json({ error: "labelId is required" }, { status: 400 })
        }
        await gmailPost(`/threads/${threadId}/modify`, { addLabelIds: [labelId] }, asUser)
        return NextResponse.json({ success: true, action: "labeled" })
      }

      case "forward": {
        if (!forwardTo) {
          return NextResponse.json({ error: "forwardTo is required for forward action" }, { status: 400 })
        }

        const fwdThread = (await gmailGet(`/threads/${threadId}`, { format: "full" }, asUser)) as { messages: GmailAPIMessage[] }
        const lastMsg = fwdThread.messages[fwdThread.messages.length - 1]
        const origFrom = getHeader(lastMsg.payload.headers, "From")
        const origSubject = getHeader(lastMsg.payload.headers, "Subject")
        const origDate = getHeader(lastMsg.payload.headers, "Date")
        const origBody = extractBody(lastMsg.payload)

        const fwdBody = [
          `---------- Forwarded message ----------`,
          `From: ${origFrom}`,
          `Date: ${origDate}`,
          `Subject: ${origSubject}`,
          ``,
          origBody.length > 5000 ? origBody.slice(0, 5000) + "..." : origBody,
        ].join("\n")

        const fwdSubject = origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`
        const encodedFwdSubject = `=?utf-8?B?${Buffer.from(fwdSubject).toString("base64")}?=`
        const fromAddr = asUser
        const headers = [
          `From: ${fromAddr}`,
          `To: ${forwardTo}`,
          `Subject: ${encodedFwdSubject}`,
          "Content-Type: text/plain; charset=utf-8",
        ]

        const raw = headers.join("\r\n") + "\r\n\r\n" + fwdBody
        const encodedRaw = Buffer.from(raw).toString("base64url")

        const result = await gmailPost("/messages/send", { raw: encodedRaw }, asUser)
        return NextResponse.json({
          success: true,
          action: "forwarded",
          messageId: (result as { id?: string }).id,
        })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error("Email action error:", error)
    return NextResponse.json({ error: "Failed to perform email action" }, { status: 500 })
  }
}
