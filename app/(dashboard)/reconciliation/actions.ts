'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { manualMatch } from '@/lib/bank-feed-matcher'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function matchFeedToInvoice(
  feedId: string,
  paymentId: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const result = await manualMatch(feedId, paymentId)
    if (!result.matched) throw new Error(result.error ?? 'Match failed')
    revalidatePath('/reconciliation')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: `Manual match: feed → payment ${paymentId}`,
  })
}

export async function ignoreFeed(feedId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from('td_bank_feeds')
      .update({ status: 'ignored', updated_at: new Date().toISOString() })
      .eq('id', feedId)
    // A write you did not verify is not a write. Discarding this error is how the review
    // queue silently never worked.
    if (error) throw new Error(`Failed to ignore bank feed: ${error.message}`)
    revalidatePath('/reconciliation')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: 'Bank feed ignored',
  })
}
