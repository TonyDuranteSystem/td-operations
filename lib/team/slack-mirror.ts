/**
 * Team Workspace — Slack channel mirror (read-only).
 *
 * Ingests Slack messages into slack_channels / slack_messages so the workspace
 * can show a Slack feed with "Open in Slack" links without polling Slack on
 * every render. Two feeds:
 *   1. LIVE — the events already arriving at the Slack webhook (message.channels)
 *      call ingestSlackMessageEvent() (additive; the worker path is untouched).
 *   2. BACKFILL — syncSlackChannels() + backfillChannelHistory() pull the current
 *      channel list + recent history via the Slack Web API (Tier-3; internal app
 *      is exempt from the 2025 rate-limit crackdown).
 *
 * All of this is DORMANT until app_settings 'slack_mirror_enabled' is true.
 * Server-only (supabaseAdmin + Slack token). Never import into client code.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isSlackMirrorEnabled } from '@/lib/settings'
import { slackApiGet } from '@/lib/ai-agent/slack-claude'
import { classifySlackEvent } from '@/lib/team/slack-mirror-classify'

export { slackTsToDate, classifySlackEvent, SKIP_SUBTYPES } from '@/lib/team/slack-mirror-classify'
export type { MirrorAction, MirrorRow } from '@/lib/team/slack-mirror-classify'

/**
 * Apply a classified Slack message event to the mirror. Best-effort + gated on
 * the kill-switch: a no-op (and never throws) when the mirror is off. Idempotent
 * via upsert on (channel_id, ts) so Slack retries don't duplicate.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ingestSlackMessageEvent(event: any): Promise<void> {
  try {
    if (!(await isSlackMirrorEnabled())) return
    const action = classifySlackEvent(event)
    if (action.op === 'skip') return

    if (action.op === 'delete') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from('slack_messages')
        .update({ deleted: true })
        .eq('channel_id', action.channel_id)
        .eq('ts', action.ts)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from('slack_messages')
      .upsert({ ...action.row, raw: event, ingested_at: new Date().toISOString() }, { onConflict: 'channel_id,ts' })

    // Keep the channel's last_message_at fresh for sidebar sorting.
    if (action.row.posted_at) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from('slack_channels')
        .upsert({ id: action.row.channel_id, last_message_at: action.row.posted_at, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    }
  } catch (err) {
    console.warn('[slack-mirror] ingest failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}

/**
 * Sync the channel list (conversations.list) into slack_channels — only channels
 * the bot is a member of. Returns the count synced. Gated on the kill-switch.
 */
export async function syncSlackChannels(): Promise<number> {
  if (!(await isSlackMirrorEnabled())) return 0
  let cursor = ''
  let synced = 0
  const now = new Date().toISOString()
  do {
    const params: Record<string, string> = {
      types: 'public_channel,private_channel',
      exclude_archived: 'false',
      limit: '200',
    }
    if (cursor) params.cursor = cursor
    const res = await slackApiGet('conversations.list', params)
    if (!res?.ok) break
    for (const ch of res.channels ?? []) {
      if (!ch.is_member) continue // only channels the bot is in
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any).from('slack_channels').upsert({
        id: ch.id,
        name: ch.name ?? null,
        is_private: !!ch.is_private,
        is_member: !!ch.is_member,
        is_archived: !!ch.is_archived,
        topic: ch.topic?.value ?? null,
        num_members: ch.num_members ?? null,
        synced_at: now,
        updated_at: now,
      }, { onConflict: 'id' })
      synced++
    }
    cursor = res.response_metadata?.next_cursor ?? ''
  } while (cursor)
  return synced
}

/**
 * Backfill recent history for one channel (conversations.history) into
 * slack_messages. `limit` capped at 200 (Slack max). Gated on the kill-switch.
 */
export async function backfillChannelHistory(channelId: string, limit = 100): Promise<number> {
  if (!(await isSlackMirrorEnabled())) return 0
  const res = await slackApiGet('conversations.history', {
    channel: channelId,
    limit: String(Math.min(Math.max(limit, 1), 200)),
  })
  if (!res?.ok) return 0
  let n = 0
  for (const m of res.messages ?? []) {
    // Reuse the same classifier by shaping a synthetic event.
    const action = classifySlackEvent({ type: 'message', channel: channelId, ...m })
    if (action.op !== 'upsert') continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from('slack_messages')
      .upsert({ ...action.row, raw: m, ingested_at: new Date().toISOString() }, { onConflict: 'channel_id,ts' })
    n++
  }
  return n
}
