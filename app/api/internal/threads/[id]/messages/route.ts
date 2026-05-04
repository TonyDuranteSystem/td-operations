import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import type { ChatAttachment } from '@/lib/types'

/**
 * POST /api/internal/threads/[id]/messages
 * Send a message in an internal thread.
 * Body: { message, reply_to_id?, attachments?, attachment_url?, attachment_name? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { id: threadId } = await params
  const body = await request.json()
  const message: string = body.message?.trim() ?? ''
  const replyToId: string | null = body.reply_to_id ?? null
  const attachments: ChatAttachment[] | null = body.attachments ?? null
  const attachmentUrl: string | null = body.attachment_url ?? null
  const attachmentName: string | null = body.attachment_name ?? null

  const hasContent = message || attachments?.length || attachmentUrl
  if (!hasContent) {
    return NextResponse.json({ error: 'message or attachment required' }, { status: 400 })
  }

  if (message.length > 5000) {
    return NextResponse.json({ error: 'Message too long (max 5000 characters)' }, { status: 400 })
  }

  // Verify thread exists
  const { data: thread } = await supabaseAdmin
    .from('internal_threads')
    .select('id, account_id')
    .eq('id', threadId)
    .single()

  if (!thread) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
  }

  // Verify reply_to_id belongs to the same thread
  if (replyToId) {
    const { data: parent } = await supabaseAdmin
      .from('internal_messages')
      .select('id')
      .eq('id', replyToId)
      .eq('thread_id', threadId)
      .single()
    if (!parent) {
      return NextResponse.json({ error: 'reply_to_id not found in this thread' }, { status: 400 })
    }
  }

  const displayName = getUserDisplayName(user)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: msg, error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      sender_name: displayName,
      message,
      reply_to_id: replyToId,
      attachments: attachments?.length ? attachments : null,
      attachment_url: attachmentUrl,
      attachment_name: attachmentName,
      read_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Push notification to other admins
  try {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', thread.account_id)
      .single()

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    await sendPushToAdmin({
      title: `${displayName} — ${account?.company_name ?? 'Team'}`,
      body: message.slice(0, 100) || (attachments?.length ? `📎 ${attachments[0].name}` : '📎 File'),
      url: `/portal-chats?view=internal`,
      tag: `internal-thread-${threadId}`,
    })
  } catch {
    // Non-critical
  }

  return NextResponse.json({ message: msg })
}
