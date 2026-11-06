/**
 * TD Marketing — the guard's decision (pure; P1, dev job 9aec66fa). The server wrapper (guard.ts) reads the rows and hands
 * them here, so every branch is unit-tested without a database. Checked on EVERY request: a removed person, a paused person
 * or a paused team is turned away on the very next click, not when a token expires.
 */
import { isMarketingRole } from "@/lib/auth/role-door"
import { isTeamLive } from "@/lib/marketing/team-status"
import type { ReviewDemoFlag } from "@/lib/auth/review-demo"
import { capForReviewDemo, type MarketingPermission } from "@/lib/marketing/permissions"

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

/**
 * The App Store review practice login (TD Social, 6 Nov 2026) — what the guard does with it, from its flag (lib/auth/review-demo.ts):
 *  - none   → an ordinary login: nothing changes.
 *  - lapsed → the login is DEAD (every request refused), so an expired practice login cannot be revived by enrolling an authenticator.
 *  - live   → refused unless the flag names THIS team (a flag put by mistake on a real team's login gives nothing); otherwise never an owner, and its
 *             permissions are cut to chat + reading leads, whatever its membership row says.
 */
export function applyReviewDemo(
  flag: ReviewDemoFlag, membership: GuardMembership, permissions: readonly MarketingPermission[],
): { ok: true; membership: GuardMembership; role: "owner" | "member"; permissions: MarketingPermission[]; reviewDemo: boolean }
  | { ok: false; status: 403; code: string; message: string } {
  if (flag.state === "none") return { ok: true, membership, role: membership.member_role, permissions: [...permissions], reviewDemo: false }
  if (flag.state === "lapsed") return deny(403, "REVIEW_ENDED", "This practice login has ended.") as { ok: false; status: 403; code: string; message: string }
  if (!flag.team || flag.team !== membership.team_id) return deny(403, "REVIEW_TEAM", "This practice login is not tied to this team.") as { ok: false; status: 403; code: string; message: string }
  return { ok: true, membership: { ...membership, member_role: "member" }, role: "member", permissions: capForReviewDemo(permissions), reviewDemo: true }
}
