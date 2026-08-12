/**
 * Card c5ff8b4d — the tax questionnaire PDF becomes a real document.
 * The privacy rule is the point of these tests: this PDF prints every member's
 * tax IDs, so it must NEVER register client-visible.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const saved: Array<Record<string, unknown>> = []
const state = { error: null as string | null }

vi.mock("@/lib/portal/auto-save-document", () => ({
  autoSaveDocument: async (p: Record<string, unknown>) => {
    saved.push(p)
    return state.error ? { error: state.error } : { id: "doc-1" }
  },
}))

import { registerOrganizerDocument, organizerDocumentName } from "@/lib/tax/register-organizer-document"

beforeEach(() => { saved.length = 0; state.error = null })

describe("organizerDocumentName", () => {
  it("names the file for humans, with the year when known", () => {
    expect(organizerDocumentName("Uxio Test LLC", 2025)).toBe("Tax Questionnaire 2025 — Uxio Test LLC")
    expect(organizerDocumentName(null, 2025)).toBe("Tax Questionnaire 2025")
    expect(organizerDocumentName("Acme LLC", null)).toBe("Tax Questionnaire — Acme LLC")
  })
})

describe("registerOrganizerDocument", () => {
  it("registers under Tax, linked to the service delivery, and NEVER client-visible", async () => {
    const r = await registerOrganizerDocument({
      accountId: "acc-1", driveFileId: "drive-1", companyName: "Uxio Test LLC",
      taxYear: 2025, serviceDeliveryId: "sd-1",
    })
    expect(r.registered).toBe(true)
    const call = saved[0]
    // PRIVACY INVARIANT: this PDF prints other members' ITIN/SSN and foreign
    // tax IDs, and a REMOVED member can still hold portal access.
    expect(call.portalVisible).toBe(false)
    expect(call.category).toBe(3) // Tax
    expect(call.documentType).toBe("Tax Questionnaire")
    expect(call.serviceDeliveryId).toBe("sd-1") // shows in the room's documents panel
    expect(call.accountId).toBe("acc-1")
    expect(call.driveFileId).toBe("drive-1")
  })

  it("refuses without an account or a drive file, and never throws", async () => {
    expect((await registerOrganizerDocument({ accountId: "", driveFileId: "d" })).registered).toBe(false)
    expect((await registerOrganizerDocument({ accountId: "a", driveFileId: "" })).registered).toBe(false)
    expect(saved).toHaveLength(0)
  })

  it("reports a helper failure instead of breaking the submission chain", async () => {
    state.error = "insert blew up"
    const r = await registerOrganizerDocument({ accountId: "acc-1", driveFileId: "drive-1" })
    expect(r.registered).toBe(false)
    expect(r.reason).toContain("insert blew up")
  })
})
