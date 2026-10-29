/**
 * TD Marketing — the shared guard (server; P1, dev job 9aec66fa). EVERY marketing page and API starts here and gets back
 * {user, team, role, permissions} or a plain refusal. It reads the person's membership and the team's status on every
 * request (nothing is cached), so removing, pausing or switching a team off takes effect on the next click.
 * Decision rules: lib/marketing/guard-rules.ts (pure, unit-tested). Marketing routes must never reach the database with the
 * service key except through `teamScoped` or an explicit team id taken from this context — never from the request.
 */
import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { isSecureAdmin } from "@/lib/auth"
import { VIEW_AS_COOKIE, parseViewAs, viewAsLabel, viewAsPermissions } from "@/lib/marketing/view-as"
import { roleLabel } from "@/lib/marketing/permission-labels"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { decideMarketingAccess, type GuardMembership, type GuardTeam } from "@/lib/marketing/guard-rules"
import { effectivePermissions, type MarketingPermission, hasPermission } from "@/lib/marketing/permissions"
import { getMarketingSetting } from "@/lib/marketing/settings"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

export interface MarketingContext {
  user: { id: string; email: string | null }
  team: GuardTeam
  role: "owner" | "member"
  membership: GuardMembership
  permissions: MarketingPermission[]
  /** set only when Antonio (strict admin) is looking at the workspace as someone else */
  viewAs?: { label: string }
  /** set when the login is a CRM admin (Antonio) — in View as, or as a member of the team. He manages the team as the admin, not as an owner, so the owner-only rules (remove / pause / cancel an owner) let him through. */
  admin?: true
}

export type GuardResult = { ok: true; ctx: MarketingContext } | { ok: false; status: 401 | 403; code: string; message: string }

export async function resolveMarketingContext(): Promise<GuardResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const role = user?.app_metadata?.role
  if (!user) return decideMarketingAccess({ signedIn: false, role, memberships: [], teams: [] }) as GuardResult
  // "View as": a strict admin who picked a team and a role in CRM > Marketing > Teams. Ignored for everybody else.
  if (isSecureAdmin(user)) {
    const v = parseViewAs(cookies().get(VIEW_AS_COOKIE)?.value)
    if (v) {
      const { data: team } = await db().from("marketing_teams").select("id, name, status").eq("id", v.teamId).maybeSingle()
      if (team) {
        const bundles = (await getMarketingSetting("permission_bundles", team.id)) as Record<string, string[]>
        const label = viewAsLabel(v.as, roleLabel)
        return {
          ok: true,
          ctx: {
            user: { id: user.id, email: user.email ?? null },
            team: team as GuardTeam,
            // he acts as the team owner so no ownership rule blocks him; the screens are the chosen role's
            role: "owner",
            membership: { team_id: team.id, member_role: "owner", status: "active", bundle: v.as === "owner" ? null : v.as.bundle, permissions: [] },
            permissions: viewAsPermissions(v.as, bundles),
            viewAs: { label },
            admin: true,
          },
        }
      }
    }
    // An admin who has been ADDED to a team as a member (the owner does it from CRM > Marketing > Teams) works as that member, with no "View as" step; "View as" above still wins when it is on.
    // If that is not possible (not a member, paused, team switched off) he gets the "View as" message, as before.
    const own = await memberContext(user.id, user.email ?? null, "marketing")
    if (own.ok) return { ok: true, ctx: { ...own.ctx, admin: true } }
    return { ok: false, status: 403, code: "ADMIN_NO_VIEW", message: "You are signed in as Antonio. Open CRM > Marketing > Teams and press \"View as\" to see a team's workspace." }
  }
  return memberContext(user.id, user.email ?? null, role)
}

/** The context of a person who is a member of a team: his membership, the team's status and his permissions. `role` is the login's role as the door rules see it (an admin who is a member is let through as "marketing"). */
async function memberContext(userId: string, email: string | null, role: unknown): Promise<GuardResult> {
  const { data: members } = await db().from("marketing_team_members")
    .select("team_id, member_role, status, bundle, permissions").eq("user_id", userId)
    // a login in several teams (Antonio, who can add himself to any) always lands in the same one: the team he joined first
    .order("joined_at", { ascending: true }).order("team_id", { ascending: true })
  const memberships = (members ?? []) as GuardMembership[]
  const teamIds = Array.from(new Set(memberships.map(m => m.team_id)))
  const { data: teams } = teamIds.length
    ? await db().from("marketing_teams").select("id, name, status").in("id", teamIds)
    : { data: [] }
  const verdict = decideMarketingAccess({ signedIn: true, role, memberships, teams: (teams ?? []) as GuardTeam[] })
  if (verdict.ok === false) return verdict
  const bundles = (await getMarketingSetting("permission_bundles", verdict.team.id)) as Record<string, string[]>
  const permissions = effectivePermissions({
    memberRole: verdict.membership.member_role, bundle: verdict.membership.bundle, bundles, extra: verdict.membership.permissions,
  })
  return {
    ok: true,
    ctx: { user: { id: userId, email }, team: verdict.team, role: verdict.membership.member_role, membership: verdict.membership, permissions },
  }
}

/** The context of an admin login that has been added to a team as a member (no "View as" involved) — for the CRM menu's red number. Not ok when he is not a member. */
export async function adminMemberContext(user: { id: string; email?: string | null }): Promise<GuardResult> {
  const r = await memberContext(user.id, user.email ?? null, "marketing")
  // He is the admin here exactly as in resolveMarketingContext (his own membership): without the flag the chat treated him as a team owner and handed him the setter's chat on his Home page and in his menu number (29 Oct 2026).
  return r.ok ? { ok: true, ctx: { ...r.ctx, admin: true } } : r
}

/** For API routes: the context, or the ready-to-return refusal. */
export async function requireMarketing(need?: MarketingPermission): Promise<{ ctx: MarketingContext; res?: undefined } | { ctx?: undefined; res: NextResponse }> {
  const g = await resolveMarketingContext()
  if (g.ok === false) return { res: NextResponse.json({ error: g.message, code: g.code }, { status: g.status, headers: { "Cache-Control": "no-store" } }) }
  if (need && !hasPermission(g.ctx.permissions, need)) {
    return { res: NextResponse.json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, { status: 403, headers: { "Cache-Control": "no-store" } }) }
  }
  return { ctx: g.ctx }
}

/** The ONLY way marketing code should read a team table with the service key: the team filter is added for you. */
export function teamScoped(ctx: Pick<MarketingContext, "team">, table: string) {
  return db().from(table).select("*").eq("team_id", ctx.team.id)
}
