/**
 * TD Marketing — the guard's decision (pure; P1, dev job 9aec66fa). The server wrapper (guard.ts) reads the rows and hands
 * them here, so every branch is unit-tested without a database. Checked on EVERY request: a removed person, a paused person
 * or a paused team is turned away on the very next click, not when a token expires.
 */
import { isMarketingRole } from "@/lib/auth/role-door"
import { isTeamLive } from "@/lib/marketing/team-status"

export interface GuardMembership { team_id: string; member_role: "owner" | "member"; status: string; bundle: string | null; permissions: string[] }
export interface GuardTeam { id: string; name: string; status: string }

export type GuardVerdict =
  | { ok: true; membership: GuardMembership; team: GuardTeam }
  | { ok: false; status: 401 | 403; code: string; message: string }

const deny = (status: 401 | 403, code: string, message: string): GuardVerdict => ({ ok: false, status, code, message })

export function decideMarketingAccess(input: {
  signedIn: boolean
  role: unknown
  memberships: readonly GuardMembership[]
  teams: readonly GuardTeam[]
}): GuardVerdict {
  if (!input.signedIn) return deny(401, "NOT_SIGNED_IN", "Please sign in.")
  if (!isMarketingRole(input.role)) return deny(403, "NOT_MARKETING", "This area is for the marketing team.")
  const active = input.memberships.filter(m => m.status === "active")
  if (active.length === 0) {
    const anyPaused = input.memberships.some(m => m.status === "paused")
    return anyPaused
      ? deny(403, "MEMBER_PAUSED", "Your access is paused. Ask your team owner.")
      : deny(403, "NO_TEAM", "You are not part of a marketing team.")
  }
  // One team per login in P1: the first active membership. (Several teams would need an explicit team choice.)
  const membership = active[0]
  const team = input.teams.find(t => t.id === membership.team_id)
  if (!team) return deny(403, "NO_TEAM", "You are not part of a marketing team.")
  if (!isTeamLive(team.status)) {
    return team.status === "paused"
      ? deny(403, "TEAM_PAUSED", "Your team is paused. Ask Antonio.")
      : deny(403, "TEAM_NOT_ACTIVE", "Your team has not been switched on yet.")
  }
  return { ok: true, membership, team }
}
