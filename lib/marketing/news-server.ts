/**
 * TD Marketing — What's New (server; dev job 9aec66fa, Addendum H). Tables marketing_news and marketing_news_reads (service key only; the routes decide who may call).
 * A member reads only posts that are posted, for his team (or for every team) and for his audience; opening one marks it read for him, except in "View as" (Antonio looking in as
 * someone else records nothing). Only the strict admin posts, edits, withdraws, approves a draft or discards it. Failing safe: a database without the tables shows no news and no error.
 */
import type { MarketingContext } from "@/lib/marketing/guard"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { effectivePermissions } from "@/lib/marketing/permissions"
import { getMarketingSetting, listTeams } from "@/lib/marketing/settings"
import { listMembers } from "@/lib/marketing/members"
import { personName } from "@/lib/marketing/setter-note"
import { sendMarketingPush } from "@/lib/marketing/push"
import { ANNOUNCEMENTS, audienceMatches, hrefForLink, pendingAnnouncements, readSummary, validateNews, type Announcement, type NewsAudience, type NewsInput } from "@/lib/marketing/news"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

export interface NewsRow {
  id: string; team_id: string | null; title: string; body: string; title_it: string | null; body_it: string | null; link_key: string | null; audience: NewsAudience
  feature_key: string | null; status: "posted" | "withdrawn" | "discarded"; created_by: string; created_at: string; posted_at: string | null; edited_at: string | null; withdrawn_at: string | null
}
export interface NewsItem extends NewsRow { unread: boolean; href: string | null }
type R<T = undefined> = { ok: true; data: T } | { ok: false; error: string; status: number }
const COLS = "id, team_id, title, body, title_it, body_it, link_key, audience, feature_key, status, created_by, created_at, posted_at, edited_at, withdrawn_at"
const NEWS_CAP = 50

/** The posts this person may read, newest first, each with whether he has not opened it yet. */
export async function listNewsFor(ctx: Pick<MarketingContext, "team" | "user" | "permissions">): Promise<NewsItem[]> {
  try {
    const { data, error } = await db().from("marketing_news").select(COLS).eq("status", "posted")
      .or(`team_id.is.null,team_id.eq.${ctx.team.id}`).order("posted_at", { ascending: false }).limit(NEWS_CAP)
    if (error) { console.error("[marketing] news read failed:", error.message); return [] }
    const rows = ((data ?? []) as NewsRow[]).filter(n => audienceMatches(n.audience, ctx.permissions))
    if (rows.length === 0) return []
    const { data: reads } = await db().from("marketing_news_reads").select("news_id").eq("user_id", ctx.user.id).in("news_id", rows.map(r => r.id))
    const seen = new Set(((reads ?? []) as Array<{ news_id: string }>).map(r => r.news_id))
    return rows.map(n => ({ ...n, unread: !seen.has(n.id), href: hrefForLink(n.link_key) }))
  } catch (e) {
    console.error("[marketing] news read failed:", e instanceof Error ? e.message : e)
    return []
  }
}

export async function unreadNewsCount(ctx: Pick<MarketingContext, "team" | "user" | "permissions">): Promise<number> {
  return (await listNewsFor(ctx)).filter(n => n.unread).length
}

/** The person opened a post: remember it. "View as" records nothing. A post he may not read is a plain "not found". */
export async function markNewsRead(ctx: Pick<MarketingContext, "team" | "user" | "permissions" | "viewAs">, id: string): Promise<R> {
  const { data } = await db().from("marketing_news").select(COLS).eq("id", id).eq("status", "posted").maybeSingle()
  const n = data as NewsRow | null
  if (!n || (n.team_id !== null && n.team_id !== ctx.team.id) || !audienceMatches(n.audience, ctx.permissions)) return { ok: false, error: "News not found.", status: 404 }
  if (ctx.viewAs) return { ok: true, data: undefined }
  const { error } = await db().from("marketing_news_reads").upsert({ news_id: id, user_id: ctx.user.id, read_at: new Date().toISOString() }, { onConflict: "news_id,user_id" })
  if (error) { console.error("[marketing] news read-mark failed:", error.message); return { ok: false, error: "Could not save. Please try again.", status: 500 } }
  return { ok: true, data: undefined }
}

// ── Antonio's side ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewsAdminItem extends NewsRow { href: string | null; read: number; total: number; unreadNames: string[]; readers: Array<{ name: string; at: string }> }
export interface NewsAdminView { drafts: Announcement[]; posts: NewsAdminItem[]; available: boolean }

interface Person { id: string; name: string; email: string | null; teamId: string; perms: string[] }

/** Every active person of the teams that are not a draft or cancelled, with the permissions he really holds. Read once per call (each member costs a login lookup). */
async function loadPeople(): Promise<Person[]> {
  const out: Person[] = []
  for (const t of (await listTeams()).filter(x => x.status === "active")) {
    const bundles = (await getMarketingSetting("permission_bundles", t.id)) as Record<string, string[]>
    for (const m of await listMembers(t.id)) {
      if (m.status !== "active" || !m.user_id) continue
      out.push({ id: m.user_id as string, name: personName(m.email), email: m.email, teamId: t.id, perms: effectivePermissions({ memberRole: m.member_role as "owner" | "member", bundle: m.bundle, bundles, extra: m.permissions }) })
    }
  }
  return out
}

/** Everyone a post goes to: the people of its team (or of every active team) in its audience, except the person who posted it. */
function recipientsFor(n: Pick<NewsRow, "team_id" | "audience" | "created_by">, people: readonly Person[]): Array<{ id: string; name: string; teamId: string }> {
  return people
    .filter(p => (n.team_id ? p.teamId === n.team_id : true) && !(p.email && p.email.toLowerCase() === n.created_by.toLowerCase()) && audienceMatches(n.audience, p.perms))
    .map(p => ({ id: p.id, name: p.name, teamId: p.teamId }))
}

export async function loadNewsAdmin(): Promise<NewsAdminView> {
  try {
    const { data, error } = await db().from("marketing_news").select(COLS).order("created_at", { ascending: false }).limit(100)
    if (error) { console.error("[marketing] news admin read failed:", error.message); return { drafts: [], posts: [], available: false } }
    const rows = (data ?? []) as NewsRow[]
    const decided = new Set(rows.filter(r => r.feature_key).map(r => r.feature_key as string))
    const shown = rows.filter(r => r.status !== "discarded")
    const ids = shown.map(r => r.id)
    const { data: reads } = ids.length ? await db().from("marketing_news_reads").select("news_id, user_id, read_at").in("news_id", ids) : { data: [] }
    const byNews = new Map<string, Array<{ user_id: string; read_at: string }>>()
    for (const r of (reads ?? []) as Array<{ news_id: string; user_id: string; read_at: string }>) byNews.set(r.news_id, [...(byNews.get(r.news_id) ?? []), r])
    const people = await loadPeople()
    const posts: NewsAdminItem[] = []
    for (const n of shown) {
      const rec = recipientsFor(n, people)
      const mine = byNews.get(n.id) ?? []
      const readerIds = new Set(mine.map(m => m.user_id))
      const s = readSummary(rec, readerIds)
      const at = new Map(mine.map(m => [m.user_id, m.read_at]))
      posts.push({ ...n, href: hrefForLink(n.link_key), read: s.read, total: s.total, unreadNames: s.unread, readers: rec.filter(r => readerIds.has(r.id)).map(r => ({ name: r.name, at: at.get(r.id) as string })) })
    }
    return { drafts: pendingAnnouncements(decided), posts, available: true }
  } catch (e) {
    console.error("[marketing] news admin read failed:", e instanceof Error ? e.message : e)
    return { drafts: [], posts: [], available: false }
  }
}

/** How many drafts wait for Antonio (the red number on his menu). 0 when it cannot be read. */
export async function draftCount(): Promise<number> {
  try {
    const { data, error } = await db().from("marketing_news").select("feature_key").not("feature_key", "is", null)
    if (error) return 0
    return pendingAnnouncements(new Set(((data ?? []) as Array<{ feature_key: string }>).map(r => r.feature_key))).length
  } catch { return 0 }
}

const UNIQUE_VIOLATION = "23505"

/** Post news to every team. `featureKey` is set when Antonio approves a prepared draft (it can be edited first): the same draft can never be posted twice. Then the audience gets a push. */
export async function postNews(by: string, input: NewsInput, featureKey?: string): Promise<R<{ id: string; notified: number }>> {
  if (featureKey && !ANNOUNCEMENTS.some(a => a.key === featureKey)) return { ok: false, error: "That draft does not exist.", status: 404 }
  const now = new Date().toISOString()
  const { data, error } = await db().from("marketing_news").insert({
    team_id: null, title: input.title, body: input.body, title_it: input.titleIt, body_it: input.bodyIt, link_key: input.linkKey, audience: input.audience,
    feature_key: featureKey ?? null, status: "posted", created_by: by, posted_at: now,
  }).select(COLS).single()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, error: "This draft was already decided. Reload the page.", status: 409 }
    console.error("[marketing] news post failed:", error.message)
    return { ok: false, error: "Could not post. Please try again.", status: 500 }
  }
  const row = data as NewsRow
  return { ok: true, data: { id: row.id, notified: await pushNews(row) } }
}

/** Tell the audience by push (the phone/computer alert the team already has). Never throws; a failed push never fails the post. */
async function pushNews(n: NewsRow): Promise<number> {
  try {
    const rec = recipientsFor(n, await loadPeople())
    const byTeam = new Map<string, string[]>()
    for (const r of rec) byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r.id])
    let sent = 0
    for (const [teamId, ids] of Array.from(byTeam.entries())) {
      const r = await sendMarketingPush(teamId, ids, { title: n.title_it || n.title, body: (n.body_it || n.body).slice(0, 140), url: hrefForLink(n.link_key) ?? "/marketing/news", tag: `news-${n.id}` })
      sent += r.sent
    }
    return sent
  } catch { return 0 }
}

/** Change a post (it is marked as edited; people who read it keep their "read" mark). Only a posted one. */
export async function editNews(id: string, input: NewsInput): Promise<R> {
  const { data, error } = await db().from("marketing_news").update({
    title: input.title, body: input.body, title_it: input.titleIt, body_it: input.bodyIt, link_key: input.linkKey, audience: input.audience, edited_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "posted").select("id")
  if (error) return { ok: false, error: "Could not save. Please try again.", status: 500 }
  if (!data || data.length === 0) return { ok: false, error: "News not found, or it was withdrawn.", status: 404 }
  return { ok: true, data: undefined }
}

/** Take a post back: the team stops seeing it; the row and its read history stay for Antonio. */
export async function withdrawNews(id: string): Promise<R> {
  const { data, error } = await db().from("marketing_news").update({ status: "withdrawn", withdrawn_at: new Date().toISOString() }).eq("id", id).eq("status", "posted").select("id")
  if (error) return { ok: false, error: "Could not withdraw. Please try again.", status: 500 }
  if (!data || data.length === 0) return { ok: false, error: "News not found, or it was already withdrawn.", status: 404 }
  return { ok: true, data: undefined }
}

/** Antonio decided a prepared draft is not for the team: it is remembered by its key and never comes back. */
export async function discardDraft(by: string, featureKey: string): Promise<R> {
  const a = ANNOUNCEMENTS.find(x => x.key === featureKey)
  if (!a) return { ok: false, error: "That draft does not exist.", status: 404 }
  const v = validateNews({ title: a.title, body: a.body, titleIt: a.titleIt, bodyIt: a.bodyIt, linkKey: a.menuKey, audience: a.audience })
  if (v.ok === false) return { ok: false, error: v.error, status: 500 }
  const { error } = await db().from("marketing_news").insert({ team_id: null, title: a.title, body: a.body, title_it: a.titleIt, body_it: a.bodyIt, link_key: a.menuKey, audience: a.audience, feature_key: featureKey, status: "discarded", created_by: by })
  if (error) return error.code === UNIQUE_VIOLATION ? { ok: false, error: "This draft was already decided. Reload the page.", status: 409 } : { ok: false, error: "Could not save. Please try again.", status: 500 }
  return { ok: true, data: undefined }
}
