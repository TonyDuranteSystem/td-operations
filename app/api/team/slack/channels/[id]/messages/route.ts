import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { isSlackMirrorEnabled } from '@/lib/settings'
import { buildSlackThreadDeepLink } from '@/lib/ai-agent/slack-claude'
import { KNOWN_SLACK_USERS, resolveSlackMentions } from '@/lib/team/slack-mirror-classify'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/team/slack/channels/[id]/messages
 * Recent mirrored messages for a channel (read-only), oldest→newest, each with
 * an "Open in Slack" deep link. Staff-only + gated on the kill-switch.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  if (!(await isSlackMirrorEnabled())) {
    return NextResponse.json({ enabled: false, messages: [] })
  }
  const { id: channelId } = await params

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: channel } = await (supabaseAdmin as any)
    .from('slack_channels').select('id, name').eq('id', channelId).maybeSingle()

  // Newest 100, then reverse to chronological for display.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows } = await (supabaseAdmin as any)
    .from('slack_messages')
    .select('channel_id, ts, thread_ts, slack_user_id, author_name, text, subtype, edited, deleted, posted_at')
    .eq('channel_id', channelId)
    .eq('deleted', false)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(100)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages = (rows ?? []).reverse().map((m: any) => ({
    ...m,
    text: resolveSlackMentions(m.text),
    // Human names need users:read (not granted yet) — use the known-team map,
    // then any bot username, then the raw id.
    display_author: m.author_name || KNOWN_SLACK_USERS[m.slack_user_id] || m.slack_user_id || 'Unknown',
    deep_link: buildSlackThreadDeepLink(channelId, m.thread_ts || m.ts),
  }))

  return NextResponse.json({ enabled: true, channel: channel ?? { id: channelId }, messages })
}
