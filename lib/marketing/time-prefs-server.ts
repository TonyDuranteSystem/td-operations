/**
 * TD Marketing — reading the time-zone settings for a screen (server; dev job 9aec66fa, Addendum K). One read of the team's settings and of its members, and the answers a lead page or the
 * Calendar needs: the zone this viewer reads times in, whether the owner's clock is hidden from him (a setter), who takes calls. The rules themselves are pure (time-prefs.ts).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { MarketingContext } from "@/lib/marketing/guard"
import { getAllMarketingSettings } from "@/lib/marketing/settings"
import { callTakers, timePrefsFrom, viewerZone, type Taker, type TimePrefs } from "@/lib/marketing/time-prefs"
import { isSetterOnly } from "@/lib/marketing/lead-chat"

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

export type MemberRow = { user_id: string; status: string; bundle: string | null }

/** The team's time settings, its members, and the members who take calls (one name lookup each, normally one person). */
export async function loadPrefsAndTakers(teamId: string): Promise<{ prefs: TimePrefs; takers: Taker[]; rows: MemberRow[] }> {
  const [all, rows] = await Promise.all([
    getAllMarketingSettings(teamId),
    db().from("marketing_team_members").select("user_id, status, bundle").eq("team_id", teamId).then((r: { data: MemberRow[] | null }) => r.data ?? []),
  ])
  const prefs = timePrefsFrom(all as Parameters<typeof timePrefsFrom>[0])
  const callers = rows.filter(m => Object.prototype.hasOwnProperty.call(prefs.callHours, m.user_id))
  const emails = await Promise.all(callers.map(async m => ({ userId: m.user_id, email: ((await db().auth.admin.getUserById(m.user_id))?.data?.user?.email ?? null) as string | null, status: m.status })))
  return { prefs, takers: callTakers(prefs, emails), rows }
}

/** Everything a screen needs to show times for this person. */
export async function loadTimeView(ctx: Pick<MarketingContext, "user" | "team" | "membership" | "permissions" | "viewAs" | "admin">): Promise<TimeView> {
  const { prefs, takers, rows } = await loadPrefsAndTakers(ctx.team.id)
  const ownerLogin = ctx.admin === true && !ctx.viewAs
  // "View as": the zone of a member who holds the chosen role, so the preview reads times as that person does
  const asBundle = ctx.viewAs ? ctx.membership.bundle : null
  const viewAsMemberId = asBundle ? rows.find(m => m.status === "active" && m.bundle === asBundle)?.user_id ?? null : null
  const zone = viewerZone(prefs, { userId: ctx.user.id, ownerLogin, viewAsMemberId })
  const hideOwner = isSetterOnly(ctx.permissions)
  const isTaker = takers.some(t => t.userId === (viewAsMemberId ?? ctx.user.id))
  return { prefs, takers, zone, hideOwner, ownerLogin, isTaker, memberId: viewAsMemberId ?? ctx.user.id }
}
