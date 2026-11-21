/**
 * Team Powers — the "choose your own password" step, enforced by the SERVER.
 *
 * A team login is created with a temporary password the owner hands over. Until the colleague sets their own, the login carries
 * `must_change_password: true` in its APP metadata. App metadata can be written ONLY by the server (the service key); a
 * signed-in person cannot edit it from the browser, unlike their user metadata. While the flag is on, the portal treats the
 * login as having no access at all (see resolvePortalIdentity), and the only thing it can do is set its own password through
 * /api/portal/change-password, which clears the flag.
 *
 * The same flag is also kept in user metadata, only so the screen can send the person to the password page; it is never
 * the thing that is trusted.
 */
import type { User } from '@supabase/supabase-js'

export function isTeamLogin(user: Pick<User, 'app_metadata'>): boolean {
  return (user.app_metadata as Record<string, unknown> | undefined)?.kind === 'team_member'
}

/** True for a team login that has not yet chosen its own password (server-written flag). */
export function teamMustChangePassword(user: Pick<User, 'app_metadata'>): boolean {
  const meta = (user.app_metadata ?? {}) as Record<string, unknown>
  return meta.kind === 'team_member' && meta.must_change_password === true
}
