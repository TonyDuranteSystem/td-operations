// How many people are on a company's REAL roster right now (the `members` table), for the staff "who sees this message" notice (dev job 8d077f3b).
// The linked-contact mirror (`account_contacts`) can be thinner than the roster: a company can have two members and only one link. The notice
// used to count the links alone, so a person's reply defaulting to such a company went out with no warning at all.
import { supabaseAdmin } from '@/lib/supabase-admin'
import { currentMemberCounts } from '@/lib/crm-lists/people'
import { newYorkToday } from '@/lib/crm-lists/queries'

/** Members of the company whose membership has not ended. A failed read gives 0 (the other counts still warn); it never throws. */
export async function accountMemberCount(accountId: string): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin.from('members').select('account_id, end_date').eq('account_id', accountId)
    if (error || !Array.isArray(data)) return 0
    return currentMemberCounts(data as { account_id: string; end_date: string | null }[], newYorkToday())[accountId] ?? 0
  } catch {
    return 0
  }
}
