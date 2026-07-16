/**
 * Submission token — one token per (person, SUBJECT, filing period).
 * Guards the cross-company overwrite class proven live 2026-07-16 (dev job
 * 8cc8e1c8): same owner, two companies, one calendar year must NEVER mint
 * the same token (the tables upsert on token).
 */

import { describe, it, expect } from "vitest"
import { buildSubmissionToken, slugifyClientName } from "@/lib/portal/submission-token"

const base = { clientName: "Uxio Test", calendarYear: 2026 }

describe("buildSubmissionToken", () => {
  it("two companies of the SAME owner in the SAME year get DIFFERENT tokens", () => {
    const a = buildSubmissionToken({ ...base, wizardType: "tax", taxYear: 2025, accountId: "30c2cd96-03e4-43cf-9536-81d961b18b1d" })
    const b = buildSubmissionToken({ ...base, wizardType: "tax", taxYear: 2025, accountId: "6bc4fd3f-7ac1-4019-8186-d50caa75b18c" })
    expect(a).not.toBe(b)
    expect(a).toBe("portal-uxio-test-ty2025-30c2cd96")
    expect(b).toBe("portal-uxio-test-ty2025-6bc4fd3f")
  })

  it("tax tokens use the PINNED TAX year, not the calendar year (back-filing two years can't collide)", () => {
    const y24 = buildSubmissionToken({ ...base, wizardType: "tax", taxYear: 2024, accountId: "30c2cd96-aaaa" })
    const y25 = buildSubmissionToken({ ...base, wizardType: "tax", taxYear: 2025, accountId: "30c2cd96-aaaa" })
    expect(y24).toContain("-ty2024-")
    expect(y25).toContain("-ty2025-")
    expect(y24).not.toBe(y25)
  })

  it("same client retrying the same submit rebuilds the identical token (upsert idempotency)", () => {
    const p = { ...base, wizardType: "tax", taxYear: 2025, accountId: "30c2cd96-03e4" } as const
    expect(buildSubmissionToken(p)).toBe(buildSubmissionToken(p))
  })

  it("formation (lead-scoped): two new companies of one person differ by lead", () => {
    const a = buildSubmissionToken({ ...base, wizardType: "formation", leadId: "aaaaaaaa-1111" })
    const b = buildSubmissionToken({ ...base, wizardType: "formation", leadId: "bbbbbbbb-2222" })
    expect(a).toBe("portal-uxio-test-2026-aaaaaaaa")
    expect(b).toBe("portal-uxio-test-2026-bbbbbbbb")
  })

  it("account outranks lead outranks contact as the scope discriminator", () => {
    const t = buildSubmissionToken({ ...base, wizardType: "onboarding", accountId: "acc11111", leadId: "lead2222", contactId: "ctc33333" })
    expect(t.endsWith("-acc11111")).toBe(true)
    const t2 = buildSubmissionToken({ ...base, wizardType: "onboarding", leadId: "lead2222", contactId: "ctc33333" })
    expect(t2.endsWith("-lead2222")).toBe(true)
    const t3 = buildSubmissionToken({ ...base, wizardType: "onboarding", contactId: "ctc33333" })
    expect(t3.endsWith("-ctc33333")).toBe(true)
  })

  it("no scope at all falls back to the legacy shape (no trailing dash)", () => {
    expect(buildSubmissionToken({ ...base, wizardType: "onboarding" })).toBe("portal-uxio-test-2026")
  })

  it("tax without a pinned year falls back to the calendar year (defensive — the gate should prevent this)", () => {
    expect(buildSubmissionToken({ ...base, wizardType: "tax", taxYear: null, accountId: "acc11111" }))
      .toBe("portal-uxio-test-2026-acc11111")
  })

  it("slug: lowercases, strips punctuation/accents to dashes, caps at 40 chars", () => {
    expect(slugifyClientName("Márk O'Brien  Jr.")).toBe("m-rk-o-brien-jr-")
    expect(slugifyClientName("x".repeat(60)).length).toBe(40)
  })
})
