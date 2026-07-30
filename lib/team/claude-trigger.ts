/**
 * Team Workspace — @claude AI worker adapter (server-only).
 *
 * When a human @mentions claude in a team thread, we:
 *   1. insert a placeholder "…thinking" message authored by Claude (so the UI
 *      shows a pending bubble immediately), and
 *   2. fire a bounded direct-trigger to /api/team/claude/process, which runs the
 *      shared worker (callWorker) and rewrites the placeholder with the answer.
 *
 * This mirrors the Slack worker's direct-fire pattern (getInternalBaseUrl +
 * CRON_SECRET + short AbortController) so a long investigation keeps running
 * server-side after the send route returns.
 *
 * Loop-safety: only HUMAN-authored messages ever reach triggerClaudeReply (the
 * send route is the sole caller and Claude's own posts go in via the sentinel
 * sender, never through the send route). The processor also refuses to act on a
 * message authored by the Claude sentinel.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { TD_MAILBOXES } from '@/lib/inbox/email-recipients'
import { getInternalBaseUrl } from '@/lib/mcp/tools/agent-messages'
import { CLAUDE_SENDER_UUID, CLAUDE_SENDER_NAME, mentionsClaude } from '@/lib/team/workspace'
import { channelNotifiesStaff } from '@/lib/team/channel-notify'
import type { WorkerImageBlock, WorkerDocumentBlock } from '@/lib/ai-agent/worker-tools'
import { fullReachEnabledFor } from '@/lib/ai-agent/full-reach'
import { surfaceApiKeyOverride } from '@/lib/ai-agent/surface-api-key'
import { reportSystemError } from '@/lib/system-errors'

const THINKING_PLACEHOLDER = '…'

/**
 * Marks a placeholder as CLAIMED by a running processor (dev job 17459c25).
 *
 * The rescue cron re-fires any placeholder still showing THINKING_PLACEHOLDER after
 * STUCK_AFTER_MS. The old guard ("is the message still '…'?") was a read-then-check,
 * and during a still-running first pass the answer is yes — so a turn slower than 45s
 * got a SECOND worker running the same prompt. The write-side TOCTOU guard meant only
 * one reply landed, but both runs executed their tool calls in full. Harmless while
 * the tools are reads; duplicate client sends and duplicate Drive uploads once they
 * are not.
 *
 * Claiming is therefore an atomic compare-and-set on the message itself, matching how
 * the rest of this flow already uses message content as state. U+22EF renders
 * near-identically to the '…' the user is already looking at, so the claim is
 * invisible in the UI while being a distinct value to the database.
 */
const WORKING_PLACEHOLDER = '⋯'

/** Either state means "no answer has been written yet". */
const PENDING_PLACEHOLDERS = [THINKING_PLACEHOLDER, WORKING_PLACEHOLDER]

/**
 * Cancel any prepared-send row this turn froze.
 *
 * A frozen email must never outlive the turn that created it: if the worker throws
 * after freezing one — a later tool call, or the 300s ceiling — no card is ever
 * rendered for it, and it would sit `pending` (and confirmable by a rescue re-run's
 * card, or nothing at all) until its TTL. Scoped by the pre-turn id snapshot so it
 * can only ever touch rows THIS turn created.
 */
/**
 * Append an honest line to Claude's reply when a Confirm card could NOT be attached.
 *
 * The worker's own text ends with "frozen for the staff member to confirm" — if no
 * card renders, that sentence names a control the screen does not have, which is the
 * false-capability failure this codebase keeps re-learning. Server-authored, so the
 * model cannot omit or reword it.
 */
async function appendCardFailureNote(placeholderId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('message')
      .eq('id', placeholderId)
      .maybeSingle()
    const body = typeof row?.message === 'string' ? row.message : ''
    if (!body || PENDING_PLACEHOLDERS.includes(body.trim())) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from('internal_messages')
      .update({
        message: `${body}\n\n⚠️ The email could NOT be prepared for confirmation, so nothing is pending and nothing will be sent. Please send it yourself, or ask again.`,
      })
      .eq('id', placeholderId)
  } catch {
    // Best-effort.
  }
}

async function cancelDraftsFrozenThisTurn(
  threadUuid: string,
  priorIds: Set<string>,
  priorKnown: boolean,
): Promise<void> {
  if (!priorKnown) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabaseAdmin as any)
      .from('worker_prepared_sends')
      .select('id')
      .eq('thread_uuid', threadUuid)
      .eq('status', 'pending')
    const mine = ((data ?? []) as Array<{ id: string }>).map(r => r.id).filter(id => !priorIds.has(id))
    if (!mine.length) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from('worker_prepared_sends')
      .update({ status: 'cancelled' })
      .in('id', mine)
      .eq('status', 'pending')
  } catch {
    // Best-effort — this runs on an error path already.
  }
}

/**
 * Insert the Claude placeholder message and fire the async processor.
 * Returns the placeholder message id (or null if @claude wasn't actually
 * mentioned / insert failed — caller can ignore).
 */
export async function triggerClaudeReply(params: {
  threadId: string
  promptBody: string
  promptMessageId: string
  senderIsAntonio: boolean
  /** The thread ROOT of the prompt (prompt.root_id ?? prompt.id). Claude's
   *  answer is stamped with this so it stays inside the same Slack-style thread
   *  the question was asked in, instead of escaping to the main channel. */
  promptRootId?: string | null
  /** Invitation-gate continuation: the route determined this thread is an
   *  active Claude conversation (discussion + prior Claude participation), so
   *  run without requiring an in-body @claude. */
  force?: boolean
}): Promise<string | null> {
  const { threadId, promptBody, promptMessageId, senderIsAntonio, promptRootId, force } = params
  if (!force && !mentionsClaude(promptBody)) return null

  // 1. Placeholder bubble authored by Claude. reply_to_id links it to the
  //    triggering human message — that renders as a quoted reply AND gives the
  //    cron rescue an exact pointer to the prompt if the direct fire is lost.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: placeholder, error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .insert({
      thread_id: threadId,
      sender_id: CLAUDE_SENDER_UUID,
      sender_name: CLAUDE_SENDER_NAME,
      message: THINKING_PLACEHOLDER,
      reply_to_id: promptMessageId,
      root_id: promptRootId ?? promptMessageId,
      read_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error || !placeholder) {
    console.error('[team-claude] placeholder insert failed:', error?.message)
    return null
  }

  // 2. Fire the processor (bounded — it keeps running server-side after abort).
  const url = `${getInternalBaseUrl()}/api/team/claude/process`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({
        thread_id: threadId,
        prompt_message_id: promptMessageId,
        placeholder_id: placeholder.id,
        sender_is_antonio: senderIsAntonio,
      }),
      signal: controller.signal,
    })
  } catch {
    // AbortError expected; processor runs server-side. (No cron net yet — Phase 1.)
  } finally {
    clearTimeout(timeout)
  }

  return placeholder.id
}

/**
 * Run the worker for a team @claude mention and rewrite the placeholder with the
 * answer. Called by /api/team/claude/process. Idempotent-ish: if the placeholder
 * has already been answered (message != placeholder), it no-ops.
 */
export async function processClaudeReply(params: {
  threadId: string
  promptMessageId: string
  placeholderId: string
  senderIsAntonio: boolean
}): Promise<{ ok: boolean; reason?: string }> {
  const { threadId, promptMessageId, placeholderId } = params

  // CLAIM the placeholder atomically. This is a compare-and-set, NOT a read then a
  // check: the direct fire and the rescue cron can both be holding this id, and a
  // read-then-check lets both pass while the first is still working — two workers,
  // one prompt, every tool call executed twice.
  //
  // Restricting the update to sender_id = CLAUDE_SENDER_UUID keeps the old
  // self-trigger guard, and matching on THINKING_PLACEHOLDER means an already-claimed
  // or already-answered row matches nothing and we bail.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claimedRows } = await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ message: WORKING_PLACEHOLDER })
    .eq('id', placeholderId)
    .eq('sender_id', CLAUDE_SENDER_UUID)
    .eq('message', THINKING_PLACEHOLDER)
    .select('id')
  if (!claimedRows?.length) {
    // Someone else owns this turn, it is already answered, or the row is gone.
    return { ok: false, reason: 'already_claimed' }
  }

  // The triggering human message. `attachments` matters: staff drop screenshots
  // and PDFs into team chat and expect @claude to look at them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: prompt } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, message, sender_id, sender_name, attachments')
    .eq('id', promptMessageId)
    .single()
  if (!prompt) return await failPlaceholder(placeholderId, 'The triggering message could not be found.')
  if (prompt.sender_id === CLAUDE_SENDER_UUID) {
    // Loop guard: never answer our own message.
    return { ok: false, reason: 'self_message' }
  }

  // Thread context: client linkage (per-client brain) + recent conversation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id, account_id, contact_id, thread_type, channel_slug, channel_name, title')
    .eq('id', threadId)
    .single()

  let clientKey: string | null = null
  let clientName: string | null = null
  if (thread?.account_id) {
    const { data: acct } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', thread.account_id)
      .single()
    clientKey = `account:${thread.account_id}`
    clientName = acct?.company_name ?? null
  } else if (thread?.contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', thread.contact_id)
      .single()
    clientKey = `contact:${thread.contact_id}`
    clientName = contact?.full_name ?? null
  }

  // SEND RAILS for this turn, pinned server-side (dev job 17459c25).
  //
  // PORTAL: allowed only when the thread is linked to exactly one client, and hard-pinned
  // to that client — the worker cannot retarget it. An unlinked thread gets no portal rail
  // at all, because there is no server fact saying who the message is for.
  const portalSendRail: { enableSlackSend?: true; pinnedPortalRecipient?: { account_id?: string; contact_id?: string } } =
    thread?.account_id
      ? { enableSlackSend: true, pinnedPortalRecipient: { account_id: thread.account_id } }
      : thread?.contact_id
        ? { enableSlackSend: true, pinnedPortalRecipient: { contact_id: thread.contact_id } }
        : {}

  // EMAIL: UNPINNED on client threads — staff decide the recipient (Antonio,
  // 2026-07-29, dev job f55ea3bb, verbatim: "You just have to unlock it because
  // he has to do what we decide"). The July-19 client-address pin blocked the
  // everyday case of emailing our own accountant firm about the client (the
  // MFCompany/Smit refusal). This surface is staff-driven — the @claude prompt
  // is authored by staff, the draft→explicit-"send it" discipline remains the
  // control, and every send is audit-attributed via sendActor. Same unpinned
  // model as Slack. TRADE-OFF (named to Antonio, accepted by him): with no pin,
  // a poisoned document trying to redirect a send is caught only by the staff
  // member reviewing the draft before saying "send it".
  let emailSendRail: {
    enableEmailSend?: true
    emailConfirmExempt?: string[]
    forceMailbox?: 'support' | 'antonio'
    emailSendPrep?: {
      threadUuid: string
      gmailThreadId: string | null
      mailbox: string
      defaultReplyToMessageId: string | null
      sendable: Array<{ ref: string; path: string; name: string; contentType?: string; size?: number }>
    }
  } = {}
  {
    // EVERY team thread, not only client-linked ones. Gating this on a client link
    // meant "@claude email our accountant about MFCompany" inside #td-taxreturn —
    // a channel thread, which carries NULL client ids — got no send_email tool at
    // all, while the shared prompt still told it to call send_email: a false
    // capability on the very channel the work happens in.
    //
    // CONFIRM-ONCE APPLIES HERE TOO (Antonio, 2026-07-29: "I want the confirm step
    // everywhere, that must be present"). An address already known for this thread
    // — the linked client's own, or one of our mailboxes — sends on the staff
    // member's go-ahead. Any OTHER address freezes and a Confirm card is posted
    // into this very thread (see the card block after the worker call). This was
    // briefly left out because Team Chat had no control to render a card into; the
    // card is now built, so the step is real rather than a refusal.
    //
    // OLD COMMENT (kept for the reasoning, no longer the behaviour) — and this is the case the whole change was
    // reported for (MFCompany: "email our accountant Smit about this client").
    //
    // Team Chat is STAFF-AUTHORED text: a teammate typing "@claude email X" is the
    // decision itself, which is exactly why Antonio's rule ("the worker sends what
    // we decide") applies cleanly here. The confirm-a-new-recipient step exists for
    // the two surfaces that put ATTACKER-authored text in front of the model (an
    // inbound email, a client's own chat message) — and, critically, those are the
    // only surfaces with a Confirm card to render. Setting an exempt list here
    // WITHOUT a card would freeze nothing and simply refuse every third-party
    // address: the original bug, re-created by its own fix. Verified: this surface
    // has no prepared-send UI.
    //
    // forceMailbox still applies — there is no mailbox-authorisation check here, so
    // `from: 'antonio'` must never be honoured.
    // The linked client's own addresses (if this thread has a client) plus our own
    // mailboxes are confirm-exempt. A lookup failure leaves the list at just our
    // mailboxes, so an unknown address still gets a card — it degrades toward the
    // human, never toward a silent send.
    const exempt: string[] = [...TD_MAILBOXES]
    if (thread?.account_id || thread?.contact_id) {
      try {
        let rows: Array<{ email: string | null }> = []
        if (thread.account_id) {
          const { data: links } = await supabaseAdmin
            .from('account_contacts')
            .select('contact_id')
            .eq('account_id', thread.account_id)
          const ids = ((links ?? []) as Array<{ contact_id: string }>).map(l => l.contact_id).filter(Boolean)
          if (ids.length) {
            const { data } = await supabaseAdmin.from('contacts').select('email').in('id', ids)
            rows = (data ?? []) as Array<{ email: string | null }>
          }
        } else {
          const { data } = await supabaseAdmin
            .from('contacts')
            .select('email')
            .eq('id', thread.contact_id as string)
          rows = (data ?? []) as Array<{ email: string | null }>
        }
        for (const r of rows) if (r.email && r.email.includes('@')) exempt.push(r.email)
      } catch (err) {
        console.warn('[team-claude] client address lookup failed (every new address will be confirmed):', err)
      }
    }
    emailSendRail = {
      enableEmailSend: true,
      forceMailbox: 'support',
      emailConfirmExempt: Array.from(new Set(exempt)),
      // Freezing needs a prep context. threadId is the TEAM thread's uuid, which is
      // what the Confirm card is looked up by after the turn.
      //
      // `sendable` is EMPTY and that is honest: files posted in a team thread are
      // READ by the worker but are not staged as outbound email attachments here
      // (that staging exists only on the panels, which upload to the private
      // worker-attachments bucket). The surface prompt below says so plainly —
      // without that, the executor's "drop the file into the panel on the same
      // message" advice names a control this screen does not have, which is the
      // false-capability class Luca has reported twice.
      emailSendPrep: {
        threadUuid: threadId,
        gmailThreadId: null,
        mailbox: TD_MAILBOXES[0],
        defaultReplyToMessageId: null,
        sendable: [],
      },
    }
  }

  // Recent conversation (exclude the placeholder itself) for context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: recent } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, sender_id, sender_name, message, attachments, created_at')
    .eq('thread_id', threadId)
    .is('deleted_at', null)
    .neq('id', placeholderId)
    .order('created_at', { ascending: false })
    .limit(12)

  const history = (recent ?? [])
    .slice()
    .reverse()
    .map((m: { sender_name: string; message: string }) => `${m.sender_name}: ${m.message}`)
    .join('\n')

  const contextBlock = history
    ? `RECENT TEAM CHAT (for reference — you are "Claude", a teammate in this internal staff thread):\n${history}\n\n`
    : ''

  let userBody = `${contextBlock}The latest message mentions you (@claude):\n${prompt.sender_name}: ${prompt.message}`

  // Attachments. Take them from the @mention itself, or — when it carries none —
  // from the most recent earlier HUMAN message that does. Staff routinely post a
  // screenshot and then @claude in the next message ("look at this"), exactly the
  // way they do in Slack, where the worker harvests thread history for the same
  // reason. `recent` is newest-first, so the first hit is the nearest one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasFiles = (m: any) => Array.isArray(m?.attachments) && m.attachments.length > 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const carrier = hasFiles(prompt) ? prompt : (recent ?? []).find((m: any) => m.sender_id !== CLAUDE_SENDER_UUID && hasFiles(m))

  const media = { imageBlocks: [] as WorkerImageBlock[], documentBlocks: [] as WorkerDocumentBlock[] }
  if (carrier) {
    try {
      const { readAttachments, fetchTrustedStorageBytes, attachmentRefsFromChatRow, capMediaBudget, fenceUntrustedContent } = await import(
        '@/lib/ai-agent/attachment-reader'
      )
      const read = await readAttachments(attachmentRefsFromChatRow(carrier), fetchTrustedStorageBytes)
      // Keep the whole turn under the Anthropic request ceiling; name what's dropped.
      const capped = capMediaBudget(read.imageBlocks, read.documentBlocks)
      media.imageBlocks = capped.images
      media.documentBlocks = capped.documents
      if (read.textBlocks.length) {
        const whose = carrier.id === prompt.id ? 'this message' : `an earlier message from ${carrier.sender_name}`
        // Team Chat has email + portal send rails, so a shared file's text must
        // never be able to read as an instruction or as an approval to send.
        userBody += `\n\n${fenceUntrustedContent(`files shared in ${whose}`, read.textBlocks.join('\n\n'))}`
      }
      if (capped.dropped.length) {
        userBody += `\n\n[Too much was attached to show you everything. Not shown: ${capped.dropped.join(', ')}.]`
      }
    } catch (err) {
      // Never block the reply on attachment reading.
      console.warn('[team-claude] attachment read failed (answering without files):', err)
    }
  }

  // Prepared-send rows that ALREADY existed on this thread before this turn — so a
  // Confirm card is only posted for a draft THIS turn froze, never a stale one. Id
  // snapshot (not a clock comparison): the database's now() and this process's clock
  // are different clocks, and skew would either drop this turn's card or resurface an
  // old one. A failed lookup suppresses the card rather than risking a stale confirm.
  const priorPreparedIds = new Set<string>()
  let priorPreparedKnown = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing, error } = await (supabaseAdmin as any)
      .from('worker_prepared_sends')
      .select('id')
      .eq('thread_uuid', threadId)
      .eq('status', 'pending')
    if (error) priorPreparedKnown = false
    for (const r of (existing ?? []) as Array<{ id: string }>) priorPreparedIds.add(r.id)
  } catch {
    priorPreparedKnown = false
  }

  let reply: string
  try {
    const { callWorkerWithAttachments } = await import('@/lib/ai-agent/attachment-reader')
    // FULL SLACK PARITY (parity matrix 2026-07-08, after the "send it in the
    // thread" incident): the Team Chat worker runs with the SAME configuration
    // as the Slack worker — same persona/discipline prompt (SOURCES FIRST, TWO
    // GEARS, DRAFTS, send-after-explicit-"send it"), same send rails, same
    // iteration budget, same billing key. Differences are transport-only:
    //  - threadId = the TEAM thread uuid → worker thread memory AND
    //    approval_queue.thread_id linkage for the in-chat 6-digit code rail.
    //  - messageId is NOT passed: approval_queue.source_message_id FKs
    //    agent_messages(id) (Slack rows) — a team message id would violate it.
    //  - enableClientThreadTag stays off (that rail is #td-support-specific).
    const { SLACK_WORKER_SYSTEM_PROMPT } = await import('@/lib/ai-agent/slack-claude')
    const { loadRelevantTemplates, formatTemplatesForPrompt } = await import('@/lib/ai-agent/templates')

    let systemPrompt = `${SLACK_WORKER_SYSTEM_PROMPT}\n\nCONTEXT CORRECTION: you are in the CRM TEAM CHAT (crm.tonydurante.us → Team Chat), not Slack. Same team, same rules, same tools — replies render as chat messages in this internal thread (never client-visible).\n\nEMAIL FROM HERE: you may email ANY address the staff member names. EVERY email is FROZEN for their confirmation — no exceptions. A "Confirm & send" card appears under your reply in this thread with the recipient, subject, body, and a choice of which of our addresses it goes out from (support@ or antonio.durante@). Nothing leaves until they click, so say it is READY FOR THEIR CONFIRMATION, show the exact address, and NEVER say it has been sent.\n\nFILES IN THIS THREAD CANNOT BE EMAILED. You can READ what people post here, but there is no way to attach those files to an outbound email from Team Chat — the attach flow exists only in the Inbox and client-chat panels. If someone asks you to forward a file from this thread, say that plainly and offer to draft the email for them to send with the file themselves. NEVER tell them to "drop the file into the panel" — there is no panel on this screen — and never claim a file is attached.`
    try {
      const templates = await loadRelevantTemplates(prompt.message)
      const block = formatTemplatesForPrompt(templates)
      if (block) systemPrompt += `\n${block}`
    } catch { /* best-effort, same as Slack */ }

    const res = await callWorkerWithAttachments(userBody, {
      threadId,
      systemPromptOverride: systemPrompt,
      surface: 'team_chat',
      // Per-surface key config (WORKER_KEY_TEAM_CHAT, unset ⇒ shared key). This
      // surface used to hardwire SLACK_WORKER_ANTHROPIC_KEY — so disabling the
      // Slack key at Anthropic took Team Chat down with it (2026-07-29 outage,
      // Luca's "Claude in td-taxreturn doesn't work"). See surface-api-key.ts.
      apiKeyOverride: surfaceApiKeyOverride('team_chat'),
      maxIterations: 20,
      // Files shared in the thread, handed to the model directly (vision for
      // images, native blocks for scanned PDFs). Extracted text for everything
      // else is already appended to userBody above.
      ...(media.imageBlocks.length ? { images: media.imageBlocks } : {}),
      ...(media.documentBlocks.length ? { documents: media.documentBlocks } : {}),
      // Read/research rails.
      enableDbRead: true,
      enableDocReads: true,
      enableCallReads: true,
      enableCalendly: true,
      enableClientThreadRead: true,
      enableWebSearch: true,
      enableThreadRecall: true,
      enableFullToolReach: fullReachEnabledFor('team_chat'),
      // Send rails — draft in thread, send on the staff member's explicit "send it".
      //
      // SERVER-SIDE PINS (dev job 17459c25). Until this fix these rails ran with no
      // pin and no actor, which meant: the recipient check was skipped entirely (it
      // only engages when a pin is present), the portal send used whatever client ids
      // the MODEL supplied, and — because the Italian/English language guard and the
      // one-shot send latch are both conditioned on a pin existing — those two were
      // inert as well. Nothing but prompt text stood between a draft and a real client.
      //
      // A team thread is not inherently about one client, so the pin is derived from
      // the thread's own client link and the rail is SWITCHED OFF when there is none.
      // Off is the correct default here: an unpinnable send is one the server cannot
      // check, and this surface has no confirm step of its own yet.
      ...portalSendRail,
      ...emailSendRail,
      // Internal team-chat send (staff-only, posts as Claude). Same draft →
      // explicit "send it" discipline. Answering @claude already runs in team
      // chat; this lets it post to OTHER team channels/threads on approval.
      enableTeamChatSend: true,
      // Code-task rail OFF (2026-07-10, Antonio): the team-chat worker never
      // launches or ships a coding job — it investigates and reports; Antonio
      // does code himself. (Reverses the earlier Antonio-only gate.)
      enableCodeTasks: false,
      // WHO asked for this. Without it every send from this surface was written to the
      // audit trail as the generic worker, so "who told it to send that" had no answer.
      sendActor: `team-chat:${prompt.sender_name ?? prompt.sender_id}`,
      // EXPLICIT identity for team_chat_send's "on behalf of" stamp — the
      // @claude prompt's sender IS the auth user driving this turn. Passed as
      // the raw uuid (never the display-name actor label above, which cannot
      // resolve). Silences only that person's own-dictated-message
      // notifications; validated against the staff directory downstream.
      onBehalfOf: prompt.sender_id ?? null,
      clientKey,
      clientName,
    })
    reply = res.reply?.trim() || '(no response generated)'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[team-claude] worker failed:', msg)
    // Report BEFORE replying. During the 2026-07-29 outage (Team Chat's key
    // disabled at Anthropic) every request failed here for hours with ZERO rows in
    // system_errors — the failure was invisible to /system-health and the 15-min
    // audit cron, and we learned about it from Luca's bug report instead. Never
    // throws (reportSystemError catches internally), so the user reply is safe.
    await reportSystemError({
      source: 'server',
      route: 'team-chat/claude-trigger',
      message: `@claude worker call failed: ${msg}`,
      context: { thread_id: threadId, sender: prompt.sender_name ?? prompt.sender_id ?? null },
    })
    // A frozen email must never outlive the turn that made it. If the worker threw
    // AFTER freezing one (a later tool call, or the 300s ceiling), nothing would
    // ever render its card and it would sit pending until the TTL — a real
    // outbound email prepared and then invisible. Cancel anything this turn froze.
    await cancelDraftsFrozenThisTurn(threadId, priorPreparedIds, priorPreparedKnown)
    return await failPlaceholder(
      placeholderId,
      msg.includes('ANTHROPIC_API_KEY')
        ? '⚠️ AI is not configured in this environment (ANTHROPIC_API_KEY missing).'
        : '⚠️ I hit an error working on that. Please try again.',
    )
  }

  // Rewrite the placeholder with the answer + bump thread activity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ message: reply })
    .eq('id', placeholderId)
    // Only write over OUR claim. Must match WORKING_PLACEHOLDER, not the original
    // '…' — this turn set the claim on entry, so matching the old value here would
    // never fire and the reply would be silently dropped.
    .eq('message', WORKING_PLACEHOLDER)

  // CONFIRM CARD — a new email recipient waits for a human here, in this thread.
  // The card carries the frozen row's id; its buttons call the same confirm-send
  // endpoint the Inbox and client-chat panels use, so one payload, one code path,
  // and what leaves is exactly what was read.
  if (priorPreparedKnown) {
    try {
      // Rows THIS turn froze — every pending row minus the pre-turn snapshot. Taking
      // "the newest pending row on the thread" was wrong: thread_uuid is the whole
      // CHANNEL, and two people can have overlapping @claude turns in it, so turn A
      // could pick up turn B's draft — A's answer would carry B's recipient while
      // A's own email became invisible. Sorted oldest-first so the one we show is
      // this turn's own; a second freeze in one turn is already refused upstream.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: mineRows, error: mineErr } = await (supabaseAdmin as any)
        .from('worker_prepared_sends')
        .select('id, to_address, subject, body, attachments')
        .eq('thread_uuid', threadId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
      if (mineErr) throw new Error(mineErr.message)
      const prep = ((mineRows ?? []) as Array<{ id: string }>).find(r => !priorPreparedIds.has(r.id)) as
        | { id: string; to_address: string; subject: string; body: string | null; attachments: unknown }
        | undefined
      if (prep) {
        const files = ((prep.attachments ?? []) as Array<{ name?: string }>)
          .map(a => a.name)
          .filter(Boolean)
          .join(', ')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabaseAdmin as any).from('internal_messages').update({
          // NOT-A-PLACEHOLDER guard, twin to the answer write above: a card must
          // never land on a row that never received this turn's answer (it would
          // render a Confirm button under a thinking spinner). The costs is one
          // line; the invariant otherwise rests on the function ceiling staying
          // below the abandon window forever.
          card: {
            kind: 'email_confirm',
            title: `Confirm email to ${prep.to_address}`,
            subtitle: [prep.subject, files ? `📎 ${files}` : ''].filter(Boolean).join(' — ') || undefined,
            entity_type: 'worker_prepared_send',
            entity_id: prep.id,
            // The exact body that will be sent, so Confirm approves a MESSAGE and
            // not just an address (the panels render it for the same reason).
            body: typeof prep.body === 'string' ? prep.body : '',
          },
        })
          .eq('id', placeholderId)
          .not('message', 'in', `("${THINKING_PLACEHOLDER}","${WORKING_PLACEHOLDER}")`)
      }
    } catch (err) {
      // A missing card must never break the answer — but it must not be SILENT
      // either: the worker's reply says "frozen for the staff member to confirm",
      // and with no card there is nothing to confirm and the email dies at its TTL.
      // Cancel what this turn froze and say so, rather than promising a control
      // that isn't there.
      console.warn('[team-claude] confirm-card attach failed:', err)
      await cancelDraftsFrozenThisTurn(threadId, priorPreparedIds, priorPreparedKnown)
      await appendCardFailureNote(placeholderId)
      await reportSystemError({
        source: 'server',
        route: 'team-chat/claude-trigger',
        message: `Confirm card could not be attached; the prepared email was cancelled: ${err instanceof Error ? err.message : String(err)}`,
        context: { thread_id: threadId },
      })
    }
  } else {
    // The pre-turn snapshot failed, so we cannot tell this turn's draft from an
    // older one. Cancel nothing (we'd risk cancelling someone else's) but never
    // show a card we can't attribute — and don't leave the reply claiming one.
    await appendCardFailureNote(placeholderId)
  }

  await bumpThreadActivity(threadId)

  // PERMANENT MEMORY (council redo WS1.4): record this @claude exchange in
  // agent_messages so the assistant actually REMEMBERS this thread beyond the
  // last-12 window — buildThreadContext ("CONVERSATION SO FAR") and the
  // recall_thread tool both read agent_messages by thread_id, which was ALWAYS
  // EMPTY for team threads (a tool that lied to the model). We store the RAW
  // prompt + reply (never the enriched userBody, which already contains the
  // last-12 recap — storing that would nest recap-in-recap on the next turn).
  // recipient='worker' keeps it isolated from the Slack/Hermes crons (they
  // claim recipient='claude'); status='done' so it never engages the CRM
  // per-thread in-flight lock. Best-effort — never blocks the reply.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('agent_messages').insert({
      sender: 'crm',
      recipient: 'worker',
      subject: clientName || 'Team chat (@claude)',
      body: prompt.message,
      reply,
      status: 'done',
      thread_id: threadId,
      context_json: {
        source: 'crm-worker',
        surface: 'team-chat',
        user_message: prompt.message,
        ...(clientKey ? { client_key: clientKey } : {}),
      },
    })
  } catch (err) {
    console.warn('[team-claude] memory write failed (reply still delivered):', err)
  }

  // BUSINESS BRAIN capture (dev job 203cda1a): if this staff message corrected the
  // worker's PRIOR reply in this thread, learn the lesson. Team chat is staff-only,
  // so this turn is staff by construction. Client-scoped when the thread is linked
  // to a client; else global + scrubbed (Antonio's policy). Inputs are the RAW staff
  // message + the prior worker reply ONLY (never userBody — it carries the last-12
  // recap + fenced files). Best-effort, never blocks the reply.
  try {
    const priorReply = (recent ?? []).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // Must exclude BOTH pending states — a claimed placeholder is still a spinner,
      // not a reply, and feeding it to lesson capture would teach on an empty turn.
      (m: any) =>
        m.sender_id === CLAUDE_SENDER_UUID && m.message && !PENDING_PLACEHOLDERS.includes(m.message),
    )?.message as string | undefined
    if (priorReply) {
      const { captureLessonFromTurn } = await import('@/lib/ai-agent/lesson-capture')
      await captureLessonFromTurn({
        staffMessage: prompt.message,
        priorReply,
        clientKey,
        clientName,
        surface: 'team_chat',
        sourceRef: `team:${threadId}:${promptMessageId}`,
        actors: ['antonio', 'claude'],
        mode: 'correction',
      })
    }
  } catch (err) {
    console.warn('[team-claude] brain capture failed (non-fatal):', err)
  }

  // Slack parity: Slack posts the answer as a NEW message so the phone gets a
  // push. In Team Chat the answer REPLACES the placeholder — an UPDATE, not an
  // insert — so no send route ever runs and nothing else can notify here.
  //
  // In a WORK CHANNEL that means every staff member, not just the asker: an
  // @claude answer in td-bug is part of the bug, and Antonio must see it whoever
  // asked (2026-07-24). Elsewhere (a DM, a client discussion) it stays with the
  // person who asked. Best-effort.
  try {
    const { sendPushToAdminUsers } = await import('@/lib/portal/web-push')
    const payload = {
      title: 'Claude replied',
      body: reply.slice(0, 120),
      url: `/team-chat?thread=${threadId}`,
      tag: `team-claude-${threadId}`,
    }
    const isWorkChannel = (thread?.thread_type === 'channel' || thread?.thread_type === 'general')
      && channelNotifiesStaff(thread?.channel_slug ?? thread?.channel_name ?? null)
    if (isWorkChannel) {
      const { sendPushToStaffExcept } = await import('@/lib/team/notify')
      await sendPushToStaffExcept(CLAUDE_SENDER_UUID, payload)
    } else {
      await sendPushToAdminUsers([prompt.sender_id], payload)
    }
  } catch { /* non-critical */ }

  return { ok: true }
}

/**
 * Cron rescue — process placeholders whose direct fire was lost.
 *
 * The send route fires /api/team/claude/process with a 2.5s-bounded fetch; on
 * Vercel that fire-and-forget can occasionally be dropped before the target
 * invocation starts (same failure mode the Slack worker has — its cron is the
 * safety net there, and this is the equivalent net here). Finds "…" placeholders
 * older than STUCK_AFTER_MS and runs them. The prompt is recovered from the
 * placeholder's reply_to_id (set at trigger time); legacy placeholders without
 * it fall back to the nearest earlier human message in the thread.
 *
 * TWO WINDOWS, deliberately (dev job 17459c25):
 *  - UNCLAIMED ('…') after STUCK_AFTER_MS — nothing ever started, so re-firing is
 *    free. 45s is right here.
 *  - CLAIMED ('⋯') after ABANDONED_AFTER_MS — a processor took this turn and then
 *    died (function killed, deploy mid-run). Re-firing is only safe once we are sure
 *    nobody is still working, so this window is far longer than any real turn. A
 *    45s window here is exactly the double-run bug this claim was added to fix: a
 *    20-iteration turn with DB, Drive and web tools routinely runs past 45s.
 */
const STUCK_AFTER_MS = 45_000
const ABANDONED_AFTER_MS = 10 * 60_000
const RESCUE_BATCH = 3

export async function rescueStuckClaudeReplies(): Promise<{ scanned: number; rescued: number }> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString()

  // Abandoned claims first: hand them back to the unclaimed state so the normal
  // claim path below can pick them up. Conditioned on age, so a live run is never
  // reset out from under itself.
  const abandonedCutoff = new Date(Date.now() - ABANDONED_AFTER_MS).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ message: THINKING_PLACEHOLDER })
    .eq('sender_id', CLAUDE_SENDER_UUID)
    .eq('message', WORKING_PLACEHOLDER)
    .is('deleted_at', null)
    .lt('created_at', abandonedCutoff)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stuck } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, thread_id, reply_to_id, created_at')
    .eq('sender_id', CLAUDE_SENDER_UUID)
    .eq('message', THINKING_PLACEHOLDER)
    .is('deleted_at', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(RESCUE_BATCH)

  let rescued = 0
  for (const ph of stuck ?? []) {
    let promptId: string | null = ph.reply_to_id
    if (!promptId) {
      // Legacy placeholder (pre reply_to_id): nearest earlier human message.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: prev } = await (supabaseAdmin as any)
        .from('internal_messages')
        .select('id')
        .eq('thread_id', ph.thread_id)
        .neq('sender_id', CLAUDE_SENDER_UUID)
        .is('deleted_at', null)
        .lt('created_at', ph.created_at)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      promptId = prev?.id ?? null
    }
    if (!promptId) {
      await failPlaceholder(ph.id, '⚠️ I lost track of the question this was answering — please ask again.')
      continue
    }

    // Recover the code-task gate (R111): Antonio-only, keyed on the prompt author.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prompt } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('sender_id')
      .eq('id', promptId)
      .single()
    const senderIsAntonio = prompt?.sender_id ? await isAntonioUser(prompt.sender_id) : false

    const res = await processClaudeReply({
      threadId: ph.thread_id,
      promptMessageId: promptId,
      placeholderId: ph.id,
      senderIsAntonio,
    })
    if (res.ok) rescued++
  }
  return { scanned: (stuck ?? []).length, rescued }
}

/** Mirror of lib/auth isAdmin, usable from a cron (no session): admin role or
 *  Antonio's email. Default-safe: unknown/missing user → false. */
async function isAntonioUser(userId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId)
    const u = data?.user
    if (!u) return false
    return (
      u.email === 'antonio.durante@tonydurante.us' ||
      u.app_metadata?.role === 'admin' ||
      (u.user_metadata as Record<string, unknown> | undefined)?.role === 'admin'
    )
  } catch {
    return false
  }
}

async function failPlaceholder(placeholderId: string, message: string) {
  // Accepts EITHER pending state: most failures happen after this turn claimed the
  // row (so it reads WORKING_PLACEHOLDER), but a pre-claim caller may still hold the
  // original. Matching only one of them would leave the placeholder spinning forever.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ message })
    .eq('id', placeholderId)
    .in('message', PENDING_PLACEHOLDERS)
  return { ok: false, reason: 'worker_error' }
}

async function bumpThreadActivity(threadId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_threads')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', threadId)
}
