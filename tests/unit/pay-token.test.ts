/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { resolveInvoiceAudience, gateBankDetailsForAudience } from "@/lib/portal/pay-token"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/database.types"

function makeSupabase(table: "accounts" | "contacts", data: unknown, error: unknown = null) {
  return {
    from: vi.fn((t: string) => {
      if (t !== table) throw new Error(`unexpected table ${t}`)
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data, error }),
      }
    }),
  } as unknown as SupabaseClient<Database>
}

describe("resolveInvoiceAudience", () => {
  it("returns no_portal when both ids are null", async () => {
    const supabase = {} as unknown as SupabaseClient<Database>
    const result = await resolveInvoiceAudience({ account_id: null, contact_id: null }, supabase)
    expect(result).toBe("no_portal")
  })

  it("returns portal for an account on a portal-audience tier", async () => {
    const supabase = makeSupabase("accounts", { portal_tier: "active", account_type: "Client" })
    const result = await resolveInvoiceAudience({ account_id: "a1", contact_id: null }, supabase)
    expect(result).toBe("portal")
  })

  it("returns no_portal for an account on a non-portal tier", async () => {
    const supabase = makeSupabase("accounts", { portal_tier: "lead", account_type: "Client" })
    const result = await resolveInvoiceAudience({ account_id: "a1", contact_id: null }, supabase)
    expect(result).toBe("no_portal")
  })

  // QA follow-up (dev job 1834af40, post-ship sweep, bug-hunter finding): a
  // genuine lookup failure used to be discarded silently and fall through to
  // "no_portal" — the audience allowed to see real bank details. A DB error
  // tells us NOTHING about the recipient; failing toward "portal" (no bank
  // details shown) is the only safe default, since the two wrong answers are
  // not symmetric — a no-portal client seeing "log in to pay" is a
  // recoverable annoyance, a portal client seeing real bank numbers is a
  // live leak.
  it("fails safe to portal when the account lookup errors, even if a portal-tier account was never actually reached", async () => {
    const supabase = makeSupabase("accounts", null, { message: "connection reset" })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await resolveInvoiceAudience({ account_id: "a1", contact_id: null }, supabase)
    expect(result).toBe("portal")
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("account lookup failed"))
    errorSpy.mockRestore()
  })

  it("returns portal for a contact on a portal-audience tier (contact-only payment)", async () => {
    const supabase = makeSupabase("contacts", { portal_tier: "formation" })
    const result = await resolveInvoiceAudience({ account_id: null, contact_id: "c1" }, supabase)
    expect(result).toBe("portal")
  })

  it("returns no_portal for a contact with no portal_tier", async () => {
    const supabase = makeSupabase("contacts", { portal_tier: null })
    const result = await resolveInvoiceAudience({ account_id: null, contact_id: "c1" }, supabase)
    expect(result).toBe("no_portal")
  })

  it("fails safe to portal when the contact lookup errors", async () => {
    const supabase = makeSupabase("contacts", null, { message: "timeout" })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await resolveInvoiceAudience({ account_id: null, contact_id: "c1" }, supabase)
    expect(result).toBe("portal")
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("contact lookup failed"))
    errorSpy.mockRestore()
  })
})

describe("gateBankDetailsForAudience", () => {
  const bankDetails = { label: "Mercury — USD", accountNumber: "202236384517" }

  it("passes the value through unchanged for a no_portal audience", () => {
    expect(gateBankDetailsForAudience(bankDetails, "no_portal")).toBe(bankDetails)
  })

  it("returns null for a portal audience, regardless of the value given", () => {
    expect(gateBankDetailsForAudience(bankDetails, "portal")).toBeNull()
  })
})
