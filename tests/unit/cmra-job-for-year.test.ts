import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { cmraJobForYear } from "@/lib/installment-handler"

const job = (id: string, status: string | null, service_name: string | null, created_at: string | null = null) => ({
  id,
  status,
  service_name,
  created_at,
})

describe("cmraJobForYear — no second CMRA job for the same year", () => {
  it("finds an open job (the existing rule)", () => {
    expect(cmraJobForYear([job("a", "active", "CMRA 2026 - X LLC")], 2027)?.id).toBe("a")
  })
  it("finds this year's job even after it closed at CMRA Active", () => {
    expect(cmraJobForYear([job("a", "completed", "CMRA 2027 - X LLC")], 2027)?.id).toBe("a")
  })
  it("a closed job from LAST year does not block this year's", () => {
    expect(cmraJobForYear([job("a", "completed", "CMRA 2026 - X LLC")], 2027)).toBeNull()
  })
  it("a cancelled job never counts, even this year's", () => {
    expect(cmraJobForYear([job("a", "cancelled", "CMRA 2027 - X LLC")], 2027)).toBeNull()
  })
  it("matches the name the handler gives, not any name that merely contains the year", () => {
    expect(cmraJobForYear([job("a", "completed", "Old CMRA 2027")], 2027)).toBeNull()
  })
  it("no jobs, nothing found", () => {
    expect(cmraJobForYear([], 2027)).toBeNull()
  })
  it("a job created this year counts even when its name has no year (activation / backfill names)", () => {
    expect(cmraJobForYear([job("a", "completed", "CMRA Mailing Address - X LLC", "2027-01-08T10:00:00Z")], 2027)?.id).toBe("a")
    expect(cmraJobForYear([job("b", "completed", null, "2027-03-01T00:00:00Z")], 2027)?.id).toBe("b")
  })
  it("a closed job created LAST year does not block this year's", () => {
    expect(cmraJobForYear([job("a", "completed", "CMRA Mailing Address - X LLC", "2026-12-20T10:00:00Z")], 2027)).toBeNull()
  })
})
