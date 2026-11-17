/**
 * Does this person have a Company Formation job that is still waiting for its company (active, no company yet)?
 *
 * Read by the wizard-reminder cron (app/api/cron/wizard-reminders/route.ts): while such a job exists the client still has a
 * formation wizard to complete, so the cron must not close it as "done elsewhere" just because their other companies are formed.
 * On a read error the answer is "yes" — fail toward leaving the wizard open and reminding, never toward silently closing it.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function hasFormationWaitingForItsCompany(contactId: string | null | undefined): Promise<boolean> {
  if (!contactId) return false
  const { count, error } = await supabaseAdmin
    .from('service_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('service_type', 'Company Formation')
    .eq('status', 'active')
    .is('account_id', null)
  if (error) {
    console.error(`[wizard-reminders] could not check for a formation waiting for its company (${contactId}): ${error.message}`)
    return true
  }
  return (count ?? 0) > 0
}
