import { describe, it, expect } from "vitest"
import { GROUP_TITLE_MAX, MAX_GROUP_MEMBERS, checkGroup, dmKey, parseMentions, sortThreads, threadPush, threadRecipients, threadTitle, threadUrlFor } from "@/lib/marketing/team-chat"

const people = [{ id: "u-rocco", name: "Rocco" }, { id: "u-cri", name: "Cristina" }, { id: "u-ale", name: "Ale" }, { id: "u-maria", name: "Maria" }, { id: "u-mr", name: "Maria Rosa" }]

describe("direct message key", () => {
  it("is the same whoever starts the chat", () => {
    expect(dmKey("b", "a")).toBe(dmKey("a", "b"))
    expect(dmKey("a", "b")).toBe("a:b")
  })
})

describe("a new group", () => {
  const allowed = new Set(["me", "u1", "u2"])
  it("needs a name and at least one other person; the creator is in once, first", () => {
    expect(checkGroup({ title: "Hot leads", memberIds: ["u1", "u2", "u1", "me"], creatorId: "me", allowed })).toEqual({ ok: true, title: "Hot leads", memberIds: ["me", "u1", "u2"] })
    expect(checkGroup({ title: "  ", memberIds: ["u1"], creatorId: "me", allowed })).toMatchObject({ ok: false })
    expect(checkGroup({ title: "x", memberIds: [], creatorId: "me", allowed })).toMatchObject({ ok: false })
    expect(checkGroup({ title: "x", memberIds: ["me"], creatorId: "me", allowed })).toMatchObject({ ok: false })
    expect(checkGroup({ title: "x", memberIds: "u1", creatorId: "me", allowed })).toMatchObject({ ok: false })
  })
  it("trims and tidies the name, refuses a long one and a person who cannot use the chat", () => {
    expect(checkGroup({ title: "  Hot   leads  ", memberIds: ["u1"], creatorId: "me", allowed })).toMatchObject({ ok: true, title: "Hot leads" })
    expect(checkGroup({ title: "x".repeat(GROUP_TITLE_MAX + 1), memberIds: ["u1"], creatorId: "me", allowed })).toMatchObject({ ok: false })
    expect(checkGroup({ title: "x", memberIds: ["u1", "stranger"], creatorId: "me", allowed })).toMatchObject({ ok: false })
  })
  it("has a size limit", () => {
    const many = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, i) => `p${i}`)
    expect(checkGroup({ title: "x", memberIds: many, creatorId: "me", allowed: new Set(["me", ...many]) })).toMatchObject({ ok: false })
  })
})

describe("@mentions", () => {
  it("finds the people named after an @, once each, never the sender", () => {
    expect(parseMentions("@Cristina can you call Elena?", people, "u-rocco")).toEqual(["u-cri"])
    expect(parseMentions("@Rocco @Ale and @rocco again", people, "u-cri").sort()).toEqual(["u-ale", "u-rocco"])
    expect(parseMentions("@Rocco hi", people, "u-rocco")).toEqual([])
  })
  it("needs the @ and a whole word: an email, a part of a longer word or a missing @ is not a mention", () => {
    expect(parseMentions("write to rocco@example.com", people, "u-cri")).toEqual([])
    expect(parseMentions("@Roccos is not Rocco", people, "u-cri")).toEqual([])
    expect(parseMentions("hello Rocco", people, "u-cri")).toEqual([])
    expect(parseMentions("(@Ale) ok", people, "u-cri")).toEqual(["u-ale"])
    expect(parseMentions("@Ale, @Ale.", people, "u-cri")).toEqual(["u-ale"])
  })
  it("a longer name wins over a shorter one inside it", () => {
    expect(parseMentions("@Maria Rosa please", people, "u-cri")).toEqual(["u-mr"])
    expect(parseMentions("@Maria please", people, "u-cri")).toEqual(["u-maria"])
    expect(parseMentions("@Maria and @Maria Rosa", people, "u-cri").sort()).toEqual(["u-maria", "u-mr"])
  })
  it("names with accents and special characters are matched literally", () => {
    expect(parseMentions("@José (x) ok", [{ id: "j", name: "José (x)" }], "o")).toEqual(["j"])
    expect(parseMentions("@Zoë!", [{ id: "z", name: "Zoë" }], "o")).toEqual(["z"])
  })
})

describe("notifications and the list", () => {
  it("every other active member is told", () => {
    const m = [{ user_id: "a" }, { user_id: "b" }, { user_id: "c", status: "paused" }, { user_id: "d", status: "removed" }, { user_id: "e", status: "active" }]
    expect(threadRecipients(m, "a")).toEqual(["b", "e"])
  })
  it("a direct message shows the other person, a group its own name", () => {
    const nameOf = (id: string) => ({ a: "Anna", b: "Bruno" } as Record<string, string>)[id]
    expect(threadTitle({ kind: "dm", title: null, memberIds: ["a", "b"] }, "a", nameOf)).toBe("Bruno")
    expect(threadTitle({ kind: "group", title: "Hot leads", memberIds: ["a", "b"] }, "a", nameOf)).toBe("Hot leads")
    expect(threadTitle({ kind: "dm", title: null, memberIds: ["a", "z"] }, "a", nameOf)).toBe("Chat")
  })
  it("the list puts what is new first, then the newest", () => {
    const r = sortThreads([{ id: "old", unread: 0, lastAt: "2026-10-01" }, { id: "new", unread: 0, lastAt: "2026-10-05" }, { id: "unread", unread: 2, lastAt: "2026-09-01" }, { id: "empty", unread: 0, lastAt: null }])
    expect(r.map(x => x.id)).toEqual(["unread", "new", "old", "empty"])
  })
  it("the notification says who wrote where, or that you were mentioned", () => {
    expect(threadPush({ senderName: "Rocco", threadTitle: "Cristina", kind: "dm", mentioned: false, preview: "hi" })).toEqual({ title: "Rocco", body: "hi" })
    expect(threadPush({ senderName: "Rocco", threadTitle: "Hot leads", kind: "group", mentioned: false, preview: "hi" })).toEqual({ title: "Rocco · Hot leads", body: "hi" })
    expect(threadPush({ senderName: "Rocco", threadTitle: "Marco Bianchi", kind: "lead", mentioned: true, preview: "@Cristina call" })).toEqual({ title: "Rocco mentioned you · Marco Bianchi", body: "@Cristina call" })
    // a mention in a direct message has no "place" to name (the place would be the reader herself)
    expect(threadPush({ senderName: "Rocco", threadTitle: "", kind: "dm", mentioned: true, preview: "@Cristina call" })).toEqual({ title: "Rocco mentioned you", body: "@Cristina call" })
    expect(threadPush({ senderName: "Rocco", threadTitle: "", kind: "group", mentioned: false, preview: "hi" })).toEqual({ title: "Rocco", body: "hi" })
    expect(threadUrlFor("t1")).toBe("/marketing/chat?thread=t1")
  })
})

import { splitMentions } from "@/lib/talk/chat-model"
describe("highlighting @names in a message", () => {
  const join = (p: Array<{ text: string; mention?: boolean }>) => p.map(x => (x.mention ? `[${x.text}]` : x.text)).join("")
  it("marks the names the chat knows after an @; the rest is left as it was", () => {
    expect(join(splitMentions("Hi @Cristina and @Rocco, ok?", ["Cristina", "Rocco"]))).toBe("Hi [@Cristina] and [@Rocco], ok?")
    expect(join(splitMentions("write to rocco@x.com", ["Rocco"]))).toBe("write to rocco@x.com")
    expect(join(splitMentions("@Roccos no", ["Rocco"]))).toBe("@Roccos no")
  })
  it("TD Talk passes no names and gets the text back whole; a text with no @ is returned whole", () => {
    expect(splitMentions("Hi @Cristina", [])).toEqual([{ text: "Hi @Cristina" }])
    expect(splitMentions("no mention", ["Rocco"])).toEqual([{ text: "no mention" }])
  })
  it("a longer name wins; names with spaces and accents work", () => {
    expect(join(splitMentions("@Maria Rosa and @Maria", ["Maria", "Maria Rosa"]))).toBe("[@Maria Rosa] and [@Maria]")
    expect(join(splitMentions("@Qa Cl Settera ok, @Zoë!", ["Qa Cl Settera", "Zoë"]))).toBe("[@Qa Cl Settera] ok, [@Zoë]!")
  })
})
