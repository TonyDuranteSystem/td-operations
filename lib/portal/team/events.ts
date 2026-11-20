/**
 * Team Powers — the record of every team action (table `portal_team_events`, append-only: the database refuses to
 * change or delete a row). Who did what to which team member, when, from where.
 *
 * Two ways to write it:
 *   - recordTeamEvent        STRICT: throws when the line cannot be saved. Used when an action GIVES access (adding someone,
 *                            adding powers, switching someone back on) — no record, no grant (the caller undoes the grant).
 *   - recordTeamEventBestEffort  never throws. Used when an action TAKES access away (switch off, remove) or only hands over a
 *                            password: a failing log must never stop a safety action.
 *
 * The allowed event names are ALSO listed in the database trigger (scripts/migrations/20261117-2300-team-foundation.sql);
 * a unit test keeps the two lists identical.
 */

export const TEAM_EVENTS = [
  'added',
  'powers_changed',
  'removed',
  'switched_off',
  'switched_on',
  'password_reset',
  'notice_accepted',
  'migrated',
] as const
export type TeamEventName = (typeof TEAM_EVENTS)[number]

export const TEAM_ACTOR_KINDS = ['owner', 'td', 'system'] as const
export type TeamActorKind = (typeof TEAM_ACTOR_KINDS)[number]

export interface TeamActor {
  kind: TeamActorKind
  /** The owner / member (a contact) who acted — required for kind 'owner'. */
  contactId?: string | null
  /** The TD staff login who acted — required for kind 'td'. */
  staffEmail?: string | null
  /** Where the request came from (first address of x-forwarded-for). */
  ip?: string | null
}

export interface TeamEventInput {
  teamMemberId: string
  accountId: string
  event: TeamEventName
  actor: TeamActor
  /** Free facts for this event: powers before/after, reason, notice version, … */
  detail?: Record<string, unknown>
}

export interface TeamEventRow {
  team_member_id: string
  account_id: string
  event: TeamEventName
  actor_kind: TeamActorKind
  actor_contact_id: string | null
  actor_staff_email: string | null
  detail: Record<string, unknown>
  ip: string | null
}

/** The smallest slice of the database client this file needs (so tests need no database). */
export interface TeamEventDb {
  from(table: 'portal_team_events'): {
    insert(row: TeamEventRow): PromiseLike<{ error: { message: string } | null }>
  }
}

const MAX_IP = 64

/** Pure: checks the input and builds the row. Throws on an unknown event/actor or a missing "who". */
export function buildTeamEventRow(input: TeamEventInput): TeamEventRow {
  if (!(TEAM_EVENTS as readonly string[]).includes(input.event)) throw new Error(`Unknown team event: ${String(input.event)}`)
  if (!(TEAM_ACTOR_KINDS as readonly string[]).includes(input.actor.kind)) throw new Error(`Unknown team actor: ${String(input.actor.kind)}`)
  if (!input.teamMemberId || !input.accountId) throw new Error('A team event needs the team member and the company')
  if (input.actor.kind === 'owner' && !input.actor.contactId) throw new Error('An owner action must say which owner did it')
  if (input.actor.kind === 'td' && !input.actor.staffEmail) throw new Error('A TD action must say which staff login did it')
  const ip = typeof input.actor.ip === 'string' && input.actor.ip.trim() ? input.actor.ip.trim().slice(0, MAX_IP) : null
  return {
    team_member_id: input.teamMemberId,
    account_id: input.accountId,
    event: input.event,
    actor_kind: input.actor.kind,
    actor_contact_id: input.actor.kind === 'owner' ? input.actor.contactId ?? null : null,
    actor_staff_email: input.actor.kind === 'td' ? input.actor.staffEmail ?? null : null,
    detail: input.detail ?? {},
    ip,
  }
}

/** STRICT write — throws when the row is invalid or cannot be saved. */
export async function recordTeamEvent(db: TeamEventDb, input: TeamEventInput): Promise<void> {
  const row = buildTeamEventRow(input)
  const { error } = await db.from('portal_team_events').insert(row)
  if (error) throw new Error(`Could not save the team record: ${error.message}`)
}

/** Never throws. Returns whether the line was saved. */
export async function recordTeamEventBestEffort(db: TeamEventDb, input: TeamEventInput): Promise<boolean> {
  try {
    await recordTeamEvent(db, input)
    return true
  } catch (err) {
    // eslint-disable-next-line no-console -- a failed best-effort log must be visible in the server log
    console.error('[team-events] could not record', input.event, err instanceof Error ? err.message : err)
    return false
  }
}

/** The owner who made a request, with the caller's address (first x-forwarded-for entry). */
export function ownerActorFromRequest(contactId: string, headers: { get(name: string): string | null }): TeamActor {
  const forwarded = headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : null
  return { kind: 'owner', contactId, ip: ip || null }
}

/** A TD staff member who made a request (their login email), with the caller's address. */
export function tdActorFromRequest(staffEmail: string, headers: { get(name: string): string | null }): TeamActor {
  const forwarded = headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : null
  return { kind: 'td', staffEmail, ip: ip || null }
}

/** True when `after` holds a power that `before` did not (a "tick added"). */
export function powersGrew(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): boolean {
  const had = before ?? {}
  for (const [key, value] of Object.entries(after ?? {})) {
    if (value === true && had[key] !== true) return true
  }
  return false
}
