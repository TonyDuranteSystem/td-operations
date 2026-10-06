import { describe, it, expect } from "vitest"
import {
  REPLY_DRAFT_MAX_AGE_MS,
  REPLY_DRAFT_MAX_HTML_CHARS,
  REPLY_DRAFT_VERSION,
  clearReplyDraft,
  describeStoredDraft,
  loadReplyDraft,
  replyDraftKey,
  saveReplyDraft,
  type DraftStorage,
  type ReplyDraftInput,
} from "../../lib/inbox/reply-draft-store"
import { DEFAULT_RICH_STYLE } from "../../lib/inbox/rich-text"

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const NOW = 1_800_000_000_000
const KEY = replyDraftKey("support", "gmail:abc")
const input = (over: Partial<ReplyDraftInput> = {}): ReplyDraftInput => ({
  html: "<p>Hi Michael, <strong>thanks</strong>.</p>",
  style: { ...DEFAULT_RICH_STYLE, font: "Georgia" },
  target: { messageId: "m1", sender: "Michael <michael@fresh-ops.com>", mode: "reply" },
  to: ["michael@fresh-ops.com"],
  quoteMode: "message",
  signatureVariant: "text",
  attachmentCount: 0,
  ...over,
})

describe("replyDraftKey", () => {
  it("is per mailbox and per conversation, and unknown mailboxes collapse to support", () => {
    expect(replyDraftKey("support", "gmail:a")).not.toBe(replyDraftKey("antonio", "gmail:a"))
    expect(replyDraftKey("support", "gmail:a")).not.toBe(replyDraftKey("support", "gmail:b"))
    expect(replyDraftKey(undefined, "gmail:a")).toBe(replyDraftKey("support", "gmail:a"))
    expect(replyDraftKey("whatever", "gmail:a")).toBe(replyDraftKey("support", "gmail:a"))
  })
})

describe("save + load round trip", () => {
  it("stores and returns the same reply, with the time it was saved", () => {
    const s = memory()
    expect(saveReplyDraft(s, KEY, input(), NOW)).toBe(true)
    const d = loadReplyDraft(s, KEY, NOW + 5 * 60_000)!
    expect(d.html).toBe("<p>Hi Michael, <strong>thanks</strong>.</p>")
    expect(d.style.font).toBe("Georgia")
    expect(d.target).toEqual({ messageId: "m1", sender: "Michael <michael@fresh-ops.com>", mode: "reply" })
    expect(d.to).toEqual(["michael@fresh-ops.com"])
    expect(d.quoteMode).toBe("message")
    expect(d.signatureVariant).toBe("text")
    expect(d.savedAt).toBe(NOW)
    expect(d.sendStartedAt).toBeUndefined()
  })
  it("keeps sendStartedAt when it was set", () => {
    const s = memory()
    saveReplyDraft(s, KEY, input({ sendStartedAt: NOW - 1000 }), NOW)
    expect(loadReplyDraft(s, KEY, NOW)!.sendStartedAt).toBe(NOW - 1000)
  })
  it("an empty reply removes the stored copy instead of storing nothing", () => {
    const s = memory()
    saveReplyDraft(s, KEY, input(), NOW)
    expect(s.data.has(KEY)).toBe(true)
    expect(saveReplyDraft(s, KEY, input({ html: "<p></p>" }), NOW + 1)).toBe(false)
    expect(s.data.has(KEY)).toBe(false)
  })
  it("a reply that is only an empty list item or invisible characters counts as empty", () => {
    const s = memory()
    expect(saveReplyDraft(s, KEY, input({ html: "<ul><li><p></p></li></ul>" }), NOW)).toBe(false)
    expect(saveReplyDraft(s, KEY, input({ html: "<p>​</p>" }), NOW)).toBe(false)
  })
  it("refuses to store an oversize body", () => {
    const s = memory()
    expect(saveReplyDraft(s, KEY, input({ html: "<p>" + "a".repeat(REPLY_DRAFT_MAX_HTML_CHARS) + "</p>" }), NOW)).toBe(false)
    expect(s.data.size).toBe(0)
  })
})

describe("never throws, whatever the storage does", () => {
  it("no storage at all", () => {
    expect(saveReplyDraft(null, KEY, input(), NOW)).toBe(false)
    expect(loadReplyDraft(null, KEY, NOW)).toBeNull()
    expect(() => clearReplyDraft(null, KEY)).not.toThrow()
  })
  it("a full or blocked storage (setItem / getItem / removeItem throw)", () => {
    const boom: DraftStorage = {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("QuotaExceededError") },
      removeItem: () => { throw new Error("blocked") },
    }
    expect(saveReplyDraft(boom, KEY, input(), NOW)).toBe(false)
    expect(loadReplyDraft(boom, KEY, NOW)).toBeNull()
    expect(() => clearReplyDraft(boom, KEY)).not.toThrow()
  })
})

describe("load re-validates everything (the storage is only a string anyone can edit)", () => {
  const put = (s: ReturnType<typeof memory>, v: unknown) => s.data.set(KEY, typeof v === "string" ? v : JSON.stringify(v))
  const good = () => ({ v: REPLY_DRAFT_VERSION, html: "<p>hello</p>", style: {}, target: null, to: [], quoteMode: "message", signatureVariant: "text", attachmentCount: 0, savedAt: NOW })

  it("drops (and removes) corrupt JSON, the wrong version, and non-objects", () => {
    for (const bad of ["{not json", JSON.stringify([1]), JSON.stringify("x"), JSON.stringify({ ...good(), v: 1 }), "null"]) {
      const s = memory()
      put(s, bad)
      expect(loadReplyDraft(s, KEY, NOW)).toBeNull()
      expect(s.data.has(KEY)).toBe(false)
    }
  })
  it("drops one older than 24 hours, and one dated in the future", () => {
    const s = memory()
    put(s, good())
    expect(loadReplyDraft(s, KEY, NOW + REPLY_DRAFT_MAX_AGE_MS - 1)).not.toBeNull()
    expect(loadReplyDraft(s, KEY, NOW + REPLY_DRAFT_MAX_AGE_MS + 1)).toBeNull()
    expect(s.data.has(KEY)).toBe(false)
    put(s, { ...good(), savedAt: NOW + 10 * 60_000 })
    expect(loadReplyDraft(s, KEY, NOW)).toBeNull()
  })
  it("drops a stored reply with no words, a non-string html, or an oversize one", () => {
    for (const bad of [{ ...good(), html: "<p></p>" }, { ...good(), html: 5 }, { ...good(), html: "<p>" + "a".repeat(REPLY_DRAFT_MAX_HTML_CHARS) + "</p>" }, { ...good(), savedAt: "yesterday" }]) {
      const s = memory()
      put(s, bad)
      expect(loadReplyDraft(s, KEY, NOW)).toBeNull()
    }
  })
  it("style goes through parseRichStyle: unknown values fall back to the default per field", () => {
    const s = memory()
    put(s, { ...good(), style: { font: "Comic Sans", size: "huge", line: "1000", para: "wide" } })
    expect(loadReplyDraft(s, KEY, NOW)!.style).toEqual({ ...DEFAULT_RICH_STYLE, size: "huge" })
  })
  it("recipients: only well-formed addresses survive, capped", () => {
    const s = memory()
    put(s, { ...good(), to: ["ok@x.com", "not an address", 5, "a@b", "<script>@x.com", ...Array.from({ length: 80 }, (_, i) => `u${i}@x.com`)] })
    const to = loadReplyDraft(s, KEY, NOW)!.to
    expect(to[0]).toBe("ok@x.com")
    expect(to).not.toContain("not an address")
    expect(to).not.toContain("a@b")
    expect(to.length).toBeLessThanOrEqual(50)
  })
  it("target: kept only when complete and of a known mode; unknown quote mode / signature fall back", () => {
    const s = memory()
    put(s, { ...good(), target: { messageId: "m", sender: "x <x@y.com>", mode: "reply" }, quoteMode: "everything", signatureVariant: "javascript:x" })
    let d = loadReplyDraft(s, KEY, NOW)!
    expect(d.target).toEqual({ messageId: "m", sender: "x <x@y.com>", mode: "reply" })
    expect(d.quoteMode).toBe("message")
    expect(d.signatureVariant).toBe("")
    for (const t of [{ messageId: "", sender: "s", mode: "reply" }, { messageId: "m", sender: "s", mode: "forward" }, { messageId: "m", mode: "reply" }, "x"]) {
      put(s, { ...good(), target: t })
      d = loadReplyDraft(s, KEY, NOW)!
      expect(d.target).toBeNull()
    }
  })
  it("attachment count is a small non-negative whole number", () => {
    const s = memory()
    for (const [raw, want] of [[3, 3], [-2, 0], [2.7, 2], [1e9, 99], ["2", 0], [null, 0]] as Array<[unknown, number]>) {
      put(s, { ...good(), attachmentCount: raw })
      expect(loadReplyDraft(s, KEY, NOW)!.attachmentCount).toBe(want)
    }
  })
  it("hostile html is returned as-is (the EDITOR's schema is what filters it) but never executed here", () => {
    const s = memory()
    put(s, { ...good(), html: '<p onclick="x()">hi</p><script>alert(1)</script>' })
    expect(loadReplyDraft(s, KEY, NOW)!.html).toContain("hi")
  })
})

describe("describeStoredDraft", () => {
  const base = (over: object = {}) => ({ ...(JSON.parse(JSON.stringify(input())) as ReplyDraftInput), v: REPLY_DRAFT_VERSION as 2, savedAt: NOW, ...over })
  it("says how long ago, in plain words", () => {
    expect(describeStoredDraft(base(), NOW + 10_000)).toContain("a moment ago")
    expect(describeStoredDraft(base(), NOW + 12 * 60_000)).toContain("12 min ago")
    expect(describeStoredDraft(base(), NOW + 3 * 3_600_000)).toContain("3 h ago")
  })
  it("warns that a send may have gone out", () => {
    const t = describeStoredDraft(base({ sendStartedAt: NOW }), NOW + 60_000)
    expect(t).toContain("may or may not have gone out")
    expect(t).toContain("Check Sent")
  })
  it("tells the person to re-attach files", () => {
    expect(describeStoredDraft(base({ attachmentCount: 1 }), NOW)).toContain("Re-attach the 1 file ")
    expect(describeStoredDraft(base({ attachmentCount: 3 }), NOW)).toContain("Re-attach the 3 files")
    expect(describeStoredDraft(base({ attachmentCount: 0 }), NOW)).not.toContain("Re-attach")
  })
})
