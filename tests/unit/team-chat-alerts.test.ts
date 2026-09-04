/**
 * Staff Alerts — chat half. computeChatAlerts reads get_team_threads rows (trusted
 * as-is for dm/mention unread) plus raw channel/general messages (NOT trusted from
 * the RPC — its channel unread_count means "Threads-panel bugs with new activity,"
 * not "new message," verified against the live function 2026-09-04).
 */
import { describe, it, expect } from "vitest"
import {
  computeChatAlerts,
  latestChannelActivity,
  type ChatThreadForAlerts,
  type ChannelMessageForAlerts,
  type ThreadReadPointer,
  type ChatMemberForAlerts,
} from "@/lib/team/chat-alerts"

const ANTONIO = "11111111-1111-4111-8111-111111111111"
const LUCA = "22222222-2222-4222-8222-222222222222"
const MEMBERS: ChatMemberForAlerts[] = [
  { id: ANTONIO, name: "Antonio" },
  { id: LUCA, name: "Luca" },
]

function thread(overrides: Partial<ChatThreadForAlerts> = {}): ChatThreadForAlerts {
  return {
    id: "t-1",
    thread_type: "dm",
    channel_slug: null,
    channel_name: null,
    dm_key: `${ANTONIO}:${LUCA}`,
    unread_count: 0,
    mention_count: 0,
    last_message: "hey",
    last_message_at: "2026-09-04T10:00:00.000Z",
    last_sender_name: "Luca",
    ...overrides,
  }
}

function chanMsg(overrides: Partial<ChannelMessageForAlerts> = {}): ChannelMessageForAlerts {
  return {
    thread_id: "t-chan",
    sender_id: LUCA,
    sender_name: "Luca",
    message: "new bug from Aces",
    created_at: "2026-09-04T10:00:00.000Z",
    edited_at: null,
    deleted_at: null,
    on_behalf_of_user_id: null,
    ...overrides,
  }
}

describe("computeChatAlerts — DM unread", () => {
  it("alerts on an unread DM, naming the OTHER party", () => {
    const t = thread({ id: "t-dm", thread_type: "dm", unread_count: 2, mention_count: 0 })
    const alerts = computeChatAlerts([t], [], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_dm")
    expect(alerts[0].title).toBe("Luca sent you a message")
  })

  it("zero prior read history (unread_count reflecting the whole thread, never read before) still alerts", () => {
    // A brand-new DM thread with no internal_thread_reads row at all — the RPC's
    // COALESCE(last_read_at, '-infinity') makes every message unread, which is
    // exactly what unread_count already reflects here.
    const t = thread({ id: "t-dm-new", thread_type: "dm", unread_count: 5, mention_count: 0 })
    const alerts = computeChatAlerts([t], [], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].thread_id).toBe("t-dm-new")
  })

  it("no alert when unread_count is 0", () => {
    const t = thread({ thread_type: "dm", unread_count: 0 })
    expect(computeChatAlerts([t], [], [], MEMBERS, ANTONIO)).toHaveLength(0)
  })
})

describe("computeChatAlerts — mentions win priority", () => {
  it("a thread with BOTH a mention and plain unread shows only the mention", () => {
    const t = thread({ id: "t-dm", thread_type: "dm", unread_count: 3, mention_count: 1 })
    const alerts = computeChatAlerts([t], [], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_mention")
  })

  it("mention in a channel names the channel", () => {
    const t = thread({
      id: "t-chan", thread_type: "channel", channel_name: "bugs", mention_count: 1,
      last_sender_name: "Luca", last_message: "@Antonio can you check this",
    })
    const alerts = computeChatAlerts([t], [], [], MEMBERS, ANTONIO)
    expect(alerts[0].title).toBe("Luca mentioned you in #bugs")
  })

  it("mention in a client conversation (discussion) still alerts — the one way in per conversationNotifiesParticipants", () => {
    const t = thread({ id: "t-disc", thread_type: "discussion", mention_count: 1, last_sender_name: "Luca" })
    const alerts = computeChatAlerts([t], [], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_mention")
  })
})

describe("computeChatAlerts — client conversations stay silent otherwise", () => {
  it("a discussion thread with plain unread (no mention) produces NO alert — conversationNotifiesParticipants() is false", () => {
    const t = thread({ id: "t-disc", thread_type: "discussion", unread_count: 4, mention_count: 0 })
    expect(computeChatAlerts([t], [], [], MEMBERS, ANTONIO)).toHaveLength(0)
  })
})

describe("computeChatAlerts — channel plain messages (the RPC's own unread_count is NOT used here)", () => {
  it("a plain channel post (never promoted to a Threads-panel item) still alerts via the raw-message path", () => {
    const t = thread({
      id: "t-chan", thread_type: "channel", channel_name: "general-work",
      unread_count: 0, mention_count: 0, // exactly what the RPC gives an un-promoted post
    })
    const msg = chanMsg({ thread_id: "t-chan" })
    const alerts = computeChatAlerts([t], [msg], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_channel")
    expect(alerts[0].title).toBe("Luca posted in #general-work")
  })

  it("the muted worker-bug channel never alerts even with fresh activity", () => {
    const t = thread({ id: "t-bug", thread_type: "channel", channel_slug: "td-worker-bug" })
    const msg = chanMsg({ thread_id: "t-bug" })
    expect(computeChatAlerts([t], [msg], [], MEMBERS, ANTONIO)).toHaveLength(0)
  })

  it("general room uses the same raw-message path as a named channel", () => {
    const t = thread({ id: "t-general", thread_type: "general", channel_name: null, channel_slug: null })
    const msg = chanMsg({ thread_id: "t-general" })
    const alerts = computeChatAlerts([t], [msg], [], MEMBERS, ANTONIO)
    expect(alerts[0].title).toBe("Luca posted in #general")
  })

  it("no channel alert when nothing is newer than my read pointer", () => {
    const t = thread({ id: "t-chan", thread_type: "channel", channel_name: "bugs" })
    const msg = chanMsg({ thread_id: "t-chan", created_at: "2026-09-01T09:00:00.000Z" })
    const reads: ThreadReadPointer[] = [{ thread_id: "t-chan", last_read_at: "2026-09-02T00:00:00.000Z" }]
    expect(computeChatAlerts([t], [msg], reads, MEMBERS, ANTONIO)).toHaveLength(0)
  })
})

describe("latestChannelActivity — skip rules mirror the realtime toast exactly", () => {
  it("skips my own message", () => {
    const map = latestChannelActivity([chanMsg({ sender_id: ANTONIO })], [], ANTONIO)
    expect(map.size).toBe(0)
  })

  it("skips a message I dictated on-behalf-of, even sent by the Claude sentinel (wrong-recipient / on-behalf-of case)", () => {
    const map = latestChannelActivity(
      [chanMsg({ sender_id: "claude-sentinel", on_behalf_of_user_id: ANTONIO })],
      [],
      ANTONIO,
    )
    expect(map.size).toBe(0)
  })

  it("does NOT skip a message dictated on behalf of someone else", () => {
    const map = latestChannelActivity(
      [chanMsg({ sender_id: "claude-sentinel", on_behalf_of_user_id: LUCA, thread_id: "t-x" })],
      [],
      ANTONIO,
    )
    expect(map.get("t-x")).toBeDefined()
  })

  it("skips a deleted message", () => {
    const map = latestChannelActivity([chanMsg({ deleted_at: "2026-09-04T11:00:00.000Z" })], [], ANTONIO)
    expect(map.size).toBe(0)
  })

  it("skips a pending placeholder body", () => {
    const map = latestChannelActivity([chanMsg({ message: "…" })], [], ANTONIO)
    expect(map.size).toBe(0)
  })

  it("an edit that lands after my last read resurfaces the thread even though created_at is old", () => {
    const old = chanMsg({
      thread_id: "t-edit",
      created_at: "2026-09-01T09:00:00.000Z",
      edited_at: "2026-09-04T12:00:00.000Z",
    })
    const reads: ThreadReadPointer[] = [{ thread_id: "t-edit", last_read_at: "2026-09-02T00:00:00.000Z" }]
    const map = latestChannelActivity([old], reads, ANTONIO)
    expect(map.get("t-edit")).toBeDefined()
  })

  it("picks the latest qualifying message per thread when several are candidates", () => {
    const earlier = chanMsg({ thread_id: "t-x", message: "first", created_at: "2026-09-04T09:00:00.000Z" })
    const later = chanMsg({ thread_id: "t-x", message: "second", created_at: "2026-09-04T10:00:00.000Z" })
    const map = latestChannelActivity([earlier, later], [], ANTONIO)
    expect(map.get("t-x")?.message).toBe("second")
  })
})
