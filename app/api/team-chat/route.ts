import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { NextResponse } from 'next/server'

const TEAM_GENERAL_TITLE = '__team_general__'

/**
 * GET /api/team-chat
 * Returns (or creates) the Team General thread + all messages.
 * Marks messages from other senders as read.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  // Find or create the team general thread
  let { data: thread } = await supabaseAdmin
    .from('internal_threads')
    .select('*')
    .eq('title', TEAM_GENERAL_TITLE)
    .is('account_id', null)
    .is('contact_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()

  if (!thread) {
    const { data: created } = await supabaseAdmin
      .from('internal_threads')
      .insert({ title: TEAM_GENERAL_TITLE, created_by: user.id })
      .select()
      .single()
    thread = created
  }

  if (!thread) {
    return NextResponse.json({ error: 'Failed to initialize team chat' }, { status: 500 })
  }

  // Get all messages
  const { data: messages } = await supabaseAdmin
    .from('internal_messages')
    .select('*')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true })
    .limit(500)

  // Mark messages from other senders as read
  await supabaseAdmin
    .from('internal_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('thread_id', thread.id)
    .neq('sender_id', user.id)
    .is('read_at', null)

  return NextResponse.json({
    thread_id: thread.id,
    current_user_id: user.id,
    current_user_name: getUserDisplayName(user),
    messages: messages ?? [],
  })
}
