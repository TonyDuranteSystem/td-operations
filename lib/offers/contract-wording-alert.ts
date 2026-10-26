/**
 * Tell staff — in the team chat they actually read, not only in the error log — that a client opened an offer whose
 * NEW service has no approved contract wording (the client sees "your agreement is being prepared"). This should
 * never happen (Send refuses such an offer), so when it does it needs a human today. Said once per offer per six
 * hours so a client refreshing the page cannot flood the channel. SERVER-ONLY. Never throws.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { reportSystemError } from '@/lib/system-errors'
import { postTeamMessage } from '@/lib/team/post-message'

const ROUTE = '/api/offers/view'
const QUIET_HOURS = 6
const CHANNEL = 'td-bug'

export function missingWordingMessage(token: string, types: string[], reason?: string): string {
  if (reason) {
    return `A client opened offer ${token}, but the system could not prepare the contract wording${types.length ? ` of ${types.join(', ')}` : ''} (${reason}), so the client sees "your agreement is being prepared" and cannot sign. Fix: check the message above, then ask the client to reload; if it keeps failing the offer's contract wording needs a person.`
  }
  return `A client opened offer ${token}, but the contract wording of ${types.join(', ')} is not approved, so the client sees "your agreement is being prepared" and cannot sign. Fix: open the service in the Service Catalog, go to its Contract, and approve the draft (or write one). The offer needs no change.`
}

export async function alertMissingContractWording(token: string, types: string[], reason?: string): Promise<void> {
  try {
    const since = new Date(Date.now() - QUIET_HOURS * 3600 * 1000).toISOString()
    const { data } = await supabaseAdmin
      .from('system_errors')
      .select('id')
      .eq('route', ROUTE)
      .ilike('message', `%offer ${token},%`) // the whole token, not a piece of a longer one
      .gte('created_at', since)
      .limit(1)
    if (data && data.length > 0) return
    const message = missingWordingMessage(token, types, reason)
    await reportSystemError({ source: 'server', route: ROUTE, message })
    await postTeamMessage({ channel: CHANNEL, message: `⚠️ ${message}` })
  } catch (e) {
    console.warn('[contract-wording-alert] could not alert staff:', e instanceof Error ? e.message : e)
  }
}
