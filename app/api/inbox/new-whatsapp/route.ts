import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/inbox/new-whatsapp
 * Find or create a WhatsApp messaging_group for a contact, then send the first message.
 * Body: { contactId, phone, message, accountId? }
 */
export async function POST(req: NextRequest) {
  try {
    const { contactId, phone, message, accountId } = await req.json() as {
      contactId: string
      phone: string
      message: string
      accountId?: string | null
    }

    if (!contactId || !phone || !message) {
      return NextResponse.json({ error: 'contactId, phone, and message are required' }, { status: 400 })
    }

    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    // Normalize phone to WhatsApp chat_id format: digits@c.us
    const digits = phone.replace(/[^\d]/g, '')
    const chatId = `${digits}@c.us`

    // Find the WhatsApp Lead channel (default channel for outbound)
    // @ts-expect-error Type instantiation is excessively deep
    const { data: channels } = await supabaseAdmin
      .from('messaging_channels')
      .select('id')
      .eq('platform', 'whatsapp')
      .limit(1)

    const channelId = channels?.[0]?.id
    if (!channelId) {
      return NextResponse.json({ error: 'No WhatsApp channel configured' }, { status: 500 })
    }

    // Check if a messaging_group already exists for this chat_id
    let { data: group } = await supabaseAdmin
      .from('messaging_groups')
      .select('id, group_name, external_group_id')
      .eq('external_group_id', chatId)
      .single()

    // If not found, create one
    if (!group) {
      // Get contact name for group_name
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('full_name')
        .eq('id', contactId)
        .single()

      const groupName = contact?.full_name ?? phone

      const { data: newGroup, error: insertErr } = await supabaseAdmin
        .from('messaging_groups')
        .insert({
          channel_id: channelId,
          external_group_id: chatId,
          group_name: groupName,
          account_id: accountId || null,
          contact_id: contactId,
          unread_count: 0,
          participant_count: 2,
        })
        .select('id, group_name, external_group_id')
        .single()

      if (insertErr) {
        console.error('Failed to create messaging group:', insertErr)
        return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
      }
      group = newGroup
    }

    // Send message via provider routing (reads provider from messaging_channels)
    const { dispatchWhatsAppMessage } = await import('@/lib/messaging/send-dispatcher')
    const sendResult = await dispatchWhatsAppMessage(chatId, message, channelId)

    if (!sendResult.ok) {
      return NextResponse.json({ error: sendResult.error || 'Failed to send WhatsApp message' }, { status: 500 })
    }

    // Return conversation object for the UI to select
    return NextResponse.json({
      success: true,
      conversation: {
        id: group!.id,
        channel: 'whatsapp',
        name: group!.group_name,
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
