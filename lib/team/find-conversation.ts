/**
 * The SINGLE find-or-create path for a client conversation (a `discussion`
 * thread on a client + topic).
 *
 * Extracted so the "New conversation" modal (`POST /api/team/conversations`) and
 * the Share flow (`POST /api/team/share`) create/dedupe conversations through the
 * SAME logic — never two competing grains. The pre-build review flagged that a
 * second dedup path would fragment identity (a topic-blind legacy path already
 * exists; do not add a third).
 *
 * Server-only: uses `supabaseAdmin` (service role). Every team route already
 * reads through the service-role client, so RLS is bypassed consistently — a
 * green sandbox test still won't prove a user-scoped RLS path, so never route
 * this through the request client.
 *
 * Channel filing and the channel "conversation started" card are NOT here — they
 * are specific to the modal and stay in that route. This helper is only the
 * client+topic discussion identity.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { channelSlug } from '@/lib/team/workspace'
import {
  clientRefColumn,
  conversationTitle,
  type ClientRef,
} from '@/lib/team/conversations'

export interface FoundConversation {
  /** The discussion thread row (existing or newly created). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  thread: any
  reused: boolean
  clientName: string
}

/** Resolve the display name for a client ref; null if the row doesn't exist. */
async function resolveClientName(ref: ClientRef): Promise<string | null> {
  if (ref.kind === 'account') {
    const { data } = await supabaseAdmin.from('accounts').select('company_name').eq('id', ref.id).single()
    return data ? (data.company_name ?? 'Client') : null
  }
  if (ref.kind === 'contact') {
    const { data } = await supabaseAdmin.from('contacts').select('full_name').eq('id', ref.id).single()
    return data ? (data.full_name ?? 'Client') : null
  }
  const { data } = await supabaseAdmin.from('leads').select('full_name').eq('id', ref.id).single()
  return data ? (data.full_name ?? 'Client') : null
}

export interface FindOrCreateConversationInput {
  ref: ClientRef
  /** Topic display name (free-typed or a catalog label); null → topic-less. */
  topic: string | null
  createdBy: string
  createdByName: string
  /**
   * When true, always create a NEW conversation even if an open one exists for
   * the same client+topic (the "start a new one" escape hatch). Default false =
   * reuse the open one.
   */
  forceNew?: boolean
}

/**
 * Find a reusable discussion for this client+topic (or create one). Returns the
 * thread, whether it was reused, and the resolved client name.
 *
 * Reuse predicate: not archived, same `topic_slug`, and **not `Closed`** — a
 * Closed conversation was deliberately dropped, so new activity starts a fresh
 * one. A `Solved` conversation IS reused and **reopened** (new activity means
 * the matter is live again), clearing its resolution so it stops reading as
 * done. This deliberately does NOT key on `resolved_at IS NULL` — that would
 * fork a duplicate the moment a thread is solved (pre-build review, finding b).
 */
export async function findOrCreateConversation(
  input: FindOrCreateConversationInput,
): Promise<FoundConversation | { error: string; status: number }> {
  const { ref, createdBy, createdByName, forceNew } = input

  const clientName = await resolveClientName(ref)
  if (clientName === null) {
    return { error: `${ref.kind[0].toUpperCase()}${ref.kind.slice(1)} not found.`, status: 404 }
  }

  const topic = (input.topic ?? '').trim() || null
  const topicSlug = topic ? channelSlug(topic) || null : null
  const col = clientRefColumn(ref.kind)
  const now = new Date().toISOString()

  if (!forceNew) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reuseQuery: any = (supabaseAdmin as any)
      .from('internal_threads')
      .select('*')
      .eq('thread_type', 'discussion')
      .eq(col, ref.id)
      .is('archived_at', null)
      .or('resolution.is.null,resolution.eq.solved') // reuse Open + Solved; skip Closed
    reuseQuery = topicSlug ? reuseQuery.eq('topic_slug', topicSlug) : reuseQuery.is('topic_slug', null)
    const { data: existing } = await reuseQuery.order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (existing) {
      // Reopen a previously-Solved thread — new activity means it's live again.
      if (existing.resolution === 'solved' || existing.resolved_at) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: reopened } = await (supabaseAdmin as any)
          .from('internal_threads')
          .update({ resolution: null, resolved_at: null, resolved_by: null, work_status: 'todo', last_activity_at: now })
          .eq('id', existing.id)
          .select()
          .single()
        return { thread: reopened ?? existing, reused: true, clientName }
      }
      return { thread: existing, reused: true, clientName }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: created, error } = await (supabaseAdmin as any)
    .from('internal_threads')
    .insert({
      thread_type: 'discussion',
      [col]: ref.id,
      topic,
      topic_slug: topicSlug,
      title: conversationTitle(clientName, topic),
      created_by: createdBy,
      last_activity_at: now,
    })
    .select()
    .single()
  if (error) return { error: error.message, status: 500 }

  // Seed the opening marker message.
  await supabaseAdmin.from('internal_messages').insert({
    thread_id: created.id,
    sender_id: createdBy,
    sender_name: createdByName,
    message: `🗂️ Conversation started: ${conversationTitle(clientName, topic)}`,
    read_at: now,
  })

  return { thread: created, reused: false, clientName }
}
