/**
 * TD Marketing — password reset rules (pure; dev job 9aec66fa). A reset is a single-use, expiring link that lets a team member choose a new password.
 * Two ways to get one: the person asks for it himself ("Forgot password?", emailed ONLY to the address of his own login) or a team owner makes it on the Team page and sends it.
 * Only the HASH of the token is stored. The public routes answer with ONE generic message for every failure, so nobody can learn which emails are marketing logins,
 * and a reset can only ever change the password of a marketing login that is an active member of an active team (never a client, staff, admin or partner login).
 * The token itself (random, hashed, plausibility check) is the same as an invitation's (invite-rules.ts).
 */
import { isMarketingRole } from "@/lib/auth/role-door"

export const RESET_TTL_SELF_MS = 60 * 60 * 1000
export const RESET_TTL_OWNER_MS = 24 * 60 * 60 * 1000
export const MAX_SELF_REQUESTS_PER_HOUR = 3
export const MAX_OWNER_RESETS_PER_HOUR = 20

export const GENERIC_RESET_ERROR = "This link cannot be used. Ask for a new one."
/** What "Forgot password?" always answers, whether or not the address belongs to a marketing login. */
export const FORGOT_ANSWER = "If this email belongs to a TD Marketing login, a link to choose a new password is on its way. It works once and expires in one hour."

export type ResetKind = "self" | "owner"

export function resetExpiry(now: Date, kind: ResetKind): string {
  return new Date(now.getTime() + (kind === "self" ? RESET_TTL_SELF_MS : RESET_TTL_OWNER_MS)).toISOString()
}
export function overSelfLimit(countLastHour: number): boolean {
  return countLastHour >= MAX_SELF_REQUESTS_PER_HOUR
}
export function overOwnerLimit(countLastHour: number): boolean {
  return countLastHour >= MAX_OWNER_RESETS_PER_HOUR
}

/** A person may ask for a link for himself only when his login is a marketing login, he is an ACTIVE member and his team is active. */
export function eligibleForForgot(input: { authRole: unknown; banned: boolean; memberStatus: string | null | undefined; teamStatus: string | null | undefined }): boolean {
  return isMarketingRole(input.authRole) && !input.banned && input.memberStatus === "active" && input.teamStatus === "active"
}

/**
 * Can this actor make a reset link for this person? (The caller has already checked that the actor may manage the team.)
 * Never for yourself (use "Forgot password?"), never for someone who is not on the team or is paused, never for a login that is not a marketing login
 * (Antonio's own CRM login can be a member: a link must never be able to change HIS password), and only Antonio for a team owner.
 */
export function mayResetMember(input: {
  actorKind: "admin" | "owner" | "member"; actorUserId: string | null; targetUserId: string
  targetAuthRole: unknown; targetBanned: boolean; targetMemberRole: "owner" | "member" | null; targetStatus: string | null
}): { ok: true } | { ok: false; error: string } {
  if (input.actorUserId && input.actorUserId === input.targetUserId) return { ok: false, error: "Use “Forgot password?” on the login page for your own password." }
  if (!input.targetMemberRole || input.targetStatus === "removed" || input.targetStatus === null) return { ok: false, error: "That person is not on the team." }
  if (input.targetStatus !== "active") return { ok: false, error: "Resume this person first, then make the link." }
  if (!isMarketingRole(input.targetAuthRole)) return { ok: false, error: "This login is not a marketing login. Its password is not changed from here." }
  if (input.targetBanned) return { ok: false, error: "This login is closed." }
  if (input.targetMemberRole === "owner" && input.actorKind !== "admin") return { ok: false, error: "Only Antonio can make a reset link for a team owner." }
  return { ok: true }
}

/** The page the person opens. Built from the app's own address and the token only. */
export function resetUrl(appBase: string, token: string): string {
  return `${appBase}/marketing/reset?token=${token}`
}
