/**
 * Send's last steps (lib/offers/publish.ts, offer builder Part 3 item A): wired to markOfferSent, the lead moves only when
 * the offer did, and a step that failed after the email went out is no longer invisible.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const src = readFileSync(join(process.cwd(), "lib/offers/publish.ts"), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const code = strip(src)

describe("publishOffer's last write", () => {
  it("uses the guarded writer, not a bare update of status", () => {
    expect(code).toContain('import { markOfferSent } from "@/lib/offers/mark-sent"')
    expect(code).toContain("await markOfferSent(token)")
    expect(code).not.toMatch(/\.update\(\{ status: "sent" \}\)\s*\.eq\("token", token\)\s*\n/)
  })

  it("moves the lead to 'Offer Sent' only when the offer was really flipped", () => {
    const flip = code.indexOf("offerMarkedSent = true")
    const gate = code.indexOf("if (!offerMarkedSent) return")
    const lead = code.indexOf('offer_status: "Sent", status: "Offer Sent"')
    expect(flip).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(flip)
    expect(lead).toBeGreaterThan(gate)
    expect(code).toContain("let offerMarkedSent = false")
  })

  it("a step that failed after the email went out becomes a warning, also written to the log", () => {
    expect(code).toContain('for (const step of result.steps)')
    expect(code).toContain('step.status === "error"')
    expect(code).toContain("warnings.push(")
    expect(code).toMatch(/\.\.\.\(warnings\.length > 0 \? \{ warnings \} : \{\}\)/)
  })

  it("the email is still sent FIRST and the status written after (the rule that an offer is never marked sent when the email failed)", () => {
    const send = code.indexOf("sendFn: async () => {")
    const post = code.indexOf("postSendSteps: [")
    expect(send).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(send)
  })
})
