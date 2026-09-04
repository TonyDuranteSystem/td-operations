/**
 * Staff Alerts — read-side notification feed sourced from Team Workspace (DMs,
 * @mentions, work-channel posts). Sibling of lib/notes/staff-alerts.ts, same
 * philosophy: computed fresh on every read, nothing new persisted for "have I
 * seen this" — chat already has that, in internal_thread_reads.
 *
 * THREE SOURCES OF "UNREAD," NOT ONE, because get_team_threads' own unread_count
 * means two different things depending on thread_type — verified against its
 * live definition (2026-09-04), not assumed:
 *  - dm / discussion / general: a plain count of messages after my last_read_at.
 *    Trustworthy as-is — lib/team/chat-window-threads.ts already leans on this
 *    exact field for the floating chat's own badge, and re-deriving it here
 *    would be a second copy of the same number that could quietly disagree.
 *  - channel: NOT that. It counts "Threads-panel bugs with new activity" (root
 *    messages promoted via a title/assignee/status/reply — see the RPC body),
 *    which a plain top-level channel post never satisfies on its own. Reusing
 *    it here would silently miss ordinary channel chatter — exactly the class
 *    of bug the note_update creation-gap incident already taught this feature
 *    to watch for. So channel unread is computed HERE, from raw messages, the
 *    same way general/dm already are under the hood.
 *  - mentions: mention_count from the RPC IS trustworthy for every thread type
 *    (it never routes through the Threads-panel formula) and wins priority
 *    over both — one alert per thread, never two, mirroring how the realtime
 *    toast picks a single title (mention > DM > channel).
 *
 * A muted channel (SILENT_CHANNEL_SLUGS) and a silenced client conversation
 * (conversationNotifiesParticipants() === false) read the SAME predicates the
 * toast and the push routes already use — see lib/team/channel-notify.ts.
 */

import { channelNotifiesStaff } from "./channel-notify"
import { otherPartyId } from "./chat-window-threads"
import { parsedMs } from "../notes/staff-alerts"

export type ChatAlertKind = "chat_mention" | "chat_dm" | "chat_channel"

export interface ChatAlert {
  kind: ChatAlertKind
  thread_id: string
  title: string
  body: string
  url: string
  tag: string
  created_at: string
}

/** Shape read from the get_team_threads RPC — only the columns this feature uses. */
export interface ChatThreadForAlerts {
  id: string
  thread_type: string | null
  channel_slug: string | null
  channel_name: string | null
  dm_key: string | null
  unread_count: number | string | null
  mention_count: number | string | null
  last_message: string | null
  last_message_at: string | null
  last_sender_name: string | null
}

export interface ChatMemberForAlerts {
  id: string
  name: string
}

/** A candidate message in a channel/general thread — raw, unfiltered. */
export interface ChannelMessageForAlerts {
  thread_id: string
  sender_id: string | null
  sender_name: string | null
  message: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  on_behalf_of_user_id: string | null
}

export interface ThreadReadPointer {
  thread_id: string
  last_read_at: string | null
}

/** "Claude is thinking" is not news — the answer arrives as a later edit. Same
 *  list realtime-notifications.tsx skips for the live toast. */
const PENDING_PLACEHOLDERS = ["…", "⋯"]

function num(v: number | string | null | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** The later of created vs edited — an edit that adds a mention/changes the text
 *  must be able to re-surface a thread already read before the edit. */
function effectiveMs(m: ChannelMessageForAlerts): number {
  return Math.max(parsedMs(m.created_at), parsedMs(m.edited_at))
}

/**
 * The latest notify-worthy message per channel/general thread, newer than my
 * read pointer for that thread. Mirrors realtime-notifications.tsx's own skip
 * rules exactly (own messages, on-behalf-of-me, deleted, placeholder bodies) —
 * this is what makes it safe to trust as "would this have toasted."
 */
export function latestChannelActivity(
  messages: readonly ChannelMessageForAlerts[],
  readPointers: readonly ThreadReadPointer[],
  myId: string,
): Map<string, ChannelMessageForAlerts> {
  const readMsByThread = new Map(readPointers.map((r) => [r.thread_id, parsedMs(r.last_read_at)]))
  const latestByThread = new Map<string, ChannelMessageForAlerts>()
  for (const m of messages) {
    if (m.deleted_at) continue
    if (!m.sender_id || m.sender_id === myId) continue
    if (m.on_behalf_of_user_id === myId) continue
    if (PENDING_PLACEHOLDERS.includes((m.message ?? "").trim())) continue
    const readAtMs = readMsByThread.get(m.thread_id) ?? 0
    const ms = effectiveMs(m)
    if (ms <= readAtMs) continue
    const cur = latestByThread.get(m.thread_id)
    if (!cur || ms > effectiveMs(cur)) latestByThread.set(m.thread_id, m)
  }
  return latestByThread
}

function channelLabelOf(t: ChatThreadForAlerts): string {
  if (t.thread_type === "general") return "general"
  return t.channel_name || t.channel_slug || "team"
}

function dmOtherPartyName(dmKey: string | null, members: readonly ChatMemberForAlerts[], myId: string): string {
  const otherId = otherPartyId(dmKey, myId)
  return members.find((m) => m.id === otherId)?.name || "Someone"
}

/**
 * Staff Alerts feed for ONE person, chat half. One alert PER THREAD at most —
 * a thread that both mentions me and has plain unread activity shows only the
 * mention, same priority order the realtime toast already uses.
 */
export function computeChatAlerts(
  threads: readonly ChatThreadForAlerts[],
  channelMessages: readonly ChannelMessageForAlerts[],
  channelReadPointers: readonly ThreadReadPointer[],
  members: readonly ChatMemberForAlerts[],
  myId: string,
): ChatAlert[] {
  const activityByThread = latestChannelActivity(channelMessages, channelReadPointers, myId)
  const out: ChatAlert[] = []

  for (const t of threads) {
    if (num(t.mention_count) > 0) {
      const where = t.thread_type === "dm"
        ? dmOtherPartyName(t.dm_key, members, myId)
        : t.thread_type === "channel" || t.thread_type === "general"
          ? `#${channelLabelOf(t)}`
          : null
      out.push({
        kind: "chat_mention",
        thread_id: t.id,
        title: `${t.last_sender_name || "Someone"} mentioned you${where ? ` in ${where}` : ""}`,
        body: (t.last_message ?? "").slice(0, 160),
        url: `/team-chat?thread=${t.id}`,
        tag: `staff-alert-chat-mention-${t.id}`,
        created_at: t.last_message_at || new Date(0).toISOString(),
      })
      continue // mention wins — never a second alert for the same thread
    }

    if (t.thread_type === "dm" && num(t.unread_count) > 0) {
      out.push({
        kind: "chat_dm",
        thread_id: t.id,
        title: `${dmOtherPartyName(t.dm_key, members, myId)} sent you a message`,
        body: (t.last_message ?? "").slice(0, 160),
        url: `/team-chat?thread=${t.id}`,
        tag: `staff-alert-chat-dm-${t.id}`,
        created_at: t.last_message_at || new Date(0).toISOString(),
      })
      continue
    }

    if (t.thread_type === "channel" || t.thread_type === "general") {
      if (!channelNotifiesStaff(t.channel_slug ?? t.channel_name)) continue
      const activity = activityByThread.get(t.id)
      if (!activity) continue
      out.push({
        kind: "chat_channel",
        thread_id: t.id,
        title: `${activity.sender_name || "Someone"} posted in #${channelLabelOf(t)}`,
        body: (activity.message ?? "").slice(0, 160),
        url: `/team-chat?thread=${t.id}`,
        tag: `staff-alert-chat-channel-${t.id}`,
        created_at: activity.created_at,
      })
    }
    // discussion (client conversation) with no mention: silent by design —
    // conversationNotifiesParticipants() === false. Any other/unknown
    // thread_type: no alert kind defined for it.
  }

  return out.sort((a, b) => parsedMs(b.created_at) - parsedMs(a.created_at))
}
