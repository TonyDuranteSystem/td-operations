import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Auto-move (dev_task be582c5e, Phase 2). When a LEAD converts into a CLIENT (a
 * new account is created from that lead), move any Team Chat CONVERSATIONS that
 * were manually opened on the lead onto the new account — so the conversation
 * jumps from the "Leads" bucket to "Active clients" automatically.
 *
 * A lead-anchored conversation is an `internal_threads` discussion with a
 * non-null `lead_id` (created only via the team-workspace "New conversation" /
 * "share to a conversation" flows when a human picks a lead). This clears
 * `lead_id` and sets `account_id`, so it re-buckets on the next sidebar load.
 *
 * Design (Antonio 2026-07-12): if the account already has a conversation on the
 * same topic, KEEP BOTH — do not merge (merging risks losing content; a stray
 * duplicate is trivial to clean up).
 *
 * Idempotent: once moved, `lead_id` is null so a re-run is a no-op. Only touches
 * rows still anchored to the lead and NOT yet on an account (`account_id IS NULL`).
 * NEVER throws — it is called from live activation/conversion paths and must
 * never break a conversion.
 */
export interface ReanchorResult {
  moved: number
}

// Minimal client surface so the helper can be unit-tested with a fake.
interface UpdatableClient {
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => {
        eq: (col: string, val: unknown) => {
          is: (col: string, val: unknown) => {
            select: (cols: string) => Promise<{ data: { id: string }[] | null; error: { message: string } | null }>
          }
        }
      }
    }
  }
}

export async function reanchorLeadConversations(
  leadId: string | null | undefined,
  accountId: string | null | undefined,
  client: UpdatableClient = supabaseAdmin as unknown as UpdatableClient,
): Promise<ReanchorResult> {
  if (!leadId || !accountId) return { moved: 0 }
  try {
    const { data, error } = await client
      .from('internal_threads')
      .update({ account_id: accountId, lead_id: null })
      .eq('lead_id', leadId)
      .eq('thread_type', 'discussion')
      .is('account_id', null)
      .select('id')
    if (error) {
      console.error('[reanchorLeadConversations] failed', { leadId, accountId, error: error.message })
      return { moved: 0 }
    }
    return { moved: data?.length ?? 0 }
  } catch (e) {
    console.error('[reanchorLeadConversations] threw', e instanceof Error ? e.message : String(e))
    return { moved: 0 }
  }
}
