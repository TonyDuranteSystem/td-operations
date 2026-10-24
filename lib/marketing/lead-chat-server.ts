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
import {
  BUCKET, SIGNED_URL_SECONDS, URL_CACHE_SECONDS, checkEdit, isInvolved, checkEmoji, checkSend, chatUrlFor, isUuid, mayDelete, mayEdit, newObjectPath, previewLine, pushRecipients, toTalkMessage, unreadCount,
  type ChatMessageRow, type ChatReaction, type StoredAttachment,
} from "@/lib/marketing/lead-chat"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; storage: any }
export const NO_STORE = { "Cache-Control": "no-store" }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const MESSAGE_COLS = "id, sender_id, sender_name, message, attachments, reply_to_id, edited_at, deleted_at, created_at"
/** the newest messages one open chat holds (like TD Talk: the latest 500) */
const LOAD_LIMIT = 500

/** For every chat route: the chat permission AND the right to read leads, and a lead that belongs to the guard's team. */
export async function openChat(leadId: string): Promise<{ ctx: MarketingContext; lead: LeadRow; res?: undefined } | { res: NextResponse; ctx?: undefined; lead?: undefined }> {
  const g = await requireMarketing("chat")
  if (g.res) return { res: g.res }
  if (!hasPermission(g.ctx.permissions, "leads.read")) return { res: json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, 403) }
  if (!isUuid(leadId)) return { res: json({ error: "Lead not found." }, 404) }
  const lead = await getTeamLead(leadDb(), g.ctx.team.id, leadId)
  if (!lead) return { res: json({ error: "Lead not found." }, 404) }
  return { ctx: g.ctx, lead }
}

/** For the chat routes that are not about one lead: the same two permissions as `openChat` (the chat AND the right to read leads), so a list of conversations never shows more than the leads would. */
export async function requireChatAccess(): Promise<{ ctx: MarketingContext; res?: undefined } | { res: NextResponse; ctx?: undefined }> {
  const g = await requireMarketing("chat")
  if (g.res) return { res: g.res }
  if (!hasPermission(g.ctx.permissions, "leads.read")) return { res: json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, 403) }
  return { ctx: g.ctx }
}

type ChatMember = { id: string; name: string; permissions: string[]; status: string }
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

async function loadChatMembers(teamId: string): Promise<ChatMember[]> {
  const bundles = (await getMarketingSetting("permission_bundles", teamId)) as Bundles
  const rows = await listMembers(teamId)
  return rows
    .filter(m => m.status !== "removed")
    .map(m => ({ id: m.user_id as string, name: personName(m.email), status: String(m.status), permissions: effectivePermissions({ memberRole: m.member_role as "owner" | "member", bundle: m.bundle, bundles, extra: m.permissions }) as string[] }))
    .filter(m => m.permissions.includes("chat"))
}

const urlCache = new Map<string, { at: number; url: string }>()

/** Signed links for these files. The same link is handed out for URL_CACHE_SECONDS (fewer calls to storage, and the audio player is not reloaded by every refresh); a new one is signed after that. */
async function signUrls(paths: readonly string[]): Promise<Map<string, string>> {
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

async function shape(rows: ChatMessageRow[], reactions: ChatReaction[]) {
  const byId = new Map(rows.map(r => [r.id, r]))
  const urls = await signUrls(rows.flatMap(r => (r.deleted_at ? [] : (r.attachments ?? []).map(a => a.path))))
  return rows.map(r => toTalkMessage(r, byId, reactions, p => urls.get(p) ?? null))
}

/** One lead's chat: the newest messages (oldest first), who has read and received how far, who can chat. `markRead` follows TD Talk's rule: only while the person is looking. */
export async function loadChat(ctx: MarketingContext, leadId: string, markRead: boolean) {
  const d = db()
  const [{ data: rowsDesc }, { data: reads }, { data: deliveries }, members] = await Promise.all([
    d.from("marketing_lead_messages").select(MESSAGE_COLS).eq("team_id", ctx.team.id).eq("lead_id", leadId).order("created_at", { ascending: false }).limit(LOAD_LIMIT),
    d.from("marketing_lead_chat_reads").select("user_id, last_read_at").eq("lead_id", leadId),
    d.from("marketing_lead_chat_delivery").select("user_id, delivered_at").eq("lead_id", leadId),
    chatMembers(ctx.team.id),
  ])
  const rows = ((rowsDesc ?? []) as ChatMessageRow[]).slice().reverse()
  const ids = rows.map(r => r.id)
  const { data: reacts } = ids.length ? await d.from("marketing_lead_message_reactions").select("message_id, user_id, user_name, emoji").in("message_id", ids) : { data: [] }
  if (markRead) await markLeadRead(ctx, leadId)
  const me = ctx.user.id
  // the ticks wait for the people who work the leads (the setter, the seller), not for the ad person who only watches
  // (a paused person is not waited for: his ticks would never turn blue)
  const memberIds = members.filter(m => m.status === "active" && isInvolved(m.permissions)).map(m => m.id).filter(id => id !== me)
  return {
    me,
    messages: await shape(rows, (reacts ?? []) as ChatReaction[]),
    members: members.filter(m => m.status === "active" && isInvolved(m.permissions)).map(m => ({ id: m.id, name: m.name })),
    // the ticks: how far every OTHER person who can chat has read / received it
    member_ids: memberIds,
    member_reads: ((reads ?? []) as Array<{ user_id: string; last_read_at: string }>).filter(r => r.user_id !== me),
    member_delivered: ((deliveries ?? []) as Array<{ user_id: string; delivered_at: string }>).filter(r => r.user_id !== me),
  }
}

export async function markLeadRead(ctx: MarketingContext, leadId: string): Promise<void> {
  await db().from("marketing_lead_chat_reads").upsert({ lead_id: leadId, team_id: ctx.team.id, user_id: ctx.user.id, last_read_at: new Date().toISOString() }, { onConflict: "lead_id,user_id" })
}

/** This device now has the chat: tell the others (grey double tick). Only leads of the guard's team. */
export async function markDelivered(ctx: MarketingContext, leadIds: readonly string[]): Promise<number> {
  const ids = Array.from(new Set(leadIds.filter(isUuid))).slice(0, 50)
  if (ids.length === 0) return 0
  const { data: own } = await db().from("marketing_leads").select("id").eq("team_id", ctx.team.id).in("id", ids)
  const now = new Date().toISOString()
  const rows = ((own ?? []) as Array<{ id: string }>).map(l => ({ lead_id: l.id, team_id: ctx.team.id, user_id: ctx.user.id, delivered_at: now }))
  if (rows.length) await db().from("marketing_lead_chat_delivery").upsert(rows, { onConflict: "lead_id,user_id" })
  return rows.length
}

export async function sendChatMessage(ctx: MarketingContext, lead: LeadRow, body: { message?: unknown; attachments?: unknown; reply_to_id?: unknown }): Promise<{ ok: true; message: unknown } | { ok: false; error: string; status: number }> {
  const c = checkSend({ message: body.message, attachments: body.attachments, teamId: ctx.team.id, leadId: lead.id })
  if (c.ok === false) return { ok: false, error: c.error, status: 400 }
  const d = db()
  let replyTo: string | null = null
  if (body.reply_to_id != null) {
    if (!isUuid(body.reply_to_id)) return { ok: false, error: "The message you are answering was not found.", status: 400 }
    const { data: q } = await d.from("marketing_lead_messages").select("id").eq("id", body.reply_to_id).eq("lead_id", lead.id).maybeSingle()
    if (!q) return { ok: false, error: "The message you are answering was not found.", status: 400 }
    replyTo = body.reply_to_id
  }
  const senderName = personName(ctx.user.email ?? "")
  const { data: row, error } = await d.from("marketing_lead_messages").insert({
    team_id: ctx.team.id, lead_id: lead.id, sender_id: ctx.user.id, sender_name: senderName, message: c.message, attachments: c.attachments.length ? c.attachments : null, reply_to_id: replyTo,
  }).select(MESSAGE_COLS).single()
  if (error || !row) return { ok: false, error: "Could not send. Please try again.", status: 500 }
  // what you send you have read, and this device has it
  await Promise.all([markLeadRead(ctx, lead.id), markDelivered(ctx, [lead.id])])
  const [message] = await shape([row as ChatMessageRow], [])
  // tell the others (never the sender); a failed notification never fails the message
  try {
    const members = await chatMembers(ctx.team.id)
    const to = pushRecipients(members.map(m => ({ user_id: m.id, status: m.status, permissions: m.permissions })), ctx.user.id)
    // a lead with no name is shown by its email, never its phone number (a notification can sit on a lock screen)
    const leadName = lead.full_name || lead.email || "Lead"
    // WAIT for the notifications (a function may be stopped as soon as it has answered), but never longer than a few seconds: a slow phone service must not hold up the sender
    await Promise.race([
      sendMarketingPush(ctx.team.id, to, { title: `${senderName} · ${leadName}`, body: previewLine({ message: c.message, attachments: c.attachments, deleted_at: null }), url: chatUrlFor(lead.id), tag: `chat-${lead.id}` }),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ])
  } catch { /* the message is already saved */ }
  return { ok: true, message }
}

async function messageInTeam(ctx: MarketingContext, id: string): Promise<(ChatMessageRow & { lead_id: string }) | null> {
  if (!isUuid(id)) return null
  const { data } = await db().from("marketing_lead_messages").select(`${MESSAGE_COLS}, lead_id`).eq("id", id).eq("team_id", ctx.team.id).maybeSingle()
  return (data as (ChatMessageRow & { lead_id: string }) | null) ?? null
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
  return { ok: true, message: { message: c.message, edited_at } }
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

/** How many unread messages I have in each lead of my team (leads with none are left out). */
export const unreadByLead = (ctx: MarketingContext): Promise<Map<string, number>> => unreadFor(ctx.team.id, ctx.user.id)

/** Only messages from the last 90 days are counted as unread (the number is recomputed on every screen, so it must not grow with the whole history). */
export const UNREAD_LOOKBACK_DAYS = 90
const CHAT_ROW_CAP = 5000

async function unreadFor(teamId: string, userId: string): Promise<Map<string, number>> {
  const d = db()
  const since = new Date(Date.now() - UNREAD_LOOKBACK_DAYS * 86_400_000).toISOString()
  const [{ data: reads, error: e1 }, { data: msgs, error: e2 }] = await Promise.all([
    d.from("marketing_lead_chat_reads").select("lead_id, last_read_at").eq("user_id", userId).eq("team_id", teamId),
    d.from("marketing_lead_messages").select("lead_id, sender_id, created_at, deleted_at").eq("team_id", teamId).neq("sender_id", userId).is("deleted_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(CHAT_ROW_CAP),
  ])
  // a failed read is a zero on the screen; at least leave a trace in the server log
  if (e1 || e2) console.error("[marketing] unread count failed:", (e1 ?? e2)?.message)
  const readAt = new Map(((reads ?? []) as Array<{ lead_id: string; last_read_at: string }>).map(r => [r.lead_id, r.last_read_at]))
  const by = new Map<string, Array<{ sender_id: string; created_at: string; deleted_at: string | null }>>()
  for (const m of (msgs ?? []) as Array<{ lead_id: string; sender_id: string; created_at: string; deleted_at: string | null }>) by.set(m.lead_id, [...(by.get(m.lead_id) ?? []), m])
  const out = new Map<string, number>()
  for (const [lead, list] of Array.from(by)) { const n = unreadCount(list, userId, readAt.get(lead) ?? null); if (n > 0) out.set(lead, n) }
  return out
}

export interface Conversation { leadId: string; name: string; last: string; lastAt: string; lastBy: string; unread: number }

/** Every lead of my team that has a chat: the newest line, who wrote it, and my unread number. Newest first. */
export async function listConversations(ctx: MarketingContext): Promise<Conversation[]> {
  const d = db()
  const { data: msgs } = await d.from("marketing_lead_messages").select(`${MESSAGE_COLS}, lead_id`).eq("team_id", ctx.team.id).order("created_at", { ascending: false }).limit(CHAT_ROW_CAP)
  const newest = new Map<string, ChatMessageRow & { lead_id: string }>()
  for (const m of (msgs ?? []) as Array<ChatMessageRow & { lead_id: string }>) if (!newest.has(m.lead_id)) newest.set(m.lead_id, m)
  if (newest.size === 0) return []
  // the lead names, a hundred at a time (hundreds of ids in one request make the address too long and the whole lookup fails)
  const ids = Array.from(newest.keys())
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
  const [unread, ...found] = await Promise.all([unreadByLead(ctx), ...chunks.map(c => d.from("marketing_leads").select("id, full_name, email").eq("team_id", ctx.team.id).in("id", c))])
  const failed = found.find(f => f.error)
  if (failed?.error) console.error("[marketing] chat list names failed:", failed.error.message)
  const leads = found.flatMap(f => (f.data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>)
  const nameOf = new Map(leads.map(l => [l.id, l.full_name || l.email || "Lead"]))
  return Array.from(newest.values()).map(m => ({ leadId: m.lead_id, name: nameOf.get(m.lead_id) ?? "Lead", last: previewLine({ message: m.message, attachments: m.attachments, deleted_at: m.deleted_at }), lastAt: m.created_at, lastBy: m.sender_id === ctx.user.id ? "" : m.sender_name, unread: unread.get(m.lead_id) ?? 0 }))
    .sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.lastAt.localeCompare(a.lastAt))
}
