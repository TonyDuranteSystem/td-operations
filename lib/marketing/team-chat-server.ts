/**
 * TD Marketing — the team's own chat, server side (dev job 9aec66fa, round 2 step 3): direct messages and groups. Every function takes the guard's context: the team id is in every query, and a
 * conversation is always read through the team AND my membership first, so another team's id — or a conversation I am not in — finds nothing. The rules are in `team-chat.ts` (pure, tested)
 * and `lead-chat.ts` (shared with the lead chat); the screen is the same TD Talk pieces. This file only reads and writes.
 */
import { randomUUID } from "crypto"
import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireMarketing, type MarketingContext } from "@/lib/marketing/guard"
import { personName } from "@/lib/marketing/setter-note"
import { sendMarketingPush } from "@/lib/marketing/push"
import { chatMembers, shape, NO_STORE, UNREAD_LOOKBACK_DAYS } from "@/lib/marketing/lead-chat-server"
import { pointerBefore } from "@/lib/talk/unread-pointer"
import {
  BUCKET, checkEdit, checkEmoji, checkSend, isUuid, mayDelete, mayEdit, newObjectPath, previewLine, unreadCount,
  type ChatMessageRow, type ChatReaction, type StoredAttachment,
} from "@/lib/marketing/lead-chat"
import { checkGroup, dmKey, MAX_GROUP_MEMBERS, GROUP_TITLE_MAX, parseMentions, sortThreads, threadPush, threadRecipients, threadTitle, threadUrlFor, type GroupAction, type ThreadRow } from "@/lib/marketing/team-chat"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; storage: any }
export { NO_STORE }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const MESSAGE_COLS = "id, sender_id, sender_name, message, attachments, reply_to_id, edited_at, deleted_at, created_at"
const LOAD_LIMIT = 500
const CAP = 5000
/** the most conversations whose newest line is looked up in one list (the rest still show their unread numbers) */
const MAX_LISTED = 80

export interface Thread { id: string; kind: "dm" | "group"; title: string | null; created_by: string }
type Res<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; status: number }
const fail = (error: string, status: number) => ({ ok: false as const, error, status })

/** For every team-chat route: the chat permission (the ad person has it too: direct messages and groups are for the whole team). */
export async function requireTeamChat(): Promise<{ ctx: MarketingContext; res?: undefined } | { res: NextResponse; ctx?: undefined }> {
  const g = await requireMarketing("chat")
  if (g.res) return { res: g.res }
  return { ctx: g.ctx }
}

type Person = { id: string; name: string; status: string }
const guestNames = new Map<string, string>()
/** The names of people who are in a conversation but are not on the team's member list (Antonio looking in with "View as" is one): read once from their login, then remembered. */
async function guestName(id: string): Promise<string | undefined> {
  const hit = guestNames.get(id)
  if (hit) return hit
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(id)
    const name = data?.user?.email ? personName(data.user.email) : undefined
    if (name) { guestNames.set(id, name); if (guestNames.size > 500) guestNames.delete(Array.from(guestNames.keys())[0]) }
    return name
  } catch { return undefined }
}

/** Everyone in a conversation as a person with a name: a team member as the chat knows them, anyone else by their login. */
async function peopleOf(teamMembers: Awaited<ReturnType<typeof chatMembers>>, ids: readonly string[]): Promise<Person[]> {
  const out: Person[] = []
  for (const id of ids) {
    const m = teamMembers.find(x => x.id === id)
    if (m) { out.push({ id, name: m.name, status: m.status }); continue }
    const name = await guestName(id)
    if (name) out.push({ id, name, status: "active" })
  }
  return out
}

/** A conversation of MY team that I am a member of, with its members; null for anything else (another team's, a stranger's, not a uuid). */
export async function myThread(ctx: MarketingContext, threadId: string): Promise<{ thread: Thread; memberIds: string[] } | null> {
  if (!isUuid(threadId)) return null
  const d = db()
  const { data: t } = await d.from("marketing_chat_threads").select("id, kind, title, created_by").eq("id", threadId).eq("team_id", ctx.team.id).maybeSingle()
  if (!t) return null
  const { data: ms } = await d.from("marketing_chat_thread_members").select("user_id").eq("thread_id", threadId)
  const memberIds = ((ms ?? []) as Array<{ user_id: string }>).map(m => m.user_id)
  return memberIds.includes(ctx.user.id) ? { thread: t as Thread, memberIds } : null
}

/** For the routes about one conversation. */
export async function openThread(threadId: string): Promise<{ ctx: MarketingContext; thread: Thread; memberIds: string[]; res?: undefined } | { res: NextResponse; ctx?: undefined; thread?: undefined; memberIds?: undefined }> {
  const g = await requireTeamChat()
  if (g.res) return { res: g.res }
  const t = await myThread(g.ctx, threadId)
  if (!t) return { res: json({ error: "Chat not found." }, 404) }
  return { ctx: g.ctx, ...t }
}

const chunk = <T,>(a: readonly T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out }

/** My conversations: the name I see, the newest line and who wrote it, my unread number, whether I was mentioned in what is unread. Newest / unread first. Also the people I can start a chat with. */
export async function listThreads(ctx: MarketingContext): Promise<{ threads: ThreadRow[]; people: Array<{ id: string; name: string }>; me: string }> {
  const d = db()
  const me = ctx.user.id
  const members = await chatMembers(ctx.team.id)
  const people = members.filter(m => m.status === "active" && m.id !== me).map(m => ({ id: m.id, name: m.name }))
  const { data: mine } = await d.from("marketing_chat_thread_members").select("thread_id").eq("user_id", me).limit(1000)
  const ids = ((mine ?? []) as Array<{ thread_id: string }>).map(x => x.thread_id)
  if (ids.length === 0) return { threads: [], people, me }
  const threads: Array<{ id: string; kind: "dm" | "group"; title: string | null }> = []
  const memberRows: Array<{ thread_id: string; user_id: string }> = []
  const reads = new Map<string, string>()
  for (const part of chunk(ids, 100)) {
    const [{ data: ts, error: e1 }, { data: ms, error: e2 }, { data: rs, error: e3 }] = await Promise.all([
      d.from("marketing_chat_threads").select("id, kind, title").eq("team_id", ctx.team.id).in("id", part),
      d.from("marketing_chat_thread_members").select("thread_id, user_id").in("thread_id", part),
      d.from("marketing_team_chat_reads").select("thread_id, last_read_at").eq("user_id", me).in("thread_id", part),
    ])
    if (e1 || e2 || e3) console.error("[marketing] team chat list failed:", (e1 ?? e2 ?? e3)?.message)
    threads.push(...((ts ?? []) as typeof threads)); memberRows.push(...((ms ?? []) as typeof memberRows))
    for (const r of (rs ?? []) as Array<{ thread_id: string; last_read_at: string }>) reads.set(r.thread_id, r.last_read_at)
  }
  const teamIds = threads.map(t => t.id)
  // the newest line of each conversation: ONE small read per conversation (never the whole history); and what is unread / mentioned: one LIGHT read per hundred conversations
  const since = new Date(Date.now() - UNREAD_LOOKBACK_DAYS * 86_400_000).toISOString()
  const lastOf = new Map<string, ChatMessageRow>()
  const recent: Array<{ thread_id: string; sender_id: string; created_at: string; deleted_at: string | null; mentions: string[] | null }> = []
  await Promise.all([
    Promise.all(teamIds.slice(0, MAX_LISTED).map(async id => {
      const { data, error } = await d.from("marketing_team_messages").select(MESSAGE_COLS).eq("team_id", ctx.team.id).eq("thread_id", id).order("created_at", { ascending: false }).limit(1)
      if (error) console.error("[marketing] team chat newest line failed:", error.message)
      const row = ((data ?? []) as ChatMessageRow[])[0]
      if (row) lastOf.set(id, row)
    })),
    Promise.all(chunk(teamIds, 100).map(async part => {
      const { data, error } = await d.from("marketing_team_messages").select("thread_id, sender_id, created_at, deleted_at, mentions").eq("team_id", ctx.team.id).neq("sender_id", me).is("deleted_at", null).gte("created_at", since).in("thread_id", part).order("created_at", { ascending: false }).limit(CAP)
      if (error) console.error("[marketing] team chat unread failed:", error.message)
      recent.push(...((data ?? []) as typeof recent))
    })),
  ])
  // the people of these conversations: team members as the chat knows them, anyone else (Antonio under View as) by their login
  const memberIdsAll = Array.from(new Set(memberRows.map(m => m.user_id)))
  const named = await peopleOf(members, memberIdsAll)
  const nameOf = (id: string) => named.find(p => p.id === id)?.name
  const rows: ThreadRow[] = threads.map(t => {
    const last = lastOf.get(t.id)
    const readAt = reads.get(t.id) ?? null
    const unreadMsgs = recent.filter(m => m.thread_id === t.id && (!readAt || m.created_at > readAt))
    const memberIds = memberRows.filter(m => m.thread_id === t.id).map(m => m.user_id)
    return {
      id: t.id, kind: t.kind, title: threadTitle({ kind: t.kind, title: t.title, memberIds }, me, nameOf),
      lastAt: last?.created_at ?? null, last: last ? previewLine({ message: last.message, attachments: last.attachments, deleted_at: last.deleted_at }) : "", lastBy: last ? (last.sender_id === me ? "" : last.sender_name) : "",
      unread: unreadMsgs.length, mentioned: unreadMsgs.some(m => (m.mentions ?? []).includes(me)), memberIds,
    }
  })
  return { threads: sortThreads(rows), people, me }
}

/** My unread numbers per conversation (the menu's red number adds these to the lead chats'). Three small reads, like the lead chats' count: it runs on every screen, so it must stay cheap. */
export async function unreadByThread(ctx: MarketingContext): Promise<Map<string, number>> {
  const d = db()
  const me = ctx.user.id
  const { data: mine } = await d.from("marketing_chat_thread_members").select("thread_id").eq("user_id", me).limit(1000)
  const ids = ((mine ?? []) as Array<{ thread_id: string }>).map(x => x.thread_id)
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const since = new Date(Date.now() - UNREAD_LOOKBACK_DAYS * 86_400_000).toISOString()
  const reads = new Map<string, string>()
  const byThread = new Map<string, Array<{ sender_id: string; created_at: string; deleted_at: string | null }>>()
  for (const part of chunk(ids, 100)) {
    const [{ data: rs, error: e1 }, { data: ms, error: e2 }] = await Promise.all([
      d.from("marketing_team_chat_reads").select("thread_id, last_read_at").eq("user_id", me).in("thread_id", part),
      d.from("marketing_team_messages").select("thread_id, sender_id, created_at, deleted_at").eq("team_id", ctx.team.id).neq("sender_id", me).is("deleted_at", null).gte("created_at", since).in("thread_id", part).order("created_at", { ascending: false }).limit(CAP),
    ])
    if (e1 || e2) console.error("[marketing] team chat unread failed:", (e1 ?? e2)?.message)
    for (const r of (rs ?? []) as Array<{ thread_id: string; last_read_at: string }>) reads.set(r.thread_id, r.last_read_at)
    for (const m of (ms ?? []) as Array<{ thread_id: string; sender_id: string; created_at: string; deleted_at: string | null }>) { const l = byThread.get(m.thread_id) ?? []; l.push(m); byThread.set(m.thread_id, l) }
  }
  byThread.forEach((list, id) => { const n = unreadCount(list, me, reads.get(id) ?? null); if (n > 0) out.set(id, n) })
  return out
}

/** The direct message with another person: opened, or created the first time. One chat per pair. */
export async function openDm(ctx: MarketingContext, otherId: unknown): Promise<Res<{ threadId: string }>> {
  if (!isUuid(otherId)) return fail("Pick a person.", 400)
  if (otherId === ctx.user.id) return fail("You cannot write to yourself.", 400)
  const members = await chatMembers(ctx.team.id)
  if (!members.some(m => m.id === otherId && m.status === "active")) return fail("That person cannot be reached in this chat.", 400)
  const d = db()
  const key = dmKey(ctx.user.id, otherId)
  const find = async () => (await d.from("marketing_chat_threads").select("id").eq("team_id", ctx.team.id).eq("kind", "dm").eq("dm_key", key).maybeSingle()).data as { id: string } | null
  const both = [{ thread_id: "", user_id: ctx.user.id, added_by: ctx.user.id }, { thread_id: "", user_id: otherId, added_by: ctx.user.id }]
  const ensureMembers = (threadId: string) => d.from("marketing_chat_thread_members").upsert(both.map(m => ({ ...m, thread_id: threadId })), { onConflict: "thread_id,user_id", ignoreDuplicates: true })
  const existing = await find()
  if (existing) {
    // a chat whose second step once failed has no members: put the two people back (it can never be left broken)
    const { error: healErr } = await ensureMembers(existing.id)
    return healErr ? fail("Could not open the chat. Please try again.", 500) : { ok: true, threadId: existing.id }
  }
  const { data: t, error } = await d.from("marketing_chat_threads").insert({ team_id: ctx.team.id, kind: "dm", dm_key: key, created_by: ctx.user.id }).select("id").single()
  if (error || !t) {
    // two people starting the same chat at once: the second one finds the first one's
    if ((error as { code?: string } | null)?.code === "23505") { const again = await find(); if (again) return { ok: true, threadId: again.id } }
    return fail("Could not start the chat. Please try again.", 500)
  }
  const { error: mErr } = await ensureMembers(t.id)
  if (mErr) { await d.from("marketing_chat_threads").delete().eq("id", t.id); return fail("Could not start the chat. Please try again.", 500) }
  return { ok: true, threadId: t.id }
}

/** A new group, with the people picked (each must be able to use the chat in this team). Those added are told. */
export async function createGroup(ctx: MarketingContext, body: { title?: unknown; member_ids?: unknown }): Promise<Res<{ threadId: string }>> {
  const members = await chatMembers(ctx.team.id)
  const c = checkGroup({ title: body.title, memberIds: body.member_ids, creatorId: ctx.user.id, allowed: new Set(members.filter(m => m.status === "active").map(m => m.id)) })
  if (c.ok === false) return fail(c.error, 400)
  const d = db()
  const { data: t, error } = await d.from("marketing_chat_threads").insert({ team_id: ctx.team.id, kind: "group", title: c.title, created_by: ctx.user.id }).select("id").single()
  if (error || !t) return fail("Could not create the group. Please try again.", 500)
  const { error: mErr } = await d.from("marketing_chat_thread_members").insert(c.memberIds.map(id => ({ thread_id: t.id, user_id: id, added_by: ctx.user.id })))
  if (mErr) { await d.from("marketing_chat_threads").delete().eq("id", t.id); return fail("Could not create the group. Please try again.", 500) }
  await tell(ctx.team.id, c.memberIds.filter(id => id !== ctx.user.id), { title: `${personName(ctx.user.email ?? "")} added you to a group`, body: c.title, url: threadUrlFor(t.id), tag: `team-${t.id}` })
  return { ok: true, threadId: t.id }
}

/** Rename a group, add people to it, or leave it (a direct message has none of these). Any member may rename and add; leaving takes only me out, and the history stays. */
export async function groupAction(ctx: MarketingContext, t: { thread: Thread; memberIds: string[] }, input: GroupAction): Promise<Res> {
  if (t.thread.kind !== "group") return fail("This is a direct message.", 400)
  const d = db()
  if (input.action === "rename") {
    const title = typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ") : ""
    if (!title) return fail("Give the group a name.", 400)
    if (title.length > GROUP_TITLE_MAX) return fail(`The group name is too long (max ${GROUP_TITLE_MAX} characters).`, 400)
    const { error } = await d.from("marketing_chat_threads").update({ title }).eq("id", t.thread.id).eq("team_id", ctx.team.id)
    return error ? fail("Could not rename the group.", 500) : { ok: true }
  }
  if (input.action === "add") {
    const members = await chatMembers(ctx.team.id)
    const allowed = new Set(members.filter(m => m.status === "active").map(m => m.id))
    const wanted = Array.isArray(input.memberIds) ? Array.from(new Set((input.memberIds as unknown[]).filter((x): x is string => typeof x === "string"))).filter(id => !t.memberIds.includes(id)) : []
    if (wanted.length === 0) return fail("Pick at least one person who is not in the group yet.", 400)
    if (wanted.some(id => !allowed.has(id))) return fail("One of those people cannot be in this chat.", 400)
    if (t.memberIds.length + wanted.length > MAX_GROUP_MEMBERS) return fail(`A group can have at most ${MAX_GROUP_MEMBERS} people.`, 400)
    const { error } = await d.from("marketing_chat_thread_members").upsert(wanted.map(id => ({ thread_id: t.thread.id, user_id: id, added_by: ctx.user.id })), { onConflict: "thread_id,user_id", ignoreDuplicates: true })
    if (error) return fail("Could not add them.", 500)
    await tell(ctx.team.id, wanted, { title: `${personName(ctx.user.email ?? "")} added you to a group`, body: t.thread.title ?? "", url: threadUrlFor(t.thread.id), tag: `team-${t.thread.id}` })
    return { ok: true }
  }
  const { error } = await d.from("marketing_chat_thread_members").delete().eq("thread_id", t.thread.id).eq("user_id", ctx.user.id)
  return error ? fail("Could not leave the group.", 500) : { ok: true }
}

/** One conversation: the newest messages (oldest first), who has read and received how far, who is in it. `markRead` follows TD Talk's rule: only while the person is looking. */
export async function loadThread(ctx: MarketingContext, t: { thread: Thread; memberIds: string[] }, markRead: boolean) {
  const d = db()
  const me = ctx.user.id
  const [{ data: rowsDesc }, { data: reads }, { data: deliveries }, members] = await Promise.all([
    d.from("marketing_team_messages").select(MESSAGE_COLS).eq("team_id", ctx.team.id).eq("thread_id", t.thread.id).order("created_at", { ascending: false }).limit(LOAD_LIMIT),
    d.from("marketing_team_chat_reads").select("user_id, last_read_at").eq("thread_id", t.thread.id),
    d.from("marketing_team_chat_delivery").select("user_id, delivered_at").eq("thread_id", t.thread.id),
    chatMembers(ctx.team.id),
  ])
  const rows = ((rowsDesc ?? []) as ChatMessageRow[]).slice().reverse()
  const ids = rows.map(r => r.id)
  const { data: reacts } = ids.length ? await d.from("marketing_team_message_reactions").select("message_id, user_id, user_name, emoji").in("message_id", ids) : { data: [] }
  if (markRead) await markThreadRead(ctx, t.thread.id)
  // the people of THIS conversation who can be reached (a paused person is not waited for: his ticks would never turn blue); a person who is not on the team list (Antonio under View as) counts too
  const inChat = await peopleOf(members, t.memberIds)
  const waiting = inChat.filter(m => m.status === "active" && m.id !== me)
  return {
    me,
    thread: { id: t.thread.id, kind: t.thread.kind, title: threadTitle({ kind: t.thread.kind, title: t.thread.title, memberIds: t.memberIds }, me, id => inChat.find(m => m.id === id)?.name) },
    messages: await shape(rows, (reacts ?? []) as ChatReaction[]),
    members: inChat.map(m => ({ id: m.id, name: m.name })),
    member_ids: waiting.map(m => m.id),
    member_reads: ((reads ?? []) as Array<{ user_id: string; last_read_at: string }>).filter(r => r.user_id !== me),
    member_delivered: ((deliveries ?? []) as Array<{ user_id: string; delivered_at: string }>).filter(r => r.user_id !== me),
  }
}

export async function markThreadRead(ctx: MarketingContext, threadId: string): Promise<void> {
  await db().from("marketing_team_chat_reads").upsert({ thread_id: threadId, team_id: ctx.team.id, user_id: ctx.user.id, last_read_at: new Date().toISOString() }, { onConflict: "thread_id,user_id" })
}

/** "Mark unread" from one message on, for me only — the same as a lead chat's (see markLeadUnreadFrom). */
export async function markThreadUnreadFrom(ctx: MarketingContext, threadId: string, messageId: unknown): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const m = typeof messageId === "string" ? await myMessage(ctx, messageId) : null
  if (!m || m.thread_id !== threadId) return { ok: false, error: "That message was not found.", status: 404 }
  const { data: cur } = await db().from("marketing_team_chat_reads").select("last_read_at").eq("thread_id", threadId).eq("user_id", ctx.user.id).maybeSingle()
  const next = pointerBefore(m.created_at, (cur as { last_read_at: string } | null)?.last_read_at ?? null)
  const { error } = await db().from("marketing_team_chat_reads").upsert({ thread_id: threadId, team_id: ctx.team.id, user_id: ctx.user.id, last_read_at: next }, { onConflict: "thread_id,user_id" })
  return error ? { ok: false, error: "Could not mark it unread. Please try again.", status: 500 } : { ok: true }
}

/** This device now has these conversations: tell the others (grey double tick). Only conversations I am in. */
export async function markThreadsDelivered(ctx: MarketingContext, threadIds: readonly string[]): Promise<number> {
  const ids = Array.from(new Set(threadIds.filter(isUuid))).slice(0, 50)
  if (ids.length === 0) return 0
  const { data: own } = await db().from("marketing_chat_thread_members").select("thread_id").eq("user_id", ctx.user.id).in("thread_id", ids)
  const now = new Date().toISOString()
  const rows = ((own ?? []) as Array<{ thread_id: string }>).map(x => ({ thread_id: x.thread_id, team_id: ctx.team.id, user_id: ctx.user.id, delivered_at: now }))
  if (rows.length) await db().from("marketing_team_chat_delivery").upsert(rows, { onConflict: "thread_id,user_id" })
  return rows.length
}

/** Tell people by push, waiting at most a few seconds (a slow phone service must not hold up the sender). Never throws. */
async function tell(teamId: string, userIds: readonly string[], p: { title: string; body: string; url: string; tag: string }): Promise<number> {
  if (userIds.length === 0) return 0
  try {
    const r = await Promise.race([sendMarketingPush(teamId, userIds, p), new Promise<null>(resolve => setTimeout(() => resolve(null), 4000))])
    return r?.sent ?? 0
  } catch { return 0 }
}

export async function sendThreadMessage(ctx: MarketingContext, t: { thread: Thread; memberIds: string[] }, body: { message?: unknown; attachments?: unknown; reply_to_id?: unknown }): Promise<{ ok: true; message: unknown } | { ok: false; error: string; status: number }> {
  const c = checkSend({ message: body.message, attachments: body.attachments, teamId: ctx.team.id, leadId: t.thread.id })
  if (c.ok === false) return { ok: false, error: c.error, status: 400 }
  const d = db()
  let replyTo: string | null = null
  if (body.reply_to_id != null) {
    if (!isUuid(body.reply_to_id)) return { ok: false, error: "The message you are answering was not found.", status: 400 }
    const { data: q } = await d.from("marketing_team_messages").select("id").eq("id", body.reply_to_id).eq("thread_id", t.thread.id).maybeSingle()
    if (!q) return { ok: false, error: "The message you are answering was not found.", status: 400 }
    replyTo = body.reply_to_id
  }
  const members = await chatMembers(ctx.team.id)
  const inChat = await peopleOf(members, t.memberIds)
  const mentions = parseMentions(c.message, inChat.map(m => ({ id: m.id, name: m.name })), ctx.user.id)
  const senderName = personName(ctx.user.email ?? "")
  const { data: row, error } = await d.from("marketing_team_messages").insert({
    team_id: ctx.team.id, thread_id: t.thread.id, sender_id: ctx.user.id, sender_name: senderName, message: c.message, attachments: c.attachments.length ? c.attachments : null, reply_to_id: replyTo, mentions,
  }).select(MESSAGE_COLS).single()
  if (error || !row) return { ok: false, error: "Could not send. Please try again.", status: 500 }
  await Promise.all([markThreadRead(ctx, t.thread.id), markThreadsDelivered(ctx, [t.thread.id])])
  const [message] = await shape([row as ChatMessageRow], [])
  // tell the others (never the sender); a failed notification never fails the message. A person named with @ gets a note that says so.
  try {
    const to = threadRecipients(inChat.map(m => ({ user_id: m.id, status: m.status })), ctx.user.id)
    const preview = previewLine({ message: c.message, attachments: c.attachments, deleted_at: null })
    const named = to.filter(id => mentions.includes(id))
    const rest = to.filter(id => !mentions.includes(id))
    // a direct message is titled by the sender (the person already knows it is a chat with them); a group by "sender · group". A mention has its OWN notification tag, so the next ordinary message does not replace it.
    const where = t.thread.kind === "group" ? t.thread.title ?? "" : ""
    await Promise.all([
      tell(ctx.team.id, named, { ...threadPush({ senderName, threadTitle: where, kind: t.thread.kind, mentioned: true, preview }), url: threadUrlFor(t.thread.id), tag: `team-${t.thread.id}-at` }),
      tell(ctx.team.id, rest, { ...threadPush({ senderName, threadTitle: where, kind: t.thread.kind, mentioned: false, preview }), url: threadUrlFor(t.thread.id), tag: `team-${t.thread.id}` }),
    ])
  } catch { /* the message is already saved */ }
  return { ok: true, message }
}

/** A signed upload link for ONE file into this conversation's own folder of the private bucket. */
export async function createThreadUploadUrl(ctx: MarketingContext, thread: Thread, fileName: unknown): Promise<{ ok: true; signedUrl: string; token: string; path: string } | { ok: false; error: string; status: number }> {
  if (typeof fileName !== "string" || !fileName.trim()) return { ok: false, error: "file_name required", status: 400 }
  const path = newObjectPath(ctx.team.id, thread.id, fileName, randomUUID())
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) return { ok: false, error: "Could not start the upload. Please try again.", status: 500 }
  return { ok: true, signedUrl: data.signedUrl, token: data.token, path }
}

/** A message of MY team in a conversation I am in; null for anything else (so an id from another team or another chat finds nothing). */
async function myMessage(ctx: MarketingContext, id: string): Promise<(ChatMessageRow & { thread_id: string }) | null> {
  if (!isUuid(id)) return null
  const { data } = await db().from("marketing_team_messages").select(`${MESSAGE_COLS}, thread_id`).eq("id", id).eq("team_id", ctx.team.id).maybeSingle()
  const m = data as (ChatMessageRow & { thread_id: string }) | null
  if (!m) return null
  return (await myThread(ctx, m.thread_id)) ? m : null
}

export async function editThreadMessage(ctx: MarketingContext, id: string, text: unknown): Promise<{ ok: true; message: { message: string; edited_at: string } } | { ok: false; error: string; status: number }> {
  const c = checkEdit(text)
  if (c.ok === false) return { ok: false, error: c.error, status: 400 }
  const m = await myMessage(ctx, id)
  if (!m) return { ok: false, error: "Message not found", status: 404 }
  if (m.deleted_at) return { ok: false, error: "Cannot edit a deleted message", status: 400 }
  if (!mayEdit(m, ctx.user.id)) return { ok: false, error: "You can only edit your own messages.", status: 403 }
  const edited_at = new Date().toISOString()
  const { error } = await db().from("marketing_team_messages").update({ message: c.message, edited_at, original_message: m.message }).eq("id", id).is("deleted_at", null)
  if (error) return { ok: false, error: "Could not edit the message.", status: 500 }
  await remention(ctx, m, c.message)
  return { ok: true, message: { message: c.message, edited_at } }
}

/** After an edit: the people named in the NEW text are the mentioned ones (a name added is notified now, a name taken out stops counting). Best effort: the edit is already saved. */
async function remention(ctx: MarketingContext, m: ChatMessageRow & { thread_id: string }, text: string): Promise<void> {
  try {
    const t = await myThread(ctx, m.thread_id)
    if (!t) return
    const inChat = await peopleOf(await chatMembers(ctx.team.id), t.memberIds)
    const now = parseMentions(text, inChat.map(p => ({ id: p.id, name: p.name })), ctx.user.id)
    const { data: before } = await db().from("marketing_team_messages").select("mentions").eq("id", m.id).maybeSingle()
    const was = ((before?.mentions ?? []) as string[])
    await db().from("marketing_team_messages").update({ mentions: now }).eq("id", m.id)
    const fresh = now.filter(id => !was.includes(id) && inChat.some(p => p.id === id && p.status !== "removed" && p.status !== "paused"))
    if (fresh.length === 0) return
    const senderName = personName(ctx.user.email ?? "")
    await tell(ctx.team.id, fresh, { ...threadPush({ senderName, threadTitle: t.thread.kind === "group" ? t.thread.title ?? "" : "", kind: t.thread.kind, mentioned: true, preview: previewLine({ message: text, attachments: m.attachments, deleted_at: null }) }), url: threadUrlFor(t.thread.id), tag: `team-${t.thread.id}-at` })
  } catch { /* the edit is already saved */ }
}

export async function deleteThreadMessage(ctx: MarketingContext, id: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const m = await myMessage(ctx, id)
  if (!m) return { ok: false, error: "Message not found", status: 404 }
  if (m.deleted_at) return { ok: true }
  if (!mayDelete(m, ctx.user.id, ctx.role === "owner")) return { ok: false, error: "You can only delete your own messages.", status: 403 }
  const { error } = await db().from("marketing_team_messages").update({ deleted_at: new Date().toISOString(), deleted_by: ctx.user.id }).eq("id", id).is("deleted_at", null)
  if (error) return { ok: false, error: "Could not delete the message.", status: 500 }
  return { ok: true }
}

export async function toggleThreadReaction(ctx: MarketingContext, id: string, emojiIn: unknown): Promise<{ ok: true; reactions: unknown[] } | { ok: false; error: string; status: number }> {
  const emoji = checkEmoji(emojiIn)
  if (!emoji) return { ok: false, error: "A valid emoji is required.", status: 400 }
  const m = await myMessage(ctx, id)
  if (!m || m.deleted_at) return { ok: false, error: "Message not found", status: 404 }
  const d = db()
  // try to add; if it is already there (the primary key says so) take it away — two quick taps can never both "add"
  const { error: addErr } = await d.from("marketing_team_message_reactions").insert({ message_id: id, user_id: ctx.user.id, user_name: personName(ctx.user.email ?? ""), emoji })
  if (addErr) {
    if ((addErr as { code?: string }).code !== "23505") return { ok: false, error: "Could not react.", status: 500 }
    await d.from("marketing_team_message_reactions").delete().eq("message_id", id).eq("user_id", ctx.user.id).eq("emoji", emoji)
  }
  const { data } = await d.from("marketing_team_message_reactions").select("message_id, user_id, user_name, emoji").eq("message_id", id)
  return { ok: true, reactions: ((data ?? []) as ChatReaction[]).map(r => ({ emoji: r.emoji, reactor_id: r.user_id, reactor_name: r.user_name })) }
}

/** One stored voice note of a message in a conversation I am in. */
export async function threadVoiceAttachment(ctx: MarketingContext, messageId: string, index: unknown): Promise<{ msg: ChatMessageRow; att: StoredAttachment } | null> {
  const m = await myMessage(ctx, messageId)
  if (!m || m.deleted_at || typeof index !== "number" || !Number.isInteger(index) || index < 0) return null
  const att = (m.attachments ?? [])[index]
  if (!att || !(att.mime_type ?? "").startsWith("audio/")) return null
  return { msg: m, att }
}

export async function saveThreadTranscript(messageId: string, index: number, path: string, transcript: unknown): Promise<void> {
  const { data: fresh } = await db().from("marketing_team_messages").select("attachments").eq("id", messageId).maybeSingle()
  const list = Array.isArray(fresh?.attachments) ? (fresh.attachments as StoredAttachment[]) : null
  if (!list || !list[index] || list[index].path !== path) return
  await db().from("marketing_team_messages").update({ attachments: list.map((a, i) => (i === index ? { ...a, transcript } : a)) }).eq("id", messageId)
}
