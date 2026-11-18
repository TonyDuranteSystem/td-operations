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
import { generatePassword } from '@/lib/portal/team/credentials'
import { recordTeamEvent, recordTeamEventBestEffort, powersGrew, type TeamActor } from '@/lib/portal/team/events'
import {
  eventWriter,
  switchOffTeammate,
  switchOnTeammate,
  type SwitchDeps,
  type SwitchRow,
} from '@/lib/portal/team/switch'
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
          // The notice columns are only written when a notice was actually accepted (older callers send none).
          ...(row.notice_version
            ? { notice_version: row.notice_version, notice_accepted_at: new Date().toISOString(), notice_accepted_ip: row.notice_accepted_ip ?? null }
            : {}),
        })
        .select('id')
        .single()
      if (error || !data) {
        // Keep the database's error code so a "already exists" refusal (double click / username race) can be told apart.
        throw Object.assign(new Error(error?.message || 'Failed to save team member'), { code: error?.code })
      }
      return { id: data.id }
    },
    deleteAuthUser: async (authUserId) => {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(authUserId)
      if (error) throw new Error(error.message)
    },
    deleteTeamMember: async (teamMemberId) => {
      const { error } = await sb().from('portal_team_members').delete().eq('id', teamMemberId)
      if (error) throw new Error(error.message)
    },
    recordAdded: async (info) => {
      await recordTeamEvent(sb(), {
        teamMemberId: info.teamMemberId,
        accountId: info.accountId,
        event: 'added',
        actor: { kind: 'owner', contactId: info.createdByContactId, ip: info.ip },
        detail: { username: info.username, display_name: info.displayName, capabilities: info.capabilities, notice_version: info.noticeVersion },
      })
    },
    newToken: () => randomUUID().slice(0, 12),
    // A Member / Owner of this company with the same name: they get their own full login, never a team login.
    findCompanyMemberByName: async (accountId, displayName) => {
      const wanted = displayName.trim().toLowerCase().replace(/\s+/g, ' ')
      const { data } = await sb()
        .from('account_contacts')
        .select('role, contacts:contact_id(full_name)')
        .eq('account_id', accountId)
      for (const row of (data ?? []) as Array<{ role: string | null; contacts: { full_name: string | null } | null }>) {
        const name = (row.contacts?.full_name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
        if (name && name === wanted) return { name: row.contacts?.full_name ?? null, role: row.role ?? null }
      }
      return null
    },
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

/**
 * Edit a teammate's powers and/or name. Scoped to the account, and only while the person is active.
 * Every change of powers is written to the team record; ADDING a power is strict (no record, no grant: the old powers are put back).
 */
export async function updateTeammate(
  id: string,
  accountId: string,
  patch: { capabilities?: unknown; display_name?: string },
  actor: TeamActor,
) {
  const { data: before } = await sb()
    .from('portal_team_members')
    .select('capabilities, status')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!before) throw new Error('Team member not found')
  if (before.status !== 'active') throw new Error('This team member is switched off or removed')
  const beforeCaps = normalizeCapabilities(before.capabilities)

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const afterCaps = patch.capabilities !== undefined ? normalizeCapabilities(patch.capabilities) : undefined
  if (afterCaps !== undefined) update.capabilities = afterCaps
  if (patch.display_name !== undefined) update.display_name = patch.display_name
  const { data: changed, error } = await sb()
    .from('portal_team_members')
    .update(update)
    .eq('id', id)
    .eq('account_id', accountId)
    .eq('status', 'active') // never edit a person TD or the owner switched off a moment ago
    .select('id')
  if (error) throw new Error(error.message)
  if (!changed || changed.length === 0) throw new Error('This team member was changed by someone else. Refresh and try again.')

  if (afterCaps !== undefined && JSON.stringify(afterCaps) !== JSON.stringify(beforeCaps)) {
    const input = { teamMemberId: id, accountId, event: 'powers_changed' as const, actor, detail: { before: beforeCaps, after: afterCaps } }
    if (powersGrew(beforeCaps, afterCaps)) {
      try {
        await recordTeamEvent(sb(), input)
      } catch {
        // No record, no grant: put the old powers back.
        await sb().from('portal_team_members').update({ capabilities: beforeCaps, updated_at: new Date().toISOString() }).eq('id', id).eq('account_id', accountId)
        throw new Error('We could not save the record of this change, so the powers were not changed. Please try again.')
      }
    } else {
      await recordTeamEventBestEffort(sb(), input)
    }
  }
  return { ok: true }
}

/**
 * Remove a team member FOR GOOD: mark revoked AND ban the auth login. Scoped to the account. Cannot be undone from the screens
 * (the person is added again instead). Any earlier switch-off stamp is cleared so a removed person can never be "switched on".
 */
export async function revokeTeammate(id: string, accountId: string, actor: TeamActor) {
  const { data: row } = await sb()
    .from('portal_team_members')
    .select('auth_user_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!row) throw new Error('Team member not found')
  const { error: updErr } = await sb()
    .from('portal_team_members')
    .update({ status: 'revoked', switched_off_at: null, switched_off_by: null, switched_off_reason: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
  if (updErr) {
    // Removing someone is a safety action: if the database does not have the switch-off columns yet (code deployed before the
    // database change), still remove them the old way rather than leave them in.
    if (updErr.code !== '42703' && !/switched_off/i.test(updErr.message ?? '')) throw new Error(updErr.message)
    const { error: oldErr } = await sb()
      .from('portal_team_members')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
    if (oldErr) throw new Error(oldErr.message)
  }
  // Ban the login so any existing session is cut, not just future resolves.
  await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: '876000h' })
  await recordTeamEventBestEffort(sb(), { teamMemberId: id, accountId, event: 'removed', actor })
  return { ok: true }
}

/** The real database + login wiring for switch off / on (the rules live in lib/portal/team/switch.ts). */
export function switchDeps(): SwitchDeps {
  return {
    getRow: async (id, accountId) => {
      const { data } = await sb()
        .from('portal_team_members')
        .select('id, account_id, auth_user_id, status, switched_off_at, switched_off_by, switched_off_reason')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle()
      return (data as SwitchRow | null) ?? null
    },
    markOff: async (id, accountId, by, reason, atIso) => {
      const { data, error } = await sb()
        .from('portal_team_members')
        .update({ status: 'revoked', switched_off_at: atIso, switched_off_by: by, switched_off_reason: reason || null, updated_at: atIso })
        .eq('id', id)
        .eq('account_id', accountId)
        .eq('status', 'active')
        .select('id')
      if (error) throw new Error(error.message)
      return (data?.length ?? 0) > 0
    },
    markOn: async (id, accountId, actorKind) => {
      let q = sb()
        .from('portal_team_members')
        .update({ status: 'active', switched_off_at: null, switched_off_by: null, switched_off_reason: null, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', accountId)
        .eq('status', 'revoked')
        .not('switched_off_at', 'is', null)
      // An owner may only undo an OWNER's switch-off; TD may undo either.
      if (actorKind === 'owner') q = q.eq('switched_off_by', 'owner')
      const { data, error } = await q.select('id')
      if (error) throw new Error(error.message)
      return (data?.length ?? 0) > 0
    },
    restoreOff: async (row) => {
      await sb()
        .from('portal_team_members')
        .update({ status: 'revoked', switched_off_at: row.switched_off_at, switched_off_by: row.switched_off_by, switched_off_reason: row.switched_off_reason, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('account_id', row.account_id)
    },
    setBan: async (authUserId, banned) => {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(authUserId, { ban_duration: banned ? '876000h' : 'none' })
      if (error) throw new Error(error.message)
    },
    record: eventWriter(sb()),
  }
}

/** Switch a team member OFF (reversible). The caller has already checked who may press the button. */
export function switchTeammateOff(id: string, accountId: string, actor: TeamActor, reason: unknown) {
  return switchOffTeammate(id, accountId, actor, reason, switchDeps())
}

/** Switch a team member back ON. The caller has already checked who may press the button; TD's switch-off can only be undone by TD. */
export function switchTeammateOn(id: string, accountId: string, actor: TeamActor) {
  return switchOnTeammate(id, accountId, actor, switchDeps())
}

/**
 * Owner-managed password reset, no email involved. The SYSTEM makes the new password and returns it ONCE for the handover
 * message; the colleague must choose their own at the next login. Scoped to the account.
 * Refuses anything that is not a team login (so this can never change a real client's password).
 */
export async function resetTeammatePassword(id: string, accountId: string, actor: TeamActor): Promise<{ ok: true; username: string; password: string }> {
  const { data: row } = await sb()
    .from('portal_team_members')
    .select('auth_user_id, username, status')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!row) throw new Error('Team member not found')
  if (row.status !== 'active') throw new Error('This team member has been removed or switched off')
  const { data: existing } = await supabaseAdmin.auth.admin.getUserById(row.auth_user_id)
  const meta = (existing?.user?.app_metadata ?? {}) as Record<string, unknown>
  if (meta.kind !== 'team_member' || meta.role !== 'client' || meta.contact_id) {
    throw new Error('This login is not a team login, so its password cannot be reset here')
  }
  const password = generatePassword()
  const { error } = await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, {
    password,
    user_metadata: { ...(existing?.user?.user_metadata ?? {}), must_change_password: true },
  })
  if (error) throw new Error(error.message)
  // The new password is already set, so the owner must get it even if the log line fails (best effort).
  await recordTeamEventBestEffort(sb(), { teamMemberId: id, accountId, event: 'password_reset', actor })
  return { ok: true, username: row.username, password }
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
