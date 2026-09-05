/**
 * Staff Alerts — read-side notification feed sourced from Team Workspace (DMs,
 * @mentions, work-channel posts). Sibling of lib/notes/staff-alerts.ts, same
 * philosophy: computed fresh on every read, nothing new persisted for "have I
 * seen this" — chat already has that, in internal_thread_reads.
 *
 * TWO SOURCES OF "UNREAD," NOT ONE, because get_team_threads' own unread_count
 * means two different things depending on thread_type — verified against its
 * LIVE definition on both sandbox and production (2026-09-04), not assumed:
 *  - dm: a plain count of messages after my last_read_at, INCLUDING a manual
 *    "Mark unread" (the RPC's own GREATEST of the message count and the
 *    manual_unread flag). Trustworthy as-is — lib/team/chat-window-threads.ts
 *    already leans on this exact field for the floating chat's own badge, and
 *    re-deriving it here would be a second copy of the same number that could
 *    quietly disagree.
 *  - channel: NOT trustworthy for "is there a new message." The RPC's channel
 *    branch counts "Threads-panel bugs with new activity" (a root message
 *    promoted via a title/assignee/status/reply — see the RPC body), which a
 *    plain top-level channel post never satisfies on its own. Computed HERE
 *    from raw messages instead, the same way dm already is under the hood —
 *    plus a manual "Mark unread" (real, reachable — see
 *    app/api/team/threads/[id]/mark-unread/route.ts), honored separately
 *    since it carries no message of its own to find.
 *  - general: NEITHER of the above — general is EXCLUDED from plain-unread
 *    alerting entirely, matching an existing, deliberate product decision.
 *    app/api/team/notifications/route.ts's own comment: "general is
 *    deliberately mention-only" — the sidebar dot, its dropdown, and the
 *    dashboard badge all already treat plain general chatter as not
 *    notification-worthy. An earlier version of this file silently reversed
 *    that precedent by raw-recomputing general the same as channel — caught
 *    in council review (ai-architect, 2026-09-04) before shipping. General
 *    still alerts on a genuine @mention, same as every other thread type.
 *
 * MENTIONS ARE MESSAGE-GRAIN, NOT THREAD-GRAIN, and computed from raw
 * messages too — NOT from get_team_threads' mention_count. Council review
 * (senior-engineer, 2026-09-04) found trusting mention_count would show the
 * WRONG content: the RPC's own last_message/last_sender_name/last_message_at
 * are the thread's overall latest message regardless of whether THAT message
 * is the one that mentions you (its LATERAL join has no mention filter) — a
 * mention followed by an unrelated reply before you next check would alert
 * "X mentioned you" with body text that never mentioned you, and a stale
 * timestamp. Fetching the actual mentioning messages and picking the latest
 * UNREAD one per thread fixes this at the source and wins priority over
 * dm/channel on the same thread, mirroring the toast's mention > DM > channel
 * ordering.
 *
 * ONE ALERT PER THREAD IS A REAL, ACCEPTED LOSS OF GRANULARITY, STATED NOT
 * HIDDEN (ai-architect, 2026-09-04): dismissing (or even opening) a thread's
 * alert advances its read pointer for the WHOLE thread, same as Team Chat's
 * own "mark read" already does — so two unread messages 30s apart collapse to
 * one alert, and acting on it clears both. A dedicated per-message dismissal
 * table would fix this fully but is disproportionate for a 2-person tool, so
 * instead: when more than one qualifying item sits behind the shown preview,
 * the alert body says so ("+N more") rather than silently discarding them.
 *
 * ONE NAMED RESIDUAL GAP the "+N more" count does not close (bug-hunter,
 * 2026-09-04): "+N more" only counts OTHER items of the SAME kind (other
 * unread mentions, or other plain channel activity) — a thread with an
 * unread @mention AND a separate, older, unrelated plain post shows only the
 * mention, with no count reflecting the plain post at all. Dismissing that
 * mention advances the thread's read pointer and the plain post can never
 * surface as a chat_channel alert afterward. Nothing is actually LOST — every
 * message is still fully visible by opening the thread in Team Chat, this
 * only affects whether it was ever flagged unread — but it is a real,
 * accepted trade-off of one-alert-per-thread + a single read pointer, stated
 * here rather than silently engineered around with fragile cross-source
 * counting (which risks double-counting a message that is both a mention AND
 * a plain post) or a new dismissal table (disproportionate for this team's
 * scale, per council review).
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
  last_message: string | null
  last_message_at: string | null
  last_sender_name: string | null
}

export interface ChatMemberForAlerts {
  id: string
  name: string
}

/** A candidate message — raw, unfiltered. Used both for "recent channel
 *  activity" and "messages that mention me" queries; same shape either way. */
export interface RawMessageForAlerts {
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
  /** A real, reachable Team Chat action ("Mark unread") — forces the thread
   *  unread with no new message of its own. See mark-unread/route.ts. */
  manual_unread?: boolean | null
}

export interface QualifyingActivity {
  latest: RawMessageForAlerts
  /** How many notify-worthy messages qualify, not just the one shown — lets
   *  the alert say "+N more" instead of silently discarding the rest when its
   *  one dismiss/open clears the whole thread's read pointer. */
  count: number
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
function effectiveMs(m: RawMessageForAlerts): number {
  return Math.max(parsedMs(m.created_at), parsedMs(m.edited_at))
}

/**
 * The latest notify-worthy message per thread (plus how many qualify total),
 * newer than my read pointer for that thread. Mirrors realtime-notifications
 * .tsx's own skip rules exactly (own messages, on-behalf-of-me, deleted,
 * placeholder bodies) — this is what makes it safe to trust as "would this
 * have toasted." Used for BOTH the raw channel-activity check and the mention
 * check; the caller decides which messages to feed it (all recent channel
 * messages, or only ones that mention a specific person).
 */
export function latestQualifyingActivity(
  messages: readonly RawMessageForAlerts[],
  readPointers: readonly ThreadReadPointer[],
  myId: string,
): Map<string, QualifyingActivity> {
  const readMsByThread = new Map(readPointers.map((r) => [r.thread_id, parsedMs(r.last_read_at)]))
  const byThread = new Map<string, QualifyingActivity>()
  for (const m of messages) {
    if (m.deleted_at) continue
    if (!m.sender_id || m.sender_id === myId) continue
    if (m.on_behalf_of_user_id === myId) continue
    if (PENDING_PLACEHOLDERS.includes((m.message ?? "").trim())) continue
    const readAtMs = readMsByThread.get(m.thread_id) ?? 0
    const ms = effectiveMs(m)
    if (ms <= readAtMs) continue
    const cur = byThread.get(m.thread_id)
    if (!cur) {
      byThread.set(m.thread_id, { latest: m, count: 1 })
    } else if (ms > effectiveMs(cur.latest)) {
      byThread.set(m.thread_id, { latest: m, count: cur.count + 1 })
    } else {
      byThread.set(m.thread_id, { ...cur, count: cur.count + 1 })
    }
  }
  return byThread
}

function channelLabelOf(t: ChatThreadForAlerts): string {
  if (t.thread_type === "general") return "general"
  return t.channel_name || t.channel_slug || "team"
}

function dmOtherPartyName(dmKey: string | null, members: readonly ChatMemberForAlerts[], myId: string): string {
  const otherId = otherPartyId(dmKey, myId)
  return members.find((m) => m.id === otherId)?.name || "Someone"
}

function whereFor(t: ChatThreadForAlerts, members: readonly ChatMemberForAlerts[], myId: string): string | null {
  if (t.thread_type === "dm") return dmOtherPartyName(t.dm_key, members, myId)
  if (t.thread_type === "channel" || t.thread_type === "general") return `#${channelLabelOf(t)}`
  return null
}

/** "+N more" when more than one qualifying item sits behind the one shown. */
function withExtra(body: string, extra: number): string {
  return extra > 0 ? `${body} (+${extra} more)` : body
}

/**
 * How far back the channel-messages query needs to look, in ms since epoch —
 * bug-hunter, 2026-09-04: a bare LIMIT with no lower bound competes old,
 * already-read history for the same budget as genuinely unread messages, and
 * at real production channel volume (verified: one channel alone carries
 * hundreds of messages) a busy channel can push a real unread message in a
 * quiet one clean out of the window — permanently, not just for one refresh.
 * The earliest point ANY of these threads' unread state could possibly start
 * is the OLDEST read pointer among them; nothing older than that can matter.
 * null = no safe bound (at least one of these threads has never been read by
 * this person, so its entire history could in principle be unread) — the
 * caller falls back to LIMIT alone for that thread, same as before this fix.
 */
export function earliestPossibleUnreadMs(
  readPointers: readonly ThreadReadPointer[],
  threadIds: readonly string[],
): number | null {
  if (threadIds.length === 0) return null
  const readAtByThread = new Map(readPointers.map((r) => [r.thread_id, r.last_read_at]))
  let min: number | null = null
  for (const id of threadIds) {
    const at = readAtByThread.get(id)
    if (!at) return null
    const ms = parsedMs(at)
    if (min === null || ms < min) min = ms
  }
  return min
}

/**
 * Staff Alerts feed for ONE person, chat half. One alert PER THREAD at most —
 * a thread that both mentions me and has plain unread activity shows only the
 * mention, same priority order the realtime toast already uses.
 */
export function computeChatAlerts(
  threads: readonly ChatThreadForAlerts[],
  channelMessages: readonly RawMessageForAlerts[],
  mentionMessages: readonly RawMessageForAlerts[],
  readPointers: readonly ThreadReadPointer[],
  members: readonly ChatMemberForAlerts[],
  myId: string,
): ChatAlert[] {
  const channelActivityByThread = latestQualifyingActivity(channelMessages, readPointers, myId)
  const mentionActivityByThread = latestQualifyingActivity(mentionMessages, readPointers, myId)
  const manualUnreadByThread = new Map(readPointers.map((r) => [r.thread_id, r.manual_unread === true]))
  const out: ChatAlert[] = []

  for (const t of threads) {
    const mention = mentionActivityByThread.get(t.id)
    if (mention) {
      const where = whereFor(t, members, myId)
      out.push({
        kind: "chat_mention",
        thread_id: t.id,
        title: `${mention.latest.sender_name || "Someone"} mentioned you${where ? ` in ${where}` : ""}`,
        body: withExtra((mention.latest.message ?? "").slice(0, 160), mention.count - 1),
        url: `/team-chat?thread=${t.id}`,
        tag: `staff-alert-chat-mention-${t.id}`,
        created_at: mention.latest.created_at,
      })
      continue // mention wins — never a second alert for the same thread
    }

    if (t.thread_type === "dm") {
      const unread = num(t.unread_count)
      if (unread <= 0) continue
      out.push({
        kind: "chat_dm",
        thread_id: t.id,
        title: `${dmOtherPartyName(t.dm_key, members, myId)} sent you a message`,
        body: withExtra((t.last_message ?? "").slice(0, 160), unread - 1),
        url: `/team-chat?thread=${t.id}`,
        tag: `staff-alert-chat-dm-${t.id}`,
        created_at: t.last_message_at || new Date(0).toISOString(),
      })
      continue
    }

    if (t.thread_type === "channel") {
      if (!channelNotifiesStaff(t.channel_slug ?? t.channel_name)) continue
      const activity = channelActivityByThread.get(t.id)
      if (activity) {
        out.push({
          kind: "chat_channel",
          thread_id: t.id,
          title: `${activity.latest.sender_name || "Someone"} posted in #${channelLabelOf(t)}`,
          body: withExtra((activity.latest.message ?? "").slice(0, 160), activity.count - 1),
          url: `/team-chat?thread=${t.id}`,
          tag: `staff-alert-chat-channel-${t.id}`,
          created_at: activity.latest.created_at,
        })
      } else if (manualUnreadByThread.get(t.id)) {
        // A real, reachable Team Chat action ("Mark unread") carries no
        // message of its own to point at — fall back to the RPC's own
        // thread-level preview, the same content Team Chat's own sidebar
        // would show for this thread right now.
        out.push({
          kind: "chat_channel",
          thread_id: t.id,
          title: `#${channelLabelOf(t)} marked unread`,
          body: (t.last_message ?? "").slice(0, 160),
          url: `/team-chat?thread=${t.id}`,
          tag: `staff-alert-chat-channel-${t.id}`,
          created_at: t.last_message_at || new Date(0).toISOString(),
        })
      }
    }
    // general, no mention: silent by design — matches app/api/team/notifications
    // /route.ts's own "general is deliberately mention-only" precedent.
    // discussion (client conversation), no mention: silent by design —
    // conversationNotifiesParticipants() === false.
  }

  return out.sort((a, b) => parsedMs(b.created_at) - parsedMs(a.created_at))
}
