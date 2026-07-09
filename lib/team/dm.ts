/**
 * Team Workspace — DM find-or-create (server-only).
 *
 * Single source of truth for "open (or reuse) the direct-message thread between
 * two staff members". Extracted from app/api/team/dms/route.ts so that route AND
 * the Share-to-Team endpoint (app/api/team/share) create DMs the exact same way
 * — deduped by dm_key, race-safe on the partial-unique index. Never hand-roll a
 * DM insert again; call this.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { dmKey } from '@/lib/team/workspace'

export interface FindOrCreateDmResult {
  /** The internal_threads row (thread_type='dm'). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  thread: any
  /** True when an existing DM was reused rather than created. */
  reused: boolean
}

/**
 * Find-or-create the DM thread between `userId` and `otherId`.
 * Order-independent (dm_key sorts the pair). Does NOT validate that either id is
 * a real staff member — the caller must do that (both current callers do).
 * Throws only on an unexpected DB error; the create-race (23505) is recovered.
 */
export async function findOrCreateDm(
  userId: string,
  otherId: string,
): Promise<FindOrCreateDmResult> {
  const key = dmKey(userId, otherId)

  // Reuse an existing DM thread if present.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('*')
    .eq('dm_key', key)
    .maybeSingle()
  if (existing) return { thread: existing, reused: true }

  const now = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread, error } = await (supabaseAdmin as any)
    .from('internal_threads')
    .insert({
      thread_type: 'dm',
      dm_key: key,
      title: `DM: ${key}`,
      created_by: userId,
      last_activity_at: now,
    })
    .select()
    .single()

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      // Race — someone created it between our check and insert. Fetch and return.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: raced } = await (supabaseAdmin as any)
        .from('internal_threads').select('*').eq('dm_key', key).maybeSingle()
      if (raced) return { thread: raced, reused: true }
    }
    throw new Error(error.message)
  }

  return { thread, reused: false }
}
