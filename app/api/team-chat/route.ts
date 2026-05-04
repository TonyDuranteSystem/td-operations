import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin, isClient, getUserDisplayName } from '@/lib/auth'
import { NextResponse } from 'next/server'
import type { ChatAttachment } from '@/lib/types'

const TEAM_GENERAL_TITLE = '__team_general__'

interface RawMsg {
  id: string
  thread_id: string
  sender_id: string
  sender_name: string
  message: string
  created_at: string
  read_at: string | null
  seen_at: string | null
  attachment_url: string | null
  attachment_name: string | null
  attachments: ChatAttachment[] | null
  reply_to_id: string | null
  deleted_at: string | null
  deleted_by: string | null
}

/**
 * GET /api/team-chat
 * Returns (or creates) the Team General thread + all messages.
 * Marks messages from other senders as seen (seen_at).
 * Enriches each message with reply_to_preview.
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

  // Get all messages (including deleted — UI renders tombstones)
  const { data: rawMessages } = await supabaseAdmin
    .from('internal_messages')
    .select('*')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true })
    .limit(500)

  const messages = (rawMessages ?? []) as unknown as RawMsg[]

  // Enrich with reply_to previews
  type ReplyParent = { id: string; message: string; sender_name: string; deleted_at: string | null }
  const replyToIds = Array.from(new Set(messages.filter(m => m.reply_to_id).map(m => m.reply_to_id as string)))
  const parentMap = new Map<string, ReplyParent>()
  if (replyToIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: parents } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('id, message, sender_name, deleted_at')
      .in('id', replyToIds)
    ;(parents ?? []).forEach((p: ReplyParent) => parentMap.set(p.id, p))
  }

  const enriched = messages.map(m => ({
    ...m,
    reply_to_preview: m.reply_to_id ? (parentMap.get(m.reply_to_id) ?? null) : null,
  }))

  // Mark messages from other senders as seen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ seen_at: new Date().toISOString() })
    .eq('thread_id', thread.id)
    .neq('sender_id', user.id)
    .is('seen_at', null)

  // Fetch all team members except the current user for the sound picker
  const { data: { users: allUsers } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 })
  const teamMembers = (allUsers ?? [])
    .filter(u => u.id !== user.id && !isClient(u))
    .map(u => ({ id: u.id, name: getUserDisplayName(u) }))

  return NextResponse.json({
    thread_id: thread.id,
    current_user_id: user.id,
    current_user_name: getUserDisplayName(user),
    is_admin: isAdmin(user),
    messages: enriched,
    members: teamMembers,
  })
}
