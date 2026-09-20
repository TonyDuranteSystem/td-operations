/**
 * lib/public-forms/verify-token-access.ts unit tests.
 *
 * Server-side replacement for the direct anon-key browser queries the public
 * signing pages (SS-4, ITIN, etc.) used to make. Must fail closed: no row, a
 * lookup error, or a wrong code all deny — and admin preview only bypasses
 * the code when isStaffPreview (a real staff session) says so, never from
 * the request's own flag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

let row: Record<string, unknown> | null = null
let lookupError: { message: string } | null = null
let lastTable = ""
let lastToken = ""

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      lastTable = table
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: vi.fn(() => chain),
        eq: vi.fn((_col: string, value: string) => {
          lastToken = value
          return chain
        }),
        maybeSingle: vi.fn(() => Promise.resolve({ data: row, error: lookupError })),
      })
      return chain
    },
  },
}))

const isStaffPreview = vi.fn()
vi.mock("@/lib/auth/staff-preview", () => ({ isStaffPreview: (...args: unknown[]) => isStaffPreview(...args) }))

import { verifyTokenAccess } from "@/lib/public-forms/verify-token-access"

describe("verifyTokenAccess", () => {
  beforeEach(() => {
    row = null
    lookupError = null
    lastTable = ""
    lastToken = ""
    isStaffPreview.mockReset()
    isStaffPreview.mockResolvedValue(false)
  })

  it("denies with 404 when no row matches the token", async () => {
    row = null
    const result = await verifyTokenAccess("ss4_applications", "*", "tok-1", "code-1", false)
    expect(result.ok).toBe(false)
    expect((result as { status: number }).status).toBe(404)
    expect(lastTable).toBe("ss4_applications")
    expect(lastToken).toBe("tok-1")
  })

  it("denies with 404 when the lookup errors", async () => {
    lookupError = { message: "connection reset" }
    row = { access_code: "1234" }
    const result = await verifyTokenAccess("ss4_applications", "*", "tok-1", "1234", false)
    expect(result.ok).toBe(false)
    expect((result as { status: number }).status).toBe(404)
  })

  it("denies with 403 when the code does not match and the caller is not staff", async () => {
    row = { access_code: "1234" }
    isStaffPreview.mockResolvedValue(false)
    const result = await verifyTokenAccess("ss4_applications", "*", "tok-1", "wrong", false)
    expect(result.ok).toBe(false)
    expect((result as { status: number }).status).toBe(403)
  })

  it("allows when the code matches", async () => {
    row = { access_code: "1234", company_name: "Test LLC" }
    const result = await verifyTokenAccess("ss4_applications", "*", "tok-1", "1234", false)
    expect(result.ok).toBe(true)
    expect((result as { row: { company_name: string } }).row.company_name).toBe("Test LLC")
    expect((result as { isAdmin: boolean }).isAdmin).toBe(false)
  })

  it("allows a wrong/missing code ONLY when isStaffPreview confirms a real staff session", async () => {
    row = { access_code: "1234" }
    isStaffPreview.mockResolvedValue(true)
    const result = await verifyTokenAccess("ss4_applications", "*", "tok-1", null, true)
    expect(result.ok).toBe(true)
    expect((result as { isAdmin: boolean }).isAdmin).toBe(true)
  })

  it("never trusts the preview flag alone — isStaffPreview is always awaited, never skipped", async () => {
    row = { access_code: "1234" }
    isStaffPreview.mockResolvedValue(false)
    const result = await verifyTokenAccess("ss4_applications", "*", "tok-1", "wrong", true)
    expect(isStaffPreview).toHaveBeenCalledWith(true)
    expect(result.ok).toBe(false)
  })
})
