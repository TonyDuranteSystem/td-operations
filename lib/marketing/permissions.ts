/**
 * TD Marketing — permissions (pure; P1, dev job 9aec66fa).
 *
 * The TEAM OWNER (Rocco, as boss) has every permission on his team — Antonio's ruling 2026-10-17. A MEMBER has what his
 * bundle (a setting) plus his own extra grants give him. A grant can never exceed what the granter has himself. Nobody can
 * raise his own access. (There is no separate limit Antonio sets on what an owner may hand out: removed 2026-10-18, nothing used it.)
 */

/** Every permission name that exists. A grant naming anything else is refused (a typo must not silently grant nothing). */
export const MARKETING_PERMISSIONS = [
  "leads.read", "leads.pick", "leads.call", "leads.mark", "leads.worklist", "leads.import", "leads.export",
  "payment_links.create", "money.read",
  "offers.create",
  "calls.host", "calls.recordings",
  "whatsapp", "inbox", "chat",
  "content.manage", "documents", "documents.manage", "reports.read", "team.activity", "team.notes",
  "team.manage",
] as const
export type MarketingPermission = (typeof MARKETING_PERMISSIONS)[number]

export function isMarketingPermission(p: unknown): p is MarketingPermission {
  return typeof p === "string" && (MARKETING_PERMISSIONS as readonly string[]).includes(p)
}

/** Only known permissions, deduplicated; anything else is dropped (use validatePermissionList to refuse instead). */
export function cleanPermissions(list: readonly unknown[] | null | undefined): MarketingPermission[] {
  return Array.from(new Set((list ?? []).filter(isMarketingPermission)))
}

export function validatePermissionList(list: unknown): { ok: boolean; error?: string; value?: MarketingPermission[] } {
  if (!Array.isArray(list)) return { ok: false, error: "Permissions must be a list." }
  const bad = list.filter(p => !isMarketingPermission(p))
  if (bad.length) return { ok: false, error: `Unknown permission: ${bad.map(String).join(", ")}.` }
  return { ok: true, value: cleanPermissions(list) }
}

export interface PermissionInput {
  memberRole: "owner" | "member"
  bundle?: string | null
  /** The bundles setting (key → permissions). */
  bundles: Record<string, readonly string[]>
  /** The member's own extra grants. */
  extra?: readonly string[] | null
}

/** Everything this person may do. The owner has every permission. A bundle that no longer exists grants nothing (fails closed). */
export function effectivePermissions(i: PermissionInput): MarketingPermission[] {
  if (i.memberRole === "owner") return [...MARKETING_PERMISSIONS]
  const fromBundle = i.bundle ? (i.bundles[i.bundle] ?? []) : []
  return cleanPermissions([...fromBundle, ...(i.extra ?? [])])
}

export function hasPermission(perms: readonly string[], needed: MarketingPermission): boolean {
  return perms.includes(needed)
}

export interface GrantCheck {
  /** the person handing out access */
  granterRole: "owner" | "member"
  granterPermissions: readonly string[]
  /** what he wants to give */
  requested: readonly unknown[]
  /** who receives it; granting to yourself is always refused */
  granterUserId: string
  targetUserId: string | null
}

/**
 * May this grant happen? Refused when: it targets the granter himself; it names an unknown permission; it exceeds what the
 * granter has (an owner has everything). A member may only grant if he holds team.manage.
 */
export function canGrant(g: GrantCheck): { ok: boolean; error?: string } {
  if (g.targetUserId && g.targetUserId === g.granterUserId) return { ok: false, error: "Nobody can change his own access." }
  if (g.granterRole !== "owner" && !g.granterPermissions.includes("team.manage")) return { ok: false, error: "You cannot manage the team." }
  const v = validatePermissionList(g.requested)
  if (!v.ok) return { ok: false, error: v.error }
  const own = g.granterRole === "owner" ? MARKETING_PERMISSIONS : g.granterPermissions
  const over = (v.value ?? []).filter(p => !(own as readonly string[]).includes(p))
  if (over.length) return { ok: false, error: `You cannot give what you do not have: ${over.join(", ")}.` }
  return { ok: true }
}
