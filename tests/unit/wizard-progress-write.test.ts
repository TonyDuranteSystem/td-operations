/**
 * lib/portal/wizard-progress-write.ts — unit tests (dev job 9a9c5cf5).
 *
 * This is the ONE write primitive every wizard_progress "mark submitted"
 * call site in app/api/portal/wizard-submit/route.ts now goes through. The
 * whole incident this file exists to prevent (a 2026-08-27 missing-column
 * deploy silently breaking every write for 5+ days) came from THREE
 * independent copies of this insert/update, none of which checked the
 * returned error. These tests pin: (a) insert vs update branch selection,
 * (b) the exact payload shape sent to Supabase, (c) that a write error is
 * actually surfaced on the return value, never swallowed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const insertMock = vi.fn()
const updateMock = vi.fn()
const eqMock = vi.fn()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      insert: insertMock,
      update: updateMock,
    })),
  },
}))

import { markWizardProgressSubmitted } from "@/lib/portal/wizard-progress-write"

beforeEach(() => {
  insertMock.mockReset()
  updateMock.mockReset()
  eqMock.mockReset()
  updateMock.mockReturnValue({ eq: eqMock })
})

describe("markWizardProgressSubmitted — insert branch (no progressId)", () => {
  it("inserts a new row with status='submitted' and the given fields", async () => {
    insertMock.mockResolvedValue({ error: null })
    const result = await markWizardProgressSubmitted({
      progressId: null,
      wizardType: "formation",
      data: { llc_name_1: "Test LLC" },
      accountId: null,
      contactId: "contact-1",
      leadId: "lead-1",
      serviceDeliveryId: null,
    })
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wizard_type: "formation",
        data: { llc_name_1: "Test LLC" },
        account_id: null,
        contact_id: "contact-1",
        lead_id: "lead-1",
        service_delivery_id: null,
        status: "submitted",
        current_step: 99,
      }),
    )
    expect(updateMock).not.toHaveBeenCalled()
    expect(result.error).toBeNull()
  })

  it("defaults service_delivery_id to null when omitted (not undefined — a real column value)", async () => {
    insertMock.mockResolvedValue({ error: null })
    await markWizardProgressSubmitted({
      progressId: null,
      wizardType: "tax",
      data: {},
      accountId: "acc-1",
      contactId: null,
      leadId: null,
    })
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ service_delivery_id: null }),
    )
  })

  it("surfaces the error instead of swallowing it — the exact defect this file exists to close", async () => {
    insertMock.mockResolvedValue({
      error: { message: "Could not find the 'service_delivery_id' column of 'wizard_progress' in the schema cache" },
    })
    const result = await markWizardProgressSubmitted({
      progressId: null,
      wizardType: "formation",
      data: {},
      accountId: null,
      contactId: "contact-1",
      leadId: null,
    })
    expect(result.error).not.toBeNull()
    expect(result.error?.message).toContain("schema cache")
  })
})

describe("markWizardProgressSubmitted — update branch (progressId present)", () => {
  it("updates the existing row by id with status='submitted'", async () => {
    eqMock.mockResolvedValue({ error: null })
    const result = await markWizardProgressSubmitted({
      progressId: "wp-123",
      wizardType: "onboarding",
      data: { step: 3 },
      accountId: "acc-1",
      contactId: "contact-1",
      leadId: null,
    })
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { step: 3 }, status: "submitted" }),
    )
    expect(eqMock).toHaveBeenCalledWith("id", "wp-123")
    expect(insertMock).not.toHaveBeenCalled()
    expect(result.error).toBeNull()
  })

  it("surfaces an update error too, not just an insert error", async () => {
    eqMock.mockResolvedValue({ error: { message: "row not found" } })
    const result = await markWizardProgressSubmitted({
      progressId: "wp-missing",
      wizardType: "itin",
      data: {},
      accountId: null,
      contactId: "contact-1",
      leadId: null,
    })
    expect(result.error?.message).toBe("row not found")
  })
})
