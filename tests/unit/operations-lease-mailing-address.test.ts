/**
 * dev job 525e0e67 — lib/operations/lease.ts mailing-address sync helpers.
 *
 * Covers: resolveTdMailingAddressForLease() prefix matching (case-insensitive,
 * no match, null input) and linkAccountToLeaseMailingAddress() write behavior
 * (only writes on a match, never on a miss).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

let addressCandidates: Array<{ id: string; address_line1: string }> = []
const updateCalls: Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, unknown> }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      let pendingUpdate: Record<string, unknown> | null = null

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
        then: (resolve: (v: unknown) => void) => {
          if (pendingUpdate) {
            updateCalls.push({ table, payload: pendingUpdate, filters: { ...filters } })
            return resolve({ data: null, error: null })
          }
          if (table === "addresses") {
            return resolve({ data: addressCandidates, error: null })
          }
          return resolve({ data: null, error: null })
        },
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
})

describe("linkAccountToLeaseMailingAddress", () => {
  beforeEach(() => {
    updateCalls.length = 0
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
})
