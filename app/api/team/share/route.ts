import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { findOrCreateDm } from '@/lib/team/dm'
import { listTeamMembers } from '@/lib/team/directory'
import { buildShareCards, composeShareMessage, MAX_SHARE_ITEMS } from '@/lib/team/share'
import { getSupportPersonUserId } from '@/lib/settings'
import { findOrCreateConversation } from '@/lib/team/find-conversation'
import { parseClientRef } from '@/lib/team/conversations'
import { loadStageSetForType } from '@/lib/dev-tracker/load-stage-set'
import { initialMilestones, deriveStatusForSet, labelForStage } from '@/lib/dev-tracker/milestones'
import { generatePlainFields } from '@/lib/dev-tracker/plain-summary'
import { isSafeInternalUrl } from '@/lib/dev-tracker/board'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'
import { NextRequest, NextResponse } from 'next/server'

// The Dev-Board target runs an AI patch phase after the insert (~16s worst
// case with model failover) — keep the route comfortably above that.
export const maxDuration = 60

/**
 * POST /api/team/share
 *
 * Share one or more items (a client portal message, or an email from the Inbox)
 * into the internal Team Workspace as a DM — either to a chosen teammate ("discuss")
 * or to the configured support person ("Send to Support"). Each item becomes its
 * OWN message (note + client_message card) so a multi-share creates one message
 * per item, never a merged blob.
 *
 * Notifies ONLY the recipient (sendPushToAdminUsers) — deliberately NOT the
 * team-chat send route, which broadcasts DM/thread activity to the whole staff
 * (sendPushToAdminExcluding). Reusing that route here would ping everyone on
 * every share.
 *
 * Body:
 *   {
 *     target: 'support' | { user_id: string },
 *     note?: string,
 *     items: Array<{ kind?, title, subtitle?, url?, color?, entity_type?, entity_id? }>
 *   }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const note: string = typeof body.note === 'string' ? body.note.trim() : ''

  // Validate + normalize the items into cards (pure, unit-tested).
  const built = buildShareCards(body.items, MAX_SHARE_ITEMS)
  if (built.error) {
    return NextResponse.json({ error: built.error }, { status: 400 })
  }
  const cards = built.cards

  const now = new Date().toISOString()
  const displayName = getUserDisplayName(user)

  // ── Dev Board target: turn a client message into a tracked bug / feature card ──
  //   { dev_board: { channel: 'td-bug' | 'td-dev' } }
  const devBoard =
    body.target && typeof body.target === 'object' && body.target.dev_board
      ? body.target.dev_board
      : null
  if (devBoard) {
    const card = cards[0]
    if (!card) return NextResponse.json({ error: 'Nothing to share.' }, { status: 400 })
    const channel = devBoard.channel === 'td-bug' ? 'td-bug' : 'td-dev'
    const type = channel === 'td-bug' ? 'bugfix' : 'feature'
    const title = (note || card.title || 'Client message').slice(0, 140)
    const description = [
      note && `Note: ${note}`,
      card.title && `Client: ${card.title}`,
      card.subtitle && `Message: ${card.subtitle}`,
      card.url && `Source (click to open the client/message): ${card.url}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const set = await loadStageSetForType(db, type)
    const startStage = set.stages[0]?.key || 'requested'

    // Durable write FIRST (council ordering contract): the card must exist
    // even if the AI patch below times out — a staff share must never hang
    // ~16s and then be lost. buildShareCards already enforces relative URLs;
    // the extra guard blocks protocol-relative '//host' values.
    const originUrl = card.url && isSafeInternalUrl(card.url) ? card.url : null
    const { data: job, error } = await db
      .from('dev_tasks')
      .insert({
        title,
        type,
        priority: 'medium',
        status: deriveStatusForSet(set, startStage),
        channel,
        description,
        summary_plain: note || card.title || null,
        origin_url: originUrl,
        milestones: initialMilestones(now, `${displayName} (shared)`, startStage),
      })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message || 'Could not create the card.' }, { status: 500 })

    // AI patch phase — plain-English card fields (same contract as the
    // dev_task tools): best-effort, null on failure keeps the note/title.
    const ai = await generatePlainFields({
      title,
      type,
      priority: 'medium',
      channel,
      stageLabel: labelForStage(set, startStage),
      description,
      findings: null,
      plan: null,
      decisions: null,
      blockers: null,
      callerSummary: note || card.title || null,
      progressTail: [],
    })
    if (ai) {
      const { error: patchErr } = await db
        .from('dev_tasks')
        .update({
          summary_plain: ai.summary_plain,
          business_impact: ai.business_impact,
          simple_next_step: ai.simple_next_step,
          plain_generated_at: new Date().toISOString(),
        })
        .eq('id', job.id)
      if (patchErr) console.error('[team/share] plain-fields patch failed:', patchErr.message)
    }

    return NextResponse.json({ ok: true, dev_task_id: job.id, url: `/dev-board/${job.id}` })
  }

  // Resolve WHERE the share lands (threadId) and WHO gets pinged (pushIds).
  // Three targets:
  //   'support'                        → the support person's DM (legacy)
  //   { user_id }                      → a chosen teammate's DM (legacy)
  //   { conversation: { client, topic }} → a team-visible CLIENT CONVERSATION
  let threadId: string
  let pushIds: string[] = []
  let openLabel = 'teammate'

  const convTarget =
    body.target && typeof body.target === 'object' && body.target.conversation
      ? body.target.conversation
      : null

  if (convTarget) {
    // ── Client conversation (team-visible discussion on a client + topic) ──
    const ref = parseClientRef((convTarget.client ?? '').toString())
    if (!ref) return NextResponse.json({ error: 'A valid client is required.' }, { status: 400 })
    const topic: string | null = (convTarget.topic ?? '').toString().trim() || null

    const found = await findOrCreateConversation({
      ref,
      topic,
      createdBy: user.id,
      createdByName: displayName,
      forceNew: convTarget.force_new === true,
    })
    if ('error' in found) {
      return NextResponse.json({ error: found.error }, { status: found.status })
    }
    threadId = found.thread.id
    openLabel = found.thread.title ?? found.clientName

    // Notify the support person (Luca) by default — the person picking up client
    // work. If the sharer IS the support person, fall back to notifying admins so
    // it never rings the sharer alone. (Full @tag routing is a later slice.)
    const supportId = await getSupportPersonUserId()
    if (supportId && supportId !== user.id) {
      pushIds = [supportId]
    } else {
      const members = await listTeamMembers()
      pushIds = members.filter(m => m.role === 'admin' && m.id !== user.id).map(m => m.id)
    }

    // Seed each recipient as a PARTICIPANT of the conversation (a read row whose
    // last_read_at is the epoch → every existing message, incl. the shared item,
    // counts as unread for them, and they now get the conversation's ring + dot
    // on every future message). `last_read_at` is NOT NULL, so we use the epoch
    // rather than null. ignoreDuplicates so we never clobber a recipient who has
    // already read further.
    if (pushIds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from('internal_thread_reads')
        .upsert(
          pushIds.map(uid => ({ thread_id: threadId, user_id: uid, last_read_at: '1970-01-01T00:00:00Z', updated_at: now })),
          { onConflict: 'thread_id,user_id', ignoreDuplicates: true },
        )
    }
  } else {
    // ── Legacy DM targets (support person, or a chosen teammate) ──
    let recipientId: string
    if (body.target === 'support') {
      const supportId = await getSupportPersonUserId()
      if (!supportId) {
        return NextResponse.json(
          { error: 'No support person is configured. Set one before sharing to Support.' },
          { status: 409 },
        )
      }
      recipientId = supportId
    } else if (body.target && typeof body.target === 'object' && typeof body.target.user_id === 'string') {
      recipientId = body.target.user_id.trim()
    } else {
      return NextResponse.json({ error: 'A share target is required.' }, { status: 400 })
    }
    if (!recipientId) {
      return NextResponse.json({ error: 'A share target is required.' }, { status: 400 })
    }

    // The recipient must be a real, active staff member.
    const members = await listTeamMembers()
    const recipient = members.find(m => m.id === recipientId)
    if (!recipient) {
      return NextResponse.json({ error: 'That teammate was not found.' }, { status: 404 })
    }
    openLabel = recipient.name

    // Find-or-create the DM (order-independent, race-safe).
    try {
      const { thread } = await findOrCreateDm(user.id, recipientId)
      threadId = thread.id
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Could not open the conversation.' },
        { status: 500 },
      )
    }
    pushIds = recipientId !== user.id ? [recipientId] : []
  }

  // One message per item. The message body = the sharer's note + the item's full
  // source text (whole email / portal message), capped; the card is the titled
  // link back. Bulk insert keeps them in order.
  const rawItems = Array.isArray(body.items) ? body.items : []
  const rows = cards.map((card, i) => ({
    thread_id: threadId,
    sender_id: user.id,
    sender_name: displayName,
    message: composeShareMessage(note, rawItems[i]?.body),
    card,
    mentions: [],
    mentioned_user_ids: [],
    attachments: [],
    read_at: now,
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insErr } = await (supabaseAdmin as any)
    .from('internal_messages')
    .insert(rows)
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  // Bump thread activity so it re-sorts to the top of the sidebar.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_threads')
    .update({ last_activity_at: now })
    .eq('id', threadId)

  // Sender has implicitly read their own messages.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_thread_reads')
    .upsert(
      { thread_id: threadId, user_id: user.id, last_read_at: now, updated_at: now },
      { onConflict: 'thread_id,user_id' },
    )

  // Notify the resolved recipient(s). Empty when you shared to your own DM.
  try {
    const count = cards.length
    await sendPushToAdminUsers(pushIds, {
      title: `${displayName} shared ${count > 1 ? `${count} items` : 'an item'} — ${openLabel}`,
      body: note ? note.slice(0, 120) : (cards[0].title || 'Shared to team chat'),
      url: `/team-chat?thread=${threadId}`,
      tag: `team-share-${threadId}`,
    })
  } catch {
    // non-critical
  }

  return NextResponse.json({ thread_id: threadId, count: cards.length })
}
