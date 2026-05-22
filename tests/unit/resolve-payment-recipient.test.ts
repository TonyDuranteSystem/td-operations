/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { resolvePaymentRecipient } from "@/lib/portal/resolve-payment-recipient"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/database.types"

function makeSupabase(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      ...overrides,
    }),
    ...overrides,
  } as unknown as SupabaseClient<Database>
}

describe("resolvePaymentRecipient", () => {
  it("returns null when both ids are null", async () => {
    const supabase = makeSupabase()
    const result = await resolvePaymentRecipient(
      { contact_id: null, account_id: null },
      supabase,
    )
    expect(result).toBeNull()
  })

  it("resolves directly from contact_id — ignores account entirely", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { email: "alex@example.com", full_name: "Alex V" },
              error: null,
            }),
          }
        }
        // account_contacts and accounts should never be called
        return { select: vi.fn(() => { throw new Error("should not reach account tables") }) }
      }),
    } as unknown as SupabaseClient<Database>

    const result = await resolvePaymentRecipient(
      { contact_id: "c1", account_id: "a1" },
      supabase,
    )
    expect(result).toEqual({ email: "alex@example.com", name: "Alex V" })
  })

  it("resolves via account_contacts when contact_id is null — any role", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "accounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { company_name: "NDB LLC", communication_email: null },
              error: null,
            }),
          }
        }
        if (table === "account_contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ contacts: { email: "alex@example.com", full_name: "Alex V" } }],
              error: null,
            }),
          }
        }
        return { select: vi.fn().mockReturnThis() }
      }),
    } as unknown as SupabaseClient<Database>

    const result = await resolvePaymentRecipient(
      { contact_id: null, account_id: "a1" },
      supabase,
    )
    expect(result).toEqual({ email: "alex@example.com", name: "NDB LLC" })
  })

  it("falls back to communication_email when no contacts have email", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "accounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { company_name: "NDB LLC", communication_email: "billing@ndb.com" },
              error: null,
            }),
          }
        }
        if (table === "account_contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ contacts: { email: null, full_name: "No Email" } }],
              error: null,
            }),
          }
        }
        return { select: vi.fn().mockReturnThis() }
      }),
    } as unknown as SupabaseClient<Database>

    const result = await resolvePaymentRecipient(
      { contact_id: null, account_id: "a1" },
      supabase,
    )
    expect(result).toEqual({ email: "billing@ndb.com", name: "NDB LLC" })
  })

  it("returns null when account has no contacts and no communication_email", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "accounts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { company_name: "Ghost LLC", communication_email: null },
              error: null,
            }),
          }
        }
        if (table === "account_contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }
        }
        return { select: vi.fn().mockReturnThis() }
      }),
    } as unknown as SupabaseClient<Database>

    const result = await resolvePaymentRecipient(
      { contact_id: null, account_id: "a1" },
      supabase,
    )
    expect(result).toBeNull()
  })
})
