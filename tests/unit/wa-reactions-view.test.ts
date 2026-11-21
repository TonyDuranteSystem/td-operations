import { describe, it, expect } from "vitest"
import { splitReactions } from "@/lib/messaging/wa-reactions-view"

const staff = (emoji: string, id = "u1", name: string | null = "Luca") => ({ emoji, reactor_id: id, reactor_type: "staff", reactor_name: name })
const phone = (side: string, emoji: string) => ({ emoji, reactor_id: `wa-${side}`, reactor_type: side, reactor_name: null, source: "phone" })

describe("splitReactions", () => {
  it("returns nothing for missing / non-array input", () => {
    for (const v of [null, undefined, "x", 5, {}]) expect(splitReactions(v)).toEqual({ staff: [], phone: [] })
  })

  it("groups staff marks by emoji and keeps the phone's two sides apart", () => {
    const v = splitReactions([staff("👍"), staff("👍", "u2", "Antonio"), phone("client", "❤️"), phone("line", "🙏")])
    expect(v.staff).toEqual([{ emoji: "👍", count: 2, names: ["Luca", "Antonio"], mine: false }])
    expect(v.phone).toEqual([{ emoji: "❤️", side: "client", key: "client", name: null, member: false }, { emoji: "🙏", side: "line", key: "line", name: null, member: false }])
  })

  it("never draws a removal tombstone (empty emoji)", () => {
    const v = splitReactions([phone("client", ""), staff("👍")])
    expect(v.phone).toEqual([])
    expect(v.staff).toHaveLength(1)
  })

  it("treats an old row with no type as a staff mark", () => {
    expect(splitReactions([{ emoji: "🔥", reactor_id: "u9" }]).staff[0]).toMatchObject({ emoji: "🔥", count: 1, names: [] })
  })

  it("marks the viewer's own pill", () => {
    expect(splitReactions([staff("👍", "me")], "me").staff[0].mine).toBe(true)
    expect(splitReactions([staff("👍", "other")], "me").staff[0].mine).toBe(false)
  })

  it("skips junk rows and a duplicated side", () => {
    const v = splitReactions([null, 7, { emoji: 5 }, phone("client", "❤️"), phone("client", "😂")])
    expect(v.phone).toEqual([{ emoji: "❤️", side: "client", key: "client", name: null, member: false }])
    expect(v.staff).toEqual([])
  })
})

describe("splitReactions — a WhatsApp group", () => {
  const member = (id: string, emoji: string, name: string | null) => ({ emoji, reactor_type: "client", reactor_id: `wa-client:${id}`, reactor_name: name })
  it("draws one pill per member (not one per side), with the member's name, and still one for the business phone", () => {
    const v = splitReactions([member("111111", "👍", "Mario Rossi"), member("222222", "👍", null), { emoji: "🙏", reactor_type: "line", reactor_id: "wa-line", reactor_name: null }])
    expect(v.phone).toEqual([
      { emoji: "👍", side: "client", key: "wa-client:111111", name: "Mario Rossi", member: true },
      { emoji: "👍", side: "client", key: "wa-client:222222", name: null, member: true },
      { emoji: "🙏", side: "line", key: "line", name: null, member: false },
    ])
  })
  it("a repeated row for the same member is drawn once", () => {
    expect(splitReactions([member("111111", "👍", "A"), member("111111", "❤️", "A")]).phone.length).toBe(1)
  })
})

