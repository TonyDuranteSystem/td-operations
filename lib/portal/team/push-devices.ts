/**
 * Team Powers — which team logins' phones and browsers may receive a COMPANY's chat alerts (dev job e59dd470, bug hunt).
 *
 * A company alert goes to every device registered to the company. A team login's device is registered to the company with no person
 * (app/api/portal/team... /api/portal/push), so nothing used to stop the alert reaching a login that was switched off or removed, or that
 * lost the chat tick. Same rule as the client iPhone app's alert (lib/portal-app/send-to-client-phones.ts): only a login that is ACTIVE
 * and may see CHAT gets it. Checked at SEND time, so it holds even if no cleanup ever ran.
 *
 * `teamLoginsBarredFromAlerts` and `filterAlertDevices` are pure (unit-tested); the two database helpers are the only code that touches the tables.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { hasCapability, normalizeCapabilities } from '@/lib/portal/team/capabilities'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = () => supabaseAdmin as any

/** The sign-in ids of the team logins whose devices must NOT get the company's alerts: anyone not active, or active without the chat tick. */
export function teamLoginsBarredFromAlerts(rows: ReadonlyArray<{ auth_user_id: string; status: string; capabilities: unknown }>): Set<string> {
  const barred = new Set<string>()
  for (const r of rows) {
    if (r.status !== 'active' || !hasCapability(normalizeCapabilities(r.capabilities), 'chat')) barred.add(r.auth_user_id)
  }
  return barred
}

/** Drops the devices of barred team logins. A device with no sign-in id cannot be shown to be a team login's and stays (unchanged legacy behaviour). */
export function filterAlertDevices<T extends { user_id?: string | null }>(devices: T[], barred: ReadonlySet<string>): T[] {
  if (barred.size === 0) return devices
  return devices.filter((d) => !d.user_id || !barred.has(d.user_id))
}

/** Reads this company's team logins and answers which are barred. THROWS on a database error (the caller decides what to do). */
export async function barredTeamLoginIds(accountId: string): Promise<Set<string>> {
  const { data, error } = await sb().from('portal_team_members').select('auth_user_id, status, capabilities').eq('account_id', accountId)
  if (error) throw new Error(error.message)
  return teamLoginsBarredFromAlerts((data ?? []) as Array<{ auth_user_id: string; status: string; capabilities: unknown }>)
}

/** Deletes every alert device of one login (used when it is removed for good). THROWS on a database error. Returns how many were deleted. */
export async function endAlertDevicesOfLogin(authUserId: string): Promise<number> {
  const { data, error } = await sb().from('push_subscriptions').delete().eq('user_id', authUserId).select('id')
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown[]).length
}
