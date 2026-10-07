import { describe, it, expect } from "vitest"
// @ts-expect-error — plain ES module script (runs on the Mac), no type declarations
import * as P from "../../scripts/wa-bridge/react-plan.mjs"

const ID = "11111111-2222-4333-8444-555555555555"
const claim = (over: Record<string, unknown> = {}) => ({ claimed: true, id: ID, attempt: 1, to_digits: "17274234285", external_message_id: "3A005FCF60C597CA99D0", emoji: "👍", ...over })

describe("validateClaim — the Mac's last look before touching WhatsApp", () => {
  it("accepts a normal claim and builds the program's address (jid) and request body", () => {
    const v = P.validateClaim(claim())
    expect(v).toMatchObject({ ok: true, id: ID, attempt: 1, jid: "17274234285@s.whatsapp.net", extId: "3A005FCF60C597CA99D0", emoji: "👍" })
    expect(P.reactionPayload(v)).toEqual({ phone: "17274234285@s.whatsapp.net", emoji: "👍" })
  })
  it("an EMPTY emoji is valid — it means REMOVE the reaction", () => {
    const v = P.validateClaim(claim({ emoji: "" }))
    expect(v.ok).toBe(true)
    expect(P.reactionPayload(v).emoji).toBe("")
  })
  it("refuses anything malformed, so a bad answer can never become a request to the program", () => {
    for (const bad of [
      { id: "nope" }, { id: undefined }, { to_digits: "123" }, { to_digits: "12345678901234567" }, { to_digits: "1727423428a" }, { to_digits: "1203630@g.us" },
      { external_message_id: "ab" }, { external_message_id: "bad id!" }, { external_message_id: "../etc" },
      { emoji: "abc" }, { emoji: "👍 👍" }, { emoji: "x".repeat(40) }, { emoji: 5 },
      { attempt: undefined }, { attempt: 0 }, { attempt: 1.5 }, { attempt: "1" },
    ]) {
      expect(P.validateClaim(claim(bad as Record<string, unknown>)).ok).toBe(false)
    }
    for (const nothing of [null, undefined, "x", 5]) expect(P.validateClaim(nothing).ok).toBe(false)
  })
})

describe("interpretProgramAnswer — only an explicit success counts", () => {
  it("HTTP 200 with code SUCCESS is a success", () => {
    expect(P.interpretProgramAnswer(200, JSON.stringify({ code: "SUCCESS", message: "Success", results: {} }))).toEqual({ ok: true, error: null })
  })
  it("anything else is a failure with a short reason", () => {
    for (const [status, body] of [[200, ""], [200, "not json"], [200, JSON.stringify({ code: "ERROR" })], [500, JSON.stringify({ message: "boom" })], [0, ""], [404, JSON.stringify({ code: "SUCCESS" })]] as const) {
      const r = P.interpretProgramAnswer(status, body)
      expect(r.ok).toBe(false)
      expect(typeof r.error).toBe("string")
      expect((r.error as string).length).toBeGreaterThan(0)
    }
    expect(P.interpretProgramAnswer(500, JSON.stringify({ message: "boom" })).error).toBe("boom")
    expect((P.interpretProgramAnswer(500, JSON.stringify({ message: "y".repeat(500) })).error as string).length).toBe(200)
  })
})

describe("backoffSeconds", () => {
  it("waits long when paused/unhealthy/capped, follows the CRM's own gap hint (bounded), and checks again soon when idle", () => {
    expect(P.backoffSeconds("paused")).toBe(20)
    expect(P.backoffSeconds("reader_stale")).toBe(20)
    expect(P.backoffSeconds("hourly_cap")).toBe(30)
    expect(P.backoffSeconds("gap", 3)).toBe(3)
    expect(P.backoffSeconds("gap", 0)).toBe(2)
    expect(P.backoffSeconds("gap", 9999)).toBe(60)
    expect(P.backoffSeconds("gap", "x")).toBe(2)
    expect(P.backoffSeconds("nothing_to_send")).toBe(2)
    expect(P.backoffSeconds(undefined)).toBe(2)
  })
})

describe("maskIdentifiers — the program's error text never keeps a customer's number or chat address", () => {
  it("masks chat addresses and phone numbers, leaves ordinary words", () => {
    expect(P.maskIdentifiers("message 17274234285@s.whatsapp.net not found")).toBe("message <chat> not found")
    expect(P.maskIdentifiers("cannot send to +1 (727) 423-4285 right now")).toBe("cannot send to <number> right now")
    expect(P.maskIdentifiers("chat 251556368777322@lid is gone")).toBe("chat <chat> is gone")
    expect(P.maskIdentifiers("the program said no")).toBe("the program said no")
  })
  it("is applied to every error the sender reports", () => {
    const r = P.interpretProgramAnswer(500, JSON.stringify({ message: "no such message for 17274234285@s.whatsapp.net" }))
    expect(r.ok).toBe(false)
    expect(r.error).not.toMatch(/\d{6,}/)
    expect(r.error).toContain("<chat>")
  })
})
