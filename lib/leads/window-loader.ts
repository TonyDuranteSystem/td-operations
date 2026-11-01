// Loads everything the lead window shows (dev job 6fc63c52). Shared by the window route and the draft route so both
// see the same story. `userDb` is the staff member's own session (lead, offers, emails, contracts, activation);
// `adminDb` is the service client, used ONLY after the caller has checked the person is staff.

import type { createClient } from "@/lib/supabase/server"
import type { supabaseAdmin } from "@/lib/supabase-admin"
import { buildLeadWindowData, type WindowCallRow, type WindowData } from "@/lib/leads/window-data"
import { fetchLeadCallData } from "@/lib/leads/lead-calls"
import { digitsOnly } from "@/lib/messaging/phone"
import {
  buildEmailEvents, buildWhatsAppEvents, mergeMessageEvents, type EmailRow, type ChatRow, type ChatMessageRow, type MessageEvent,
} from "@/lib/leads/window-messages"

type UserDb = ReturnType<typeof createClient>
type AdminDb = typeof supabaseAdmin

const MAX_EMAIL_ROWS = 200
const MAX_CHAT_MESSAGES = 300
const CALL_COLUMNS = "id, meeting_name, duration_seconds, notes, recording_url, created_at"

export interface LoadResult { status: number; error?: string; data?: WindowData }

export async function loadLeadWindowData(supabase: UserDb, supabaseAdmin: AdminDb, id: string): Promise<LoadResult> {
  const BASE_COLUMNS = "id, full_name, email, phone, language, source, referrer_name, status, call_date, notes, created_at, updated_at, existing_client_contact_id, converted_to_contact_id, circleback_call_id"
  // owner / follow_up_date arrive with the phase B+D migration. If the code is deployed before that migration has been
  // run, the window must still open (without those two fields) instead of failing for every lead.
  let { data: lead, error: leadError } = await supabase
    .from("leads").select(`${BASE_COLUMNS}, owner, follow_up_date`).eq("id", id).maybeSingle()
  if (leadError && /owner|follow_up_date|column/i.test(leadError.message)) {
    const retry = await supabase.from("leads").select(BASE_COLUMNS).eq("id", id).maybeSingle()
    lead = retry.data as typeof lead
    leadError = retry.error
  }
  if (leadError) {
    console.error("[leads/window] lead query failed:", leadError.message)
    return { status: 500, error: "Could not load this lead — please try again." }
  }
  if (!lead) return { status: 404, error: "Lead not found." }

  const { data: offers } = await supabase
    .from("offers")
    .select("token, status, version, created_at, viewed_at, view_count, superseded_by")
    .eq("lead_id", id)
  const offerTokens = (offers ?? []).map(o => o.token)

  const [emailsRes, contractsRes, activationRes, callsRes, textRes, callData] = await Promise.all([
    supabase.from("email_tracking").select("id, subject, created_at, first_opened_at").eq("lead_id", id).order("created_at", { ascending: true }),
    offerTokens.length > 0
      ? supabase.from("contracts").select("offer_token, signed_at").in("offer_token", offerTokens)
      : Promise.resolve({ data: [] as { offer_token: string; signed_at: string | null }[] }),
    supabase
      .from("pending_activations")
      .select("id, status, amount, currency, payment_confirmed_at, created_at")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin.from("call_summaries").select(CALL_COLUMNS).eq("lead_id", id).order("created_at", { ascending: true }),
    supabaseAdmin.from("call_summaries").select("id").eq("lead_id", id).not("transcript", "is", null),
    // The lead's own call records and the moves made from them (phase B). New tables: untyped client.
    fetchLeadCallData(supabaseAdmin, id),
  ])

  let calls = (callsRes.data ?? []) as WindowCallRow[]
  // Older edge the lead page also handles: the pointer is set but the call was never back-linked by lead_id.
  if (lead.circleback_call_id && !calls.some(c => c.id === lead.circleback_call_id)) {
    const { data: pointer } = await supabaseAdmin
      .from("call_summaries")
      .select(CALL_COLUMNS)
      .eq("id", lead.circleback_call_id)
      .maybeSingle()
    if (pointer) calls = [...calls, pointer as WindowCallRow]
  }
  const transcriptIds = new Set((textRes.data ?? []).map(r => r.id as string))
  if (lead.circleback_call_id && calls.some(c => c.id === lead.circleback_call_id) && !transcriptIds.has(lead.circleback_call_id)) {
    const { data: t } = await supabaseAdmin.from("call_summaries").select("id").eq("id", lead.circleback_call_id).not("transcript", "is", null).maybeSingle()
    if (t) transcriptIds.add(t.id as string)
  }

  // "Already a client": exact email match (case-insensitive) to a contact that belongs to a company.
  let isLiveClient = false
  if (lead.email && lead.email.trim()) {
    const escaped = lead.email.trim().replace(/[\\%_]/g, "\\$&")
    const { data: match } = await supabase
      .from("contacts")
      .select("id, account_contacts!inner(account_id)")
      .ilike("email", escaped)
      .limit(1)
    isLiveClient = (match ?? []).length > 0
  }

  const data = buildLeadWindowData({
    lead,
    offers: offers ?? [],
    calls,
    transcriptCallIds: Array.from(transcriptIds),
    emails: emailsRes.data ?? [],
    contracts: contractsRes.data ?? [],
    activation: activationRes.data ?? null,
    isLiveClient,
    leadCalls: callData.calls,
    moves: callData.moves,
  })
  return { status: 200, data }
}

export interface MessagesResult { status: number; error?: string; events?: MessageEvent[]; truncated?: boolean }

/** Emails and WhatsApp of a lead as short story lines. Service client: the caller must have checked the person is staff. */
export async function loadLeadMessageEvents(supabaseAdmin: AdminDb, id: string): Promise<MessagesResult> {
  const { data: lead } = await supabaseAdmin.from("leads").select("id, email, phone").eq("id", id).maybeSingle()
  if (!lead) return { status: 404, error: "Lead not found." }

  const email = (lead.email ?? "").trim().toLowerCase()
  // An address is put inside a PostgREST filter: refuse anything that could break out of it.
  const safeEmail = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) ? email : ""
  const emailFilter = safeEmail
    ? `lead_id.eq.${id},from_email.eq.${safeEmail},to_emails.cs.{${safeEmail}}`
    : `lead_id.eq.${id}`
  const { data: emailRows } = await supabaseAdmin
    .from("email_index")
    .select("mailbox, thread_id, message_id, from_email, to_emails, subject, snippet, internal_date, lead_id")
    .or(emailFilter)
    .not("internal_date", "is", null)
    .order("internal_date", { ascending: false })
    .limit(MAX_EMAIL_ROWS)

  const digits = lead.phone ? digitsOnly(lead.phone) : ""
  const jids = digits.length >= 7 ? [`${digits}@c.us`, digits] : []
  const chatFilter = jids.length ? `lead_id.eq.${id},external_group_id.in.(${jids.join(",")})` : `lead_id.eq.${id}`
  const { data: chats } = await supabaseAdmin
    .from("messaging_groups")
    .select("id, group_name, lead_id, external_group_id")
    .or(chatFilter)
  const chatIds = (chats ?? []).map(c => c.id)
  let messages: ChatMessageRow[] = []
  if (chatIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("messages")
      .select("id, group_id, direction, content_text, content_type, created_at, sender_name")
      .in("group_id", chatIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(MAX_CHAT_MESSAGES)
    messages = (data ?? []) as ChatMessageRow[]
  }

  const events = mergeMessageEvents(
    buildEmailEvents((emailRows ?? []) as EmailRow[], safeEmail || null, id),
    buildWhatsAppEvents((chats ?? []) as ChatRow[], messages, id, digits || null),
  )
  return { status: 200, events: events.slice(0, 120), truncated: (emailRows ?? []).length >= MAX_EMAIL_ROWS || messages.length >= MAX_CHAT_MESSAGES }
}

export interface ReplyTarget { conversationId: string | null; reason: string }

/**
 * Where a WhatsApp message to this lead can be sent from the CRM. The existing reply path only answers a chat that has
 * already written to us (a first message to a lead is made from the phone), so a chat with an inbound message is
 * required. Returns why not when there is none. Service client: the caller must have checked the person is staff.
 */
export async function findWhatsAppReplyTarget(supabaseAdmin: AdminDb, id: string): Promise<ReplyTarget> {
  const { data: lead } = await supabaseAdmin.from("leads").select("phone").eq("id", id).maybeSingle()
  const digits = lead?.phone ? digitsOnly(lead.phone) : ""
  const jids = digits.length >= 7 ? [`${digits}@c.us`, digits] : []
  const filter = jids.length ? `lead_id.eq.${id},external_group_id.in.(${jids.join(",")})` : `lead_id.eq.${id}`
  const { data: chats } = await supabaseAdmin.from("messaging_groups").select("id").or(filter)
  const ids = (chats ?? []).map(c => c.id)
  if (ids.length === 0) return { conversationId: null, reason: "This lead has no WhatsApp chat yet. Copy the text and send it from the phone." }
  const { data: inbound } = await supabaseAdmin
    .from("messages").select("group_id").in("group_id", ids).eq("direction", "inbound").is("deleted_at", null)
    .order("created_at", { ascending: false }).limit(1)
  if (!inbound || inbound.length === 0) return { conversationId: null, reason: "This lead has not written on WhatsApp yet, and the first message is sent from the phone. Copy the text and send it from there." }
  return { conversationId: inbound[0].group_id as string, reason: "" }
}
