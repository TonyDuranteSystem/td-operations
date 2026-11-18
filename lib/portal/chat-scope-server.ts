/**
 * Server-side half of per-company chat scoping. The privacy decision (may a
 * contact's personal/NULL messages appear inside a company thread?) MUST be made
 * here with supabaseAdmin, never derived from a client-supplied value. Pure
 * predicate lives in ./chat-scope; this file only gathers the DB inputs.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { hasSeparatePersonalChat, mayIncludePersonalNull } from './chat-scope'
import { getChatMembership, getInProgressFormations } from './queries'

/**
 * True only when `accountId` is sole-owned by `viewerContactId` (exactly one
 * linked contact == the viewer) AND the viewer has no separate personal chat.
 * Any second linked contact (a member, i.e. a shared MMLLC thread) ⇒ false, so
 * personal messages never leak to others. A viewer who ALSO belongs to a shared
 * company (and has no company being set up) has a separate personal chat, so
 * their private messages never show inside this company either (dev job
 * 58cb7a82) — the same rule, from the same inputs, as the chat entity list.
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
  const ownedAlone = mayIncludePersonalNull({
    linkedContactCount: ids.length,
    viewerIsSoleLinkedContact: ids.length === 1 && ids[0] === viewerContactId,
  })
  if (!ownedAlone) return false
  const { hasSoleOwned, hasShared } = await getChatMembership(viewerContactId)
  // Only a viewer who is also in a shared company can have a separate personal chat here, and a company being set up
  // would host the private messages instead — so look for one only in that case.
  const hasFormation = hasShared ? (await getInProgressFormations(viewerContactId)).length > 0 : false
  return !hasSeparatePersonalChat({ hasSoleOwned, hasShared, hasFormation })
}
