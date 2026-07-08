import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { isSlackMirrorEnabled } from '@/lib/settings'
import { NextResponse } from 'next/server'

/**
 * GET /api/team/slack/channels
 * List mirrored Slack channels (bot is a member of), newest activity first.
 * Staff-only + gated on the slack_mirror_enabled kill-switch (returns
 * { enabled:false, channels:[] } when off, so the UI can hide the section).
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  if (!(await isSlackMirrorEnabled())) {
    return NextResponse.json({ enabled: false, channels: [] })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('slack_channels')
    .select('id, name, is_private, is_archived, topic, num_members, last_message_at')
    .eq('is_member', true)
    .eq('is_archived', false)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100)

  return NextResponse.json({ enabled: true, channels: data ?? [] })
}
