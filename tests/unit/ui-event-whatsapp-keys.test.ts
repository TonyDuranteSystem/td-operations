import { describe, it, expect } from "vitest"
import { WHATSAPP_LIVE_QUERY_KEYS, GMAIL_COST_QUERY_KEYS, WHATSAPP_LIVE_DEBOUNCE_MS, WHATSAPP_LIVE_MAX_WAIT_MS, WHATSAPP_LIST_QUERY_KEY } from "@/lib/ui-event-whatsapp-keys"

describe("the WhatsApp live-update key list", () => {
  it("never contains a bare Gmail-cost key (their GET makes ~300 Gmail calls and has blanked the Inbox before)", () => {
    for (const key of WHATSAPP_LIVE_QUERY_KEYS) {
      expect(key.length).toBeGreaterThan(0)
      if (key.length === 1) expect(GMAIL_COST_QUERY_KEYS).not.toContain(key[0])
    }
  })

  it("the only shared prefix ('inbox-conversations') is always narrowed to the whatsapp channel", () => {
    const shared = WHATSAPP_LIVE_QUERY_KEYS.filter((k) => GMAIL_COST_QUERY_KEYS.includes(k[0]))
    expect(shared.length).toBeGreaterThan(0)
    for (const k of shared) expect(k).toEqual(["inbox-conversations", "whatsapp"])
  })

  it("covers the chat list and the open conversation", () => {
    expect(WHATSAPP_LIVE_QUERY_KEYS).toContainEqual(["inbox-conversations", "whatsapp"])
    expect(WHATSAPP_LIVE_QUERY_KEYS).toContainEqual(["whatsapp-messages"])
  })

  it("debounces a burst for under a couple of seconds (fast, but one refresh) and never postpones past the max wait", () => {
    expect(WHATSAPP_LIVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(300)
    expect(WHATSAPP_LIVE_DEBOUNCE_MS).toBeLessThanOrEqual(2000)
    expect(WHATSAPP_LIVE_MAX_WAIT_MS).toBeGreaterThan(WHATSAPP_LIVE_DEBOUNCE_MS)
    expect(WHATSAPP_LIVE_MAX_WAIT_MS).toBeLessThanOrEqual(10_000)
  })
})

// Source-level guards: the constants above are only useful while the listener really uses them and the WhatsApp list really
// keys itself the way they assume. Reading the source is crude but it catches the silent-drift failures (a reordered key
// part stops the live refresh with every other test still green; a Gmail key slipped into the WhatsApp path blanks the Inbox).
import { readFileSync } from "node:fs"

describe("the listener and the list agree with the key list (source guards)", () => {
  const listener = readFileSync("components/dashboard/ui-event-listener.tsx", "utf8")
  const list = readFileSync("components/inbox/conversation-list.tsx", "utf8")

  it("the WhatsApp chat list is keyed ['inbox-conversations', activeChannel, …] with 'whatsapp' as the channel", () => {
    expect(list).toContain("queryKey: ['inbox-conversations', activeChannel,")
    expect(list).toMatch(/const isWhatsApp = activeChannel === 'whatsapp'/)
    expect(WHATSAPP_LIST_QUERY_KEY).toEqual(["inbox-conversations", "whatsapp"])
  })

  it("the listener refreshes the WhatsApp keys by NAME (never by array position)", () => {
    expect(listener).not.toMatch(/WHATSAPP_LIVE_QUERY_KEYS\[\d+\]/)
    expect(listener).toContain("WHATSAPP_LIST_QUERY_KEY")
  })

  it("'whatsapp' has no entry in the generic kind→keys map, and no Gmail-cost key is added next to it", () => {
    const map = listener.slice(listener.indexOf("const UI_EVENT_QUERY_KEYS"), listener.indexOf("/** kinds that also refresh"))
    expect(map).not.toMatch(/\bwhatsapp\s*:/)
    for (const forbidden of GMAIL_COST_QUERY_KEYS) expect(map).not.toContain(`'${forbidden}'`)
  })
})
