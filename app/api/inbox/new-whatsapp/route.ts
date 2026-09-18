import { NextRequest, NextResponse } from 'next/server'
import { dispatchWhatsAppMessage } from '@/lib/messaging/send-dispatcher'
import { findOrCreateWhatsAppGroup } from '@/lib/messaging/groups'
import { toWhatsAppJid } from '@/lib/messaging/phone'
import { resolveWhatsAppAttachmentUrl } from '@/lib/messaging/attachment-staging'
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = 'force-dynamic'

/**
 * POST /api/inbox/new-whatsapp
 * Find or create a WhatsApp messaging_group for a lead or a contact, then
 * send the first message. Exactly one of leadId/contactId is required — a
 * lead has no contact record until it converts, so this cannot require
 * contactId the way it used to.
 * Body: { leadId? | contactId?, phone, message, accountId?, attachmentPath? }
 */
export async function POST(req: NextRequest) {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    const { leadId, contactId, phone, message, accountId, attachmentPath } = await req.json() as {
      leadId?: string
      contactId?: string
      phone: string
      message: string
      accountId?: string | null
      attachmentPath?: string
    }

    if (!leadId && !contactId) {
      return NextResponse.json({ error: 'leadId or contactId is required' }, { status: 400 })
    }
    if (!phone || !message) {
      return NextResponse.json({ error: 'phone and message are required' }, { status: 400 })
    }

    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    const chatId = toWhatsAppJid(phone)

    // Find the WhatsApp Lead channel (default channel for outbound) — active
    // only, ordered so a second/third channel later can't make this ambiguous.
    const { data: channels } = await supabaseAdmin
      .from('messaging_channels')
      .select('id')
      .eq('platform', 'whatsapp')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)

    const channelId = channels?.[0]?.id
    if (!channelId) {
      return NextResponse.json({ error: 'No WhatsApp channel configured' }, { status: 500 })
    }

    // Name for the group label (only matters if the group is new) — from
    // whichever record this send is scoped to.
    let groupName: string | null = null
    if (contactId) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('full_name')
        .eq('id', contactId)
        .single()
      groupName = contact?.full_name ?? null
    } else if (leadId) {
      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('full_name')
        .eq('id', leadId)
        .single()
      groupName = lead?.full_name ?? null
    }

    const groupResult = await findOrCreateWhatsAppGroup({
      channelId,
      remoteIdentifier: phone,
      groupName: groupName ?? phone,
      accountId: accountId || null,
      contactId: contactId || null,
      leadId: leadId || null,
    })
    if ('error' in groupResult) {
      console.error('Failed to find/create messaging group:', groupResult.error)
      return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
    }
    const group = groupResult.group

    let mediaUrl: string | undefined
    if (attachmentPath) {
      const resolved = await resolveWhatsAppAttachmentUrl(attachmentPath)
      if (!resolved) {
        return NextResponse.json(
          { error: 'The attachment is no longer available — please re-attach it and try again.' },
          { status: 400 }
        )
      }
      mediaUrl = resolved
    }

    // Send message via provider routing (reads provider from messaging_channels)
    const sendResult = await dispatchWhatsAppMessage({
      chatId,
      message,
      channelId,
      groupId: group.id,
      mediaUrl,
    })

    if (!sendResult.ok) {
      const errMsg = 'error' in sendResult ? sendResult.error : 'Failed to send WhatsApp message'
      return NextResponse.json({ error: errMsg || 'Failed to send WhatsApp message' }, { status: 500 })
    }

    // Return conversation object for the UI to select
    return NextResponse.json({
      success: true,
      conversation: {
        id: group.id,
        channel: 'whatsapp',
        name: group.group_name,
        preview: message.slice(0, 80),
        unread: 0,
        lastMessageAt: new Date().toISOString(),
        accountId: accountId || null,
      },
    })
  } catch (error) {
    console.error('New WhatsApp error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
