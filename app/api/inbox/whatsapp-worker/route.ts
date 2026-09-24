import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { callWorkerWithAttachments } from "@/lib/ai-agent/attachment-reader"
import { SLACK_WORKER_SYSTEM_PROMPT } from "@/lib/ai-agent/slack-claude"
import { deterministicThreadUuid } from "@/lib/ai-agent/inbox-worker-prompt"
import { explainWorkerFailure } from "@/lib/ai-agent/transient-errors"
import { jidToE164 } from "@/lib/messaging/phone"
import {
  WHATSAPP_WORKER_SURFACE,
  buildIdentityBlock,
  buildWhatsAppSystemPrompt,
  buildWhatsAppWorkerOptions,
  formatTranscript,
  isGroupChat,
  type WhatsAppMessageRow,
} from "@/lib/inbox/whatsapp-worker-context"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_QUESTION_CHARS = 4000
const HISTORY_ROWS = 30
// Longer than maxDuration (300s): a turn that is still legitimately running must never be swept.
const STALE_TURN_MS = 6 * 60 * 1000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const scopeFor = (groupId: string) => `whatsapp-${groupId}`

type ChatBasics = {
  group: { id: string; group_name: string | null; external_group_id: string | null; group_type: string | null }
  isGroup: boolean
  leadName: string | null
  contactName: string | null
  accountName: string | null
  languageOnFile: string | null
}

/** The chat's verified identity, read from the database — never taken from the client. */
async function loadChatBasics(groupId: string): Promise<{ error: NextResponse } | { chat: ChatBasics }> {
  const { data: group } = await db
    .from("messaging_groups")
    .select("id, group_name, external_group_id, group_type, lead_id, contact_id, account_id, channel_id")
    .eq("id", groupId)
    .maybeSingle()
  if (!group) return { error: NextResponse.json({ error: "Conversation not found." }, { status: 404 }) }

  const { data: channel } = await db.from("messaging_channels").select("platform").eq("id", group.channel_id).maybeSingle()
  if (channel?.platform !== "whatsapp") {
    return { error: NextResponse.json({ error: "The Worker is only available on WhatsApp conversations." }, { status: 400 }) }
  }

  const [lead, contact, account] = await Promise.all([
    group.lead_id ? db.from("leads").select("full_name, language").eq("id", group.lead_id).maybeSingle() : null,
    group.contact_id ? db.from("contacts").select("full_name, language").eq("id", group.contact_id).maybeSingle() : null,
    group.account_id ? db.from("accounts").select("company_name").eq("id", group.account_id).maybeSingle() : null,
  ])
  return {
    chat: {
      group,
      isGroup: isGroupChat(group.external_group_id, group.group_type),
      leadName: lead?.data?.full_name ?? null,
      contactName: contact?.data?.full_name ?? null,
      accountName: account?.data?.company_name ?? null,
      languageOnFile: lead?.data?.language ?? contact?.data?.language ?? null,
    },
  }
}

/** GET — the recorded conversation for this chat, so reopening the panel continues it. */
export async function GET(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const groupId = req.nextUrl.searchParams.get("groupId")?.trim() ?? ""
  if (!UUID.test(groupId)) return NextResponse.json({ error: "groupId required" }, { status: 400 })

  const loaded = await loadChatBasics(groupId)
  if ("error" in loaded) return loaded.error
  const { chat } = loaded

  const threadId = deterministicThreadUuid(scopeFor(groupId))
  const { data } = await db
    .from("agent_messages")
    .select("id, body, reply, status, context_json, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(60)

  const turns = ((data ?? []) as Array<{
    id: string
    body: string
    reply: string | null
    status: string
    context_json: { user_message?: string } | null
    created_at: string
  }>).map((r) => ({
    id: r.id,
    user: r.context_json?.user_message ?? r.body,
    worker: r.status === "failed" ? null : r.reply,
    created_at: r.created_at,
  }))

  return NextResponse.json({
    threadId,
    turns,
    chat: {
      name: chat.group.group_name ?? null,
      isGroup: chat.isGroup,
      leadName: chat.leadName,
      contactName: chat.contactName,
      accountName: chat.accountName,
    },
  })
}

/**
 * POST — one Worker turn about the open WhatsApp chat. READ-ONLY: the options come from
 * buildWhatsAppWorkerOptions() and nothing else, so no send or write tool is ever loaded.
 * Identity and transcript are rebuilt from the database on every turn (never trusted from
 * the client) and travel in the per-call system prompt, not in the stored question.
 */
export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  let body: { groupId?: string; message?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const groupId = body.groupId?.trim() ?? ""
  const message = body.message?.trim() ?? ""
  if (!UUID.test(groupId) || !message) {
    return NextResponse.json({ error: "groupId and message are required" }, { status: 400 })
  }
  if (message.length > MAX_QUESTION_CHARS) {
    return NextResponse.json({ error: `Message is too long (max ${MAX_QUESTION_CHARS} characters).` }, { status: 400 })
  }

  const loaded = await loadChatBasics(groupId)
  if ("error" in loaded) return loaded.error
  const { chat } = loaded
  const { group, isGroup } = chat

  const history = await db
    .from("messages")
    .select("direction, content_text, content_type, sender_name, sender_phone, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_ROWS)

  const identity = buildIdentityBlock({
    groupName: group.group_name ?? null,
    phone: !isGroup && group.external_group_id ? jidToE164(group.external_group_id) : null,
    isGroup,
    leadName: chat.leadName,
    contactName: chat.contactName,
    accountName: chat.accountName,
    languageOnFile: chat.languageOnFile,
  })
  const historyRows = (history?.data ?? []) as WhatsAppMessageRow[]
  const transcript = formatTranscript(historyRows, { isGroup, moreExist: historyRows.length >= HISTORY_ROWS })
  const systemPromptOverride = buildWhatsAppSystemPrompt(SLACK_WORKER_SYSTEM_PROMPT, { identity, transcript })

  const scope = scopeFor(groupId)
  const threadId = deterministicThreadUuid(scope)
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // One in-flight turn per chat (uq_worker_inflight_per_thread). Recover a crashed turn first:
  // nothing reclaims recipient='worker' rows, so a turn that died would block the chat forever.
  try {
    await db
      .from("agent_messages")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("thread_id", threadId)
      .eq("recipient", "worker")
      .eq("status", "processing")
      .lt("created_at", new Date(Date.now() - STALE_TURN_MS).toISOString())
  } catch (err) {
    console.warn("[whatsapp-worker] stale in-flight sweep failed (non-fatal):", err)
  }

  const { data: inserted, error: insertError } = await db
    .from("agent_messages")
    .insert({
      sender: "crm",
      recipient: "worker",
      subject: `WhatsApp: ${(group.group_name ?? "chat").toString().slice(0, 80)}`,
      body: message,
      status: "processing",
      thread_id: threadId,
      context_json: {
        source: "crm-worker",
        surface: WHATSAPP_WORKER_SURFACE,
        crm_scope_key: scope,
        user_message: message,
        whatsapp_group_id: groupId,
        user_email: user?.email ?? null,
      },
    })
    .select("id")
    .single()
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "The assistant is still working on the previous message in this chat. Give it a moment and try again." },
        { status: 409 },
      )
    }
    console.error("[whatsapp-worker] agent_messages insert failed (memory degraded):", insertError)
  }
  const rowId: string | null = inserted?.id ?? null

  try {
    const { reply, reachedMaxLoops } = await callWorkerWithAttachments(message, {
      threadId,
      ...(rowId ? { messageId: rowId } : {}),
      systemPromptOverride,
      ...buildWhatsAppWorkerOptions(),
    })

    // The loop's own give-up text must never be offered as a draftable answer.
    if (reachedMaxLoops || !reply?.trim()) {
      if (rowId) await db.from("agent_messages").update({ status: "failed", reply: "ran out of steps" }).eq("id", rowId)
      return NextResponse.json(
        { error: "The assistant ran out of steps before it could answer. Try a narrower question." },
        { status: 502 },
      )
    }

    if (rowId) await db.from("agent_messages").update({ reply, status: "done" }).eq("id", rowId)
    return NextResponse.json({ reply, threadId, messageId: rowId })
  } catch (error) {
    if (rowId) {
      await db
        .from("agent_messages")
        .update({ status: "failed", reply: error instanceof Error ? error.message : "failed" })
        .eq("id", rowId)
        .then(() => {}, () => {})
    }
    console.error("[whatsapp-worker] failed:", error)
    return NextResponse.json({ error: explainWorkerFailure(error) }, { status: 500 })
  }
}
