/**
 * Team Powers — Switch off / Switch on (reversible), as opposed to Remove (for good).
 *
 * How a state is stored (no new status value, so every reader that trusts `status = 'active'` keeps refusing a
 * switched-off person with no code change):
 *   active                                      → can sign in
 *   revoked + switched_off_at set               → SWITCHED OFF: cannot sign in, may be switched back on
 *   revoked + switched_off_at NULL              → REMOVED for good: can never be switched back on
 * Who switched off decides who may switch on: if TD did it, the owner cannot undo it.
 *
 * Order of work is chosen so a failure always leaves the person LOCKED OUT, never wrongly let in:
 *   off: status first, then the login ban     (a failed ban still leaves status 'revoked')
 *   on : end any old personal-document shares, lift the ban, then status, then the record; if the record cannot be saved the person is put back OFF.
 * A share of personal documents lives only while the login stays continuously active: it ends at switch-off and before a switch-on.
 *
 * Authorization (who may press the button) is the CALLER's job; this file only enforces the state rules.
 * All database access goes through `SwitchDeps` so the rules are unit-tested without a database.
 */
import { recordTeamEvent, recordTeamEventBestEffort, type TeamActor, type TeamEventInput } from './events'

export type SwitchedOffBy = 'owner' | 'td'

export interface SwitchRow {
  id: string
  account_id: string
  auth_user_id: string
  status: string
  switched_off_at: string | null
  switched_off_by: string | null
  switched_off_reason: string | null
}

export type SwitchErrorCode =
  | 'not_found'
  | 'already_off'
  | 'removed'
  | 'not_off'
  | 'td_locked'
  | 'reason_required'
  | 'conflict'
  | 'ban_failed'
  | 'log_failed'
  | 'shares_failed'

export class TeamSwitchError extends Error {
  constructor(public code: SwitchErrorCode, message: string) {
    super(message)
    this.name = 'TeamSwitchError'
  }
}

const REASON_MAX = 500

/** A switched-off person: status revoked AND a switch-off stamp. (Revoked with no stamp = removed for good.) */
export function isSwitchedOff(row: Pick<SwitchRow, 'status' | 'switched_off_at'>): boolean {
  return row.status === 'revoked' && !!row.switched_off_at
}

export function cleanReason(reason: unknown): string {
  return typeof reason === 'string' ? reason.trim().slice(0, REASON_MAX) : ''
}

export interface SwitchDeps {
  getRow(id: string, accountId: string): Promise<SwitchRow | null>
  /** Only when the row is still 'active'. Returns whether it changed a row. */
  markOff(id: string, accountId: string, by: SwitchedOffBy, reason: string, atIso: string): Promise<boolean>
  /**
   * Only when the row is still switched off (revoked + stamp) and, for an owner, was switched off by an owner.
   * Clears the stamp and sets status active. Returns whether it changed a row.
   */
  markOn(id: string, accountId: string, actorKind: SwitchedOffBy): Promise<boolean>
  /** Put the exact earlier switch-off back (used when the record of a switch-on cannot be saved). */
  /** TD locks a person an OWNER switched off (so the owner can no longer switch them on). Returns whether it changed a row. */
  takeOver(id: string, accountId: string, reason: string, atIso: string): Promise<boolean>
  restoreOff(row: SwitchRow): Promise<void>
  setBan(authUserId: string, banned: boolean): Promise<void>
  /**
   * End every personal-document share of this login (an owner's papers shared with it). Throws when the shares cannot be deleted.
   * A share only lives while the login stays continuously active: it ends at switch-off (best effort — the login is already locked out) and
   * again, strictly, before a switch-on (so a login never comes back with an old share).
   */
  endShares(id: string, accountId: string, actor: TeamActor, because: 'switched_off' | 'switched_on'): Promise<void>
  record: TeamEventDbWriter
  now?: () => Date
}

export interface TeamEventDbWriter {
  strict(input: TeamEventInput): Promise<void>
  bestEffort(input: TeamEventInput): Promise<boolean>
}

/** Wire a TeamEventDb into the strict / best-effort writers SwitchDeps wants. */
export function eventWriter(db: Parameters<typeof recordTeamEvent>[0]): TeamEventDbWriter {
  return {
    strict: (input) => recordTeamEvent(db, input),
    bestEffort: (input) => recordTeamEventBestEffort(db, input),
  }
}

function requireActor(actor: TeamActor): SwitchedOffBy {
  if (actor.kind !== 'owner' && actor.kind !== 'td') throw new TeamSwitchError('conflict', 'Only an owner or TD can switch a team member off or on')
  return actor.kind
}

export async function switchOffTeammate(
  id: string,
  accountId: string,
  actor: TeamActor,
  reasonRaw: unknown,
  deps: SwitchDeps,
): Promise<{ ok: true }> {
  const by = requireActor(actor)
  const reason = cleanReason(reasonRaw)
  if (by === 'td' && !reason) throw new TeamSwitchError('reason_required', 'Say why you are switching this person off')

  const row = await deps.getRow(id, accountId)
  if (!row) throw new TeamSwitchError('not_found', 'Team member not found')
  if (isSwitchedOff(row)) {
    // TD may LOCK a person an owner switched off, so the owner can no longer switch them back on. Anything else is "already off".
    if (by === 'td' && row.switched_off_by === 'owner') {
      const at = (deps.now?.() ?? new Date()).toISOString()
      const taken = await deps.takeOver(id, accountId, reason, at)
      if (!taken) throw new TeamSwitchError('conflict', 'This person was changed by someone else a moment ago. Refresh and try again.')
      await deps.setBan(row.auth_user_id, true).catch(() => undefined) // already blocked; make sure
      await deps.record.bestEffort({
        teamMemberId: id,
        accountId,
        event: 'switched_off',
        actor,
        detail: { reason, took_over_from: 'owner', previous_reason: row.switched_off_reason },
      })
      return { ok: true }
    }
    throw new TeamSwitchError('already_off', 'This person is already switched off')
  }
  if (row.status !== 'active') throw new TeamSwitchError('removed', 'This person was removed and cannot be switched off')

  const at = (deps.now?.() ?? new Date()).toISOString()
  const applied = await deps.markOff(id, accountId, by, reason, at)
  if (!applied) throw new TeamSwitchError('conflict', 'This person was changed by someone else a moment ago. Refresh and try again.')

  // Cut the login too. A failure here is reported but the person is ALREADY refused (status is no longer active).
  let banFailed = false
  try {
    await deps.setBan(row.auth_user_id, true)
  } catch {
    banFailed = true
  }

  // The login is already refused, so a share that cannot be ended right now is dormant — and is ended strictly before any switch-on.
  let sharesEndFailed = false
  try {
    await deps.endShares(id, accountId, actor, 'switched_off')
  } catch {
    sharesEndFailed = true
  }

  await deps.record.bestEffort({
    teamMemberId: id,
    accountId,
    event: 'switched_off',
    actor,
    detail: { reason: reason || null, ban_failed: banFailed || undefined, shares_end_failed: sharesEndFailed || undefined },
  })

  if (banFailed) throw new TeamSwitchError('ban_failed', 'Switched off, but the sign-in could not be fully blocked. Please try again.')
  return { ok: true }
}

export async function switchOnTeammate(
  id: string,
  accountId: string,
  actor: TeamActor,
  deps: SwitchDeps,
): Promise<{ ok: true }> {
  const by = requireActor(actor)

  const row = await deps.getRow(id, accountId)
  if (!row) throw new TeamSwitchError('not_found', 'Team member not found')
  if (row.status === 'active') throw new TeamSwitchError('not_off', 'This person is not switched off')
  if (!isSwitchedOff(row)) throw new TeamSwitchError('removed', 'This person was removed for good and cannot be switched back on. Add them again instead.')
  if (by === 'owner' && row.switched_off_by === 'td') {
    throw new TeamSwitchError('td_locked', 'Tony Durante LLC switched this person off. Please contact us to switch them back on.')
  }

  // 0) end any share left from before (the owner shares again) — BEFORE the login can come back. If that fails they stay off.
  try {
    await deps.endShares(id, accountId, actor, 'switched_on')
  } catch {
    throw new TeamSwitchError('shares_failed', 'We could not end the personal-document sharing this person had before, so they stay switched off. Please try again.')
  }

  // 1) lift the ban  2) set active  3) record it. Any failure leaves them off.
  try {
    await deps.setBan(row.auth_user_id, false)
  } catch {
    throw new TeamSwitchError('ban_failed', 'The sign-in could not be unblocked. Please try again.')
  }

  const applied = await deps.markOn(id, accountId, by)
  if (!applied) {
    await deps.setBan(row.auth_user_id, true).catch(() => undefined)
    throw new TeamSwitchError('conflict', 'This person was changed by someone else a moment ago. Refresh and try again.')
  }

  try {
    await deps.record.strict({
      teamMemberId: id,
      accountId,
      event: 'switched_on',
      actor,
      detail: { previously_switched_off_by: row.switched_off_by, previous_reason: row.switched_off_reason },
    })
  } catch {
    // No record, no grant: block the sign-in FIRST (so whatever happens next they stay locked out), then put the status back.
    await deps.setBan(row.auth_user_id, true).catch(() => undefined)
    const restored = await deps.restoreOff(row).then(() => true, () => false)
    throw new TeamSwitchError(
      'log_failed',
      restored
        ? 'We could not save the record of this change, so the person stays switched off. Please try again.'
        : 'We could not save the record of this change. The person is blocked from signing in, but their status could not be put back — please contact support.',
    )
  }
  return { ok: true }
}
