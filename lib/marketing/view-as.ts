/**
 * TD Marketing — "View as" for Antonio (pure; dev job 9aec66fa). Lets the strict admin open the team's workspace exactly as the team
 * owner or as any role in the permission bundles setting would see it, with NOTHING blocking him inside those screens (he acts as the
 * team owner, so the "someone else picked this lead" rule never stops him). What he does is recorded under his own email.
 * Honoured ONLY for a strict admin: a marketing login or staff login that carries the cookie is simply ignored (guard.ts).
 * The choice lives in a short-lived httpOnly cookie "<team id>:<owner | bundle key>".
 */
import { MARKETING_PERMISSIONS, cleanPermissions, type MarketingPermission } from "@/lib/marketing/permissions"

export const VIEW_AS_COOKIE = "td_marketing_view_as"
export const VIEW_AS_MAX_AGE_SECONDS = 8 * 3600

export interface ViewAs { teamId: string; as: "owner" | { bundle: string } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9_ -]{1,60}$/

export function serializeViewAs(v: ViewAs): string {
  return `${v.teamId}:${v.as === "owner" ? "owner" : `bundle=${v.as.bundle}`}`
}

/** Reads the cookie value; anything that does not look exactly right is null (never a guess). */
export function parseViewAs(raw: string | null | undefined): ViewAs | null {
  if (!raw) return null
  const i = raw.indexOf(":")
  if (i < 0) return null
  const teamId = raw.slice(0, i), rest = raw.slice(i + 1)
  if (!UUID.test(teamId)) return null
  if (rest === "owner") return { teamId, as: "owner" }
  if (rest.startsWith("bundle=")) {
    const bundle = rest.slice(7)
    return KEY.test(bundle) ? { teamId, as: { bundle } } : null
  }
  return null
}

export interface ViewAsOption { value: "owner" | { bundle: string }; label: string; key: string }

/** What Antonio can choose: the team owner (every screen), then each role in the bundles setting. Nothing here is a fixed list of names. */
export function viewAsOptions(bundles: Record<string, readonly string[]>, labelOf: (key: string) => string): ViewAsOption[] {
  return [
    { value: "owner", label: "Team owner (every screen)", key: "owner" },
    ...Object.keys(bundles).map(b => ({ value: { bundle: b }, label: labelOf(b), key: `bundle=${b}` })),
  ]
}

/** The screens a role gets: the owner has everything; a bundle that does not exist gives nothing (the page then says so). */
export function viewAsPermissions(as: ViewAs["as"], bundles: Record<string, readonly string[]>): MarketingPermission[] {
  if (as === "owner") return [...MARKETING_PERMISSIONS]
  return cleanPermissions(bundles[as.bundle] ?? [])
}

export function viewAsLabel(as: ViewAs["as"], labelOf: (key: string) => string): string {
  return as === "owner" ? "the team owner" : labelOf(as.bundle)
}
