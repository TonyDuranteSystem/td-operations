/**
 * Portal Team Access — teammate provisioning.
 *
 * Creates a teammate login the account-admin invites: an auth user with
 * role='client' + team_member markers, plus a portal_team_members grant row.
 * Teammates are NOT contacts and NOT in account_contacts.
 *
 * Login is by USERNAME. The auth user needs an email (Supabase requirement); it is ALWAYS a generated, non-deliverable
 * placeholder (dev job e5d5400d, Antonio 2026-10-22: no email at all for team members, for privacy and security). So a
 * colleague's real address is never claimed by a team login, never stored, and the same person can later become a client.
 * The system generates the password; the owner gets a handover message and a Reset password button (no email involved).
 * The username→auth-email translation at login is resolved server-side (see the team-login route, Phase 2b).
 *
 * Design: sysdoc 'portal-team-access-design'.
 */
import { normalizeCapabilities, type CapabilityFlags } from './capabilities'
import { generatePassword, suggestUsername } from './credentials'

export interface TeammateInput {
  accountId: string
  /** Blank = the system suggests one from the display name. */
  username?: string | null
  displayName: string
  capabilities: unknown
  createdByContactId: string
  disclaimerAccepted: boolean
}

export interface NormalizedTeammate {
  accountId: string
  username: string // '' = to be suggested
  displayName: string
  capabilities: CapabilityFlags
  createdByContactId: string
}

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i

/** Pure validation + normalization. Returns errors[] (empty = ok) and the normalized value. */
export function validateTeammateInput(input: TeammateInput): { errors: string[]; value: NormalizedTeammate | null } {
  const errors: string[] = []
  const username = (input.username ?? '').trim()
  const displayName = (input.displayName ?? '').trim()

  if (!input.accountId) errors.push('Missing company')
  if (!input.createdByContactId) errors.push('Missing creator')
  if (!input.disclaimerAccepted) errors.push('The responsibility disclaimer must be accepted')
  if (displayName.length < 2) errors.push('Enter the colleague’s name')
  if (username && !USERNAME_RE.test(username)) errors.push('Username must be 3–30 chars: letters, numbers, dot, dash, underscore')

  const capabilities = normalizeCapabilities(input.capabilities)

  if (errors.length > 0) return { errors, value: null }

  return {
    errors: [],
    value: {
      accountId: input.accountId,
      username,
      displayName,
      capabilities,
      createdByContactId: input.createdByContactId,
    },
  }
}

/** Generate a stable, non-deliverable placeholder email: the team login's address, never shown, never mailed. */
export function generateTeammateEmail(token: string): string {
  return `tm-${token}@teammate.portal.tonydurante.us`
}

export interface ProvisionDeps {
  usernameTaken: (usernameLower: string) => Promise<boolean>
  createAuthUser: (params: {
    email: string
    password: string
    appMetadata: Record<string, unknown>
    userMetadata: Record<string, unknown>
  }) => Promise<{ id: string }>
  insertTeamMember: (row: {
    account_id: string
    auth_user_id: string
    username: string
    display_name: string
    email: string | null
    capabilities: CapabilityFlags
    created_by: string
  }) => Promise<{ id: string }>
  newToken: () => string
  /**
   * A Member / Owner of this company with the same name (a contact linked to it). They get their own full login with the
   * same rights as the owner and must never be made a team member with limited, owner-controlled access (dev job e5d5400d:
   * Victoria / Lead Lift). With no email to match on, the name is the check. Optional so older callers and tests keep working.
   */
  findCompanyMemberByName?: (accountId: string, displayName: string) => Promise<{ name: string | null; role: string | null } | null>
  /** Password maker, injectable for tests. */
  makePassword?: () => string
}

/** The message shown to the owner when the name matches a Member/Owner of the company (Antonio's wording, 2026-10-21/22). */
export function companyMemberMessage(c: { name: string | null; role: string | null }): string {
  const who = c.name ? ` (${c.name}${c.role ? `, ${c.role}` : ''})` : ''
  return `Stop: this person is already a member of this company${who}. Members get their own full login with the same access as you. Please contact support and we will send the login. (If this is a different person with the same name, add a middle initial to the name.)`
}

export interface ProvisionResult {
  ok: boolean
  teamMemberId?: string
  /** Shown to the owner ONCE, in the handover message. */
  username?: string
  password?: string
  errors?: string[]
}

/**
 * Orchestrates teammate creation. Caller MUST have already authorized that the
 * requester is the account admin (see isAccountAdmin) — this function does not
 * re-check authorization.
 */
export async function provisionTeammate(input: TeammateInput, deps: ProvisionDeps): Promise<ProvisionResult> {
  const { errors, value } = validateTeammateInput(input)
  if (!value) return { ok: false, errors }

  if (deps.findCompanyMemberByName) {
    const member = await deps.findCompanyMemberByName(value.accountId, value.displayName)
    if (member) return { ok: false, errors: [companyMemberMessage(member)] }
  }

  let username = value.username
  if (username) {
    if (await deps.usernameTaken(username.toLowerCase())) {
      return { ok: false, errors: ['That username is already taken — pick another'] }
    }
  } else {
    username = await suggestUsername(value.displayName, (u) => deps.usernameTaken(u))
  }

  const password = (deps.makePassword ?? generatePassword)()
  const authEmail = generateTeammateEmail(deps.newToken())

  const authUser = await deps.createAuthUser({
    email: authEmail,
    password,
    appMetadata: {
      role: 'client',
      kind: 'team_member',
      account_id: value.accountId,
    },
    userMetadata: {
      display_name: value.displayName,
      is_team_member: true,
      // The owner hands the first password over by message: the colleague chooses their own at first login.
      must_change_password: true,
    },
  })

  const row = await deps.insertTeamMember({
    account_id: value.accountId,
    auth_user_id: authUser.id,
    username,
    display_name: value.displayName,
    email: null, // no email at all for team members
    capabilities: value.capabilities,
    created_by: value.createdByContactId,
  })

  return { ok: true, teamMemberId: row.id, username, password }
}
