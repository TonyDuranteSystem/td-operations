import { describe, it, expect } from "vitest"
import { pickNewestNonOwnMessage } from "../../lib/inbox/default-reply-target"

function msg(id: string, direction: "inbound" | "outbound") {
  return { id, direction, sender: `${id}@example.com` }
}

describe("pickNewestNonOwnMessage", () => {
  it("returns null for an empty thread", () => {
    expect(pickNewestNonOwnMessage([])).toBeNull()
  })

  it("picks the newest inbound message when it's also the literal newest", () => {
    const messages = [msg("a", "outbound"), msg("b", "inbound")]
    expect(pickNewestNonOwnMessage(messages)?.id).toBe("b")
  })

  // The actual production incident shape (2026-08-05, 2026-09-02): our own
  // reply is the thread's literal newest message, with a real client message
  // earlier in the same thread — the untargeted default must skip past our
  // own reply and land on the client's message, not the newest overall.
  it("skips a trailing own message and picks the newest one that ISN'T ours", () => {
    const messages = [msg("client-1", "inbound"), msg("our-reply", "outbound")]
    expect(pickNewestNonOwnMessage(messages)?.id).toBe("client-1")
  })

  it("skips MULTIPLE trailing own messages to find the newest non-own one", () => {
    const messages = [
      msg("client-1", "inbound"),
      msg("our-reply-1", "outbound"),
      msg("our-reply-2", "outbound"),
    ]
    expect(pickNewestNonOwnMessage(messages)?.id).toBe("client-1")
  })

  // Nothing else to target — this is the legitimate fallback, not a mistake.
  it("falls back to the literal newest message when EVERY message is outbound", () => {
    const messages = [msg("our-1", "outbound"), msg("our-2", "outbound")]
    expect(pickNewestNonOwnMessage(messages)?.id).toBe("our-2")
  })

  it("handles a single-message thread of either direction", () => {
    expect(pickNewestNonOwnMessage([msg("only", "inbound")])?.id).toBe("only")
    expect(pickNewestNonOwnMessage([msg("only", "outbound")])?.id).toBe("only")
  })
})
