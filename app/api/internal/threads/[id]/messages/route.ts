import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/internal/threads/[id]/messages
 * Send a message in an internal thread.
 * Body: { message }
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
  const message = body.message?.trim() ?? ''
  const attachmentUrl = body.attachment_url ?? null
  const attachmentName = body.attachment_name ?? null

  if (!message && !attachmentUrl) {
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

  const displayName = getUserDisplayName(user)

  const { data: msg, error } = await supabaseAdmin
    .from('internal_messages')
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      sender_name: displayName,
      message,
      attachment_url: attachmentUrl,
      attachment_name: attachmentName,
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
      body: message.slice(0, 100),
      url: `/portal-chats?view=internal`,
      tag: `internal-thread-${threadId}`,
    })
  } catch {
    // Non-critical
  }

  return NextResponse.json({ message: msg })
}
