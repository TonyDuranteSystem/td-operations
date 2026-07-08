import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { callWorker } from "@/lib/ai-agent/worker-tools"
import {
  buildWorkerSurfacePrompt,
  buildInboxWorkerUserBody,
  buildClientWorkerUserBody,
  type InboxEmailContext,
} from "@/lib/ai-agent/inbox-worker-prompt"

export const dynamic = "force-dynamic"
// Worker runs a multi-step tool loop over the DB/CRM — can take minutes.
export const maxDuration = 300

/**
 * POST /api/inbox/worker-chat — the Slack worker, embedded in the Inbox.
 *
 * Same engine as Slack (`callWorker`): read-only WORKER_TOOLS + memory
 * recall + propose_action, Slack persona with an inbox surface override.
 * Persistent conversation memory per email thread via
 * threadId `inbox-<mailbox>-<gmailThreadId>` (reopening the same email
 * continues the same worker conversation, with full recall).
 *
 * Body: { message, gmailThreadId, mailbox?, context? (first turn only) }
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  let body: {
    message?: string
    // Inbox mode — per email thread
    gmailThreadId?: string
    mailbox?: string
    context?: InboxEmailContext | null
    // Client mode (portal-chats Worker tab) — per client
    clientKey?: string
    clientName?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const message = body.message?.trim()
  const gmailThreadId = body.gmailThreadId?.trim()
  const clientKey = body.clientKey?.trim()
  if (!message || (!gmailThreadId && !clientKey)) {
    return NextResponse.json(
      { error: "message and gmailThreadId or clientKey are required" },
      { status: 400 }
    )
  }

  let threadId: string
  let userBody: string
  let surface: "inbox" | "portal-chats"

  if (gmailThreadId) {
    // Discussing an antonio@ thread exposes its content — same admin-only
    // gate as every other inbox surface.
    if (!(await checkMailboxAccess(body.mailbox))) {
      return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
    }
    const mailboxKey = body.mailbox === "antonio" ? "antonio" : "support"
    threadId = `inbox-${mailboxKey}-${gmailThreadId}`
    userBody = buildInboxWorkerUserBody(message, body.context ?? null)
    surface = "inbox"
  } else {
    // clientKey: 'acct-<uuid>' | 'contact-<uuid>' — a per-client memory
    // namespace for the portal-chats Worker tab (the worker itself is
    // read-only; staff auth above is the ACL).
    if (!/^(acct|contact)-[0-9a-f-]{10,}$/i.test(clientKey!)) {
      return NextResponse.json({ error: "Invalid clientKey" }, { status: 400 })
    }
    threadId = `chat-${clientKey}`
    userBody = buildClientWorkerUserBody(message, { name: body.clientName })
    surface = "portal-chats"
  }

  try {
    const { reply } = await callWorker(userBody, {
      threadId,
      systemPromptOverride: buildWorkerSurfacePrompt(surface),
    })
    return NextResponse.json({ reply, threadId })
  } catch (error) {
    console.error("[worker-chat] failed:", error)
    const detail = error instanceof Error ? error.message : "Worker failed"
    return NextResponse.json({ error: detail }, { status: 500 })
  }
}
