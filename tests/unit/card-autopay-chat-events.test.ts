import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * dev job 10995181 follow-up — the "client turned on card autopay" What's
 * New note, and its retire-on-disable counterpart (so a genuine re-enrollment
 * after a disable produces a fresh note instead of silently deduping forever
 * against the first one).
 */

let accountRow: { company_name: string | null } | null = null
let existingRow: { id: string } | null = null
let inserted: Record<string, unknown> | null = null
let updateCalls: Array<{ payload: Record<string, unknown> }> = []
let updateResult: { data: Array<{ id: string }> | null; error: { message: string } | null } = { data: [], error: null }

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: accountRow, error: null }),
            }),
          }),
        }
      }
      // portal_messages
      return {
        select: () => makeDedupChain(),
        insert: (row: Record<string, unknown>) => {
          inserted = row
          return {
            select: () => ({
              single: async () => ({ data: { id: "new-msg-id" }, error: null }),
            }),
          }
        },
        update: (payload: Record<string, unknown>) => {
          updateCalls.push({ payload })
          return makeUpdateChain()
        },
      }
    },
  },
}))

function makeDedupChain() {
  const chain = {
    eq: () => chain,
    like: () => chain,
    is: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: existingRow }),
  }
  return chain
}

function makeUpdateChain() {
  const chain = {
    eq: () => chain,
    like: () => chain,
    is: () => chain,
    select: async () => updateResult,
  }
  return chain
}

import { emitCardAutopayEnabledEvent, retireCardAutopayEnabledNote } from "@/lib/portal/chat-events"

beforeEach(() => {
  accountRow = { company_name: "Brixel LLC" }
  existingRow = null
  inserted = null
  updateCalls = []
  updateResult = { data: [], error: null }
})

describe("emitCardAutopayEnabledEvent", () => {
  it("emits under card_autopay_enabled, scoped to the account, naming the company and card", async () => {
    const result = await emitCardAutopayEnabledEvent({ accountId: "acc-1", last4: "4242" })
    expect(result.emitted).toBe(true)
    expect(inserted).toMatchObject({ account_id: "acc-1", sender_type: "system" })
    expect(String(inserted?.message)).toContain("Brixel LLC turned on card autopay (card ending 4242)")
    expect(String(inserted?.message)).toContain("<!-- chat-event: kind=card_autopay_enabled src=accounts:acc-1 -->")
  })

  it("omits the card clause when no last4 is available", async () => {
    await emitCardAutopayEnabledEvent({ accountId: "acc-2" })
    expect(String(inserted?.message)).toContain("Brixel LLC turned on card autopay —")
    expect(String(inserted?.message)).not.toContain("card ending")
  })

  it("is skipped (already_emitted) when a note for this account already exists", async () => {
    existingRow = { id: "old-note" }
    const result = await emitCardAutopayEnabledEvent({ accountId: "acc-1" })
    expect(result.emitted).toBe(false)
    expect(result.reason).toBe("already_emitted")
    expect(inserted).toBeNull()
  })

  it("falls back to a generic name when the account row can't be read", async () => {
    accountRow = null
    await emitCardAutopayEnabledEvent({ accountId: "acc-3" })
    expect(String(inserted?.message)).toContain("The client turned on card autopay")
  })
})

describe("retireCardAutopayEnabledNote", () => {
  it("soft-deletes the existing marker so a future re-enrollment can emit again", async () => {
    updateResult = { data: [{ id: "old-note" }], error: null }
    const result = await retireCardAutopayEnabledNote({ accountId: "acc-1" })
    expect(result.retired).toBe(1)
    expect(updateCalls[0].payload).toMatchObject({ deleted_by: expect.any(String) })
    expect(updateCalls[0].payload.deleted_at).toBeDefined()
  })

  it("returns retired: 0 when there was nothing to retire (no prior enrollment note)", async () => {
    updateResult = { data: [], error: null }
    const result = await retireCardAutopayEnabledNote({ accountId: "acc-4" })
    expect(result.retired).toBe(0)
  })

  it("does not throw when the update errors", async () => {
    updateResult = { data: null, error: { message: "connection reset" } }
    await expect(retireCardAutopayEnabledNote({ accountId: "acc-1" })).resolves.toEqual({ retired: 0 })
  })
})
