import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { isSlackMirrorEnabled } from '@/lib/settings'
import { syncSlackChannels, backfillChannelHistory } from '@/lib/team/slack-mirror'
import { NextResponse } from 'next/server'

export const maxDuration = 120

/**
 * POST /api/team/slack/sync
 * Staff-triggered: refresh the channel list (conversations.list) + backfill
 * recent history for each member channel (conversations.history). Gives the
 * mirror an immediate snapshot without waiting for live events. Gated on the
 * kill-switch. Also usable as a cron.
 */
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  if (!(await isSlackMirrorEnabled())) {
    return NextResponse.json({ error: 'Slack mirror is off. Enable slack_mirror_enabled first.' }, { status: 400 })
  }

  const channelsSynced = await syncSlackChannels()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: channels } = await (supabaseAdmin as any)
    .from('slack_channels').select('id').eq('is_member', true).eq('is_archived', false)

  let messagesSynced = 0
  for (const ch of channels ?? []) {
    messagesSynced += await backfillChannelHistory(ch.id, 60)
  }

  return NextResponse.json({ ok: true, channels_synced: channelsSynced, messages_synced: messagesSynced })
}
