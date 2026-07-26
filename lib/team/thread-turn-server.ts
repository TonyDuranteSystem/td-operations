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
    // Every reply under those roots, ascending so the last write per root wins.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rp, error: rpErr } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('root_id, sender_id, sender_name, created_at')
      .in('root_id', part)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (replyRows ?? []) as any[]) {
    // Ascending order → the last assignment per root is the newest message.
    lastByRoot.set(r.root_id, { sender_id: r.sender_id, created_at: r.created_at })
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
