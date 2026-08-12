/**
 * Topic-scoped chat for a single flow (service_delivery). Backs the flow
 * Workspace `chat` component. [id] = service_delivery_id.
 *
 * This is a CLIENT-FACING thread, scoped to one flow:
 * - GET  → { success, messages } — every portal_messages row stamped with this
 *          SD, chronological (oldest first), soft-deleted rows excluded. Includes
 *          client replies (a reply to a flow message inherits its
 *          service_delivery_id in the portal chat route).
 * - POST → { success, message } — staff sends a message ABOUT this flow. The row
 *          is stamped with service_delivery_id + topic (auto-set to the flow
 *          name, e.g. "Tax Return 2025") AND account_id + contact_id, so it both
 *          threads to this Workspace and appears in the client's portal chat. The
 *          client is notified via the existing portal notification system.
 *
 * Mirrors the portal chat send pattern (createClient + auth.getUser, the staff
 * member is sender_type='admin', sender_id=user.id). portal_messages.
 * service_delivery_id was added by 20260614-1700-portal-messages-service-delivery
 * .sql but is not in the generated DB types yet — queried via an untyped surface,
 * mirroring app/api/flows/[id]/documents/route.ts.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { pickChatSenderName } from '@/lib/portal/chat-sender-name'
import { deriveFlowYear, buildFlowTopic } from '@/lib/flows/resolve-flows'
import { createPortalNotification, notifyClientOfAdminMessage } from '@/lib/portal/notifications'

const MAX_MESSAGE_LENGTH = 5000

type ChatRow = {
  id: string
  sender_type: string
  sender_name: string | null
  message: string
  topic: string | null
  created_at: string | null
  /** Present on the room's list read — used to tag this return's own thread. */
  service_delivery_id?: string | null
  contacts?: { full_name: string } | null
}

type QueryResult = { data: ChatRow[] | null; error: { message: string } | null }
type SingleResult = { data: ChatRow | null; error: { message: string } | null }

// Untyped surface for the columns the generated types don't carry yet
// (service_delivery_id). Mirrors app/api/flows/[id]/documents/route.ts.
type UntypedChat = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        is: (col: string, val: null) => {
          order: (col: string, opts: { ascending: boolean }) => Promise<QueryResult>
        }
      }
    }
    insert: (row: Record<string, unknown>) => {
      select: (cols: string) => { single: () => Promise<SingleResult> }
    }
  }
}

function flatten(row: ChatRow, ctx?: { serviceDeliveryId: string; topic: string | null }) {
  const { contacts, ...rest } = row
  const r = rest
  // `in_flow` = this message belongs to THIS return's thread (stamped with the
  // service delivery, or carrying its topic). Everything else is the client's
  // other conversation with us — shown, never hidden, just not emphasised.
  const inFlow = ctx
    ? r.service_delivery_id === ctx.serviceDeliveryId || (!!ctx.topic && r.topic === ctx.topic)
    : true
  return { ...rest, in_flow: inFlow, sender_name: pickChatSenderName(contacts?.full_name, rest.sender_name) }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id

    // Resolve the flow's account + topic so the Workspace thread shows EVERY
    // message in this flow's topic — not only rows stamped with the SD. A client
    // who types in the portal chat under the flow topic (without replying to a
    // specific message) produces a row with the topic + account but NO
    // service_delivery_id; matching on (topic + account) surfaces it here too.
    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, account_id, due_date, stage_entered_at, created_at')
      .eq('id', serviceDeliveryId)
      .single()

    const topic = sd ? (buildFlowTopic(sd.service_type, deriveFlowYear(sd)) || null) : null
    const accountId = (sd?.account_id as string | null) ?? null

    // THE ROOM SHOWS THE CLIENT'S WHOLE CONVERSATION (card c5ff8b4d Phase 1,
    // Antonio 2026-08-12). It used to show ONLY rows stamped with this SD or
    // carrying the flow topic — so a client who wrote in their general portal
    // chat was INVISIBLE to the staff member working in the room, who believed
    // he was looking at the whole conversation. Luca answers clients from here;
    // a message he cannot see is a message nobody answers.
    // Now: every non-deleted message on this ACCOUNT (plus any row stamped with
    // this SD, defensively), each tagged `in_flow` so the UI can emphasise this
    // return's thread without hiding the rest. Internal chat-event notes stay
    // excluded, so the room shows exactly what the CLIENT sees — one
    // conversation, one truth.
    const orFilter = accountId
      ? `service_delivery_id.eq.${serviceDeliveryId},account_id.eq.${accountId}`
      : `service_delivery_id.eq.${serviceDeliveryId}`

    const { data, error } = (await (supabaseAdmin as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          or: (f: string) => {
            is: (col: string, v: null) => {
              not: (col: string, op: string, v: string) => {
                order: (col: string, opts: { ascending: boolean }) => Promise<QueryResult>
              }
            }
          }
        }
      }
    })
      .from('portal_messages')
      .select('id, sender_type, sender_name, message, topic, created_at, service_delivery_id, contacts:contact_id(full_name)')
      .or(orFilter)
      .is('deleted_at', null)
      // Internal chat-event notes (`<!-- chat-event: -->`) are staff-only and
      // must not leak into the client-facing flow thread.
      .not('message', 'ilike', '%<!-- chat-event:%')
      .order('created_at', { ascending: true })) as QueryResult

    if (error) {
      return NextResponse.json(
        { success: false, error: `Could not load messages: ${error.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      messages: (data ?? []).map((r) => flatten(r, { serviceDeliveryId, topic })),
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id

    // Staff sender — authenticated via the dashboard's Supabase session.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) {
      return NextResponse.json({ success: false, error: 'Message required' }, { status: 400 })
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { success: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` },
        { status: 400 },
      )
    }

    // Resolve the flow's account + topic from the SD.
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, account_id, contact_id, due_date, stage_entered_at, created_at')
      .eq('id', serviceDeliveryId)
      .single()
    if (sdErr || !sd) {
      return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    }

    // Stamp the message to a contact so it lands in the client's contact-scoped
    // portal thread (same resolution as the portal chat route / MCP tool).
    let contactId: string | null = null
    if (sd.account_id) {
      const { data: link } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id')
        .eq('account_id', sd.account_id)
        .limit(1)
        .maybeSingle()
      contactId = link?.contact_id ?? null
    }
    // Contact-scoped SDs (in-progress formations, account_id NULL) carry the
    // contact directly — without this the message stamps contact_id=null and
    // never reaches the client's contact-scoped portal thread (lost message).
    if (!contactId) contactId = (sd.contact_id as string | null) ?? null

    // Topic is auto-set to the flow name (e.g. "Tax Return 2025").
    const topic = buildFlowTopic(sd.service_type, deriveFlowYear(sd)) || null

    const admin = supabaseAdmin as unknown as UntypedChat
    const { data: inserted, error } = await admin
      .from('portal_messages')
      .insert({
        account_id: sd.account_id || null,
        contact_id: contactId,
        service_delivery_id: serviceDeliveryId,
        topic,
        sender_type: 'admin',
        sender_id: user.id,
        message,
      })
      .select('id, sender_type, sender_name, message, topic, created_at, service_delivery_id, contacts:contact_id(full_name)')
      .single()

    if (error || !inserted) {
      return NextResponse.json(
        { success: false, error: `Could not send message: ${error?.message ?? 'unknown error'}` },
        { status: 500 },
      )
    }

    // Notify the client — reuse the existing portal notification system.
    createPortalNotification({
      account_id: sd.account_id || undefined,
      contact_id: contactId || undefined,
      type: 'chat',
      title: 'New message from Tony Durante Team',
      body: message.slice(0, 100),
      link: '/portal/chat',
    }).catch(() => {})
    notifyClientOfAdminMessage({
      account_id: sd.account_id || null,
      contact_id: contactId,
      topic,
      messagePreview: message,
    }).catch(() => {})

    return NextResponse.json({ success: true, message: flatten(inserted) })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
