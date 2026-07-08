import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { callWorker } from "@/lib/ai-agent/worker-tools"
import { gmailGet, getHeader, extractBody, type GmailAPIMessage } from "@/lib/gmail"
import {
  buildWorkerSurfacePrompt,
  buildInboxWorkerUserBody,
  buildClientWorkerUserBody,
  displayUserMessage,
  deterministicThreadUuid,
  type InboxEmailContext,
} from "@/lib/ai-agent/inbox-worker-prompt"

export const dynamic = "force-dynamic"
// Worker runs a multi-step tool loop over the DB/CRM — can take minutes.
export const maxDuration = 300

/**
 * GET — conversation history for a worker thread (panel reopen restores the
 * chat, like opening a Slack thread). Same auth + mailbox gate as POST.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const gmailThreadId = req.nextUrl.searchParams.get("gmailThreadId")?.trim()
  const clientKey = req.nextUrl.searchParams.get("clientKey")?.trim()
  const mailbox = req.nextUrl.searchParams.get("mailbox")
  if (!gmailThreadId && !clientKey) {
    return NextResponse.json({ error: "gmailThreadId or clientKey required" }, { status: 400 })
  }
  if (gmailThreadId && !(await checkMailboxAccess(mailbox))) {
    return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
  }

  // agent_messages.thread_id is a UUID column — derive it from the scope
  // string (same email/client → same thread forever).
  const scope = gmailThreadId
    ? `inbox-${mailbox === "antonio" ? "antonio" : "support"}-${gmailThreadId}`
    : `chat-${clientKey}`
  const threadId = deterministicThreadUuid(scope)

  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data } = await db
    .from("agent_messages")
    .select("id, body, reply, status, context_json, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(60)

  const turns = ((data ?? []) as Array<{
    body: string
    reply: string | null
    status: string
    context_json: unknown
    created_at: string
  }>).map((r) => ({
    user: displayUserMessage(r.body, r.context_json),
    worker: r.status === "failed" ? null : r.reply,
    created_at: r.created_at,
  }))

  return NextResponse.json({ threadId, turns })
}

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

  let scope: string
  let userBody: string
  let surface: "inbox" | "portal-chats"

  if (gmailThreadId) {
    // Discussing an antonio@ thread exposes its content — same admin-only
    // gate as every other inbox surface.
    if (!(await checkMailboxAccess(body.mailbox))) {
      return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
    }
    const mailboxKey = body.mailbox === "antonio" ? "antonio" : "support"
    const mailboxAddress = mailboxKey === "antonio"
      ? "antonio.durante@tonydurante.us"
      : "support@tonydurante.us"
    scope = `inbox-${mailboxKey}-${gmailThreadId}`

    // First turn (context present): READ THE EMAIL server-side — the worker
    // must have the thread in front of it, not a 100-char snippet (Antonio
    // 2026-07-08: "if I call it in an open email it must read the email").
    // Best-effort: a Gmail hiccup degrades to snippet context, never blocks.
    let context = body.context ?? null
    if (context) {
      try {
        const thread = (await gmailGet(`/threads/${gmailThreadId}`, { format: "full" }, mailboxAddress)) as {
          messages: GmailAPIMessage[]
        }
        const msgs = (thread.messages ?? []).slice(-5) // last 5 messages
        const transcript = msgs
          .map((m) => {
            const from = getHeader(m.payload?.headers, "From")
            const date = getHeader(m.payload?.headers, "Date")
            const text = extractBody(m.payload).slice(0, 3000)
            return `--- ${from} (${date}) ---\n${text}`
          })
          .join("\n\n")
        context = { ...context, transcript, gmailThreadId, mailboxAddress }
      } catch (err) {
        console.warn("[worker-chat] thread transcript fetch failed (using snippet):", err)
        context = { ...context, gmailThreadId, mailboxAddress }
      }
    }

    userBody = buildInboxWorkerUserBody(message, context)
    surface = "inbox"
  } else {
    // clientKey: 'acct-<uuid>' | 'contact-<uuid>' — a per-client memory
    // namespace for the portal-chats Worker tab (the worker itself is
    // read-only; staff auth above is the ACL).
    if (!/^(acct|contact)-[0-9a-f-]{10,}$/i.test(clientKey!)) {
      return NextResponse.json({ error: "Invalid clientKey" }, { status: 400 })
    }
    scope = `chat-${clientKey}`
    userBody = buildClientWorkerUserBody(message, { name: body.clientName })
    surface = "portal-chats"
  }

  // thread_id is a UUID column; same scope → same thread forever.
  const threadId = deterministicThreadUuid(scope)

  // RECORD the exchange as an agent_messages row — exactly like the Slack
  // pipeline. This is what feeds buildThreadContext ("CONVERSATION SO FAR")
  // and recall_conversation on later turns; without it the worker was
  // amnesiac between panel messages (Antonio 2026-07-08: "it must work how
  // it works in Slack").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let rowId: string | null = null
  {
    // sender/recipient use the agent_message_party enum ('crm' added by
    // migration 20260709-0200). Recipient 'worker' is claimed by NO cron
    // (Slack + dormant Hermes both claim recipient='claude' only), so these
    // rows stay isolated from the queues without touching the bridge
    // ("leave the bridge alone"). Thread context is keyed by thread_id only,
    // so memory is unaffected.
    const { data: inserted, error: insertError } = await db
      .from("agent_messages")
      .insert({
        sender: "crm",
        recipient: "worker",
        subject: body.context?.subject || body.clientName || `Worker chat (${surface})`,
        body: userBody,
        status: "processing",
        thread_id: threadId,
        context_json: {
          source: "crm-worker",
          surface,
          crm_scope_key: scope, // human-readable thread scope (thread_id is its UUID hash)
          user_message: message, // raw message for history display
          ...(gmailThreadId ? { gmail_thread_id: gmailThreadId, mailbox: body.mailbox ?? "support" } : {}),
          ...(clientKey ? { client_key: clientKey } : {}),
          user_email: user.email ?? null,
        },
      })
      .select("id")
      .single()
    if (insertError) {
      // supabase-js reports errors in the result, it does not throw — log
      // loudly, degrade to a memoryless turn rather than blocking the reply.
      console.error("[worker-chat] agent_messages insert failed (memory degraded):", insertError)
    }
    rowId = inserted?.id ?? null
  }

  // Per-surface SEND rail (Antonio 2026-07-08: "the same powerful worker I have
  // in Slack — when I say 'send it' it must send"). Scoped by surface so a screen
  // can only send through its natural channel:
  //   - Inbox  → email reply (enableEmailSend); replies in the open Gmail thread.
  //   - Portal Chats → portal-chat message (enableSlackSend), HARD-PINNED to the
  //     open client so the worker can never message anyone else.
  // Every send is attributed to the acting staff member (sendActor) in action_log.
  // These flags never touch WORKER_TOOLS, so the dormant Hermes worker is unaffected
  // (R108). Sending still requires the staff member's explicit "send it" (prompt).
  const actorEmail = user.email ?? "unknown"
  const sendRails =
    surface === "inbox"
      ? { enableEmailSend: true, sendActor: `crm-inbox:${actorEmail}` }
      : {
          enableSlackSend: true,
          sendActor: `crm-portal:${actorEmail}`,
          pinnedPortalRecipient: clientKey!.startsWith("acct-")
            ? { account_id: clientKey!.slice("acct-".length) }
            : { contact_id: clientKey!.slice("contact-".length) },
        }

  try {
    const { reply } = await callWorker(userBody, {
      threadId,
      ...(rowId ? { messageId: rowId } : {}),
      systemPromptOverride: buildWorkerSurfacePrompt(surface),
      // FULL SLACK-PARITY READ RAILS (Antonio 2026-07-08: "it must be able
      // to work how it works in Slack"). Same switches the Team Workspace
      // grants staff. The code-task rail stays OFF (Antonio-only, R111);
      // send is enabled per-surface via sendRails below.
      enableDbRead: true,
      enableDocReads: true,
      enableCallReads: true,
      enableCalendly: true,
      enableClientThreadRead: true,
      enableThreadRecall: true,
      enableWebSearch: true, // live only if WORKER_WEB_SEARCH_ENABLED
      maxIterations: 20,
      ...sendRails,
      ...(clientKey && body.clientName
        ? { clientKey, clientName: body.clientName }
        : {}),
    })
    if (rowId) {
      await db.from("agent_messages").update({ reply, status: "done" }).eq("id", rowId)
    }
    return NextResponse.json({ reply, threadId })
  } catch (error) {
    if (rowId) {
      await db
        .from("agent_messages")
        .update({ status: "failed", reply: error instanceof Error ? error.message : "failed" })
        .eq("id", rowId)
        .then(() => {}, () => {})
    }
    console.error("[worker-chat] failed:", error)
    const detail = error instanceof Error ? error.message : "Worker failed"
    return NextResponse.json({ error: detail }, { status: 500 })
  }
}
