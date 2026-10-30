/**
 * TD Marketing — the lead chat, server side (dev job 9aec66fa, Addendum G). Every function takes the guard's context: the team id is in every query and the lead is
 * always read through the team first, so another team's lead id finds nothing. The words and the rules are in `lead-chat.ts` (pure, tested); this file only reads and writes.
 */
import { randomUUID } from "crypto"
import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireMarketing, type MarketingContext } from "@/lib/marketing/guard"
import { hasPermission, effectivePermissions } from "@/lib/marketing/permissions"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { listMembers } from "@/lib/marketing/members"
import { getTeamLead, type LeadRow } from "@/lib/marketing/leads-read"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { personName } from "@/lib/marketing/setter-note"
import type { Bundles } from "@/lib/marketing/access"
import { sendMarketingPush } from "@/lib/marketing/push"
import { parseMentions, threadPush } from "@/lib/marketing/team-chat"
import { pointerBefore } from "@/lib/talk/unread-pointer"
import {
  BUCKET, SIGNED_URL_SECONDS, URL_CACHE_SECONDS, checkEdit, inLane, isInvolved, isSetterOnly, checkEmoji, checkSend, chatUrlFor, isUuid, laneLabels, lanesFor, laneRecipients, mayDelete, mayEdit, newObjectPath, previewLine, resolveLane, toTalkMessage, unreadCount,
  type ChatMessageRow, type ChatReaction, type Lane, type StoredAttachment,
} from "@/lib/marketing/lead-chat"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; storage: any }
export const NO_STORE = { "Cache-Control": "no-store" }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const MESSAGE_COLS = "id, sender_id, sender_name, message, attachments, reply_to_id, edited_at, deleted_at, created_at"
/** the newest messages one open chat holds (like TD Talk: the latest 500) */
const LOAD_LIMIT = 500

/** For every chat route: the chat permission AND the right to read leads, a lead that belongs to the guard's team, and the lane (which of the lead's two chats) when the route is about one. */
export async function openChat(leadId: string, laneAsked?: unknown): Promise<{ ctx: MarketingContext; lead: LeadRow; lane: Lane; res?: undefined } | { res: NextResponse; ctx?: undefined; lead?: undefined; lane?: undefined }> {
  const g = await requireMarketing("chat")
  if (g.res) return { res: g.res }
  if (!hasPermission(g.ctx.permissions, "leads.read")) return { res: json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, 403) }
  if (!isUuid(leadId)) return { res: json({ error: "Lead not found." }, 404) }
  const lead = await getTeamLead(leadDb(), g.ctx.team.id, leadId)
  if (!lead) return { res: json({ error: "Lead not found." }, 404) }
  // which of the lead's two chats: the one asked for, only if it is one of this person's
  const lane = resolveLane(laneAsked, laneAccess(g.ctx))
  if (!lane) return { res: json({ error: "This chat is not yours.", code: "NO_LANE" }, 403) }
  return { ctx: g.ctx, lead, lane }
}

/** For the chat routes that are not about one lead: the same two permissions as `openChat` (the chat AND the right to read leads), so a list of conversations never shows more than the leads would. */
export async function requireChatAccess(): Promise<{ ctx: MarketingContext; res?: undefined } | { res: NextResponse; ctx?: undefined }> {
  const g = await requireMarketing("chat")
  if (g.res) return { res: g.res }
  if (!hasPermission(g.ctx.permissions, "leads.read")) return { res: json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, 403) }
  return { ctx: g.ctx }
}

type ChatMember = { id: string; name: string; permissions: string[]; status: string; isAdmin: boolean }
const MEMBER_CACHE_MS = 60_000
const memberCache = new Map<string, { at: number; list: ChatMember[] }>()

/** The team's people who may use the chat (not removed, with the chat permission), as ids and names — the ones the ticks and the notifications are about. Kept for a minute: the chat asks every few seconds and each member costs a call to the login service. */
export async function chatMembers(teamId: string): Promise<ChatMember[]> {
  const hit = memberCache.get(teamId)
  if (hit && Date.now() - hit.at < MEMBER_CACHE_MS) return hit.list
  const list = await loadChatMembers(teamId)
  memberCache.set(teamId, { at: Date.now(), list })
  return list
}

/** The lanes (the two chats of a lead) this person may use: a setter the setter lane, Antonio on his own login the owners lane, Rocco both; Antonio "viewing as" a role gets that role's lanes. */
export const laneAccess = (ctx: MarketingContext): Lane[] => lanesFor({ permissions: ctx.permissions, admin: ctx.admin === true, viewAs: ctx.viewAs !== undefined })

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name

/** The buttons this person gets on a lead, each named after the other side ("Discuss with Antonio", "Discuss with Cristina", "Discuss with Rocco"). Names come from the people's profiles. */
export async function laneButtons(ctx: MarketingContext): Promise<Array<{ lane: Lane; label: string }>> {
  const members = (await chatMembers(ctx.team.id)).filter(m => m.status !== "removed")
  const setters = members.filter(m => isSetterOnly(m.permissions)).map(m => firstName(m.name))
  const seller = members.find(m => !isSetterOnly(m.permissions) && !m.isAdmin && isInvolved(m.permissions))
  const admin = members.find(m => m.isAdmin)
  const lanes = laneAccess(ctx)
  return laneLabels(lanes, { admin: admin ? firstName(admin.name) : "Antonio", seller: seller ? firstName(seller.name) : "Rocco", setters: setters.length ? setters.join(" & ") : "the setter" }, { isSetter: isSetterOnly(ctx.permissions), isAdmin: ctx.admin === true && ctx.viewAs === undefined })
}

/**
 * Messages of a lead's team, for a viewer, from the lanes the viewer may read (`run` adds the lane filter to the query it builds). A setter is never handed the owners lane, whatever the screen asks:
 * the privacy is here, at the read. `pinned_at` is asked for only by the chat screen, and a database without the pin columns (migration not run) simply shows no pins.
 */
async function readMessages<T extends { sender_id: string }>(
  ctx: MarketingContext, cols: string, run: (cols: string, lanes: Lane[]) => PromiseLike<{ data: unknown; error: { code?: string } | null }>, withPins = false,
): Promise<T[]> {
  const lanes = laneAccess(ctx)
  const ask = async (c: string) => {
    if (!withPins) return run(c, lanes)
    const r = await run(`${c}, pinned_at`, lanes)
    return r.error?.code === "42703" ? run(c, lanes) : r
  }
  return ((await ask(cols)).data ?? []) as T[]
}

async function loadChatMembers(teamId: string): Promise<ChatMember[]> {
  const bundles = (await getMarketingSetting("permission_bundles", teamId)) as Bundles
  const rows = await listMembers(teamId)
  return rows
    .filter(m => m.status !== "removed")
    .map(m => ({ id: m.user_id as string, name: m.full_name || personName(m.email), isAdmin: m.is_admin === true, status: String(m.status), permissions: effectivePermissions({ memberRole: m.member_role as "owner" | "member", bundle: m.bundle, bundles, extra: m.permissions }) as string[] }))
    .filter(m => m.permissions.includes("chat"))
}

const urlCache = new Map<string, { at: number; url: string }>()

/** Signed links for these files. The same link is handed out for URL_CACHE_SECONDS (fewer calls to storage, and the audio player is not reloaded by every refresh); a new one is signed after that. */
export async function signUrls(paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const now = Date.now()
  const missing: string[] = []
  for (const p of Array.from(new Set(paths))) {
    const hit = urlCache.get(p)
    if (hit && now - hit.at < URL_CACHE_SECONDS * 1000) out.set(p, hit.url)
    else missing.push(p)
  }
  if (missing.length === 0) return out
  const { data } = await db().storage.from(BUCKET).createSignedUrls(missing, SIGNED_URL_SECONDS)
  for (const r of (data ?? []) as Array<{ path: string | null; signedUrl: string | null }>) {
    if (r.path && r.signedUrl) { out.set(r.path, r.signedUrl); urlCache.set(r.path, { at: now, url: r.signedUrl }) }
  }
  if (urlCache.size > 5000) for (const k of Array.from(urlCache.keys()).slice(0, 1000)) urlCache.delete(k)
  return out
}

export async function shape(rows: ChatMessageRow[], reactions: ChatReaction[]) {
  const byId = new Map(rows.map(r => [r.id, r]))
  const urls = await signUrls(rows.flatMap(r => (r.deleted_at ? [] : (r.attachments ?? []).map(a => a.path))))
  return rows.map(r => toTalkMessage(r, byId, reactions, p => urls.get(p) ?? null))
}

/** One lane of a lead's chat: the newest messages (oldest first), who has read and received how far, who can chat. `markRead` follows TD Talk's rule: only while the person is looking. */
export async function loadChat(ctx: MarketingContext, leadId: string, markRead: boolean, lane: Lane) {
  const d = db()
  const [rowsDesc, { data: reads }, { data: deliveries }, members] = await Promise.all([
    readMessages<ChatMessageRow>(ctx, MESSAGE_COLS, (cols, lanes) => d.from("marketing_lead_messages").select(cols).eq("team_id", ctx.team.id).eq("lead_id", leadId).eq("lane", lane).in("lane", lanes).order("created_at", { ascending: false }).limit(LOAD_LIMIT), true),
    d.from("marketing_lead_lane_reads").select("user_id, last_read_at").eq("lead_id", leadId).eq("lane", lane),
    d.from("marketing_lead_lane_delivery").select("user_id, delivered_at").eq("lead_id", leadId).eq("lane", lane),
    chatMembers(ctx.team.id),
  ])
  const rows = rowsDesc.slice().reverse()
  const ids = rows.map(r => r.id)
  // a pin must not drop out of the bar because 500 newer messages arrived: when the window is full, the older pins are fetched on their own
  const olderRaw = rowsDesc.length >= LOAD_LIMIT
    ? await readMessages<ChatMessageRow>(ctx, MESSAGE_COLS, (cols, lanes) => d.from("marketing_lead_messages").select(cols).eq("team_id", ctx.team.id).eq("lead_id", leadId).eq("lane", lane).in("lane", lanes).not("pinned_at", "is", null).is("deleted_at", null).order("pinned_at", { ascending: false }).limit(OLDER_PINS_LIMIT), true)
    : []
  const { data: reacts } = ids.length ? await d.from("marketing_lead_message_reactions").select("message_id, user_id, user_name, emoji").in("message_id", ids) : { data: [] }
  if (markRead) await markLeadRead(ctx, leadId, lane)
  const me = ctx.user.id
  // the people of THIS lane (Rocco and the setter in hers; Antonio and Rocco in the owners one); the ticks wait for the ones who work the leads, not for the ad person who only watches
  // (a paused person is not waited for: his ticks would never turn blue)
  const inThisLane = members.filter(m => m.status === "active" && isInvolved(m.permissions) && inLane(m, lane))
  const memberIds = inThisLane.map(m => m.id).filter(id => id !== me)
  const messages = await shape(rows, (reacts ?? []) as ChatReaction[])
  return {
    me,
    lane,
    messages,
    older_pins: await shapeOlderPins(olderRaw, new Set(ids)),
    members: inThisLane.map(m => ({ id: m.id, name: m.name })),
    // the ticks: how far every OTHER person of this lane has read / received it
    member_ids: memberIds,
    member_reads: ((reads ?? []) as Array<{ user_id: string; last_read_at: string }>).filter(r => r.user_id !== me),
    member_delivered: ((deliveries ?? []) as Array<{ user_id: string; delivered_at: string }>).filter(r => r.user_id !== me),
  }
}

export async function markLeadRead(ctx: MarketingContext, leadId: string, lane: Lane): Promise<void> {
  await db().from("marketing_lead_lane_reads").upsert({ lead_id: leadId, lane, team_id: ctx.team.id, user_id: ctx.user.id, last_read_at: new Date().toISOString() }, { onConflict: "lead_id,lane,user_id" })
}

/**
 * "Mark unread" from one message on, for ME only (TD Marketing chats; Antonio 28 Oct 2026): my read position moves back to just before that message, so it and everything newer from others is
 * unread again for me — nobody else's chat changes. Never moves the position forward (older unread messages stay unread). A message a setter may not see does not exist for her.
 */
export async function markLeadUnreadFrom(ctx: MarketingContext, leadId: string, messageId: unknown): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const m = typeof messageId === "string" ? await messageInTeam(ctx, messageId) : null
  if (!m || m.lead_id !== leadId) return { ok: false, error: "That message was not found.", status: 404 }
  // the lane of the message is the lane whose position moves
  const { data: cur } = await db().from("marketing_lead_lane_reads").select("last_read_at").eq("lead_id", leadId).eq("lane", m.lane).eq("user_id", ctx.user.id).maybeSingle()
  const next = pointerBefore(m.created_at, (cur as { last_read_at: string } | null)?.last_read_at ?? null)
  const { error } = await db().from("marketing_lead_lane_reads").upsert({ lead_id: leadId, lane: m.lane, team_id: ctx.team.id, user_id: ctx.user.id, last_read_at: next }, { onConflict: "lead_id,lane,user_id" })
  return error ? { ok: false, error: "Could not mark it unread. Please try again.", status: 500 } : { ok: true }
}

/** Pin or unpin a message of a lead's chat. Anyone who can see the message may (a setter cannot touch a message she may not read: it does not exist for her). */
export async function setLeadMessagePinned(ctx: MarketingContext, leadId: string, messageId: unknown, pinned: boolean): Promise<{ ok: true; pinned_at: string | null } | { ok: false; error: string; status: number }> {
  const m = typeof messageId === "string" ? await messageInTeam(ctx, messageId) : null
  if (!m || m.lead_id !== leadId) return { ok: false, error: "That message was not found.", status: 404 }
  return writePin("marketing_lead_messages", m, ctx, pinned)
}

/**
 * The one writer of a pin (lead chats and team conversations). Pinning a message that is already pinned keeps the first pin (somebody with an out-of-date screen cannot move it or change who pinned it);
 * a deleted message cannot be pinned, but its pin can always be cleared.
 */
export async function writePin(table: "marketing_lead_messages" | "marketing_team_messages", m: { id: string; deleted_at: string | null }, ctx: MarketingContext, pinned: boolean): Promise<{ ok: true; pinned_at: string | null } | { ok: false; error: string; status: number }> {
  const d = db()
  if (!pinned) {
    const { error } = await d.from(table).update({ pinned_at: null, pinned_by: null }).eq("id", m.id).eq("team_id", ctx.team.id)
    return error ? pinFailure(error) : { ok: true, pinned_at: null }
  }
  if (m.deleted_at) return { ok: false, error: "A deleted message cannot be pinned.", status: 400 }
  const now = new Date().toISOString()
  const { data: set, error } = await d.from(table).update({ pinned_at: now, pinned_by: ctx.user.id }).eq("id", m.id).eq("team_id", ctx.team.id).is("pinned_at", null).select("pinned_at")
  if (error) return pinFailure(error)
  if ((set ?? []).length > 0) return { ok: true, pinned_at: now }
  const { data: cur } = await d.from(table).select("pinned_at").eq("id", m.id).maybeSingle()
  return { ok: true, pinned_at: (cur as { pinned_at: string | null } | null)?.pinned_at ?? now }
}

/** The pins older than the newest LOAD_LIMIT messages (only looked for when the window is full), shaped for the screen; they feed the pinned bar and nothing else. */
export async function shapeOlderPins(older: ChatMessageRow[], windowIds: ReadonlySet<string>) {
  const rows = older.filter(r => !windowIds.has(r.id)).map(r => ({ ...r, reply_to_id: null }))
  return shape(rows, [])
}
export const OLDER_PINS_LIMIT = 20

/** The pin columns are not in the database yet (migration not run) is a clear answer; anything else is a plain failure. */
export function pinFailure(error: { code?: string; message?: string }): { ok: false; error: string; status: number } {
  // a write to a column that is not there comes back as 42703 from the database or as PGRST204 from the gateway ("Could not find the 'pinned_at' column")
  const missing = error.code === "42703" || error.code === "PGRST204" || /pinned_(at|by)/.test(error.message ?? "")
  return missing
    ? { ok: false, error: "Pinning is not switched on yet. Please tell Antonio.", status: 503 }
    : { ok: false, error: "Could not pin the message. Please try again.", status: 500 }
}

/** This device now has the chat: tell the others (grey double tick). Only leads of the guard's team, only lanes that are the person's own. */
export async function markDelivered(ctx: MarketingContext, items: ReadonlyArray<{ lead_id: string; lane?: unknown }>): Promise<number> {
  const allowed = laneAccess(ctx)
  const wanted = items.filter(i => isUuid(i.lead_id)).map(i => ({ lead_id: i.lead_id, lane: resolveLane(i.lane, allowed) })).filter((i): i is { lead_id: string; lane: Lane } => i.lane !== null).slice(0, 50)
  if (wanted.length === 0) return 0
  const ids = Array.from(new Set(wanted.map(w => w.lead_id)))
  const { data: own } = await db().from("marketing_leads").select("id").eq("team_id", ctx.team.id).in("id", ids)
  const mine = new Set(((own ?? []) as Array<{ id: string }>).map(l => l.id))
  const now = new Date().toISOString()
  const rows = wanted.filter(w => mine.has(w.lead_id)).map(w => ({ lead_id: w.lead_id, lane: w.lane, team_id: ctx.team.id, user_id: ctx.user.id, delivered_at: now }))
  if (rows.length) await db().from("marketing_lead_lane_delivery").upsert(rows, { onConflict: "lead_id,lane,user_id" })
  return rows.length
}

export async function sendChatMessage(ctx: MarketingContext, lead: LeadRow, body: { message?: unknown; attachments?: unknown; reply_to_id?: unknown }, lane: Lane): Promise<{ ok: true; message: unknown } | { ok: false; error: string; status: number }> {
  const c = checkSend({ message: body.message, attachments: body.attachments, teamId: ctx.team.id, leadId: lead.id })
  if (c.ok === false) return { ok: false, error: c.error, status: 400 }
  const d = db()
  let replyTo: string | null = null
  if (body.reply_to_id != null) {
    if (!isUuid(body.reply_to_id)) return { ok: false, error: "The message you are answering was not found.", status: 400 }
    const { data: q } = await d.from("marketing_lead_messages").select("id").eq("id", body.reply_to_id).eq("lead_id", lead.id).eq("lane", lane).maybeSingle()
    if (!q) return { ok: false, error: "The message you are answering was not found.", status: 400 }
    replyTo = body.reply_to_id
  }
  // the people named with @ (among those of THIS lane); a lookup that fails only means nobody is named: the message is still sent
  let members: Awaited<ReturnType<typeof chatMembers>> = []
  try { members = await chatMembers(ctx.team.id) } catch { /* the message matters more than the mention */ }
  // the sender is shown by the name on her profile ("Cristina"), else by her email's name
  const senderName = members.find(m => m.id === ctx.user.id)?.name ?? personName(ctx.user.email ?? "")
  const mentions = parseMentions(c.message, members.filter(m => isInvolved(m.permissions) && inLane(m, lane)).map(m => ({ id: m.id, name: m.name })), ctx.user.id)
  const base = { team_id: ctx.team.id, lead_id: lead.id, lane, sender_id: ctx.user.id, sender_name: senderName, message: c.message, attachments: c.attachments.length ? c.attachments : null, reply_to_id: replyTo }
  // `mentions` is only written when somebody IS named, so a team that has not run the team-chat migration yet can still send ordinary messages
  let { data: row, error } = await d.from("marketing_lead_messages").insert(mentions.length ? { ...base, mentions } : base).select(MESSAGE_COLS).single()
  // the mentions column is not there yet (migration not run): send the message without it rather than not at all (the person is still notified below)
  if (error && mentions.length && (error as { code?: string }).code === "42703") ({ data: row, error } = await d.from("marketing_lead_messages").insert(base).select(MESSAGE_COLS).single())
  if (error || !row) return { ok: false, error: "Could not send. Please try again.", status: 500 }
  // what you send you have read, and this device has it
  await Promise.all([markLeadRead(ctx, lead.id, lane), markDelivered(ctx, [{ lead_id: lead.id, lane }])])
  const [message] = await shape([row as ChatMessageRow], [])
  // tell the others (never the sender); a failed notification never fails the message
  try {
    const to = laneRecipients(members.map(m => ({ user_id: m.id, status: m.status, permissions: m.permissions, isAdmin: m.isAdmin })), ctx.user.id, lane)
    // a lead with no name is shown by its email, never its phone number (a notification can sit on a lock screen)
    const leadName = lead.full_name || lead.email || "Lead"
    const preview = previewLine({ message: c.message, attachments: c.attachments, deleted_at: null })
    const named = to.filter(id => mentions.includes(id))
    const rest = to.filter(id => !mentions.includes(id))
    // WAIT for the notifications (a function may be stopped as soon as it has answered), but never longer than a few seconds: a slow phone service must not hold up the sender.
    // A person named with @ gets a note that says so.
    const send = (ids: string[], mentioned: boolean) => (ids.length === 0 ? Promise.resolve() : Promise.race([
      sendMarketingPush(ctx.team.id, ids, { ...threadPush({ senderName, threadTitle: leadName, kind: "lead", mentioned, preview }), url: chatUrlFor(lead.id, lane), tag: mentioned ? `chat-${lead.id}-${lane}-at` : `chat-${lead.id}-${lane}` }),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ]))
    await Promise.all([send(named, true), send(rest, false)])
  } catch { /* the message is already saved */ }
  return { ok: true, message }
}

async function messageInTeam(ctx: MarketingContext, id: string): Promise<(ChatMessageRow & { lead_id: string; lane: Lane }) | null> {
  if (!isUuid(id)) return null
  const res = await db().from("marketing_lead_messages").select(`${MESSAGE_COLS}, lead_id, lane`).eq("id", id).eq("team_id", ctx.team.id).maybeSingle()
  const m = (res.data as unknown as (ChatMessageRow & { lead_id: string; lane: Lane }) | null) ?? null
  // a message in a chat that is not hers does not exist for her: no edit, delete, reaction, pin or transcript
  if (m && !laneAccess(ctx).includes(m.lane)) return null
  return m
}

export async function editChatMessage(ctx: MarketingContext, id: string, text: unknown): Promise<{ ok: true; message: { message: string; edited_at: string } } | { ok: false; error: string; status: number }> {
  const c = checkEdit(text)
  if (c.ok === false) return { ok: false, error: c.error, status: 400 }
  const m = await messageInTeam(ctx, id)
  if (!m) return { ok: false, error: "Message not found", status: 404 }
  if (m.deleted_at) return { ok: false, error: "Cannot edit a deleted message", status: 400 }
  if (!mayEdit(m, ctx.user.id)) return { ok: false, error: "You can only edit your own messages.", status: 403 }
  const edited_at = new Date().toISOString()
  const { error } = await db().from("marketing_lead_messages").update({ message: c.message, edited_at, original_message: m.message }).eq("id", id).is("deleted_at", null)
  if (error) return { ok: false, error: "Could not edit the message.", status: 500 }
  if (c.message.includes("@") || m.message.includes("@")) await remention(ctx, m, c.message)
  return { ok: true, message: { message: c.message, edited_at } }
}

/** After an edit that has an @ in it: the people named now are told (a name added in the edit). Best effort and only when there is an @: the edit is saved, and a team without the migration is never disturbed. */
async function remention(ctx: MarketingContext, m: ChatMessageRow & { lead_id: string; lane: Lane }, text: string): Promise<void> {
  try {
    const members = await chatMembers(ctx.team.id)
    const now = parseMentions(text, members.filter(x => isInvolved(x.permissions) && inLane(x, m.lane)).map(x => ({ id: x.id, name: x.name })), ctx.user.id)
    const { data: before, error: readErr } = await db().from("marketing_lead_messages").select("mentions, lead_id").eq("id", m.id).maybeSingle()
    if (readErr) return
    const was = ((before?.mentions ?? []) as string[])
    if (now.length === 0 && was.length === 0) return
    const { error } = await db().from("marketing_lead_messages").update({ mentions: now }).eq("id", m.id)
    if (error) return
    const to = laneRecipients(members.map(x => ({ user_id: x.id, status: x.status, permissions: x.permissions, isAdmin: x.isAdmin })), ctx.user.id, m.lane).filter(id => now.includes(id) && !was.includes(id))
    if (to.length === 0) return
    const { data: lead } = await db().from("marketing_leads").select("full_name, email").eq("id", m.lead_id).eq("team_id", ctx.team.id).maybeSingle()
    await Promise.race([
      sendMarketingPush(ctx.team.id, to, { ...threadPush({ senderName: personName(ctx.user.email ?? ""), threadTitle: lead?.full_name || lead?.email || "Lead", kind: "lead", mentioned: true, preview: previewLine({ message: text, attachments: m.attachments, deleted_at: null }) }), url: chatUrlFor(m.lead_id, m.lane), tag: `chat-${m.lead_id}-${m.lane}-at` }),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ])
  } catch { /* the edit is already saved */ }
}

export async function deleteChatMessage(ctx: MarketingContext, id: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const m = await messageInTeam(ctx, id)
  if (!m) return { ok: false, error: "Message not found", status: 404 }
  if (m.deleted_at) return { ok: true }
  if (!mayDelete(m, ctx.user.id, ctx.role === "owner")) return { ok: false, error: "You can only delete your own messages.", status: 403 }
  const { error } = await db().from("marketing_lead_messages").update({ deleted_at: new Date().toISOString(), deleted_by: ctx.user.id }).eq("id", id).is("deleted_at", null)
  if (error) return { ok: false, error: "Could not delete the message.", status: 500 }
  return { ok: true }
}

/** Toggle one emoji of mine on a message; answers with the message's reactions as TD Talk's screen wants them. */
export async function toggleReaction(ctx: MarketingContext, id: string, emojiIn: unknown): Promise<{ ok: true; reactions: unknown[] } | { ok: false; error: string; status: number }> {
  const emoji = checkEmoji(emojiIn)
  if (!emoji) return { ok: false, error: "A valid emoji is required.", status: 400 }
  const m = await messageInTeam(ctx, id)
  if (!m || m.deleted_at) return { ok: false, error: "Message not found", status: 404 }
  const d = db()
  // try to add; if it is already there (the primary key says so) take it away — two quick taps can never both "add"
  const { error: addErr } = await d.from("marketing_lead_message_reactions").insert({ message_id: id, user_id: ctx.user.id, user_name: personName(ctx.user.email ?? ""), emoji })
  if (addErr) {
    if ((addErr as { code?: string }).code !== "23505") return { ok: false, error: "Could not react.", status: 500 }
    await d.from("marketing_lead_message_reactions").delete().eq("message_id", id).eq("user_id", ctx.user.id).eq("emoji", emoji)
  }
  const { data } = await d.from("marketing_lead_message_reactions").select("message_id, user_id, user_name, emoji").eq("message_id", id)
  return { ok: true, reactions: ((data ?? []) as ChatReaction[]).map(r => ({ emoji: r.emoji, reactor_id: r.user_id, reactor_name: r.user_name })) }
}

/** A signed upload link for ONE file into this lead's own folder of the private bucket. */
export async function createUploadUrl(ctx: MarketingContext, lead: LeadRow, fileName: unknown): Promise<{ ok: true; signedUrl: string; token: string; path: string } | { ok: false; error: string; status: number }> {
  if (typeof fileName !== "string" || !fileName.trim()) return { ok: false, error: "file_name required", status: 400 }
  const path = newObjectPath(ctx.team.id, lead.id, fileName, randomUUID())
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) return { ok: false, error: "Could not start the upload. Please try again.", status: 500 }
  return { ok: true, signedUrl: data.signedUrl, token: data.token, path }
}

/** One stored voice note: the attachment at `index` of a message in this team, plus the file's bytes' path (never a URL from the browser). */
export async function voiceAttachment(ctx: MarketingContext, messageId: string, index: unknown): Promise<{ msg: ChatMessageRow; att: StoredAttachment } | null> {
  const m = await messageInTeam(ctx, messageId)
  if (!m || m.deleted_at || typeof index !== "number" || !Number.isInteger(index) || index < 0) return null
  const att = (m.attachments ?? [])[index]
  if (!att || !(att.mime_type ?? "").startsWith("audio/")) return null
  return { msg: m, att }
}

/** Write the transcript onto the attachment (re-read just before, matched by path, so a concurrent change is not overwritten). */
export async function saveTranscript(messageId: string, index: number, path: string, transcript: unknown): Promise<void> {
  const { data: fresh } = await db().from("marketing_lead_messages").select("attachments").eq("id", messageId).maybeSingle()
  const list = Array.isArray(fresh?.attachments) ? (fresh.attachments as StoredAttachment[]) : null
  if (!list || !list[index] || list[index].path !== path) return
  await db().from("marketing_lead_messages").update({ attachments: list.map((a, i) => (i === index ? { ...a, transcript } : a)) }).eq("id", messageId)
}

export async function downloadFile(path: string): Promise<Blob | null> {
  const { data, error } = await db().storage.from(BUCKET).download(path)
  return error || !data ? null : (data as Blob)
}

/** Only messages from the last 90 days are counted as unread (the number is recomputed on every screen, so it must not grow with the whole history). */
export const UNREAD_LOOKBACK_DAYS = 90
const CHAT_ROW_CAP = 5000

/** My unread numbers per chat (a lead and a lane, as "<lead>|<lane>"): how many, who wrote the newest unread one (a setter or anybody else, Antonio included) and when. Only the lanes I may read are counted. */
export async function unreadByLane(ctx: MarketingContext): Promise<Map<string, { n: number; from: "setter" | "owner"; at: string }>> {
  const d = db()
  const teamId = ctx.team.id
  const userId = ctx.user.id
  const since = new Date(Date.now() - UNREAD_LOOKBACK_DAYS * 86_400_000).toISOString()
  const [{ data: reads, error: e1 }, msgs, members] = await Promise.all([
    d.from("marketing_lead_lane_reads").select("lead_id, lane, last_read_at").eq("user_id", userId).eq("team_id", teamId),
    readMessages<{ lead_id: string; lane: string; sender_id: string; created_at: string; deleted_at: string | null }>(ctx, "lead_id, lane, sender_id, created_at, deleted_at", (cols, lanes) => d.from("marketing_lead_messages").select(cols).eq("team_id", teamId).in("lane", lanes).neq("sender_id", userId).is("deleted_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(CHAT_ROW_CAP)),
    chatMembers(teamId).catch(() => [] as ChatMember[]),
  ])
  // a failed read is a zero on the screen; at least leave a trace in the server log
  if (e1) console.error("[marketing] unread count failed:", e1.message)
  const setters = new Set(members.filter(m => isSetterOnly(m.permissions)).map(m => m.id))
  const readAt = new Map(((reads ?? []) as Array<{ lead_id: string; lane: string; last_read_at: string }>).map(r => [`${r.lead_id}|${r.lane}`, r.last_read_at]))
  const by = new Map<string, Array<{ sender_id: string; created_at: string; deleted_at: string | null }>>()
  for (const m of msgs) { const key = `${m.lead_id}|${m.lane}`; by.set(key, [...(by.get(key) ?? []), m]) }
  const out = new Map<string, { n: number; from: "setter" | "owner"; at: string }>()
  for (const [key, list] of Array.from(by)) {
    const last = readAt.get(key) ?? null
    const n = unreadCount(list, userId, last)
    if (n === 0) continue
    // the list is newest first: the first unread one says who wrote the newest
    const newest = list.find(m => !m.deleted_at && (!last || m.created_at > last))
    out.set(key, { n, from: newest && setters.has(newest.sender_id) ? "setter" : "owner", at: newest?.created_at ?? "" })
  }
  return out
}

/** My unread numbers per lead, both chats added, and who wrote the newest unread message. */
export async function unreadDetailByLead(ctx: MarketingContext): Promise<Map<string, { n: number; from: "setter" | "owner" }>> {
  const out = new Map<string, { n: number; from: "setter" | "owner"; at: string }>()
  for (const [key, u] of Array.from(await unreadByLane(ctx))) {
    const lead = key.split("|")[0]
    const cur = out.get(lead)
    out.set(lead, { n: (cur?.n ?? 0) + u.n, from: cur && cur.at > u.at ? cur.from : u.from, at: cur && cur.at > u.at ? cur.at : u.at })
  }
  return new Map(Array.from(out).map(([lead, u]) => [lead, { n: u.n, from: u.from }]))
}

/** How many unread messages I have in each lead of my team, both chats added (leads with none are left out). */
export async function unreadByLead(ctx: MarketingContext): Promise<Map<string, number>> {
  return new Map(Array.from((await unreadDetailByLead(ctx)).entries()).map(([lead, u]) => [lead, u.n]))
}

/** My unread numbers in the chats of ONE lead, by lane (for the buttons on the lead: "Discuss with Antonio (2)"). */
export async function unreadLanesOfLead(ctx: MarketingContext, leadId: string): Promise<Record<Lane, number>> {
  const out: Record<Lane, number> = { owners: 0, setter: 0 }
  for (const [key, u] of Array.from(await unreadByLane(ctx))) {
    const [lead, lane] = key.split("|")
    if (lead === leadId && (lane === "owners" || lane === "setter")) out[lane] = u.n
  }
  return out
}

/**
 * What other people wrote in MY chats since `sinceIso` and I have not read yet — for the spoken alert ("Message from Rocco"). Read through the same lanes as the unread numbers, so a setter is never told
 * about the owners chat. A chat that is open on screen has already marked its messages read, so it is not read out. Newest first.
 */
export async function newLeadMessages(ctx: MarketingContext, sinceIso: string): Promise<Array<{ id: string; sender_id: string; created_at: string }>> {
  const d = db()
  const teamId = ctx.team.id
  const userId = ctx.user.id
  const msgs = await readMessages<{ id: string; lead_id: string; lane: string; sender_id: string; created_at: string }>(ctx, "id, lead_id, lane, sender_id, created_at", (cols, lanes) =>
    d.from("marketing_lead_messages").select(cols).eq("team_id", teamId).in("lane", lanes).neq("sender_id", userId).is("deleted_at", null).gt("created_at", sinceIso).order("created_at", { ascending: false }).limit(50))
  if (msgs.length === 0) return []
  const { data: reads } = await d.from("marketing_lead_lane_reads").select("lead_id, lane, last_read_at").eq("team_id", teamId).eq("user_id", userId).in("lead_id", Array.from(new Set(msgs.map(m => m.lead_id))))
  const readAt = new Map(((reads ?? []) as Array<{ lead_id: string; lane: string; last_read_at: string }>).map(r => [`${r.lead_id}|${r.lane}`, r.last_read_at]))
  return msgs.filter(m => { const last = readAt.get(`${m.lead_id}|${m.lane}`); return !last || m.created_at > last }).map(({ id, sender_id, created_at }) => ({ id, sender_id, created_at }))
}

export interface Conversation { leadId: string; lane: Lane; /** the button's words for this chat ("Discuss with Cristina") */ label: string; name: string; last: string; lastAt: string; lastBy: string; unread: number; /** set only when asked for (the owner's Home): what is unread in MY chat is for me, so it is true for all of them */ mentioned?: boolean }

/**
 * Every chat of my team's leads that I may read (a lead can have two: Antonio and Rocco, Rocco and the setter): the newest line, who wrote it, and my unread number. Unread first, then newest.
 * `withMentions` (the owner's Home) marks them all as for me: a chat that is only mine needs no @ to be about me.
 */
export async function listConversations(ctx: MarketingContext, o: { withMentions?: boolean } = {}): Promise<Conversation[]> {
  const d = db()
  const msgs = await readMessages<ChatMessageRow & { lead_id: string; lane: Lane }>(ctx, `${MESSAGE_COLS}, lead_id, lane`, (cols, lanes) => d.from("marketing_lead_messages").select(cols).eq("team_id", ctx.team.id).in("lane", lanes).order("created_at", { ascending: false }).limit(CHAT_ROW_CAP))
  const newest = new Map<string, ChatMessageRow & { lead_id: string; lane: Lane }>()
  for (const m of msgs) { const key = `${m.lead_id}|${m.lane}`; if (!newest.has(key)) newest.set(key, m) }
  if (newest.size === 0) return []
  // the lead names, a hundred at a time (hundreds of ids in one request make the address too long and the whole lookup fails)
  const ids = Array.from(new Set(Array.from(newest.values()).map(m => m.lead_id)))
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
  const [unread, buttons, ...found] = await Promise.all([unreadByLane(ctx), laneButtons(ctx), ...chunks.map(c => d.from("marketing_leads").select("id, full_name, email").eq("team_id", ctx.team.id).in("id", c))])
  const failed = found.find(f => f.error)
  if (failed?.error) console.error("[marketing] chat list names failed:", failed.error.message)
  const leads = found.flatMap(f => (f.data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>)
  const nameOf = new Map(leads.map(l => [l.id, l.full_name || l.email || "Lead"]))
  const labelOf = new Map(buttons.map(b => [b.lane, b.label]))
  return Array.from(newest.values()).map(m => ({ leadId: m.lead_id, lane: m.lane, label: labelOf.get(m.lane) ?? "", name: nameOf.get(m.lead_id) ?? "Lead", last: previewLine({ message: m.message, attachments: m.attachments, deleted_at: m.deleted_at }), lastAt: m.created_at, lastBy: m.sender_id === ctx.user.id ? "" : m.sender_name, unread: unread.get(`${m.lead_id}|${m.lane}`)?.n ?? 0, ...(o.withMentions ? { mentioned: true } : {}) }))
    .sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.lastAt.localeCompare(a.lastAt))
}
