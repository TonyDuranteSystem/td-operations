/**
 * TD Marketing — team status (pure; P0, dev job 9aec66fa). A team is created `draft` (nobody can log in), switched
 * `active` by Antonio, and can be `paused` (kill switch) and resumed. Only `active` lets people work.
 */
export const TEAM_STATUSES = ["draft", "active", "paused"] as const
export type TeamStatus = (typeof TEAM_STATUSES)[number]

export function isTeamStatus(v: unknown): v is TeamStatus {
  return typeof v === "string" && (TEAM_STATUSES as readonly string[]).includes(v)
}

/** Only an active team's people may use the workspace. Anything unknown counts as not live (fails closed). */
export function isTeamLive(status: unknown): boolean {
  return status === "active"
}

/** draft→active, active↔paused, paused→active. A team never goes back to draft. */
export function canChangeTeamStatus(from: unknown, to: unknown): boolean {
  if (!isTeamStatus(from) || !isTeamStatus(to) || from === to) return false
  if (to === "draft") return false
  return true
}
