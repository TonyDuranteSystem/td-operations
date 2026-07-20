import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin, isClient } from '@/lib/auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { deterministicThreadUuid, buildWorkerSurfacePrompt } from '@/lib/ai-agent/inbox-worker-prompt'
import { parseSidebarClientKey } from '@/lib/ai-agent/sidebar-scope'
import { fullReachEnabledFor } from '@/lib/ai-agent/full-reach'
import { workerActionsEnabled } from '@/lib/ai-agent/worker-actions-switch'
import { panelApprovalsEnabledFor, loadPendingActionCards } from '@/lib/ai-agent/panel-approvals'
import type { WorkerImageBlock, WorkerDocumentBlock } from '@/lib/ai-agent/worker-tools'
import { NextRequest, NextResponse } from 'next/server'

/**
 * The sidebar assistant IS the worker. Same engine as the Inbox, Portal Chats and
 * Team Chat: one brain, one discipline, one set of controls.
 *
 * Antonio, 2026-07-19: "the AI Agent on the sidebar must have the same capabilities.
 * It will be our AI engine to ask things for inside the CRM as we would do in Claude."
 * The sidebar is mounted on every dashboard page, so it is the primary surface, not a
 * lesser one.
 *
 * WHY THE OLD ENGINE IS GONE (dev job 17459c25): it dispatched whatever the model
 * emitted straight to the tool executor — no permission step, no recipient pin, no risk
 * classifier. `send_email` on that path reached real clients with nobody approving it,
 * on a panel present on every page. It is now read-only by construction (see
 * LEGACY_AGENT_BLOCKED_TOOLS) and reachable only via the escape hatch below.
 *
 * WORKER_SIDEBAR_LEGACY=true forces the old engine back for one deploy if the worker
 * path ever breaks in production. It is an emergency lever, not a supported mode — the
 * old engine cannot send or write any more, so falling back costs capability, not safety.
 */
function forceLegacySidebarEngine(): boolean {
  return process.env.WORKER_SIDEBAR_LEGACY === 'true'
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

    // Validate attachment if present. Shared by both engines — the worker path reads
    // it directly now rather than handing the turn to the old engine.
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

    // WORKER PATH — now the default, and now including attachment turns. Previously a
    // turn WITH a file fell through to the old engine, which is exactly the turn most
    // likely to end in "file this for me" on a panel that could act unasked.
    // The worker rebuilds conversation memory from its thread, so we send only the
    // latest user turn and let the thread carry the history.
    if (!forceLegacySidebarEngine()) {
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
        attachment: validAttachment,
      })
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
 * Build this turn's send rails from the page's client — re-resolved server-side.
 *
 * `clientKey` is posted by the browser. On a staff-only surface that is low risk, but it
 * is still the model-adjacent input that would aim a real client-facing send, so it is
 * never trusted as a pin directly: the id is looked up, and the rails are built from the
 * row that comes back. A key naming a client that does not exist yields no rails at all.
 *
 * Returns empty rails off a client page — no server fact names a recipient there, and an
 * unpinned send is one the server cannot check.
 */
async function buildSidebarSendRails(clientKey: string | null): Promise<{
  portal: { enableSlackSend?: true; pinnedPortalRecipient?: { account_id?: string; contact_id?: string } }
  email: { enableEmailSend?: true; pinnedEmailRecipients?: string[] }
  clientScope: import('@/lib/ai-agent/client-scope').ClientScope | null
  clientName: string | null
}> {
  const empty = { portal: {}, email: {}, clientScope: null, clientName: null } as const
  if (!clientKey) return empty

  const [kind, id] = clientKey.split(':')
  if ((kind !== 'account' && kind !== 'contact') || !id) return empty

  // Re-resolve. Existence here IS the authorization to pin to this client, and the name
  // that comes back is what the worker is told it can reach — both from the same row.
  let clientName: string | null = null
  if (kind === 'account') {
    const { data: acct } = await supabaseAdmin.from('accounts').select('id, company_name').eq('id', id).maybeSingle()
    if (!acct) return empty
    clientName = acct.company_name ?? null
  } else {
    const { data: contact } = await supabaseAdmin.from('contacts').select('id, full_name').eq('id', id).maybeSingle()
    if (!contact) return empty
    clientName = contact.full_name ?? null
  }

  // Addresses on file for this client. An empty list is DELIBERATELY still a pin — it
  // means "refuse every address", which is the safe reading. Dropping the rail instead
  // would leave the recipient unpinned, which is the opposite.
  const { data: contactRows } = await supabaseAdmin
    .from('contacts')
    .select('id, email')
    .or(kind === 'account' ? `account_id.eq.${id}` : `id.eq.${id}`)
  const addresses = Array.from(
    new Set(
      (contactRows ?? [])
        .map((c: { email: string | null }) => c.email)
        .filter((e): e is string => Boolean(e && e.includes('@'))),
    ),
  )

  const { buildClientScope } = await import('@/lib/ai-agent/client-scope')
  const relatedIds = (contactRows ?? []).map((c: { id: string }) => c.id)

  return {
    portal: {
      enableSlackSend: true,
      pinnedPortalRecipient: kind === 'account' ? { account_id: id } : { contact_id: id },
    },
    email: { enableEmailSend: true, pinnedEmailRecipients: addresses },
    clientScope: buildClientScope(clientKey, relatedIds),
    clientName,
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
  attachment?: { name: string; type: string; base64: string }
}): Promise<NextResponse> {
  const { userId, userEmail, conversationId, clientKey, attachment } = args
  let { userBody } = args
  // Per-conversation thread when the panel supplies an id (a "new chat" mints a
  // fresh one → fresh memory); otherwise a stable per-user thread.
  const scope = `dashboard-${userId}${conversationId ? `-${conversationId}` : ''}`
  const threadId = deterministicThreadUuid(scope)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Read the staff member's upload, if any. Images become vision blocks, scanned PDFs
  // become native document blocks, everything else is extracted to text and appended to
  // the body — the same treatment the Inbox and Team Chat give a dropped file.
  const media: { images: WorkerImageBlock[]; documents: WorkerDocumentBlock[] } = { images: [], documents: [] }
  if (attachment) {
    try {
      const { readAttachmentBuffer, capMediaBudget, fenceUntrustedContent } = await import(
        '@/lib/ai-agent/attachment-reader'
      )
      const buffer = Buffer.from(attachment.base64, 'base64')
      const read = await readAttachmentBuffer(buffer, { id: 'sidebar-upload', name: attachment.name, mimetype: attachment.type })
      if (read.kind === 'image') media.images.push(read.imageBlock)
      else if (read.kind === 'document') media.documents.push(read.documentBlock)
      else if (read.kind === 'text') {
        // Fenced: an uploaded file is data. A staff member can be forwarded a document
        // written by anyone, and this panel holds a live send rail.
        userBody = `${userBody}\n\n${fenceUntrustedContent(attachment.name, read.text)}`
      } else {
        userBody = `${userBody}\n\n${read.note}`
      }
      const capped = capMediaBudget(media.images, media.documents)
      media.images = capped.images
      media.documents = capped.documents
      if (capped.dropped.length) userBody = `${userBody}\n\n[Not attached: ${capped.dropped.join('; ')}.]`
    } catch (err) {
      console.warn('[ai-agent] sidebar attachment unreadable:', err)
      userBody = `${userBody}\n\n[The attached file "${attachment.name}" could not be read. Say so plainly rather than guessing at its contents.]`
    }
  }

  // Persist the turn (memory). Degrade to a memoryless turn if the insert fails.
  let rowId: string | null = null
  try {
    const { data: inserted, error: insertError } = await db
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
    // supabase-js RETURNS errors rather than throwing them, so a failed insert used to
    // slip past this catch and leave rowId null silently. That matters now: the send
    // idempotency marker is keyed on this row, and without it a retried turn re-sends.
    if (insertError) {
      console.error('[ai-agent] sidebar memory insert failed (memoryless turn):', insertError)
    }
    rowId = inserted?.id ?? null
  } catch (err) {
    console.warn('[ai-agent] sidebar memory insert threw (memoryless turn):', err)
  }

  // SEND RAILS, pinned server-side (dev job 17459c25 / Antonio 2026-07-19).
  //
  // The sidebar is the CRM's main assistant and must be able to act, but every send has
  // to be aimed by a server fact rather than by the model. The page's client is the only
  // such fact available here — and `clientKey` arrives from the BROWSER, so it is
  // re-resolved against the database below and the rails are built from the row that
  // comes back, never from the string that was posted.
  //
  // Off a client page there is no fact naming a recipient, so the send rails stay off.
  // That is not the finished state: arbitrary sends need the show-it-and-wait step
  // (parent job 74701b48), and until that exists an unpinned send is one the server
  // cannot check.
  const rails = await buildSidebarSendRails(clientKey)

  // WHO the client on this page actually is — name, language, services, addresses.
  // Without this the assistant holds a client-scoped boundary and a client-pinned send
  // rail while having no idea whose page it is on: it answered "I don't have a client in
  // context" while sitting on that client's account page, because the scope key is
  // plumbing the model never sees. Built from the same validated key as the pin, and
  // injected per-call as a system suffix — never persisted into the thread, so a stale
  // card cannot replay out of history.
  let clientCardSuffix = ''
  if (clientKey) {
    try {
      const { buildClientCardSuffix } = await import('@/lib/ai-agent/client-card')
      clientCardSuffix = await buildClientCardSuffix(clientKey)
    } catch (err) {
      console.warn('[ai-agent] client card build failed (answering without card):', err)
    }
  }

  try {
    const { callWorkerWithAttachments } = await import('@/lib/ai-agent/attachment-reader')
    const { reply, artifacts, pendingActions } = await callWorkerWithAttachments(userBody, {
      threadId,
      ...(rowId ? { messageId: rowId } : {}),
      // The capability statement is GENERATED from the very rails passed below, so what
      // the worker says it can do and what it can actually reach cannot drift apart.
      // Note an empty address list counts as CANNOT send: the pin refuses every address,
      // so offering to email a client with nothing on file would be a promise it cannot
      // keep — exactly the false-capability pattern this closes.
      systemPromptOverride: `${buildWorkerSurfacePrompt('dashboard', {
        canSendEmail: rails.email.enableEmailSend === true && (rails.email.pinnedEmailRecipients?.length ?? 0) > 0,
        canSendPortal: rails.portal.enableSlackSend === true,
        clientName: rails.clientName,
        // The real state of the action rail — so it never offers a queue that is off.
        // Either transport counts: the in-panel card (live) or the old rail (off).
        // Derived, never asserted — a hand-written "I can queue that" was the exact
        // false promise this pattern exists to prevent.
        canQueueApprovals: panelApprovalsEnabledFor('dashboard') || workerActionsEnabled(),
      })}${clientCardSuffix}`,
      surface: 'dashboard',
      // This panel renders confirmation cards, so actions are frozen for a click
      // instead of being described back for the staff member to redo by hand.
      panelSurface: 'dashboard',
      // Full read rails — parity with the Inbox, Portal Chats and Team Chat.
      enableDbRead: true,
      enableDocReads: true,
      enableCallReads: true,
      enableCalendly: true,
      enableClientThreadRead: true,
      enableThreadRecall: true,
      enableWebSearch: true,
      // Full catalog reach. Discovery only — what it may RUN is decided per call by
      // the reviewed allow-list in tool-risk; anything not on it asks first.
      enableFullToolReach: fullReachEnabledFor('dashboard'),
      maxIterations: 20,
      // Files the staff member dropped into the panel this turn.
      ...(media.images.length ? { images: media.images } : {}),
      ...(media.documents.length ? { documents: media.documents } : {}),
      // Client-facing sends, aimed by the server (see buildSidebarSendRails).
      ...rails.portal,
      ...rails.email,
      // WHO asked. Without it a send from here is logged as the generic worker and
      // "who told it to do that" has no answer.
      sendActor: `crm-sidebar:${userEmail ?? userId}`,
      // Server-enforced client boundary: on a client page the assistant may not look
      // up a DIFFERENT client. Note this is the control that was dead until this job —
      // it only works because the context builder now forwards it.
      ...(rails.clientScope ? { clientScope: rails.clientScope } : {}),
      // Per-page client scope → the brain recalls this client's own lessons and
      // any save is scoped to them. Derived from the live route each turn.
      ...(clientKey ? { clientKey } : {}),
    })
    if (rowId) await db.from('agent_messages').update({ reply, status: 'done' }).eq('id', rowId)
    // Files the worker produced go back as structured data, NOT left to the reply to
    // mention. The first live run generated the PDF and then dropped the link from its
    // own answer — the panel renders the download regardless of what it says.
    // Cards are loaded from the QUEUE ROW, never from what the model said it froze — the
    // staff member must be approving the payload that will actually run.
    const actionCards = await loadPendingActionCards((pendingActions ?? []).map((a) => a.id))
    return NextResponse.json({
      content: reply,
      provider: 'worker',
      tools_used: [],
      artifacts: artifacts ?? [],
      pendingActions: actionCards,
    })
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
