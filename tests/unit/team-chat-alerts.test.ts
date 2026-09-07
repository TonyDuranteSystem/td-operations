/**
 * Staff Alerts — chat half. computeChatAlerts reads get_team_threads rows (trusted
 * as-is for dm unread only) plus raw channel/mention messages (NOT trusted from
 * the RPC — its channel unread_count means "Threads-panel bugs with new activity,"
 * not "new message," and its mention preview is the thread's overall latest
 * message, not necessarily the mentioning one — both verified against the live
 * function 2026-09-04, and against a documented product decision that general is
 * mention-only, matching app/api/team/notifications/route.ts).
 */
import { describe, it, expect } from "vitest"
import {
  computeChatAlerts,
  latestQualifyingActivity,
  earliestPossibleUnreadMs,
  type ChatThreadForAlerts,
  type RawMessageForAlerts,
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
    last_message: "hey",
    last_message_at: "2026-09-04T10:00:00.000Z",
    last_sender_name: "Luca",
    ...overrides,
  }
}

function msg(overrides: Partial<RawMessageForAlerts> = {}): RawMessageForAlerts {
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

/** compute with no channel/mention activity, for the pure DM-only cases. */
function computeSimple(threads: ChatThreadForAlerts[]) {
  return computeChatAlerts(threads, [], [], [], MEMBERS, ANTONIO)
}

describe("computeChatAlerts — DM unread", () => {
  it("alerts on an unread DM, naming the OTHER party", () => {
    const t = thread({ id: "t-dm", thread_type: "dm", unread_count: 2 })
    const alerts = computeSimple([t])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_dm")
    expect(alerts[0].title).toBe("Luca sent you a message")
  })

  it("zero prior read history (unread_count reflecting the whole thread, never read before) still alerts", () => {
    const t = thread({ id: "t-dm-new", thread_type: "dm", unread_count: 5 })
    const alerts = computeSimple([t])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].thread_id).toBe("t-dm-new")
  })

  it("no alert when unread_count is 0", () => {
    const t = thread({ thread_type: "dm", unread_count: 0 })
    expect(computeSimple([t])).toHaveLength(0)
  })

  it("more than one unread DM message says '+N more'", () => {
    const t = thread({ id: "t-dm", thread_type: "dm", unread_count: 3, last_message: "third one" })
    const alerts = computeSimple([t])
    expect(alerts[0].body).toBe("third one (+2 more)")
  })
})

describe("computeChatAlerts — mentions win priority and carry the RIGHT content", () => {
  it("uses the ACTUAL mentioning message, not the thread's unrelated latest message", () => {
    // Regression: get_team_threads' last_message/last_sender_name is the
    // thread's overall latest row, independent of mention_count — an unrelated
    // follow-up after the mention must not overwrite what the alert shows.
    const t = thread({
      id: "t-dm", thread_type: "dm", unread_count: 2,
      last_message: "never mind, fixed it myself", last_sender_name: "Luca", last_message_at: "2026-09-04T11:00:00.000Z",
    })
    const mention = msg({ thread_id: "t-dm", message: "@Antonio can you check this bug", created_at: "2026-09-04T10:00:00.000Z" })
    const alerts = computeChatAlerts([t], [], [mention], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_mention")
    expect(alerts[0].body).toBe("@Antonio can you check this bug")
    expect(alerts[0].created_at).toBe("2026-09-04T10:00:00.000Z")
  })

  it("a thread with BOTH a mention and plain DM unread shows only the mention", () => {
    const t = thread({ id: "t-dm", thread_type: "dm", unread_count: 3 })
    const mention = msg({ thread_id: "t-dm", message: "@Antonio ping" })
    const alerts = computeChatAlerts([t], [], [mention], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_mention")
  })

  it("mention in a channel names the channel", () => {
    const t = thread({ id: "t-chan", thread_type: "channel", channel_name: "bugs" })
    const mention = msg({ thread_id: "t-chan", sender_name: "Luca", message: "@Antonio can you check this" })
    const alerts = computeChatAlerts([t], [], [mention], [], MEMBERS, ANTONIO)
    expect(alerts[0].title).toBe("Luca mentioned you in #bugs")
  })

  it("mention in general still alerts, even though plain general chatter never does", () => {
    const t = thread({ id: "t-general", thread_type: "general", channel_name: null, channel_slug: null })
    const mention = msg({ thread_id: "t-general", sender_name: "Luca", message: "@Antonio look at this" })
    const alerts = computeChatAlerts([t], [], [mention], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_mention")
    expect(alerts[0].title).toBe("Luca mentioned you in #general")
  })

  it("mention in a client conversation (discussion) still alerts — the one way in per conversationNotifiesParticipants", () => {
    const t = thread({ id: "t-disc", thread_type: "discussion" })
    const mention = msg({ thread_id: "t-disc", sender_name: "Luca", message: "@Antonio the client asked about X" })
    const alerts = computeChatAlerts([t], [], [mention], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_mention")
  })

  it("more than one unread mention in the same thread says '+N more'", () => {
    const t = thread({ id: "t-chan", thread_type: "channel", channel_name: "bugs" })
    const m1 = msg({ thread_id: "t-chan", message: "@Antonio first", created_at: "2026-09-04T09:00:00.000Z" })
    const m2 = msg({ thread_id: "t-chan", message: "@Antonio second", created_at: "2026-09-04T10:00:00.000Z" })
    const alerts = computeChatAlerts([t], [], [m1, m2], [], MEMBERS, ANTONIO)
    expect(alerts[0].body).toBe("@Antonio second (+1 more)")
  })
})

describe("computeChatAlerts — client conversations stay silent otherwise", () => {
  it("a discussion thread with plain DM-shaped unread (no mention) produces NO alert", () => {
    // discussion never goes through the dm or channel branch at all.
    const t = thread({ id: "t-disc", thread_type: "discussion", unread_count: 4 })
    expect(computeSimple([t])).toHaveLength(0)
  })
})

describe("computeChatAlerts — general is mention-only", () => {
  it("a plain, un-promoted message in general produces NO alert", () => {
    const t = thread({ id: "t-general", thread_type: "general", channel_name: null, channel_slug: null })
    const plain = msg({ thread_id: "t-general", message: "just chatting" })
    // fed as "channel" activity on purpose — general must ignore it even if present.
    const alerts = computeChatAlerts([t], [plain], [], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(0)
  })
})

describe("computeChatAlerts — channel plain messages (the RPC's own unread_count is NOT used here)", () => {
  it("a plain channel post (never promoted to a Threads-panel item) still alerts via the raw-message path", () => {
    const t = thread({ id: "t-chan", thread_type: "channel", channel_name: "general-work", unread_count: 0 })
    const m = msg({ thread_id: "t-chan" })
    const alerts = computeChatAlerts([t], [m], [], [], MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("chat_channel")
    expect(alerts[0].title).toBe("Luca posted in #general-work")
  })

  it("the muted worker-bug channel never alerts even with fresh activity", () => {
    const t = thread({ id: "t-bug", thread_type: "channel", channel_slug: "td-worker-bug" })
    const m = msg({ thread_id: "t-bug" })
    expect(computeChatAlerts([t], [m], [], [], MEMBERS, ANTONIO)).toHaveLength(0)
  })

  it("no channel alert when nothing is newer than my read pointer", () => {
    const t = thread({ id: "t-chan", thread_type: "channel", channel_name: "bugs" })
    const m = msg({ thread_id: "t-chan", created_at: "2026-09-01T09:00:00.000Z" })
    const reads: ThreadReadPointer[] = [{ thread_id: "t-chan", last_read_at: "2026-09-02T00:00:00.000Z" }]
    expect(computeChatAlerts([t], [m], [], reads, MEMBERS, ANTONIO)).toHaveLength(0)
  })

  it("more than one unread channel message says '+N more'", () => {
    const t = thread({ id: "t-chan", thread_type: "channel", channel_name: "bugs" })
    const m1 = msg({ thread_id: "t-chan", message: "first", created_at: "2026-09-04T09:00:00.000Z" })
    const m2 = msg({ thread_id: "t-chan", message: "second", created_at: "2026-09-04T10:00:00.000Z" })
    const alerts = computeChatAlerts([t], [m1, m2], [], [], MEMBERS, ANTONIO)
    expect(alerts[0].body).toBe("second (+1 more)")
  })

  it("a manual 'Mark unread' with no new message still alerts, using the RPC's thread-level preview", () => {
    const t = thread({
      id: "t-chan", thread_type: "channel", channel_name: "bugs",
      last_message: "the last real message here", last_sender_name: "Luca",
    })
    const reads: ThreadReadPointer[] = [{ thread_id: "t-chan", last_read_at: "2026-09-04T09:00:00.000Z", manual_unread: true }]
    const alerts = computeChatAlerts([t], [], [], reads, MEMBERS, ANTONIO)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toBe("#bugs marked unread")
    expect(alerts[0].body).toBe("the last real message here")
  })

  it("manual_unread=false with no new message does NOT alert", () => {
    const t = thread({ id: "t-chan", thread_type: "channel", channel_name: "bugs" })
    const reads: ThreadReadPointer[] = [{ thread_id: "t-chan", last_read_at: "2026-09-04T09:00:00.000Z", manual_unread: false }]
    expect(computeChatAlerts([t], [], [], reads, MEMBERS, ANTONIO)).toHaveLength(0)
  })
})

describe("latestQualifyingActivity — skip rules mirror the realtime toast exactly", () => {
  it("skips my own message", () => {
    const map = latestQualifyingActivity([msg({ sender_id: ANTONIO })], [], ANTONIO)
    expect(map.size).toBe(0)
  })

  it("skips a message I dictated on-behalf-of, even sent by the Claude sentinel (wrong-recipient / on-behalf-of case)", () => {
    const map = latestQualifyingActivity(
      [msg({ sender_id: "claude-sentinel", on_behalf_of_user_id: ANTONIO })],
      [],
      ANTONIO,
    )
    expect(map.size).toBe(0)
  })

  it("does NOT skip a message dictated on behalf of someone else", () => {
    const map = latestQualifyingActivity(
      [msg({ sender_id: "claude-sentinel", on_behalf_of_user_id: LUCA, thread_id: "t-x" })],
      [],
      ANTONIO,
    )
    expect(map.get("t-x")).toBeDefined()
  })

  it("skips a deleted message", () => {
    const map = latestQualifyingActivity([msg({ deleted_at: "2026-09-04T11:00:00.000Z" })], [], ANTONIO)
    expect(map.size).toBe(0)
  })

  it("skips a pending placeholder body", () => {
    const map = latestQualifyingActivity([msg({ message: "…" })], [], ANTONIO)
    expect(map.size).toBe(0)
  })

  it("an edit that lands after my last read resurfaces the thread even though created_at is old", () => {
    const old = msg({
      thread_id: "t-edit",
      created_at: "2026-09-01T09:00:00.000Z",
      edited_at: "2026-09-04T12:00:00.000Z",
    })
    const reads: ThreadReadPointer[] = [{ thread_id: "t-edit", last_read_at: "2026-09-02T00:00:00.000Z" }]
    const map = latestQualifyingActivity([old], reads, ANTONIO)
    expect(map.get("t-edit")).toBeDefined()
  })

  it("picks the latest qualifying message per thread and counts every qualifying one", () => {
    const earlier = msg({ thread_id: "t-x", message: "first", created_at: "2026-09-04T09:00:00.000Z" })
    const later = msg({ thread_id: "t-x", message: "second", created_at: "2026-09-04T10:00:00.000Z" })
    const map = latestQualifyingActivity([earlier, later], [], ANTONIO)
    expect(map.get("t-x")?.latest.message).toBe("second")
    expect(map.get("t-x")?.count).toBe(2)
  })
})

describe("earliestPossibleUnreadMs", () => {
  it("returns the OLDEST read pointer among the given threads", () => {
    const reads: ThreadReadPointer[] = [
      { thread_id: "a", last_read_at: "2026-09-03T00:00:00.000Z" },
      { thread_id: "b", last_read_at: "2026-09-01T00:00:00.000Z" },
    ]
    expect(earliestPossibleUnreadMs(reads, ["a", "b"])).toBe(Date.parse("2026-09-01T00:00:00.000Z"))
  })

  it("returns null (no safe bound) if ANY of the given threads has never been read", () => {
    const reads: ThreadReadPointer[] = [{ thread_id: "a", last_read_at: "2026-09-03T00:00:00.000Z" }]
    expect(earliestPossibleUnreadMs(reads, ["a", "b"])).toBeNull()
  })

  it("returns null for an empty thread list", () => {
    expect(earliestPossibleUnreadMs([], [])).toBeNull()
  })
})
