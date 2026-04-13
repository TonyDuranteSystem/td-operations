/**
 * Tests for getCompanyEmail — company email resolution with deterministic fallback.
 * Phase 1: communication_email + routing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Hoisted mocks ──────────────────────────────────────────────

const { mockAccountSingle, mockLinksResult } = vi.hoisted(() => ({
  mockAccountSingle: vi.fn(),
  mockLinksResult: vi.fn(),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table === "accounts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: mockAccountSingle,
            }),
          }),
        }
      }
      if (table === "account_contacts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: mockLinksResult,
          }),
        }
      }
      return {}
    }),
  },
}))

import { getCompanyEmail } from "@/lib/portal/queries"

// ─── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Tests ───────────────────────────────────────────────────────

describe("getCompanyEmail", () => {
  it("Test 1: returns communication_email when set", async () => {
    mockAccountSingle.mockResolvedValue({
      data: { communication_email: "hello@ohmycreatives.com" },
    })

    const result = await getCompanyEmail("acc-1")

    expect(result).toBe("hello@ohmycreatives.com")
    // Should NOT query account_contacts (short-circuit)
    expect(mockLinksResult).not.toHaveBeenCalled()
  })

  it("Test 2: falls back to owner contact email when communication_email is null", async () => {
    mockAccountSingle.mockResolvedValue({
      data: { communication_email: null },
    })
    mockLinksResult.mockResolvedValue({
      data: [
        { role: "member", ownership_pct: null, contacts: { email: "member@test.com", created_at: "2026-01-01" } },
        { role: "Owner", ownership_pct: null, contacts: { email: "owner@test.com", created_at: "2026-02-01" } },
      ],
    })

    const result = await getCompanyEmail("acc-1")

    expect(result).toBe("owner@test.com")
  })

  it("Test 3: among multiple owners, picks highest ownership_pct", async () => {
    mockAccountSingle.mockResolvedValue({
      data: { communication_email: null },
    })
    mockLinksResult.mockResolvedValue({
      data: [
        { role: "Owner", ownership_pct: 40, contacts: { email: "minor@test.com", created_at: "2026-01-01" } },
        { role: "Owner", ownership_pct: 60, contacts: { email: "major@test.com", created_at: "2026-02-01" } },
      ],
    })

    const result = await getCompanyEmail("acc-1")

    expect(result).toBe("major@test.com")
  })

  it("Test 4: among tied owners, picks earliest created_at", async () => {
    mockAccountSingle.mockResolvedValue({
      data: { communication_email: null },
    })
    mockLinksResult.mockResolvedValue({
      data: [
        { role: "Owner", ownership_pct: 50, contacts: { email: "later@test.com", created_at: "2026-06-01" } },
        { role: "Owner", ownership_pct: 50, contacts: { email: "earlier@test.com", created_at: "2026-01-01" } },
      ],
    })

    const result = await getCompanyEmail("acc-1")

    expect(result).toBe("earlier@test.com")
  })

  it("Test 5: no owner-role contacts, uses highest ownership_pct among all", async () => {
    mockAccountSingle.mockResolvedValue({
      data: { communication_email: null },
    })
    mockLinksResult.mockResolvedValue({
      data: [
        { role: "member", ownership_pct: 30, contacts: { email: "minor@test.com", created_at: "2026-01-01" } },
        { role: "member", ownership_pct: 70, contacts: { email: "major@test.com", created_at: "2026-02-01" } },
      ],
    })

    const result = await getCompanyEmail("acc-1")

    expect(result).toBe("major@test.com")
  })

  it("Test 6: no contacts linked returns null", async () => {
    mockAccountSingle.mockResolvedValue({
      data: { communication_email: null },
    })
    mockLinksResult.mockResolvedValue({
      data: [],
    })

    const result = await getCompanyEmail("acc-1")

    expect(result).toBeNull()
  })

  it("Test 7: contacts with null emails are skipped", async () => {
    mockAccountSingle.mockResolvedValue({
      data: { communication_email: null },
    })
    mockLinksResult.mockResolvedValue({
      data: [
        { role: "Owner", ownership_pct: null, contacts: { email: null, created_at: "2026-01-01" } },
        { role: "member", ownership_pct: null, contacts: { email: "valid@test.com", created_at: "2026-02-01" } },
      ],
    })

    const result = await getCompanyEmail("acc-1")

    expect(result).toBe("valid@test.com")
  })
})
