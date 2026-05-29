/**
 * Portal identity resolver — the SINGLE seam through which the portal learns who
 * the logged-in user is. Every portal page / API route / layout should resolve
 * identity here instead of reading app_metadata.contact_id directly, so that
 * teammates (Portal Team Access, Option B) are handled uniformly.
 *
 * Returns a discriminated union:
 *   - 'contact'  : a normal client (a contact linked to one or more accounts) — unchanged behavior
 *   - 'teammate' : an employee granted scoped access to ONE company (portal_team_members)
 *   - 'none'     : identity could not be resolved → callers MUST deny (deny-by-default)
 *
 * Teammate capabilities are read FRESH from the table (not from the token), so
 * edits/revocations take effect immediately.
 *
 * Design: sysdoc 'portal-team-access-design'.
 */
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { normalizeCapabilities, type CapabilityFlags } from './team/capabilities'

export type PortalIdentity =
  | { kind: 'contact'; contactId: string; accountIds: string[] }
  | {
      kind: 'teammate'
      teamMemberId: string
      accountId: string
      displayName: string
      email: string | null
      capabilities: CapabilityFlags
    }
  | { kind: 'none' }

// Injectable deps so the security-critical branches are unit-testable without a DB.
export interface ResolveDeps {
  fetchTeamMemberByAuthId: (authUserId: string) => Promise<{
    id: string
    account_id: string
    display_name: string
    email: string | null
    capabilities: unknown
    status: string
  } | null>
  getContactId: (user: User) => string | null
  getAccountIds: (contactId: string) => Promise<string[]>
}

type TeamMemberRow = Awaited<ReturnType<ResolveDeps['fetchTeamMemberByAuthId']>>

const defaultDeps: ResolveDeps = {
  fetchTeamMemberByAuthId: async (authUserId) => {
    // portal_team_members is not yet in the generated DB types — cast the builder.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabaseAdmin as any)
      .from('portal_team_members')
      .select('id, account_id, display_name, email, capabilities, status')
      .eq('auth_user_id', authUserId)
      .maybeSingle()
    return (data as TeamMemberRow) ?? null
  },
  getContactId: getClientContactId,
  getAccountIds: getClientAccountIds,
}

export async function resolvePortalIdentity(
  user: User,
  deps: ResolveDeps = defaultDeps,
): Promise<PortalIdentity> {
  const meta = (user.app_metadata ?? {}) as Record<string, unknown>

  // Teammate branch — gated by the token marker, verified against the live table.
  if (meta.kind === 'team_member') {
    const row = await deps.fetchTeamMemberByAuthId(user.id)
    // Deny-by-default: missing row or non-active status → no access.
    if (!row || row.status !== 'active' || !row.account_id) return { kind: 'none' }
    return {
      kind: 'teammate',
      teamMemberId: row.id,
      accountId: row.account_id,
      displayName: row.display_name,
      email: row.email ?? null,
      capabilities: normalizeCapabilities(row.capabilities),
    }
  }

  // Contact branch — existing client behavior.
  const contactId = deps.getContactId(user)
  if (contactId) {
    const accountIds = await deps.getAccountIds(contactId)
    return { kind: 'contact', contactId, accountIds }
  }

  // Could not resolve → deny-by-default.
  return { kind: 'none' }
}
