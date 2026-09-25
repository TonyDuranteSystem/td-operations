import { describe, it, expect } from "vitest"
import { createHmac } from "crypto"
import { isFreshTs, normalizeBackfillItem, parseGowaEvent, userDigitsFromJid, verifyGowaSignature } from "@/lib/messaging/wabridge"

const NOW = new Date("2026-09-24T18:00:00Z")
const OWNER = "17274521093@s.whatsapp.net"

const msg = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: "message",
  device_id: OWNER,
  payload: {
    id: "3EB0AAAA",
    chat_id: "393331234567@s.whatsapp.net",
    from: "393331234567@s.whatsapp.net",
    timestamp: "2026-09-24T17:59:00Z",
    is_from_me: false,
    body: "Ciao",
    ...payload,
  },
  ...extra,
})

const ingest = (b: unknown) => {
  const r = parseGowaEvent(b, NOW)
  if (r.action !== "ingest") throw new Error("expected ingest, got ignore: " + r.reason)
  return r.message
}
const ignored = (b: unknown) => {
  const r = parseGowaEvent(b, NOW)
  if (r.action !== "ignore") throw new Error("expected ignore")
  return r.reason
}

describe("verifyGowaSignature", () => {
  const secret = "s3cret"
  const body = '{"event":"message"}'
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex")

  it("accepts a correct signature", () => expect(verifyGowaSignature(body, good, secret)).toBe(true))
  it("accepts the bare hex form", () => expect(verifyGowaSignature(body, good.slice(7), secret)).toBe(true))
  it("rejects a signature made with another secret", () => {
    const bad = "sha256=" + createHmac("sha256", "other").update(body).digest("hex")
    expect(verifyGowaSignature(body, bad, secret)).toBe(false)
  })
  it("rejects a tampered body", () => expect(verifyGowaSignature(body + " ", good, secret)).toBe(false))
  it("rejects missing header, empty secret, junk and wrong-length values", () => {
    expect(verifyGowaSignature(body, null, secret)).toBe(false)
    expect(verifyGowaSignature(body, good, "")).toBe(false)
    expect(verifyGowaSignature(body, "sha256=zzzz", secret)).toBe(false)
    expect(verifyGowaSignature(body, "sha256=abcd", secret)).toBe(false)
  })
})

describe("userDigitsFromJid", () => {
  it("extracts digits from user JIDs, dropping a device suffix", () => {
    expect(userDigitsFromJid("393331234567@s.whatsapp.net")).toBe("393331234567")
    expect(userDigitsFromJid("393331234567:12@s.whatsapp.net")).toBe("393331234567")
    expect(userDigitsFromJid("393331234567@c.us")).toBe("393331234567")
  })
  it("returns null for everything that is not a real phone chat", () => {
    for (const j of ["120363000000@g.us", "status@broadcast", "251556368777322@lid", "123@newsletter", "", null, "abc@s.whatsapp.net", "12345@s.whatsapp.net"]) {
      expect(userDigitsFromJid(j as string | null)).toBeNull()
    }
  })
})

describe("parseGowaEvent — messages", () => {
  it("inbound text becomes a text row keyed on the WhatsApp id, with WhatsApp's own timestamp", () => {
    const m = ingest(msg({ from_name: "Stefano" }))
    expect(m).toMatchObject({
      externalId: "3EB0AAAA",
      remoteDigits: "393331234567",
      direction: "inbound",
      senderName: "Stefano",
      contentType: "text",
      contentText: "Ciao",
      createdAt: "2026-09-24T17:59:00.000Z",
    })
  })

  it("a message typed on the phone is an outbound row with no sender name", () => {
    const m = ingest(msg({ is_from_me: true, from: OWNER, from_name: "Antonio" }))
    expect(m.direction).toBe("outbound")
    expect(m.senderName).toBeNull()
    expect(m.remoteDigits).toBe("393331234567") // the OTHER party, never the owner
    expect(m.metadata).toMatchObject({ source: "wabridge", sent_from: "phone" })
  })

  it("prefers the saved-contact name over the push name", () => {
    expect(ingest(msg({ sender_display_name: "Stefano Stella", from_name: "Stef" })).senderName).toBe("Stefano Stella")
  })

  it("maps media kinds and uses a placeholder when there is no caption", () => {
    expect(ingest(msg({ body: undefined, image: { url: "https://x" } }))).toMatchObject({ contentType: "image", contentText: "[Photo]" })
    expect(ingest(msg({ body: undefined, audio: "statics/a.ogg" }))).toMatchObject({ contentType: "voice", contentText: "[Voice note]" })
    expect(ingest(msg({ body: undefined, video: {} }))).toMatchObject({ contentType: "video", contentText: "[Video]" })
    expect(ingest(msg({ body: undefined, video_note: {} }))).toMatchObject({ contentType: "video" })
    expect(ingest(msg({ body: undefined, sticker: {} }))).toMatchObject({ contentType: "sticker", contentText: "[Sticker]" })
    expect(ingest(msg({ body: undefined, location: {} }))).toMatchObject({ contentType: "location", contentText: "[Location]" })
    expect(ingest(msg({ body: undefined, contact: {} }))).toMatchObject({ contentType: "contact", contentText: "[Contact card]" })
    expect(ingest(msg({ body: undefined, poll: {} }))).toMatchObject({ contentType: "other" })
  })

  it("keeps the caption of a media message, and names a document", () => {
    expect(ingest(msg({ body: "Guarda", image: { url: "https://x", caption: "Guarda" } }))).toMatchObject({ contentType: "image", contentText: "Guarda" })
    expect(ingest(msg({ body: undefined, document: { filename: "passport.pdf" } }))).toMatchObject({ contentType: "document", contentText: "[Document: passport.pdf]" })
  })

  it("records forwarded, view-once and reply context in metadata", () => {
    const m = ingest(msg({ forwarded: true, view_once: true, replied_to_id: "X1", quoted_body: "prima" }))
    expect(m.metadata).toMatchObject({ forwarded: true, view_once: true, replied_to_id: "X1", quoted_body: "prima" })
  })

  it("falls back to now for a missing, garbage or future timestamp, never rewinds to epoch", () => {
    expect(ingest(msg({ timestamp: undefined })).createdAt).toBe(NOW.toISOString())
    expect(ingest(msg({ timestamp: "not-a-date" })).createdAt).toBe(NOW.toISOString())
    expect(ingest(msg({ timestamp: "2030-01-01T00:00:00Z" })).createdAt).toBe(NOW.toISOString())
    // a genuine old timestamp (catch-up after an outage) is kept as-is
    expect(ingest(msg({ timestamp: "2026-09-20T10:00:00Z" })).createdAt).toBe("2026-09-20T10:00:00.000Z")
  })
})

describe("parseGowaEvent — things that must NOT become a thread", () => {
  it("ignores groups, status broadcasts, newsletters and unresolved @lid chats", () => {
    expect(ignored(msg({ chat_id: "120363000000000000@g.us" }))).toMatch(/not a one-to-one/)
    expect(ignored(msg({ chat_id: "status@broadcast" }))).toMatch(/not a one-to-one/)
    expect(ignored(msg({ chat_id: "120363000000@newsletter" }))).toMatch(/not a one-to-one/)
    expect(ignored(msg({ chat_id: "251556368777322@lid" }))).toMatch(/not a one-to-one/)
    expect(ignored(msg({ chat_id: undefined }))).toMatch(/not a one-to-one/)
  })

  it("ignores the owner's own 'message yourself' chat", () => {
    expect(ignored(msg({ chat_id: OWNER }))).toBe("message-yourself chat")
  })

  it("ignores non-message events: reactions, receipts, edits, deletions, calls, presence", () => {
    for (const event of ["message.reaction", "message.ack", "message.edited", "message.revoked", "message.deleted", "chat_presence", "call.offer", "group.participants"]) {
      expect(ignored({ event, payload: { id: "x", chat_id: "393331234567@s.whatsapp.net" } })).toMatch(/^event /)
    }
  })

  it("ignores a message with no id, and one with neither text nor media", () => {
    expect(ignored(msg({ id: undefined }))).toBe("no message id")
    expect(ignored(msg({ body: undefined }))).toBe("no text or media")
    expect(ignored(msg({ body: "   " }))).toBe("no text or media")
  })

  it("survives garbage input without throwing", () => {
    for (const g of [null, undefined, 5, "x", [], { event: "message" }, { event: "message", payload: [] }]) {
      expect(parseGowaEvent(g, NOW).action).toBe("ignore")
    }
  })
})

describe("parseGowaEvent — @lid drops are flagged so they can be counted", () => {
  it("marks an @lid chat with code 'lid' (a real person lost to a hidden id must never be silent)", () => {
    const r = parseGowaEvent(msg({ chat_id: "251556368777322@lid" }), NOW)
    expect(r).toMatchObject({ action: "ignore", code: "lid" })
  })
  it("does not flag groups or status as lid", () => {
    expect((parseGowaEvent(msg({ chat_id: "120363000000@g.us" }), NOW) as { code?: string }).code).toBeUndefined()
    expect((parseGowaEvent(msg({ chat_id: "status@broadcast" }), NOW) as { code?: string }).code).toBeUndefined()
  })
})

describe("isFreshTs", () => {
  it("accepts now, rejects old/future/garbage", () => {
    expect(isFreshTs(NOW.getTime(), NOW)).toBe(true)
    expect(isFreshTs(NOW.getTime() - 60_000, NOW)).toBe(true)
    expect(isFreshTs(NOW.getTime() - 3 * 60_000, NOW)).toBe(false)
    expect(isFreshTs(NOW.getTime() + 3 * 60_000, NOW)).toBe(false)
    for (const v of [undefined, null, "1", NaN, Infinity]) expect(isFreshTs(v, NOW)).toBe(false)
  })
})

describe("normalizeBackfillItem (history download)", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: "H1", chat: "393339980702", from_me: false, ts: "2026-09-24T10:06:10Z", text: "Il messaggio non si sente", media_type: "", filename: "", chat_name: "Stefano Stella", ...over,
  })
  it("maps an inbound text with the phone's saved name and the original WhatsApp timestamp", () => {
    expect(normalizeBackfillItem(item(), NOW)).toMatchObject({
      externalId: "H1", remoteDigits: "393339980702", direction: "inbound", senderName: "Stefano Stella",
      contentType: "text", contentText: "Il messaggio non si sente", createdAt: "2026-09-24T10:06:10.000Z",
      metadata: { source: "wabridge", history: true },
    })
  })
  it("your own phone-typed messages are outbound with no sender name", () => {
    const m = normalizeBackfillItem(item({ from_me: true }), NOW)!
    expect(m.direction).toBe("outbound")
    expect(m.senderName).toBeNull()
    expect(m.metadata).toMatchObject({ sent_from: "phone", history: true })
  })
  it("media kinds, caption and placeholders", () => {
    expect(normalizeBackfillItem(item({ text: "", media_type: "image" }), NOW)).toMatchObject({ contentType: "image", contentText: "[Photo]" })
    expect(normalizeBackfillItem(item({ text: "", media_type: "audio" }), NOW)).toMatchObject({ contentType: "voice", contentText: "[Voice note]" })
    expect(normalizeBackfillItem(item({ text: "", media_type: "ptt" }), NOW)).toMatchObject({ contentType: "voice" })
    expect(normalizeBackfillItem(item({ text: "Guarda", media_type: "image" }), NOW)).toMatchObject({ contentType: "image", contentText: "Guarda" })
    expect(normalizeBackfillItem(item({ text: "", media_type: "document", filename: "passport.pdf" }), NOW)).toMatchObject({ contentText: "[Document: passport.pdf]" })
    expect(normalizeBackfillItem(item({ text: "", media_type: "weird-new-kind" }), NOW)).toMatchObject({ contentType: "other" })
  })
  it("skips unusable rows: no id, bad chat, no text and no media, non-objects", () => {
    expect(normalizeBackfillItem(item({ id: undefined }), NOW)).toBeNull()
    expect(normalizeBackfillItem(item({ chat: "12@abc" }), NOW)).toBeNull()
    expect(normalizeBackfillItem(item({ chat: "1234" }), NOW)).toBeNull()
    expect(normalizeBackfillItem(item({ text: "  ", media_type: "" }), NOW)).toBeNull()
    for (const g of [null, undefined, 5, "x", []]) expect(normalizeBackfillItem(g, NOW)).toBeNull()
  })
  it("a garbage or future timestamp falls back to now", () => {
    expect(normalizeBackfillItem(item({ ts: "nope" }), NOW)!.createdAt).toBe(NOW.toISOString())
    expect(normalizeBackfillItem(item({ ts: "2031-01-01T00:00:00Z" }), NOW)!.createdAt).toBe(NOW.toISOString())
  })
})
