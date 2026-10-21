/**
 * Portal Team Access — teammate provisioning.
 *
 * Creates a teammate login the account-admin invites: an auth user with
 * role='client' + team_member markers, plus a portal_team_members grant row.
 * Teammates are NOT contacts and NOT in account_contacts.
 *
 * Login is by USERNAME. The auth user needs an email (Supabase requirement):
 *   - if the owner supplied a real email → used as the auth email (enables
 *     notifications + self password reset)
 *   - otherwise → a generated, non-deliverable placeholder
 * The username→auth-email translation at login is resolved server-side (see the
 * team-login route, Phase 2b).
 *
 * Design: sysdoc 'portal-team-access-design'.
 */
import { normalizeCapabilities, type CapabilityFlags } from './capabilities'

export interface TeammateInput {
  accountId: string
  username: string
  displayName?: string | null
  password: string
  email?: string | null
  capabilities: unknown
  createdByContactId: string
  disclaimerAccepted: boolean
}

export interface NormalizedTeammate {
  accountId: string
  username: string
  displayName: string
  password: string
  email: string | null
  capabilities: CapabilityFlags
  createdByContactId: string
}

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Pure validation + normalization. Returns errors[] (empty = ok) and the normalized value. */
export function validateTeammateInput(input: TeammateInput): { errors: string[]; value: NormalizedTeammate | null } {
  const errors: string[] = []
  const username = (input.username ?? '').trim()
  const displayName = (input.displayName ?? '').trim() || username
  const email = (input.email ?? '').trim()

  if (!input.accountId) errors.push('Missing company')
  if (!input.createdByContactId) errors.push('Missing creator')
  if (!input.disclaimerAccepted) errors.push('The responsibility disclaimer must be accepted')
  if (!USERNAME_RE.test(username)) errors.push('Username must be 3–30 chars: letters, numbers, dot, dash, underscore')
  if (!input.password || input.password.length < 8) errors.push('Password must be at least 8 characters')
  if (email && !EMAIL_RE.test(email)) errors.push('Email is not valid')

  const capabilities = normalizeCapabilities(input.capabilities)

  if (errors.length > 0) return { errors, value: null }

  return {
    errors: [],
    value: {
      accountId: input.accountId,
      username,
      displayName,
      password: input.password,
      email: email || null,
      capabilities,
      createdByContactId: input.createdByContactId,
    },
  }
}

/** Generate a stable, non-deliverable placeholder email when the owner gave none. */
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
   * A person who is ALREADY a Member / Owner of this company (a contact linked to it, found by email). They get their own
   * full login with the same rights as the owner; they must never be made a team member with limited, owner-controlled
   * access (dev job e5d5400d: Victoria / Lead Lift). Optional so older callers and tests keep working.
   */
  findCompanyContactByEmail?: (accountId: string, email: string) => Promise<{ name: string | null; role: string | null } | null>
  /** True when ANY portal login already exists for this email (client, partner, another team member). Optional like the above. */
  emailHasLogin?: (email: string) => Promise<boolean>
}

/** The message shown to the owner when they try to add a company member as a team member (Antonio's wording, 2026-10-21). */
export function companyMemberMessage(c: { name: string | null; role: string | null }): string {
  const who = c.name ? ` (${c.name}${c.role ? `, ${c.role}` : ''})` : ''
  return `Stop: this email is linked to a member of this company${who}. Members get their own full login with the same access as you. Please contact support and we will send the login.`
}

/** The message when the email already has a login of any kind. */
export const EMAIL_HAS_LOGIN_MESSAGE = 'Stop: this email already has a login in the portal. Please contact support and we will help.'

export interface ProvisionResult {
  ok: boolean
  teamMemberId?: string
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

  if (await deps.usernameTaken(value.username.toLowerCase())) {
    return { ok: false, errors: ['That username is already taken — pick another'] }
  }

  if (value.email && deps.findCompanyContactByEmail) {
    const member = await deps.findCompanyContactByEmail(value.accountId, value.email)
    if (member) return { ok: false, errors: [companyMemberMessage(member)] }
  }
  if (value.email && deps.emailHasLogin && (await deps.emailHasLogin(value.email))) {
    return { ok: false, errors: [EMAIL_HAS_LOGIN_MESSAGE] }
  }

  const authEmail = value.email ?? generateTeammateEmail(deps.newToken())

  const authUser = await deps.createAuthUser({
    email: authEmail,
    password: value.password,
    appMetadata: {
      role: 'client',
      kind: 'team_member',
      account_id: value.accountId,
    },
    userMetadata: {
      display_name: value.displayName,
      is_team_member: true,
    },
  })

  const row = await deps.insertTeamMember({
    account_id: value.accountId,
    auth_user_id: authUser.id,
    username: value.username,
    display_name: value.displayName,
    email: value.email,
    capabilities: value.capabilities,
    created_by: value.createdByContactId,
  })

  return { ok: true, teamMemberId: row.id }
}
