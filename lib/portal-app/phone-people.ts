/**
 * Client iPhone app — two small checks the phone alert leg makes about the PEOPLE behind saved phones (bug hunt 2026-11-10, finding 10; docs/systems/client-app.md).
 * A saved phone only remembers who owned it when it was registered. Before sending, the leg now also asks:
 *   - is the person still linked to the company right now? (`isCurrentLink`: not ended, access not revoked, access not past its end date)
 *   - is the login suspended? (`loginIsBanned`: the same "ban" the CRM sets when it suspends a client's portal access)
 * PURE functions here; `liveBannedUserIds` does the database lookup and FAILS OPEN on any error (the lock-screen words carry no details, so a failed
 * lookup must not silence everyone's alerts; the next alert checks again).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export interface LinkRow {
  contact_id: string | null
  ended_at?: string | null
  access_revoked_at?: string | null
  access_until?: string | null
}

/** A contact↔company link that still counts as "this person is linked to the company right now". */
export function isCurrentLink(link: LinkRow, nowMs: number): boolean {
  if (!link.contact_id) return false
  if (link.ended_at) return false
  if (link.access_revoked_at) return false
  if (link.access_until) {
    const until = Date.parse(link.access_until)
    if (Number.isFinite(until) && until <= nowMs) return false
  }
  return true
}

/** A login whose `banned_until` lies in the future is suspended. Missing / unreadable = not banned (see the file note). */
export function loginIsBanned(bannedUntil: unknown, nowMs: number): boolean {
  if (typeof bannedUntil !== 'string' || bannedUntil.length === 0) return false
  const t = Date.parse(bannedUntil)
  return Number.isFinite(t) && t > nowMs
}

/** The ids (out of `userIds`) whose login is suspended right now. Any lookup failure for a person = that person is treated as not suspended. */
export async function liveBannedUserIds(userIds: readonly string[], nowMs: number = Date.now()): Promise<Set<string>> {
  const banned = new Set<string>()
  const ids = Array.from(new Set(userIds))
  await Promise.all(ids.map(async id => {
    try {
      // The auth admin API drops banned_until for some logins in the deployed runtime, so the database function is asked first (same as the CRM audit).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabaseAdmin as any).rpc('get_auth_user_banned_until', { p_user_id: id })
      let until: unknown = data
      if (error) {
        const { data: byId } = await supabaseAdmin.auth.admin.getUserById(id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        until = (byId?.user as any)?.banned_until ?? null
      }
      if (loginIsBanned(until, nowMs)) banned.add(id)
    } catch {
      /* not suspended as far as we can tell */
    }
  }))
  return banned
}
