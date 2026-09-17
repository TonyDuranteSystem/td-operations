/**
 * Tests for lib/messaging/phone.ts — the canonical WhatsApp phone-number
 * normalization used by both the outbound dispatcher and the inbound webhook.
 */

import { describe, it, expect } from "vitest"
import { digitsOnly, toWhatsAppJid, jidToE164 } from "@/lib/messaging/phone"

describe("digitsOnly", () => {
  it("strips everything but digits", () => {
    expect(digitsOnly("+1 (727) 452-1093")).toBe("17274521093")
  })

  it("passes through a bare digit string unchanged", () => {
    expect(digitsOnly("17274521093")).toBe("17274521093")
  })

  it("returns an empty string when there are no digits", () => {
    expect(digitsOnly("+()- ")).toBe("")
  })
})

describe("toWhatsAppJid", () => {
  it("produces the canonical @c.us shape from a formatted phone", () => {
    expect(toWhatsAppJid("+1 (727) 452-1093")).toBe("17274521093@c.us")
  })

  it("produces the same shape from a bare digit string", () => {
    expect(toWhatsAppJid("17274521093")).toBe("17274521093@c.us")
  })

  it("is idempotent on an already-canonical JID", () => {
    expect(toWhatsAppJid("17274521093@c.us")).toBe("17274521093@c.us")
  })
})

describe("jidToE164", () => {
  it("converts a JID to E.164", () => {
    expect(jidToE164("17274521093@c.us")).toBe("+17274521093")
  })

  it("converts a stored +digits phone to E.164 unchanged", () => {
    expect(jidToE164("+17274521093")).toBe("+17274521093")
  })

  it("adds the leading + to a bare digit string", () => {
    expect(jidToE164("17274521093")).toBe("+17274521093")
  })
})
