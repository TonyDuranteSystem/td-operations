/**
 * TD Marketing — reading the time-zone settings for a screen (server; dev job 9aec66fa, Addendum K). One read of the team's settings and of its members, and the answers a lead page or the
 * Calendar needs: the zone this viewer reads times in, whether the owner's clock is hidden from him (a setter), who takes calls. The rules themselves are pure (time-prefs.ts).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { MarketingContext } from "@/lib/marketing/guard"
import { getAllMarketingSettings } from "@/lib/marketing/settings"
import { callTakers, timePrefsFrom, viewerZone, type Taker, type TimePrefs } from "@/lib/marketing/time-prefs"
import { isSetterOnly } from "@/lib/marketing/lead-chat"
import { effectivePermissions } from "@/lib/marketing/permissions"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; auth: any }

export interface TimeView {
  prefs: TimePrefs
  takers: Taker[]
  /** the zone this viewer reads every time in */
  zone: string
  /** a setter never gets the owner's clock (Antonio, 30 Oct 2026: she works for the seller) */
  hideOwner: boolean
  /** Antonio on his own login (the owner frame) */
  ownerLogin: boolean
  /** this viewer takes calls with leads (the seller) */
  isTaker: boolean
  /** whose calendar the viewer is looking through: his own, or ("View as") the member whose role he is previewing */
  memberId: string
}

export type MemberRow = { user_id: string; status: string; bundle: string | null; member_role: string; permissions: string[] | null }

/**
 * The members who are a setter and nothing more. They never take calls with leads (the setter books the seller's calls; she has none of her own), so they are never a "taker": giving one a
 * calendar view or a slot offer would hand her the owner's and the seller's time (Antonio, 30 Oct 2026: "the setter doesn't need to see my time").
 */
export function setterOnlyIds(rows: readonly MemberRow[], bundles: Record<string, string[]>): Set<string> {
  return new Set(rows.filter(m => isSetterOnly(effectivePermissions({ memberRole: m.member_role === "owner" ? "owner" : "member", bundle: m.bundle, bundles, extra: m.permissions ?? [] }) as string[])).map(m => m.user_id))
}

/** The team's time settings and its member rows: two reads, no name lookups (enough to know whose zone is whose). */
export async function loadPrefsAndRows(teamId: string): Promise<{ prefs: TimePrefs; rows: MemberRow[]; bundles: Record<string, string[]> }> {
  const [all, rows] = await Promise.all([
    getAllMarketingSettings(teamId),
    db().from("marketing_team_members").select("user_id, status, bundle, member_role, permissions").eq("team_id", teamId).then((r: { data: MemberRow[] | null }) => r.data ?? []),
  ])
  return { prefs: timePrefsFrom(all as Parameters<typeof timePrefsFrom>[0]), rows, bundles: (all.permission_bundles ?? {}) as Record<string, string[]> }
}

/** The team's time settings, its members, and the members who take calls (one name lookup each, normally one person). */
export async function loadPrefsAndTakers(teamId: string): Promise<{ prefs: TimePrefs; takers: Taker[]; rows: MemberRow[] }> {
  const { prefs, rows, bundles } = await loadPrefsAndRows(teamId)
  const setters = setterOnlyIds(rows, bundles)
  const callers = rows.filter(m => Object.prototype.hasOwnProperty.call(prefs.callHours, m.user_id) && !setters.has(m.user_id))
  const emails = await Promise.all(callers.map(async m => ({ userId: m.user_id, email: ((await db().auth.admin.getUserById(m.user_id))?.data?.user?.email ?? null) as string | null, status: m.status })))
  return { prefs, takers: callTakers(prefs, emails), rows }
}

/** The zone this person reads times in, for the screens that only need that (no name lookups). Same rule as `loadTimeView`. */
export async function loadViewerZone(ctx: Pick<MarketingContext, "user" | "team" | "membership" | "viewAs" | "admin">): Promise<string> {
  const { prefs, rows } = await loadPrefsAndRows(ctx.team.id)
  return viewerZone(prefs, { userId: ctx.user.id, ownerLogin: ctx.admin === true && !ctx.viewAs, viewAsMemberId: viewAsMemberOf(ctx, rows) })
}

/** "View as": the first active member who holds the previewed role, so the preview reads times as that person does. */
function viewAsMemberOf(ctx: Pick<MarketingContext, "membership" | "viewAs">, rows: readonly MemberRow[]): string | null {
  const asBundle = ctx.viewAs ? ctx.membership.bundle : null
  return asBundle ? rows.find(m => m.status === "active" && m.bundle === asBundle)?.user_id ?? null : null
}

/** Everything a screen needs to show times for this person. */
export async function loadTimeView(ctx: Pick<MarketingContext, "user" | "team" | "membership" | "permissions" | "viewAs" | "admin">): Promise<TimeView> {
  const { prefs, takers, rows } = await loadPrefsAndTakers(ctx.team.id)
  const ownerLogin = ctx.admin === true && !ctx.viewAs
  const viewAsMemberId = viewAsMemberOf(ctx, rows)
  const zone = viewerZone(prefs, { userId: ctx.user.id, ownerLogin, viewAsMemberId })
  const hideOwner = isSetterOnly(ctx.permissions)
  // a setter is never the seller, whatever the Team page says about her (belt and braces: the takers already leave her out)
  const isTaker = !hideOwner && takers.some(t => t.userId === (viewAsMemberId ?? ctx.user.id))
  return { prefs, takers, zone, hideOwner, ownerLogin, isTaker, memberId: viewAsMemberId ?? ctx.user.id }
}
