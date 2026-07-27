/**
 * Team Workspace — server-side read-receipt enrichment.
 *
 * Shared by every surface that lists threads (the per-channel panel, the board,
 * the Later list) so they can never show a different receipt for the same
 * thread. Gathers the two ingredients the pure computeThreadTurn needs — the
 * last message per root and every read pointer on those roots — then computes
 * per-viewer state. NO staff-directory lookup (see the roster-free note in
 * thread-turn.ts): "the other side" is any reader that is not the viewer or AI,
 * so this avoids the expensive listAllAuthUsers call AND the dormant-account
 * trap.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { CLAUDE_SENDER_UUID } from '@/lib/team/workspace'
import { computeThreadTurn, type LastMessage, type ThreadTurn } from '@/lib/team/thread-turn'

/**
 * @param rootIds  the thread root message ids being listed.
 * @param viewerId the caller (whose list this is).
 * @returns rootId → { read_state, waiting_name }. Empty for empty input.
 */
export async function enrichThreadTurn(
  rootIds: string[],
  viewerId: string,
): Promise<Record<string, ThreadTurn>> {
  const ids = Array.from(new Set(rootIds)).filter(Boolean)
  if (ids.length === 0) return {}

  // Chunk the id lists: the board can ask for up to 300 roots, and a single
  // `.in(...)` with hundreds of UUIDs makes a very long request URL. 100 keeps
  // every query URL small while adding at most a few round-trips.
  const chunk = <T,>(arr: T[], size: number): T[][] => {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }
  const idChunks = chunk(ids, 100)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootRows: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replyRows: any[] = []
  for (const part of idChunks) {
    // The root messages themselves (a root with no replies is its own last message).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rr, error: rrErr } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('id, sender_id, sender_name, created_at')
      .in('id', part)
      .is('deleted_at', null)
    // Fail SILENT-BUT-LOGGED, never wrong: supabase-js returns {data:null,error}
    // (it does not throw), so an unchecked error would leave the badge stuck on
    // "waiting" or vanished with no trace. A missing badge means "unknown" —
    // honest — whereas a computed-from-partial-data badge would lie. Log so the
    // failure is observable in Vercel, then drop every badge for this batch.
    if (rrErr) { console.error('enrichThreadTurn: roots query failed', rrErr.message); return {} }
    if (rr) rootRows.push(...rr)
    // Every reply under those roots, DESCENDING (newest first). Deliberately not
    // ascending: PostgREST caps result sets (default ~1000 rows), and an
    // ascending fetch under that cap returns the OLDEST rows and silently drops
    // the newest — so "last message" would be stale and the receipt wrong. Newest
    // first + first-wins-per-root keeps the correct last message even when
    // capped; the worst case becomes a MISSING badge for a very hot thread
    // (honest "unknown"), never a wrong one (senior-engineer review 2026-07-26).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rp, error: rpErr } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('root_id, sender_id, sender_name, created_at')
      .in('root_id', part)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
    if (rpErr) { console.error('enrichThreadTurn: replies query failed', rpErr.message); return {} }
    if (rp) replyRows.push(...rp)
  }

  const lastByRoot = new Map<string, LastMessage>()
  const participantsByRoot = new Map<string, Set<string>>()
  const nameById = new Map<string, string>()

  const noteParticipant = (rootId: string, senderId: string, senderName: string | null) => {
    let set = participantsByRoot.get(rootId)
    if (!set) { set = new Set(); participantsByRoot.set(rootId, set) }
    set.add(senderId)
    if (senderName && !nameById.has(senderId)) nameById.set(senderId, senderName)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (rootRows ?? []) as any[]) {
    lastByRoot.set(r.id, { sender_id: r.sender_id, created_at: r.created_at })
    noteParticipant(r.id, r.sender_id, r.sender_name)
  }
  // Replies are DESCENDING → the FIRST one seen per root is the newest. A reply
  // (always newer than the root) overwrites the root seed once; older replies are
  // ignored. Participants/names still note every reply we did see.
  const replyLastSeen = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (replyRows ?? []) as any[]) {
    if (!replyLastSeen.has(r.root_id)) {
      replyLastSeen.add(r.root_id)
      lastByRoot.set(r.root_id, { sender_id: r.sender_id, created_at: r.created_at })
    }
    noteParticipant(r.root_id, r.sender_id, r.sender_name)
  }

  // Every read pointer on these roots (all users). Internal threads are
  // staff-only, so a non-viewer, non-AI pointer is the other teammate.
  const readsByRoot = new Map<string, Map<string, string>>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readRows: any[] = []
  for (const part of idChunks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rd, error: rdErr } = await (supabaseAdmin as any)
      .from('internal_root_reads')
      .select('root_message_id, user_id, last_read_at')
      .in('root_message_id', part)
    // A read-pointer failure is the worst case to swallow: with no read rows,
    // NOTHING ever computes as "seen", so every outgoing thread would sit on
    // "waiting" forever. Drop the badges instead of asserting a state we can't
    // back up. Logged for observability.
    if (rdErr) { console.error('enrichThreadTurn: reads query failed', rdErr.message); return {} }
    if (rd) readRows.push(...rd)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (readRows ?? []) as any[]) {
    let m = readsByRoot.get(r.root_message_id)
    if (!m) { m = new Map(); readsByRoot.set(r.root_message_id, m) }
    m.set(r.user_id, r.last_read_at)
    // Readers who never posted still count as participants for the name label.
    let set = participantsByRoot.get(r.root_message_id)
    if (!set) { set = new Set(); participantsByRoot.set(r.root_message_id, set) }
    set.add(r.user_id)
  }

  return computeThreadTurn({
    lastByRoot,
    viewerId,
    aiSenderId: CLAUDE_SENDER_UUID,
    readsByRoot,
    participantsByRoot,
    nameById,
  })
}

/**
 * Conversation-grain read receipt for whole threads (DMs + client discussions),
 * where the "thread" IS the conversation and messages are flat (no roots). Same
 * pure computeThreadTurn, keyed by thread id instead of root id. Read pointers
 * come from internal_thread_reads (conversation grain) rather than
 * internal_root_reads. Fails silent-but-logged, never wrong — same rule as
 * enrichThreadTurn.
 *
 * @param threadIds  DM / discussion thread ids being listed in the sidebar.
 * @param viewerId   the caller.
 */
export async function enrichConversationTurn(
  threadIds: string[],
  viewerId: string,
): Promise<Record<string, ThreadTurn>> {
  const ids = Array.from(new Set(threadIds)).filter(Boolean)
  if (ids.length === 0) return {}

  const chunk = <T,>(arr: T[], size: number): T[][] => {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }
  const idChunks = chunk(ids, 100)

  const lastByRoot = new Map<string, LastMessage>()
  const participantsByRoot = new Map<string, Set<string>>()
  const nameById = new Map<string, string>()
  const readsByRoot = new Map<string, Map<string, string>>()

  const noteParticipant = (threadId: string, senderId: string, senderName: string | null) => {
    let set = participantsByRoot.get(threadId)
    if (!set) { set = new Set(); participantsByRoot.set(threadId, set) }
    set.add(senderId)
    if (senderName && !nameById.has(senderId)) nameById.set(senderId, senderName)
  }

  const lastSeenThread = new Set<string>()
  for (const part of idChunks) {
    // Every non-deleted message in these conversations, DESCENDING (newest
    // first). Not ascending: PostgREST caps result sets (~1000 rows) and an
    // ascending fetch under the cap returns the OLDEST rows, dropping the newest
    // — a stale "last message" and a wrong receipt. Newest-first + first-wins-
    // per-thread stays correct even when capped (worst case: a missing badge on
    // a very high-volume conversation, never a wrong one). NOTE: this still
    // transfers all rows; a DISTINCT ON (thread_id) RPC is the bounded upgrade
    // once volume grows (follow-up) — negligible at the current ~hundreds.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: msgs, error: msgErr } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('thread_id, sender_id, sender_name, created_at')
      .in('thread_id', part)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
    if (msgErr) { console.error('enrichConversationTurn: messages query failed', msgErr.message); return {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of (msgs ?? []) as any[]) {
      if (!lastSeenThread.has(m.thread_id)) {
        lastSeenThread.add(m.thread_id)
        lastByRoot.set(m.thread_id, { sender_id: m.sender_id, created_at: m.created_at })
      }
      noteParticipant(m.thread_id, m.sender_id, m.sender_name)
    }

    // Every participant's conversation-grain read pointer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rd, error: rdErr } = await (supabaseAdmin as any)
      .from('internal_thread_reads')
      .select('thread_id, user_id, last_read_at')
      .in('thread_id', part)
    if (rdErr) { console.error('enrichConversationTurn: reads query failed', rdErr.message); return {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (rd ?? []) as any[]) {
      let m = readsByRoot.get(r.thread_id)
      if (!m) { m = new Map(); readsByRoot.set(r.thread_id, m) }
      m.set(r.user_id, r.last_read_at)
      let set = participantsByRoot.get(r.thread_id)
      if (!set) { set = new Set(); participantsByRoot.set(r.thread_id, set) }
      set.add(r.user_id)
    }
  }

  const turn = computeThreadTurn({
    lastByRoot,
    viewerId,
    aiSenderId: CLAUDE_SENDER_UUID,
    readsByRoot,
    participantsByRoot,
    nameById,
  })

  // Suppress the badge on a conversation whose ONLY other party is the AI (an
  // Antonio↔AI DM): there is no human on the other side, so "waiting for them" /
  // "seen" is meaningless and would otherwise stick forever. Safe to decide here
  // at conversation grain (participants ARE the full membership); the shared
  // helper can't assume this for channel threads, where the teammate may simply
  // not have joined a given thread yet.
  for (const threadId of Object.keys(turn)) {
    const parts = participantsByRoot.get(threadId)
    const humanOther = parts && Array.from(parts).some(uid => uid !== viewerId && uid !== CLAUDE_SENDER_UUID)
    if (!humanOther) turn[threadId] = { read_state: 'none', waiting_name: null }
  }

  return turn
}
