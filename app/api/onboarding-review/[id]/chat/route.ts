/**
 * Contact-scoped chat for an onboarding submission that hasn't been
 * reviewed yet — the real embedded panel, not a link-out (Antonio,
 * 2026-09-22: "I want the actual chat filed not a link"). Mirrors
 * app/api/flows/[id]/chat/route.ts exactly, except scoped by contact_id
 * instead of service_delivery_id — there is genuinely no service delivery
 * yet at this stage (nothing is created until staff review-and-confirm, by
 * design), so the SD-scoped route has nothing to key on.
 *
 * Once the submission IS reviewed and the account/SD exist, the workspace
 * switches to the real flow chat (SD-scoped) instead of this route — this
 * one is deliberately only for the pre-review window.
 *
 * - GET  → { success, messages } — every non-deleted, non-chat-event
 *          portal_messages row for this contact, chronological.
 * - POST → { success, message } — staff sends a message about this
 *          onboarding. Stamped with contact_id + a topic naming the
 *          company, notifies the client via the existing notification path.
 *
 * [id] = onboarding_submissions.id.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { pickChatSenderName } from '@/lib/portal/chat-sender-name'
import { createPortalNotification, notifyClientOfAdminMessage } from '@/lib/portal/notifications'

const MAX_MESSAGE_LENGTH = 5000

type ChatRow = {
  id: string
  sender_type: string
  sender_name: string | null
  message: string
  topic: string | null
  created_at: string | null
  contacts?: { full_name: string } | null
}

async function resolveContactAndTopic(submissionId: string): Promise<{ contactId: string | null; topic: string | null }> {
  const { data: sub } = await supabaseAdmin
    .from('onboarding_submissions')
    .select('contact_id, submitted_data')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub?.contact_id) return { contactId: null, topic: null }
  const companyName = (sub.submitted_data as Record<string, unknown> | null)?.company_name as string | undefined
  return { contactId: sub.contact_id, topic: `Onboarding${companyName ? ` — ${companyName}` : ''}` }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const denied = await requireStaffRoute()
    if (denied) return denied

    const { contactId, topic } = await resolveContactAndTopic(params.id)
    if (!contactId) {
      return NextResponse.json({ success: false, error: 'This submission has no linked contact yet' }, { status: 404 })
    }

    const { data, error } = await supabaseAdmin
      .from('portal_messages')
      .select('id, sender_type, sender_name, message, topic, created_at, contacts:contact_id(full_name)')
      .eq('contact_id', contactId)
      .is('deleted_at', null)
      .not('message', 'ilike', '%<!-- chat-event:%')
      .order('created_at', { ascending: true })

    if (error) {
      return NextResponse.json({ success: false, error: `Could not load messages: ${error.message}` }, { status: 500 })
    }

    const rows = (data ?? []) as unknown as ChatRow[]
    return NextResponse.json({
      success: true,
      messages: rows.map((r) => {
        const { contacts, ...rest } = r
        return {
          ...rest,
          in_flow: !topic || r.topic === topic,
          sender_name: pickChatSenderName(contacts?.full_name, rest.sender_name),
        }
      }),
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const denied = await requireStaffRoute()
    if (denied) return denied

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) {
      return NextResponse.json({ success: false, error: 'Message required' }, { status: 400 })
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ success: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` }, { status: 400 })
    }

    const { contactId, topic } = await resolveContactAndTopic(params.id)
    if (!contactId) {
      return NextResponse.json({ success: false, error: 'This submission has no linked contact yet' }, { status: 404 })
    }

    const { data: inserted, error } = await supabaseAdmin
      .from('portal_messages')
      .insert({
        contact_id: contactId,
        topic,
        sender_type: 'admin',
        sender_id: user.id,
        message,
      })
      .select('id, sender_type, sender_name, message, topic, created_at, contacts:contact_id(full_name)')
      .single()

    if (error || !inserted) {
      return NextResponse.json({ success: false, error: `Could not send message: ${error?.message ?? 'unknown error'}` }, { status: 500 })
    }

    createPortalNotification({
      contact_id: contactId,
      type: 'chat',
      title: 'New message from Tony Durante Team',
      body: message.slice(0, 100),
      link: topic ? `/portal/chat?topic=${encodeURIComponent(topic)}` : '/portal/chat',
    }).catch(() => {})
    notifyClientOfAdminMessage({
      contact_id: contactId,
      topic,
      messagePreview: message,
    }).catch(() => {})

    const row = inserted as unknown as ChatRow
    const { contacts, ...rest } = row
    return NextResponse.json({
      success: true,
      message: { ...rest, in_flow: true, sender_name: pickChatSenderName(contacts?.full_name, rest.sender_name) },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
