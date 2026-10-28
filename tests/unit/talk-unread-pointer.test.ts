import { describe, expect, it } from "vitest"
import { pointerBefore } from "@/lib/talk/unread-pointer"
import { clampReadsToVisible, unreadCount } from "@/lib/marketing/lead-chat"

const M = (id: string, at: string, from = "other") => ({ id, sender_id: from, created_at: at, deleted_at: null })

describe("Mark unread: my read position moves back to just before the message", () => {
  const msgs = [M("a", "2026-10-28T10:00:00.100000+00:00"), M("b", "2026-10-28T10:05:00.500000+00:00"), M("c", "2026-10-28T10:09:00.000000+00:00")]
  it("the chosen message and everything newer from others become unread again for me", () => {
    const pos = pointerBefore(msgs[1].created_at, "2026-10-28T10:30:00.000Z")
    expect(unreadCount(msgs, "me", pos)).toBe(2)
    expect(unreadCount(msgs, "me", pointerBefore(msgs[2].created_at, "2026-10-28T10:30:00.000Z"))).toBe(1)
    expect(unreadCount(msgs, "me", pointerBefore(msgs[0].created_at, "2026-10-28T10:30:00.000Z"))).toBe(3)
  })
  it("never moves forward: older unread messages stay unread", () => {
    const already = "2026-10-28T10:02:00.000Z"
    expect(pointerBefore(msgs[2].created_at, already)).toBe(already)
    expect(unreadCount(msgs, "me", pointerBefore(msgs[2].created_at, already))).toBe(2)
  })
  it("with no read position yet, it is just before the message", () => {
    expect(pointerBefore("2026-10-28T10:05:00.500Z", null)).toBe("2026-10-28T10:05:00.499Z")
  })
  it("my own messages are never counted as unread for me", () => {
    const mine = [M("a", "2026-10-28T10:00:00Z", "me"), M("b", "2026-10-28T10:05:00Z")]
    expect(unreadCount(mine, "me", pointerBefore(mine[0].created_at, null))).toBe(1)
  })
})


describe("a setter is never told the exact time of a message she cannot see (Mark unread puts a read position 1 ms before a message)", () => {
  const visible = ["2026-10-28T10:00:00.000Z", "2026-10-28T10:20:00.000Z"]
  it("cuts each read position back to her newest visible message not newer than it", () => {
    const hiddenAt = "2026-10-28T10:05:00.500Z"
    const out = clampReadsToVisible([{ user_id: "antonio", last_read_at: pointerBefore(hiddenAt, null) }], visible)
    expect(out[0].last_read_at).toBe("2026-10-28T10:00:00.000Z")
    expect(out[0].last_read_at).not.toContain("10:05")
  })
  it("her ticks come out exactly the same: a visible message is 'read' when the position reaches it, before and after the cut", () => {
    const reads = [{ user_id: "a", last_read_at: "2026-10-28T10:21:00.000Z" }, { user_id: "b", last_read_at: "2026-10-28T10:10:00.000Z" }, { user_id: "c", last_read_at: "2026-10-28T09:00:00.000Z" }]
    const cut = clampReadsToVisible(reads, visible)
    for (const v of visible) reads.forEach((r, i) => expect(new Date(cut[i].last_read_at) >= new Date(v)).toBe(new Date(r.last_read_at) >= new Date(v)))
  })
  it("a position before every visible message becomes the oldest possible time, not a real time", () => {
    expect(clampReadsToVisible([{ user_id: "x", last_read_at: "2026-10-28T08:00:00.000Z" }], visible)[0].last_read_at).toBe(new Date(0).toISOString())
  })
})
