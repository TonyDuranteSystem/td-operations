import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * lib/operations/banking-submission.ts unit tests.
 *
 * Pins the fix for dev job c3efa6cb: the banking-application record used to
 * be created two different, independently hand-rolled ways (the
 * welcome_package_prepare job and the welcome_package MCP tool); a council
 * review found that patching the notification code with a THIRD hand-rolled
 * insert would reproduce the exact drift that caused the incident, and would
 * race under a double-submit with no DB backstop. This is the single shared
 * function all three now call.
 */

let existingRow: { id: string; token: string; status: string; access_code: string | null } | null = null
let accountRow: { id: string; company_name: string; ein_number: string | null } | null = null
let accountContactsRows: Array<{ contact_id: string }> = []
let contactRow: { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; citizenship: string | null; language: string | null } | null = null
let insertedRow: Record<string, unknown> | null = null
let insertError: { code?: string; message: string } | null = null
let insertedResult: { id: string; token: string; status: string; access_code: string | null } | null = null
let winnerRowAfterRace: { id: string; token: string; status: string; access_code: string | null } | null = null
let bankingSubmissionsCallCount = 0

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        order: vi.fn(() => chain),
        maybeSingle: vi.fn(() => {
          if (table === "banking_submissions") {
            bankingSubmissionsCallCount += 1
            // Call 1 = pre-insert existence check. Call 2 (only reached when
            // the insert below hits a simulated unique-violation race) = the
            // post-race re-read for the winner's row.
            if (bankingSubmissionsCallCount === 1) {
              return Promise.resolve({ data: existingRow, error: null })
            }
            return Promise.resolve({ data: winnerRowAfterRace, error: null })
          }
          if (table === "account_contacts") return Promise.resolve({ data: accountContactsRows[0] ?? null, error: null })
          if (table === "contacts") return Promise.resolve({ data: contactRow, error: null })
          return Promise.resolve({ data: null, error: null })
        }),
        single: vi.fn(() => {
          if (table === "accounts") return Promise.resolve({ data: accountRow, error: accountRow ? null : { message: "not found" } })
          return Promise.resolve({ data: insertedResult, error: insertError })
        }),
        insert: vi.fn((row: Record<string, unknown>) => {
          insertedRow = row
          return chain
        }),
      })
      return chain
    },
  },
}))

import { getOrCreateBankingSubmission } from "@/lib/operations/banking-submission"

beforeEach(() => {
  existingRow = null
  accountRow = { id: "acct-1", company_name: "Brixel LLC", ein_number: "12-3456789" }
  accountContactsRows = [{ contact_id: "contact-1" }]
  contactRow = { first_name: "Marcell", last_name: "Bogyora", email: "marcell@example.com", phone: "+1", citizenship: "Hungary", language: "en" }
  insertedRow = null
  insertError = null
  insertedResult = { id: "new-id", token: "relay-brixel-llc-2026", status: "pending", access_code: "code-1" }
  winnerRowAfterRace = null
  bankingSubmissionsCallCount = 0
})

describe("getOrCreateBankingSubmission — existing row", () => {
  it("returns the existing row and does not insert when one already exists", async () => {
    existingRow = { id: "existing-id", token: "relay-brixel-llc-2026", status: "completed", access_code: "code-x" }
    const result = await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay" })
    expect(result.outcome).toBe("ok")
    if (result.outcome === "ok") {
      expect(result.record.id).toBe("existing-id")
      expect(result.record.created).toBe(false)
      expect(result.record.status).toBe("completed")
    }
    expect(insertedRow).toBeNull()
  })
})

describe("getOrCreateBankingSubmission — creates a new row", () => {
  it("builds the relay token/prefilled_data shape and creates the row", async () => {
    const result = await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay" })
    expect(result.outcome).toBe("ok")
    if (result.outcome === "ok") {
      expect(result.record.created).toBe(true)
      expect(result.record.id).toBe("new-id")
    }
    expect(insertedRow).toMatchObject({
      token: "relay-brixel-llc-2026",
      account_id: "acct-1",
      contact_id: "contact-1",
      provider: "relay",
      status: "pending",
    })
    const prefilled = insertedRow?.prefilled_data as Record<string, string>
    expect(prefilled.business_name).toBe("Brixel LLC")
    expect(prefilled.ein).toBe("12-3456789")
    expect(prefilled.first_name).toBe("Marcell")
  })

  it("builds the payset token/prefilled_data shape (citizenship, no ein)", async () => {
    insertedResult = { id: "new-id-2", token: "bank-brixel-llc-2026", status: "pending", access_code: "code-2" }
    const result = await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "payset" })
    expect(result.outcome).toBe("ok")
    expect(insertedRow).toMatchObject({ token: "bank-brixel-llc-2026", provider: "payset" })
    const prefilled = insertedRow?.prefilled_data as Record<string, string>
    expect(prefilled.personal_country).toBe("Hungary")
    expect(prefilled.ein).toBeUndefined()
  })

  it("truncates a long company slug to 30 characters, matching the job's original token format", async () => {
    accountRow = { id: "acct-1", company_name: "A Very Long Company Name That Exceeds Thirty Characters LLC", ein_number: null }
    await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay" })
    const token = insertedRow?.token as string
    // "relay-" (6) + 30-char slug + "-2026" (5)
    expect(token.startsWith("relay-")).toBe(true)
    const slugPart = token.slice(6, token.length - 5)
    expect(slugPart.length).toBeLessThanOrEqual(30)
  })

  it("resolves the contact via account_contacts when no contactId is passed", async () => {
    await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay" })
    expect(insertedRow?.contact_id).toBe("contact-1")
  })

  it("uses the explicitly passed contactId instead of looking one up", async () => {
    await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay", contactId: "explicit-contact" })
    expect(insertedRow?.contact_id).toBe("explicit-contact")
  })

  it("creates a row with no contact when none can be resolved, rather than failing", async () => {
    accountContactsRows = []
    await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay" })
    expect(insertedRow?.contact_id).toBeNull()
  })
})

describe("getOrCreateBankingSubmission — account missing", () => {
  it("errors cleanly when the account does not exist", async () => {
    accountRow = null
    const result = await getOrCreateBankingSubmission({ accountId: "missing-acct", provider: "relay" })
    expect(result.outcome).toBe("error")
  })
})

describe("getOrCreateBankingSubmission — concurrency", () => {
  it("on a unique-constraint race, re-reads and returns the winner's row instead of erroring", async () => {
    insertError = { code: "23505", message: "duplicate key value violates unique constraint" }
    winnerRowAfterRace = { id: "winner-id", token: "relay-brixel-llc-2026", status: "pending", access_code: "code-w" }
    const result = await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay" })
    expect(result.outcome).toBe("ok")
    if (result.outcome === "ok") {
      expect(result.record.id).toBe("winner-id")
      expect(result.record.created).toBe(false)
    }
  })

  it("surfaces a real (non-race) insert error instead of masking it", async () => {
    insertError = { message: "connection reset" }
    const result = await getOrCreateBankingSubmission({ accountId: "acct-1", provider: "relay" })
    expect(result.outcome).toBe("error")
  })
})
