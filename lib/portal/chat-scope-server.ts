/**
 * Server-side half of per-company chat scoping. The privacy decision (may a
 * contact's personal/NULL messages appear inside a company thread?) MUST be made
 * here with supabaseAdmin, never derived from a client-supplied value. Pure
 * predicate lives in ./chat-scope; this file only gathers the DB inputs.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { mayIncludePersonalNull } from './chat-scope'

/**
 * True only when `accountId` is sole-owned by `viewerContactId` (exactly one
 * linked contact == the viewer). Any second linked contact (a member, i.e. a
 * shared MMLLC thread) ⇒ false, so personal messages never leak to others.
 */
export async function resolvePersonalNullInclusion(
  accountId: string,
  viewerContactId: string,
): Promise<boolean> {
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id')
    .eq('account_id', accountId)
  const ids = (links ?? []).map((r) => r.contact_id as string)
  return mayIncludePersonalNull({
    linkedContactCount: ids.length,
    viewerIsSoleLinkedContact: ids.length === 1 && ids[0] === viewerContactId,
  })
}
