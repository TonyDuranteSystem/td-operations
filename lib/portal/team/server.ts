/**
 * Portal Team Access — server-side glue (DB + auth-admin backed).
 * Thin, real implementations used by the /api/portal/team routes. Authorization
 * (the who-may-manage check) is enforced in the routes via assertAccountAdmin.
 *
 * Design: sysdoc 'portal-team-access-design'.
 */
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'
import { provisionTeammate, type TeammateInput, type ProvisionDeps } from '@/lib/portal/team/provision'
import { normalizeCapabilities } from '@/lib/portal/team/capabilities'
import { generatePassword, escapeLikePattern } from '@/lib/portal/team/credentials'
import { canonicalTeamUsername } from '@/lib/portal/team/login-guard'
import { recordTeamEvent, recordTeamEventBestEffort, powersGrew, type TeamActor } from '@/lib/portal/team/events'
import { enqueueTeamNotices } from '@/lib/portal/team/notify'
import type { Confirmation } from '@/lib/portal/team/confirm'
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
 * Authorize that `user` may manage the team of `accountId` — a current owner or member of that company (see may-manage.ts).
 * Returns the person's contact id, or null if not authorized.
 */
export async function assertAccountAdmin(user: User, accountId: string): Promise<string | null> {
  if (!accountId) return null
  const identity = await resolvePortalIdentity(user)
  // Only a real client-contact can manage; teammates can NEVER manage the team.
  if (identity.kind !== 'contact') return null
  // The company must also be one of the person's own portal companies (a second, independent check).
  if (!identity.accountIds.includes(accountId)) return null
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
        .ilike('username', escapeLikePattern(usernameLower))
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
        detail: { username: info.username, display_name: info.displayName, capabilities: info.capabilities, notice_version: info.noticeVersion, notice_text: info.noticeText },
      })
      // Every owner and member is told (that email is the safety net). If nobody can be told, the add is undone with the rest.
      await enqueueTeamNotices({ accountId: info.accountId, teamMemberId: info.teamMemberId, kind: 'added', actorContactId: info.createdByContactId })
    },
    newToken: () => randomUUID().slice(0, 12),
    // A Member / Owner of this company with the same name: they get their own full login, never a team login.
    findCompanyMemberByName: async (accountId, displayName) => {
      const wanted = displayName.trim().toLowerCase().replace(/\s+/g, ' ')
      // portal-access-ok: roster check (a member is never given a second, team login), whether or not they use the portal
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

/** Thrown when powers would grow but the owner has not confirmed (notice + password). The route turns it into a 409 so the screen asks. */
export class ConfirmationRequiredError extends Error {
  code = 'confirmation_required' as const
  constructor() {
    super('Giving more powers needs your confirmation: read the notice and enter your password.')
    this.name = 'ConfirmationRequiredError'
  }
}

export type TeammateState = 'active' | 'off_owner' | 'off_td' | 'removed'

/** active / switched off by the owner / switched off by TD / removed for good — from a row's status and switch-off stamp. */
export function teammateState(r: { status?: unknown; switched_off_at?: unknown; switched_off_by?: unknown }): TeammateState {
  if (r.status === 'active') return 'active'
  if (r.switched_off_at) return r.switched_off_by === 'td' ? 'off_td' : 'off_owner'
  return 'removed'
}

/** List teammates for an account (owner view): active and switched-off people; people removed for good are not listed. */
export async function listTeammates(accountId: string) {
  const full = await sb()
    .from('portal_team_members')
    .select('id, username, display_name, email, capabilities, status, created_at, switched_off_by, switched_off_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  let rows = full.data as Array<Record<string, unknown>> | null
  if (full.error) {
    // Code deployed before the database change (the switch-off fields do not exist yet): list the way it always was.
    const old = await sb()
      .from('portal_team_members')
      .select('id, username, display_name, email, capabilities, status, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    rows = old.data as Array<Record<string, unknown>> | null
  }
  return (rows ?? [])
    .map((r) => ({ ...r, state: teammateState(r), capabilities: normalizeCapabilities(r.capabilities) }))
    .filter((r) => r.state !== 'removed')
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
  confirmation: Confirmation | null = null,
) {
  const { data: before } = await sb()
    .from('portal_team_members')
    .select('capabilities, status, notice_version, notice_accepted_at, notice_accepted_ip')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!before) throw new Error('Team member not found')
  if (before.status !== 'active') throw new Error('This team member is switched off or removed')
  const beforeCaps = normalizeCapabilities(before.capabilities)

  const stamp = new Date().toISOString()
  const update: Record<string, unknown> = { updated_at: stamp }
  const afterCaps = patch.capabilities !== undefined ? normalizeCapabilities(patch.capabilities) : undefined
  const grows = afterCaps !== undefined && powersGrew(beforeCaps, afterCaps)
  // Giving MORE power needs the owner's confirmation (the notice + their password), checked by the caller and passed here.
  // The server refuses the grant without it, whatever the screen did.
  if (grows && !confirmation) throw new ConfirmationRequiredError()
  if (afterCaps !== undefined) update.capabilities = afterCaps
  if (grows && confirmation) {
    update.notice_version = confirmation.version
    update.notice_accepted_at = stamp
    update.notice_accepted_ip = confirmation.ip
  }
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
    const addedKeys = Object.keys(afterCaps).filter((k) => (afterCaps as Record<string, boolean>)[k] === true && (beforeCaps as Record<string, boolean | undefined>)[k] !== true)
    const input = {
      teamMemberId: id, accountId, event: 'powers_changed' as const, actor,
      detail: { before: beforeCaps, after: afterCaps, ...(grows && confirmation ? { notice_version: confirmation.version, notice_text: confirmation.text } : {}) },
    }
    if (grows) {
      try {
        await recordTeamEvent(sb(), input)
        // Every owner and member is told. If nobody can be told, the grant is undone below.
        await enqueueTeamNotices({ accountId, teamMemberId: id, kind: 'more', actorContactId: actor.contactId ?? '', addedKeys })
      } catch {
        // No record, no grant: put the old powers back — but only if nobody edited the person since (our stamp is still on the row),
        // and check that it worked (supabase reports a failure in its result; it does not throw).
        const { data: restored, error: restoreErr } = await sb()
          .from('portal_team_members')
          .update({
            capabilities: beforeCaps,
            notice_version: before.notice_version ?? null,
            notice_accepted_at: before.notice_accepted_at ?? null,
            notice_accepted_ip: before.notice_accepted_ip ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('account_id', accountId)
          .eq('updated_at', stamp)
          .select('id')
        if (restoreErr || !restored || restored.length === 0) {
          throw new Error('We could not save the record of this change and could not put the old powers back. Please refresh the team list and check this person\'s powers.')
        }
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
  const first = await sb()
    .from('portal_team_members')
    .select('auth_user_id, switched_off_by')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  let row = first.data
  if (first.error) {
    // Code deployed before the database change: the switch-off fields do not exist yet, so nobody can be switched off by TD either.
    const old = await sb().from('portal_team_members').select('auth_user_id').eq('id', id).eq('account_id', accountId).maybeSingle()
    row = old.data
  }
  if (!row) throw new Error('Team member not found')
  // If Tony Durante LLC switched this person off, the owner may not make that permanent (it would end TD's ability to switch them on).
  if (actor.kind === 'owner' && row.switched_off_by === 'td') {
    throw new Error('Tony Durante LLC switched this person off. Please contact us before removing them.')
  }
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
  // Ban the login so any existing session is cut, not just future resolves. The result must be checked: the auth client reports
  // a failure in its result instead of throwing, and a removed login that is not blocked can still call routes that only check "is a client".
  const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: '876000h' })
  await recordTeamEventBestEffort(sb(), { teamMemberId: id, accountId, event: 'removed', actor, detail: banErr ? { ban_failed: true } : undefined })
  if (banErr) throw new Error('The person was removed from the company, but their sign-in could not be fully blocked. Please contact support.')
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
    takeOver: async (id, accountId, reason, atIso) => {
      const { data, error } = await sb()
        .from('portal_team_members')
        .update({ switched_off_by: 'td', switched_off_reason: reason || null, switched_off_at: atIso, updated_at: atIso })
        .eq('id', id)
        .eq('account_id', accountId)
        .eq('status', 'revoked')
        .eq('switched_off_by', 'owner')
        .not('switched_off_at', 'is', null)
        .select('id')
      if (error) throw new Error(error.message)
      return (data?.length ?? 0) > 0
    },
    restoreOff: async (row) => {
      const { error } = await sb()
        .from('portal_team_members')
        .update({ status: 'revoked', switched_off_at: row.switched_off_at, switched_off_by: row.switched_off_by, switched_off_reason: row.switched_off_reason, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('account_id', row.account_id)
      if (error) throw new Error(error.message)
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
    // Server-enforced: until they choose their own password again the login has no access (see password-flag.ts).
    app_metadata: { ...meta, must_change_password: true },
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
  return (await resolveTeamLoginByUsername(username))?.email ?? null
}

/**
 * The active team login with this EXACT username, and its hidden sign-in address. The username must be the one allowed form
 * (login-guard.ts): anything else — a `*` or `%` that a pattern search would read as "anything", a space — finds nobody and never reaches the
 * database, so one login can only ever be found by its own spelling (a lower-case match, nothing wider).
 */
export async function resolveTeamLoginByUsername(username: string): Promise<{ teamMemberId: string; email: string } | null> {
  const uname = canonicalTeamUsername(username)
  if (!uname) return null
  const { data: row } = await sb()
    .from('portal_team_members')
    .select('id, auth_user_id, status')
    .ilike('username', escapeLikePattern(uname))
    .maybeSingle()
  if (!row || row.status !== 'active') return null
  const { data } = await supabaseAdmin.auth.admin.getUserById(row.auth_user_id)
  const email = data?.user?.email
  return email ? { teamMemberId: row.id as string, email } : null
}
