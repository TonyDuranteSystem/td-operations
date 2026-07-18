import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin, isClient } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { deterministicThreadUuid, buildWorkerSurfacePrompt } from '@/lib/ai-agent/inbox-worker-prompt'
import { parseSidebarClientKey } from '@/lib/ai-agent/sidebar-scope'
import { NextRequest, NextResponse } from 'next/server'

/**
 * The sidebar assistant IS the worker (Business Brain D2) when this flag is on.
 * OFF by default — the sidebar keeps its old Claude+GPT-4o agent until Antonio
 * flips WORKER_SIDEBAR_ENABLED=true. When on: same engine as Slack/Inbox
 * (callWorker) — full read rails, the shared brain (global + per-page-client
 * recall), discuss-first; the old silent direct-writes are dropped.
 */
function sidebarWorkerEnabled(): boolean {
  return process.env.WORKER_SIDEBAR_ENABLED === 'true'
}

/**
 * POST /api/ai-agent
 * AI agent for dashboard users. Default: Claude (primary) + GPT-4o (fallback).
 * With WORKER_SIDEBAR_ENABLED=true: the full worker (callWorker), same as Slack/Inbox.
 * Admin always has access. Team members require ai_agent.enabled_for_team = true in app_settings.
 * Body: { messages: [...], conversationId?, clientKey?, attachment? }
 * Returns: { content: string, provider: string, tools_used: string[] }
 */
export async function POST(request: NextRequest) {
  // Rate limit: 20 requests per minute
  const rl = checkRateLimit(getRateLimitKey(request) + ':ai-agent', 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 10) } }
    )
  }

  // Auth check: admin always allowed, team allowed if toggle is on, clients never
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || isClient(user)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  if (!isAdmin(user)) {
    // Team member — check if AI agent is enabled for team
    const { data: aiSetting } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'ai_agent')
      .single()
    if (!(aiSetting?.value as Record<string, unknown> | null)?.enabled_for_team) {
      return NextResponse.json({ error: 'AI Agent is not enabled for team members. Ask your admin to enable it in Team Management.' }, { status: 403 })
    }
  }

  const ALLOWED_ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/csv', 'text/plain']

  try {
    const { messages, provider: requestedProvider, attachment, conversationId, clientKey } = await request.json()

    if (!messages?.length || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'messages array required' }, { status: 400 })
    }

    // Validate and trim messages
    const validMessages = messages
      .filter((m: { role?: string; content?: string }) =>
        (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      )
      .map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content.slice(0, 10000),
      }))
      .slice(-20) // Keep last 20 messages for context

    if (validMessages.length === 0) {
      return NextResponse.json({ error: 'No valid messages provided' }, { status: 400 })
    }

    // WORKER PATH (D2): route the sidebar through the same worker as Slack/Inbox.
    // Text turns only for now — a turn WITH an attachment falls through to the old
    // engine (attachment support in the worker path is a fast follow). The worker
    // rebuilds conversation memory from agent_messages by thread, so we send only
    // the latest user turn and let the thread carry history.
    if (sidebarWorkerEnabled() && !attachment) {
      const lastUser = [...validMessages].reverse().find((m) => m.role === 'user')
      if (!lastUser) {
        return NextResponse.json({ error: 'No user message provided' }, { status: 400 })
      }
      return await runSidebarWorker({
        userId: user.id,
        userEmail: user.email ?? null,
        userBody: lastUser.content,
        conversationId: typeof conversationId === 'string' ? conversationId : null,
        clientKey: parseSidebarClientKey(clientKey),
      })
    }

    // Validate attachment if present
    let validAttachment: { name: string; type: string; base64: string } | undefined
    if (attachment) {
      if (!attachment.base64 || !attachment.type || !attachment.name) {
        return NextResponse.json({ error: 'Invalid attachment' }, { status: 400 })
      }
      if (!ALLOWED_ATTACHMENT_TYPES.includes(attachment.type)) {
        return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
      }
      // Max 10MB → ~13.3MB base64
      if (attachment.base64.length > 14_000_000) {
        return NextResponse.json({ error: 'Attachment too large (max 10MB)' }, { status: 400 })
      }
      validAttachment = { name: String(attachment.name), type: attachment.type, base64: attachment.base64 }
    }

    // Validate provider choice
    const forcedProvider = ['claude', 'openai'].includes(requestedProvider) ? requestedProvider : undefined

    // Lazy import to avoid loading providers at build time
    const { callAgent } = await import('@/lib/ai-agent/providers')
    const result = await callAgent(validMessages, forcedProvider, validAttachment)

    return NextResponse.json({
      content: result.reply,
      provider: result.provider,
      tools_used: result.toolsUsed,
    })
  } catch (err) {
    console.error('[ai-agent] Error:', err)
    const message = err instanceof Error ? err.message : 'Agent failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Run the sidebar turn through the worker (callWorker) with the dashboard prompt,
 * full read rails, and the shared brain. Persists the turn to agent_messages so
 * the worker has conversation memory (same mechanism as the Inbox/Portal panels).
 * recipient='worker' keeps these rows isolated from the Slack/Hermes crons.
 */
async function runSidebarWorker(args: {
  userId: string
  userEmail: string | null
  userBody: string
  conversationId: string | null
  clientKey: string | null
}): Promise<NextResponse> {
  const { userId, userEmail, userBody, conversationId, clientKey } = args
  // Per-conversation thread when the panel supplies an id (a "new chat" mints a
  // fresh one → fresh memory); otherwise a stable per-user thread.
  const scope = `dashboard-${userId}${conversationId ? `-${conversationId}` : ''}`
  const threadId = deterministicThreadUuid(scope)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Persist the turn (memory). Degrade to a memoryless turn if the insert fails.
  let rowId: string | null = null
  try {
    const { data: inserted } = await db
      .from('agent_messages')
      .insert({
        sender: 'crm',
        recipient: 'worker',
        subject: 'CRM assistant (sidebar)',
        body: userBody,
        status: 'processing',
        thread_id: threadId,
        context_json: {
          source: 'crm-worker',
          surface: 'dashboard',
          crm_scope_key: scope,
          user_message: userBody,
          ...(clientKey ? { client_key: clientKey } : {}),
          user_email: userEmail,
        },
      })
      .select('id')
      .single()
    rowId = inserted?.id ?? null
  } catch (err) {
    console.warn('[ai-agent] sidebar memory insert failed (memoryless turn):', err)
  }

  try {
    const { callWorker } = await import('@/lib/ai-agent/worker-tools')
    const { reply } = await callWorker(userBody, {
      threadId,
      ...(rowId ? { messageId: rowId } : {}),
      systemPromptOverride: buildWorkerSurfacePrompt('dashboard'),
      // Full Slack-parity READ rails. No send rail here yet (sidebar is look-up +
      // draft for now; a gated send rail is a deliberate follow-up). The old
      // silent direct-writes (create_task/update_contact/…) are gone by
      // construction — the worker never had them.
      enableDbRead: true,
      enableDocReads: true,
      enableCallReads: true,
      enableCalendly: true,
      enableClientThreadRead: true,
      enableThreadRecall: true,
      enableWebSearch: true,
      maxIterations: 20,
      // Per-page client scope → the brain recalls this client's own lessons and
      // any save is scoped to them. Derived from the live route each turn.
      ...(clientKey ? { clientKey } : {}),
    })
    if (rowId) await db.from('agent_messages').update({ reply, status: 'done' }).eq('id', rowId)
    return NextResponse.json({ content: reply, provider: 'worker', tools_used: [] })
  } catch (err) {
    if (rowId) {
      await db
        .from('agent_messages')
        .update({ status: 'failed', reply: err instanceof Error ? err.message : 'failed' })
        .eq('id', rowId)
        .then(() => {}, () => {})
    }
    console.error('[ai-agent] sidebar worker failed:', err)
    const message = err instanceof Error ? err.message : 'Assistant failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// 300s timeout: the worker path runs a multi-step tool loop (same as the Inbox
// worker). The old provider path was well under 60s, but they share this route.
export const maxDuration = 300
