import { describe, it, expect } from "vitest"
import { faxEmailPredatesSs4 } from "@/lib/fax/ss4-fax-email-guard"

const SIGNED = "2026-10-28T15:00:00.000Z"
const ms = (iso: string) => String(Date.parse(iso))

describe("faxEmailPredatesSs4", () => {
  it("an email from before the SS-4 was signed belongs to an earlier SS-4", () => {
    expect(faxEmailPredatesSs4(ms("2026-10-28T12:00:00.000Z"), SIGNED)).toBe(true)
  })
  it("an email from after the signature is this SS-4's own fax", () => {
    expect(faxEmailPredatesSs4(ms("2026-10-28T15:30:00.000Z"), SIGNED)).toBe(false)
  })
  it("never blocks when the signature time or the email time is missing or unreadable", () => {
    expect(faxEmailPredatesSs4(ms("2026-10-28T12:00:00.000Z"), null)).toBe(false)
    expect(faxEmailPredatesSs4(undefined, SIGNED)).toBe(false)
    expect(faxEmailPredatesSs4("not-a-number", SIGNED)).toBe(false)
    expect(faxEmailPredatesSs4(ms("2026-10-28T12:00:00.000Z"), "garbage")).toBe(false)
  })
})
