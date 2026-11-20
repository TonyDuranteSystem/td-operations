import { describe, it, expect } from "vitest"
import { parseGowaEvent, normalizeBackfillItem, groupJidOf } from "@/lib/messaging/wabridge"
import { parseGroupsBatch } from "@/lib/messaging/wabridge-groups"

const NOW = new Date("2026-11-19T21:00:00Z")
const GROUP = "120363432541591903@g.us"
const msg = (over: Record<string, unknown> = {}) => ({
  event: "message",
  device_id: "393331112222:5@s.whatsapp.net",
  payload: {
    id: "ABC123", chat_id: GROUP, from: "393339980702:7@s.whatsapp.net", from_name: "Mario",
    timestamp: "2026-11-19T20:59:00Z", is_from_me: false, body: "Hello all", ...over,
  },
})

describe("groupJidOf", () => {
  it("accepts a group id and rejects everything else", () => {
    expect(groupJidOf(GROUP)).toBe(GROUP)
    expect(groupJidOf("393339980702@s.whatsapp.net")).toBeNull()
    expect(groupJidOf("status@broadcast")).toBeNull()
    expect(groupJidOf(null)).toBeNull()
    expect(groupJidOf("123@g.us")).toBeNull() // too short to be a real group id
  })
})

describe("parseGowaEvent — groups", () => {
  it("saves a group message keyed by the group id, with the participant as the sender", () => {
    const r = parseGowaEvent(msg(), NOW)
    expect(r.action).toBe("ingest")
    if (r.action !== "ingest") return
    expect(r.message.remoteDigits).toBe(GROUP)
    expect(r.message.isGroup).toBe(true)
    expect(r.message.senderDigits).toBe("393339980702")
    expect(r.message.senderName).toBe("Mario")
    expect(r.message.direction).toBe("inbound")
    expect(r.message.metadata.group).toBe(true)
  })
  it("a message typed on the phone in a group is outbound with no sender", () => {
    const r = parseGowaEvent(msg({ is_from_me: true }), NOW)
    expect(r.action).toBe("ingest")
    if (r.action !== "ingest") return
    expect(r.message.direction).toBe("outbound")
    expect(r.message.senderDigits).toBeNull()
  })
  it("a participant hidden behind a linked id has no number but the message is still kept", () => {
    const r = parseGowaEvent(msg({ from: "999999999999999@lid" }), NOW)
    expect(r.action).toBe("ingest")
    if (r.action !== "ingest") return
    expect(r.message.senderDigits).toBeNull()
  })
  it("one-to-one chats are unchanged", () => {
    const r = parseGowaEvent(msg({ chat_id: "393339980702@s.whatsapp.net" }), NOW)
    expect(r.action).toBe("ingest")
    if (r.action !== "ingest") return
    expect(r.message.isGroup).toBeUndefined()
    expect(r.message.remoteDigits).toBe("393339980702")
  })
  it("status, newsletters and unknown ids are still dropped", () => {
    expect(parseGowaEvent(msg({ chat_id: "status@broadcast" }), NOW).action).toBe("ignore")
    expect(parseGowaEvent(msg({ chat_id: "120363@newsletter" }), NOW).action).toBe("ignore")
  })
})

describe("normalizeBackfillItem — groups", () => {
  it("keeps a group history row, never using the group name as a person's name", () => {
    const m = normalizeBackfillItem({ id: "H1", chat: GROUP, sender: "393339980702", from_me: false, ts: "2026-11-18T10:00:00Z", text: "hi", chat_name: "2026 T Durante and SHU", sender_name: "Mario" }, NOW)
    expect(m?.isGroup).toBe(true)
    expect(m?.remoteDigits).toBe(GROUP)
    expect(m?.senderDigits).toBe("393339980702")
    expect(m?.senderName).toBe("Mario")
  })
  it("still rejects junk chat ids", () => {
    expect(normalizeBackfillItem({ id: "H2", chat: "not-a-chat", text: "x" }, NOW)).toBeNull()
  })
})

describe("parseGroupsBatch", () => {
  const ts = NOW.getTime()
  it("keeps valid groups, trims names, drops junk and duplicates", () => {
    const r = parseGroupsBatch({ ts, groups: [{ jid: GROUP, name: "  Team  " }, { jid: GROUP, name: "dup" }, { jid: "x@s.whatsapp.net", name: "no" }, { jid: "120363430864874174@g.us" }] }, NOW)
    expect("groups" in r && r.groups).toEqual([{ jid: GROUP, name: "Team" }, { jid: "120363430864874174@g.us", name: null }])
  })
  it("refuses a stale or malformed batch", () => {
    expect("error" in parseGroupsBatch({ ts: ts - 3_600_000, groups: [] }, NOW)).toBe(true)
    expect("error" in parseGroupsBatch({ ts, groups: "nope" }, NOW)).toBe(true)
    expect("error" in parseGroupsBatch(null, NOW)).toBe(true)
  })
})
