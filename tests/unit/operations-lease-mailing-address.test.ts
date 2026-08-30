/**
 * dev job 525e0e67 — lib/operations/lease.ts mailing-address sync helpers.
 *
 * Covers: resolveTdMailingAddressForLease() prefix matching (case-insensitive,
 * no match, null input, longest-prefix tie-break) and
 * linkAccountToLeaseMailingAddress() write behavior — only writes on a match,
 * never on a miss, and NEVER overwrites an already-set address (the blocker
 * council review caught before this shipped: every lease resolves to the same
 * default building, so an unconditional overwrite would silently reset any
 * account already linked to a different TD address).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

let addressCandidates: Array<{ id: string; address_line1: string }> = []
let accountRow: { business_mailing_address_id: string | null } | null = null
let updateError: { message: string } | null = null
const updateCalls: Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, unknown> }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      let pendingUpdate: Record<string, unknown> | null = null

      function resolveValue() {
        if (pendingUpdate) {
          updateCalls.push({ table, payload: pendingUpdate, filters: { ...filters } })
          pendingUpdate = null
          if (updateError) return { data: null, error: updateError }
          return { data: [{ id: filters.id }], error: null }
        }
        if (table === "accounts") return { data: accountRow, error: null }
        if (table === "addresses") return { data: addressCandidates, error: null }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, value: unknown) => {
          filters[col] = value
          return chain
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          pendingUpdate = payload
          return chain
        }),
        single: vi.fn(() => Promise.resolve(resolveValue())),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      }
      return chain
    },
  },
}))

import { resolveTdMailingAddressForLease, linkAccountToLeaseMailingAddress } from "@/lib/operations/lease"

describe("resolveTdMailingAddressForLease", () => {
  beforeEach(() => {
    addressCandidates = [
      { id: "largo-id", address_line1: "10225 Ulmerton Rd" },
      { id: "seminole-id", address_line1: "11125 Park Blvd" },
    ]
  })

  it("returns null for a null premises address", async () => {
    expect(await resolveTdMailingAddressForLease(null)).toBeNull()
  })

  it("matches the correct TD address by prefix", async () => {
    expect(await resolveTdMailingAddressForLease("10225 Ulmerton Rd, Largo, FL 33771")).toBe("largo-id")
  })

  it("matches case-insensitively", async () => {
    expect(await resolveTdMailingAddressForLease("10225 ULMERTON RD, LARGO, FL 33771")).toBe("largo-id")
  })

  it("returns null when no candidate address matches", async () => {
    expect(await resolveTdMailingAddressForLease("999 Nowhere Ave, Nowhere, FL 00000")).toBeNull()
  })

  it("returns null when there are no TD-provided addresses at all", async () => {
    addressCandidates = []
    expect(await resolveTdMailingAddressForLease("10225 Ulmerton Rd, Largo, FL 33771")).toBeNull()
  })

  it("picks the longer, more specific prefix when two candidates could both match", async () => {
    addressCandidates = [
      { id: "short-id", address_line1: "10225 Ulmerton" },
      { id: "long-id", address_line1: "10225 Ulmerton Rd, Largo" },
    ]
    expect(await resolveTdMailingAddressForLease("10225 Ulmerton Rd, Largo, FL 33771")).toBe("long-id")
  })
})

describe("linkAccountToLeaseMailingAddress", () => {
  beforeEach(() => {
    updateCalls.length = 0
    updateError = null
    accountRow = { business_mailing_address_id: null }
    addressCandidates = [{ id: "largo-id", address_line1: "10225 Ulmerton Rd" }]
  })

  it("links the account and reports success on a match", async () => {
    const result = await linkAccountToLeaseMailingAddress("account-1", "10225 Ulmerton Rd, Largo, FL 33771")
    expect(result).toEqual({ linked: true, addressId: "largo-id" })
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]).toMatchObject({
      table: "accounts",
      payload: { business_mailing_address_id: "largo-id" },
      filters: { id: "account-1" },
    })
  })

  it("does not write anything when no address matches", async () => {
    const result = await linkAccountToLeaseMailingAddress("account-1", "999 Nowhere Ave")
    expect(result).toEqual({ linked: false, addressId: null })
    expect(updateCalls).toHaveLength(0)
  })

  it("does not write anything for a null premises address", async () => {
    const result = await linkAccountToLeaseMailingAddress("account-1", null)
    expect(result).toEqual({ linked: false, addressId: null })
    expect(updateCalls).toHaveLength(0)
  })

  it("never overwrites an already-set address, even on a real match", async () => {
    accountRow = { business_mailing_address_id: "seminole-id" }
    const result = await linkAccountToLeaseMailingAddress("account-1", "10225 Ulmerton Rd, Largo, FL 33771")
    expect(result).toEqual({ linked: false, addressId: null })
    expect(updateCalls).toHaveLength(0)
  })

  it("throws instead of silently reporting success when the write fails", async () => {
    updateError = { message: "db exploded" }
    await expect(
      linkAccountToLeaseMailingAddress("account-1", "10225 Ulmerton Rd, Largo, FL 33771"),
    ).rejects.toThrow(/db exploded/)
  })
})
