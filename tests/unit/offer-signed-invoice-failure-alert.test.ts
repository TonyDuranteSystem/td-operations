import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Dev job 709ac868. When the invoice for a just-signed offer cannot be created, staff must SEE it (a system-errors
 * row), not find it in a log nobody tails. The helper never throws, and the signing code really calls it.
 */

const reported: Array<Record<string, unknown>> = []
let reporterThrows = false
vi.mock("@/lib/system-errors", () => ({
  reportSystemError: async (input: Record<string, unknown>) => {
    if (reporterThrows) throw new Error("reporter down")
    reported.push(input)
    return { fingerprint: "fp" }
  },
}))

import { reportInvoiceNotCreatedAtSigning } from "@/lib/offers/signing-invoice-alert"

beforeEach(() => { reported.length = 0; reporterThrows = false })

describe("reportInvoiceNotCreatedAtSigning", () => {
  it("puts the missing invoice in the system-errors list, naming the offer and the reason", async () => {
    await reportInvoiceNotCreatedAtSigning({ offerToken: "pierre-lacouture-2026", contactId: "c1", reason: "billing entity create failed: boom" })
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ source: "server", route: "/api/webhooks/offer-signed" })
    expect(String(reported[0].message)).toContain("pierre-lacouture-2026")
    expect(String(reported[0].message)).toContain("billing entity create failed: boom")
    expect(reported[0].context).toEqual({ offer_token: "pierre-lacouture-2026", contact_id: "c1" })
  })

  it("a signing with no contact yet still reports (contact recorded as null)", async () => {
    await reportInvoiceNotCreatedAtSigning({ offerToken: "t", contactId: undefined, reason: "x" })
    expect(reported[0].context).toEqual({ offer_token: "t", contact_id: null })
  })

  it("never throws, even when the reporter itself is down — an alert must not break signing", async () => {
    reporterThrows = true
    await expect(reportInvoiceNotCreatedAtSigning({ offerToken: "t", contactId: "c1", reason: "x" })).resolves.toBeUndefined()
  })
})

describe("the signing code uses it", () => {
  const src = readFileSync(join(process.cwd(), "lib", "offers", "process-offer-signed.ts"), "utf8")
  it("the invoice-creation catch reports through the helper (not only console.error)", () => {
    const at = src.indexOf('console.error("[offer-signed] Invoice creation failed:"')
    expect(at).toBeGreaterThan(-1)
    const after = src.slice(at, at + 600)
    expect(after).toContain("reportInvoiceNotCreatedAtSigning(")
  })
})
