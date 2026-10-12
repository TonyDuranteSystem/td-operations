import { describe, it, expect } from "vitest"
import { parseRecipients, BOFA_MAX_RECIPIENTS } from "@/lib/bofa-intake/recipients"

describe("bofa intake recipients", () => {
  it("accepts one address and normalises case and spacing", () => {
    expect(parseRecipients("  Name@Example.COM ")).toEqual({ ok: true, emails: ["name@example.com"] })
  })

  it("splits on commas, semicolons, spaces and new lines, and drops duplicates", () => {
    const r = parseRecipients("a@x.com, b@x.com;c@x.com\nA@x.com  d@x.com")
    expect(r).toEqual({ ok: true, emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"] })
  })

  it("accepts an array", () => {
    expect(parseRecipients(["a@x.com", " b@x.com "])).toEqual({ ok: true, emails: ["a@x.com", "b@x.com"] })
  })

  it("treats empty / missing input as 'send to nobody'", () => {
    expect(parseRecipients("")).toEqual({ ok: true, emails: [] })
    expect(parseRecipients(undefined)).toEqual({ ok: true, emails: [] })
    expect(parseRecipients("  ,; ")).toEqual({ ok: true, emails: [] })
  })

  it("rejects a bad address and names it", () => {
    expect(parseRecipients("good@x.com, not-an-email")).toEqual({ ok: false, error: '"not-an-email" is not a valid email address.' })
    expect(parseRecipients("a@b")).toEqual({ ok: false, error: '"a@b" is not a valid email address.' })
  })

  it("rejects header-injection style input", () => {
    expect(parseRecipients("a@x.com>\r\nBcc: evil@x.com").ok).toBe(false)
  })

  it(`allows at most ${BOFA_MAX_RECIPIENTS} addresses`, () => {
    const many = Array.from({ length: BOFA_MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@x.com`).join(",")
    expect(parseRecipients(many).ok).toBe(false)
    expect(parseRecipients(many.split(",").slice(0, BOFA_MAX_RECIPIENTS).join(",")).ok).toBe(true)
  })
})
