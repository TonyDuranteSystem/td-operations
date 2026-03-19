import { NextRequest, NextResponse } from "next/server"
import { gmailGet, gmailPost, getHeader, extractBody, type GmailAPIMessage } from "@/lib/gmail"

export const dynamic = "force-dynamic"

type EmailAction = "archive" | "star" | "unstar" | "trash" | "forward"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { threadId, action, forwardTo } = body as {
      threadId: string
      action: EmailAction
      forwardTo?: string // required for forward
    }

    if (!threadId || !action) {
      return NextResponse.json(
        { error: "threadId and action are required" },
        { status: 400 }
      )
    }

    switch (action) {
      case "archive": {
        // Remove INBOX label → archives the thread
        await gmailPost(`/threads/${threadId}/modify`, {
          removeLabelIds: ["INBOX"],
        })
        return NextResponse.json({ success: true, action: "archived" })
      }

      case "star": {
        // Add STARRED label to all messages in thread
        const thread = (await gmailGet(`/threads/${threadId}`, {
          format: "minimal",
        })) as { messages: Array<{ id: string }> }

        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, {
              addLabelIds: ["STARRED"],
            })
          )
        )
        return NextResponse.json({ success: true, action: "starred" })
      }

      case "unstar": {
        const thread = (await gmailGet(`/threads/${threadId}`, {
          format: "minimal",
        })) as { messages: Array<{ id: string }> }

        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, {
              removeLabelIds: ["STARRED"],
            })
          )
        )
        return NextResponse.json({ success: true, action: "unstarred" })
      }

      case "trash": {
        await gmailPost(`/threads/${threadId}/trash`, {})
        return NextResponse.json({ success: true, action: "trashed" })
      }

      case "forward": {
        if (!forwardTo) {
          return NextResponse.json(
            { error: "forwardTo is required for forward action" },
            { status: 400 }
          )
        }

        // Get the last message in thread to forward
        const fwdThread = (await gmailGet(`/threads/${threadId}`, {
          format: "full",
        })) as { messages: GmailAPIMessage[] }

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

        const fwdSubject = origSubject.startsWith("Fwd:")
          ? origSubject
          : `Fwd: ${origSubject}`

        const encodedFwdSubject = `=?utf-8?B?${Buffer.from(fwdSubject).toString("base64")}?=`
        const headers = [
          `From: support@tonydurante.us`,
          `To: ${forwardTo}`,
          `Subject: ${encodedFwdSubject}`,
          "Content-Type: text/plain; charset=utf-8",
        ]

        const raw = headers.join("\r\n") + "\r\n\r\n" + fwdBody
        const encodedRaw = Buffer.from(raw).toString("base64url")

        const result = await gmailPost("/messages/send", {
          raw: encodedRaw,
        })

        return NextResponse.json({
          success: true,
          action: "forwarded",
          messageId: (result as { id?: string }).id,
        })
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        )
    }
  } catch (error) {
    console.error("Email action error:", error)
    return NextResponse.json(
      { error: "Failed to perform email action" },
      { status: 500 }
    )
  }
}
