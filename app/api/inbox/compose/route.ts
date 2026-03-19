import { NextRequest, NextResponse } from "next/server"
import { gmailPost } from "@/lib/gmail"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { to, subject, message, cc, bcc } = body as {
      to: string
      subject: string
      message: string
      cc?: string
      bcc?: string
    }

    if (!to || !subject || !message) {
      return NextResponse.json(
        { error: "to, subject, and message are required" },
        { status: 400 }
      )
    }

    // Build RFC 2822 message
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const headers = [
      `From: support@tonydurante.us`,
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      ...(bcc ? [`Bcc: ${bcc}`] : []),
      `Subject: ${encodedSubject}`,
      "Content-Type: text/plain; charset=utf-8",
    ]

    const raw = headers.join("\r\n") + "\r\n\r\n" + message
    const encodedRaw = Buffer.from(raw).toString("base64url")

    const result = await gmailPost("/messages/send", {
      raw: encodedRaw,
    })

    return NextResponse.json({
      success: true,
      messageId: (result as { id?: string }).id,
    })
  } catch (error) {
    console.error("Compose email error:", error)
    return NextResponse.json(
      { error: "Failed to send email" },
      { status: 500 }
    )
  }
}
