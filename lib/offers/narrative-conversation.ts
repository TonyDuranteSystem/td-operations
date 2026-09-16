/**
 * Persistence + scope-safety for the offer-narrative CONVERSATION.
 *
 * WHY A DB TABLE: a Vercel API route is stateless between requests, so "real
 * conversational memory" (task requirement: proper Anthropic message history
 * across turns, not a one-shot call) has nowhere to live except the database.
 * See scripts/migrations/20260916-1729-offer-narrative-conversations.sql for
 * the schema + the full sequencing rationale.
 *
 * SCOPE RE-VALIDATION (security requirement, mirrors lib/ai-agent/client-scope.ts
 * and lib/ai-agent/sidebar-send-rails.ts): a client-supplied `conversation_id`
 * is NEVER trusted to belong to the offer draft the caller claims it does.
 * `loadConversation` re-derives the subject (lead/account/contact) from the
 * STORED row and refuses when the caller's claimed identity disagrees — so
 * one client's conversation can never blend into another's narrative, even
 * from a stale tab or a copy-pasted id.
 *
 * SEQUENCING (concurrency safeguard): `appendTurnPair` claims the next TWO
 * seqs (one user turn + its one assistant reply, written together — see its
 * own header for why the pair must be atomic) via max(seq)+1/+2 and retries
 * on a unique-constraint collision — the SAME idiom this codebase already
 * uses for invoice numbers (lib/portal/invoice-number.ts, R098: "race safety
 * lives in the partial unique index ... plus caller-side retry-on-unique-
 * violation"), not a new mechanism. Two browser tabs (or a rapid double-send)
 * racing to append an exchange will have exactly one INSERT succeed for a
 * given seq pair; the loser re-reads a fresh max and retries. Order is
 * therefore fixed at the moment an exchange is PERSISTED, never inferred
 * from `created_at` or insertion-completion order (either can invert under a race).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { isUniqueViolation } from '@/lib/portal/invoice-number'
import type { AIMessage } from '@/lib/portal/ai-provider'

export interface ConversationSubject {
  leadId: string | null
  accountId: string | null
  contactId: string | null
}

export interface ConversationTurnRow {
  seq: number
  role: 'user' | 'assistant'
  content: string
}

export type LoadConversationResult =
  | { ok: true; conversationId: string; subject: ConversationSubject; turns: ConversationTurnRow[] }
  | { ok: false; error: string }

const MAX_SEQ_RETRIES = 10
const TURN_SEQ_CONSTRAINT = 'offer_narrative_turns_conversation_seq_uniq'

/** Pure — no I/O. Exported so the scope-mismatch rule is independently testable. */
export function sameSubject(a: ConversationSubject, b: ConversationSubject): boolean {
  return (a.leadId ?? null) === (b.leadId ?? null)
    && (a.accountId ?? null) === (b.accountId ?? null)
    && (a.contactId ?? null) === (b.contactId ?? null)
}

/** Pure — no I/O. At least one of lead/account/contact must identify the draft,
 * mirroring CreateOfferDialogProps' own contract. */
export function hasAnySubject(s: ConversationSubject): boolean {
  return Boolean(s.leadId || s.accountId || s.contactId)
}

/**
 * Turn rows (already ordered by the caller) → proper Anthropic message
 * history. Pure — re-sorts defensively by seq so a caller that forgot ORDER
 * BY can't silently replay turns out of order.
 */
export function toMessageHistory(turns: ConversationTurnRow[]): AIMessage[] {
  return [...turns]
    .sort((a, b) => a.seq - b.seq)
    .map((t) => ({ role: t.role, content: t.content }))
}

/**
 * Start a brand-new conversation scoped to this offer draft's identity.
 * Throws on a subject with no lead/account/contact at all — there is nothing
 * to scope the conversation to, and an unscoped conversation cannot be
 * re-validated on the next turn.
 */
export async function createConversation(subject: ConversationSubject, createdBy: string | null): Promise<string> {
  if (!hasAnySubject(subject)) {
    throw new Error('Cannot start a narrative conversation with no lead_id, account_id, or contact_id')
  }
  const { data, error } = await supabaseAdmin
    .from('offer_narrative_conversations' as never)
    .insert({
      lead_id: subject.leadId,
      account_id: subject.accountId,
      contact_id: subject.contactId,
      created_by: createdBy,
    } as never)
    .select('id')
    .single()
  if (error || !data) {
    throw new Error(`Could not start narrative conversation: ${error?.message ?? 'no row returned'}`)
  }
  return (data as unknown as { id: string }).id
}

/**
 * Re-derive the conversation's scope from the STORED row and confirm it
 * matches what the caller claims this turn — see the module header. Also
 * returns the full turn history in seq order.
 */
export async function loadConversation(
  conversationId: string,
  claimedSubject: ConversationSubject,
): Promise<LoadConversationResult> {
  const { data: convoRow, error: convoErr } = await supabaseAdmin
    .from('offer_narrative_conversations' as never)
    .select('id, lead_id, account_id, contact_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (convoErr) return { ok: false, error: `Conversation lookup failed: ${convoErr.message}` }
  if (!convoRow) {
    return { ok: false, error: 'This conversation was not found — it may have expired. Starting a new one.' }
  }
  const row = convoRow as unknown as { id: string; lead_id: string | null; account_id: string | null; contact_id: string | null }
  const stored: ConversationSubject = { leadId: row.lead_id, accountId: row.account_id, contactId: row.contact_id }
  if (!sameSubject(stored, claimedSubject)) {
    return {
      ok: false,
      error: 'This conversation belongs to a different client/offer draft — refused so two clients\' narratives can never blend. Starting a new one.',
    }
  }

  const { data: turnRows, error: turnErr } = await supabaseAdmin
    .from('offer_narrative_turns' as never)
    .select('seq, role, content')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: true })
  if (turnErr) return { ok: false, error: `Could not load conversation history: ${turnErr.message}` }

  return { ok: true, conversationId, subject: stored, turns: (turnRows ?? []) as unknown as ConversationTurnRow[] }
}

/**
 * Append a user+assistant EXCHANGE atomically — both rows land in ONE
 * multi-row INSERT (a single Postgres statement either inserts every row it
 * names or none of them), so a conversation can never be left with a
 * dangling turn that has no reply.
 *
 * That matters beyond tidiness: Anthropic's Messages API requires roles to
 * strictly alternate. If a 'user' turn were ever persisted with no matching
 * 'assistant' turn (e.g. the AI call for THIS turn succeeded but a naive
 * two-call persist failed between the user and assistant inserts), the NEXT
 * turn would load history ending in 'user' — then callAI appends ANOTHER
 * 'user' message for the new turn, two 'user' messages in a row, which the
 * Anthropic API rejects outright. Persisting the pair as one statement makes
 * that state unreachable: either the whole exchange lands, or the
 * conversation is untouched and simply doesn't remember this one turn.
 *
 * Same max(seq)+1 / unique-violation-retry sequencing as the rest of this
 * module (see the module header) — this just claims two consecutive seqs at
 * once and writes both rows together.
 */
export async function appendTurnPair(
  conversationId: string,
  userContent: string,
  assistantContent: string,
): Promise<{ userSeq: number; assistantSeq: number }> {
  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
    const { data: maxRow, error: maxErr } = await supabaseAdmin
      .from('offer_narrative_turns' as never)
      .select('seq')
      .eq('conversation_id', conversationId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (maxErr) throw new Error(`Could not read conversation sequence: ${maxErr.message}`)
    const base = (maxRow as unknown as { seq: number } | null)?.seq ?? 0
    const userSeq = base + 1
    const assistantSeq = base + 2

    const { error: insErr } = await supabaseAdmin
      .from('offer_narrative_turns' as never)
      .insert([
        { conversation_id: conversationId, seq: userSeq, role: 'user', content: userContent },
        { conversation_id: conversationId, seq: assistantSeq, role: 'assistant', content: assistantContent },
      ] as never)
    if (!insErr) return { userSeq, assistantSeq }
    if (!isUniqueViolation(insErr, TURN_SEQ_CONSTRAINT)) {
      throw new Error(`Could not save conversation exchange: ${insErr.message}`)
    }
    // Another writer (a second tab, a double-send) claimed one of these seqs
    // first — the WHOLE insert failed (multi-row INSERT is all-or-nothing),
    // so nothing is left half-written. Retry with a fresh max.
  }
  throw new Error('Could not allocate a conversation exchange after repeated collisions — too many concurrent writers on this conversation')
}

/**
 * Touch `updated_at` on the conversation row. Best-effort bookkeeping only
 * (never blocks a turn on it) — lets a future admin view sort "most recently
 * discussed" without scanning turns.
 */
export async function touchConversation(conversationId: string): Promise<void> {
  try {
    await supabaseAdmin
      .from('offer_narrative_conversations' as never)
      .update({ updated_at: new Date().toISOString() } as never)
      .eq('id', conversationId)
  } catch (err) {
    console.error('[narrative-conversation] touchConversation failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}
