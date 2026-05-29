/**
 * Portal Team Access — server-side glue (DB + auth-admin backed).
 * Thin, real implementations used by the /api/portal/team routes. Authorization
 * (account-admin check) is enforced in the routes via assertAccountAdmin.
 *
 * Design: sysdoc 'portal-team-access-design'.
 */
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'
import { provisionTeammate, type TeammateInput, type ProvisionDeps } from '@/lib/portal/team/provision'
import { normalizeCapabilities } from '@/lib/portal/team/capabilities'
import { randomUUID } from 'crypto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = () => supabaseAdmin as any

/**
 * Authorize that `user` is the account admin of `accountId`.
 * Returns the admin contact id, or null if not authorized.
 */
export async function assertAccountAdmin(user: User, accountId: string): Promise<string | null> {
  if (!accountId) return null
  const identity = await resolvePortalIdentity(user)
  // Only a real client-contact can be an admin; teammates can NEVER manage the team.
  if (identity.kind !== 'contact') return null
  const ok = await isAccountAdmin(identity.contactId, accountId)
  return ok ? identity.contactId : null
}

/** ProvisionDeps backed by supabaseAdmin + the auth admin API. */
export function provisionDeps(): ProvisionDeps {
  return {
    usernameTaken: async (usernameLower) => {
      const { data } = await sb()
        .from('portal_team_members')
        .select('id')
        .eq('username', usernameLower) // stored lowercased? we store as given; compare case-insensitively below
        .maybeSingle()
      if (data) return true
      // Case-insensitive check against the unique lower(username) index.
      const { data: ci } = await sb()
        .from('portal_team_members')
        .select('id')
        .ilike('username', usernameLower)
        .maybeSingle()
      return !!ci
    },
    createAuthUser: async ({ email, password, appMetadata, userMetadata }) => {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: appMetadata,
        user_metadata: userMetadata,
      })
      if (error || !data?.user) throw new Error(error?.message || 'Failed to create login')
      return { id: data.user.id }
    },
    insertTeamMember: async (row) => {
      const { data, error } = await sb()
        .from('portal_team_members')
        .insert({
          account_id: row.account_id,
          auth_user_id: row.auth_user_id,
          username: row.username,
          display_name: row.display_name,
          email: row.email,
          capabilities: row.capabilities,
          created_by: row.created_by,
          disclaimer_accepted_at: new Date().toISOString(),
          disclaimer_accepted_by: row.created_by,
          status: 'active',
        })
        .select('id')
        .single()
      if (error || !data) throw new Error(error?.message || 'Failed to save team member')
      return { id: data.id }
    },
    newToken: () => randomUUID().slice(0, 12),
  }
}

export async function createTeammate(input: TeammateInput) {
  return provisionTeammate(input, provisionDeps())
}

/** List teammates for an account (admin view). */
export async function listTeammates(accountId: string) {
  const { data } = await sb()
    .from('portal_team_members')
    .select('id, username, display_name, email, capabilities, status, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  return (data ?? []).map((r: Record<string, unknown>) => ({
    ...r,
    capabilities: normalizeCapabilities(r.capabilities),
  }))
}

/** Edit a teammate's capabilities and/or email. Scoped to the account for safety. */
export async function updateTeammate(
  id: string,
  accountId: string,
  patch: { capabilities?: unknown; email?: string | null; display_name?: string },
) {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.capabilities !== undefined) update.capabilities = normalizeCapabilities(patch.capabilities)
  if (patch.email !== undefined) update.email = patch.email
  if (patch.display_name !== undefined) update.display_name = patch.display_name
  const { error } = await sb()
    .from('portal_team_members')
    .update(update)
    .eq('id', id)
    .eq('account_id', accountId)
  if (error) throw new Error(error.message)
  return { ok: true }
}

/** Revoke access: mark revoked AND ban the auth login. Scoped to the account. */
export async function revokeTeammate(id: string, accountId: string) {
  const { data: row } = await sb()
    .from('portal_team_members')
    .select('auth_user_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!row) throw new Error('Team member not found')
  await sb()
    .from('portal_team_members')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
  // Ban the login so any existing session is cut, not just future resolves.
  await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: '876000h' })
  return { ok: true }
}

/** Owner-managed password reset (no email needed). Scoped to the account. */
export async function resetTeammatePassword(id: string, accountId: string, newPassword: string) {
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters')
  const { data: row } = await sb()
    .from('portal_team_members')
    .select('auth_user_id, status')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!row) throw new Error('Team member not found')
  const { error } = await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { password: newPassword })
  if (error) throw new Error(error.message)
  return { ok: true }
}

/**
 * Resolve the auth email for a username login (active teammates only).
 * Returns null if not found (caller returns a generic error — don't reveal existence).
 */
export async function resolveAuthEmailForUsername(username: string): Promise<string | null> {
  const uname = (username ?? '').trim()
  if (!uname) return null
  const { data: row } = await sb()
    .from('portal_team_members')
    .select('auth_user_id, status')
    .ilike('username', uname)
    .maybeSingle()
  if (!row || row.status !== 'active') return null
  const { data } = await supabaseAdmin.auth.admin.getUserById(row.auth_user_id)
  return data?.user?.email ?? null
}
