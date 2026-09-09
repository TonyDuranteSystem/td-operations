import { describe, it, expect } from "vitest"
import { markPaymentPaid, updatePaymentStatus, createPayment, updatePayment, addPaymentNote } from "@/app/(dashboard)/payments/actions"
import { updateInvoice, markInvoicePaid, voidInvoice, deleteInvoice } from "@/app/(dashboard)/payments/invoice-actions"

// The old Payment Tracker page (dev job ef5da377) is retired behind a redirect
// to /finance, but a Next.js Server Action stays independently POST-callable
// by its own reference regardless of whether any page still renders a trigger
// for it -- a council review (2026-09-09) found this meant the redirect alone
// did NOT stop these from writing money data with none of Finance's
// money-safety hardening, and one of them (voidInvoice) bypassed RLS via
// supabaseAdmin with no auth check of its own. Every export was neutered to
// an immediate safe failure instead. This test is the regression guard: if
// someone reimplements real logic in these files later without realizing
// they're supposed to stay dead, this fails loudly.

describe("retired /payments actions never touch the database", () => {
  it("markPaymentPaid refuses immediately", async () => {
    const result = await markPaymentPaid("any-id", "any-updated-at")
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("updatePaymentStatus refuses immediately", async () => {
    const result = await updatePaymentStatus("any-id", "Paid", "any-updated-at")
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("createPayment refuses immediately", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed input; a neutered action must refuse before validation runs
    const result = await createPayment({} as any)
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("updatePayment refuses immediately", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed input; a neutered action must refuse before validation runs
    const result = await updatePayment({} as any)
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("addPaymentNote refuses immediately", async () => {
    const result = await addPaymentNote("any-id", "a note", "any-updated-at")
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("updateInvoice refuses immediately", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed input; a neutered action must refuse before validation runs
    const result = await updateInvoice("any-id", "any-updated-at", {} as any)
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("markInvoicePaid refuses immediately", async () => {
    const result = await markInvoicePaid("any-id", "any-updated-at")
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("voidInvoice refuses immediately (the one that used to bypass RLS)", async () => {
    const result = await voidInvoice("any-id", "any-updated-at")
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })

  it("deleteInvoice refuses immediately", async () => {
    const result = await deleteInvoice("any-id")
    expect(result).toEqual({ success: false, error: "This page has been retired. Use Finance instead." })
  })
})
