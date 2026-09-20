/**
 * lib/public-forms/verify-token-access.ts unit tests.
 *
 * Server-side replacement for the direct anon-key browser queries the public
 * signing pages (SS-4, ITIN, etc.) used to make. Must fail closed: no row, a
 * lookup error, or a wrong/blank code all deny — admin preview only bypasses
 * the code when isStaffPreview (a real staff session) says so, never from
 * the request's own flag — and the returned row must never include
 * access_code, since the caller already has the code and echoing it back
 * would hand the credential to anyone who can see the response.
 *
 * Return shape is deliberately FLAT (error/status/row/isAdmin), not a
 * discriminated union on an `ok` flag — this repo compiles with
 * `strict: false`, where narrowing a union by a boolean literal discriminant
 * does not work (see lib/storage/upload-guard.ts, same convention).
 *
 * The actual code-comparison hardening (fail-closed on blank, constant-time,
 * rate-limited) lives in lib/esign/access-guard.ts and is tested there —
 * this suite mocks it and asserts verifyTokenAccess wires it correctly.
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

const accessCodeError = vi.fn()
vi.mock("@/lib/esign/access-guard", () => ({ accessCodeError: (...args: unknown[]) => accessCodeError(...args) }))

import { verifyTokenAccess } from "@/lib/public-forms/verify-token-access"

const fakeReq = {} as never

describe("verifyTokenAccess", () => {
  beforeEach(() => {
    row = null
    lookupError = null
    lastTable = ""
    lastToken = ""
    isStaffPreview.mockReset()
    isStaffPreview.mockResolvedValue(false)
    accessCodeError.mockReset()
    accessCodeError.mockReturnValue(null)
  })

  it("denies with 404 when no row matches the token", async () => {
    row = null
    const result = await verifyTokenAccess(fakeReq, "ss4_applications", "*", "tok-1", "code-1", false)
    expect(result.error).toBe("Not found")
    expect(result.status).toBe(404)
    expect(lastTable).toBe("ss4_applications")
    expect(lastToken).toBe("tok-1")
    // Never reaches the code check when there's no row to check against.
    expect(accessCodeError).not.toHaveBeenCalled()
  })

  it("denies with 404 when the lookup errors", async () => {
    lookupError = { message: "connection reset" }
    row = { access_code: "1234" }
    const result = await verifyTokenAccess(fakeReq, "ss4_applications", "*", "tok-1", "1234", false)
    expect(result.error).toBe("Not found")
    expect(result.status).toBe(404)
  })

  it("denies with whatever status/message the shared code-check returns", async () => {
    row = { access_code: "1234" }
    accessCodeError.mockReturnValue({ status: 403, error: "Invalid access code." })
    const result = await verifyTokenAccess(fakeReq, "ss4_applications", "*", "tok-1", "wrong", false)
    expect(result.error).toBe("Invalid access code.")
    expect(result.status).toBe(403)
  })

  it("passes the row's access_code, the supplied code, and the resolved preview state to the shared checker", async () => {
    row = { access_code: "1234", company_name: "Test LLC" }
    isStaffPreview.mockResolvedValue(false)
    await verifyTokenAccess(fakeReq, "ss4_applications", "*", "tok-1", "1234", true)
    expect(isStaffPreview).toHaveBeenCalledWith(true)
    expect(accessCodeError).toHaveBeenCalledWith(
      fakeReq,
      expect.objectContaining({ token: "tok-1", expected: "1234", provided: "1234", isPreview: false }),
    )
  })

  it("allows when the shared code-check passes, and strips access_code from the returned row", async () => {
    row = { access_code: "1234", company_name: "Test LLC" }
    const result = await verifyTokenAccess(fakeReq, "ss4_applications", "*", "tok-1", "1234", false)
    expect(result.error).toBeNull()
    expect(result.row).toEqual({ company_name: "Test LLC" })
    expect(result.row).not.toHaveProperty("access_code")
  })

  it("a real staff session (isStaffPreview true) is passed through as isPreview, bypassing the code entirely", async () => {
    row = { access_code: "1234" }
    isStaffPreview.mockResolvedValue(true)
    accessCodeError.mockImplementation((_req, opts) => (opts.isPreview ? null : { status: 403, error: "nope" }))
    const result = await verifyTokenAccess(fakeReq, "ss4_applications", "*", "tok-1", null, true)
    expect(result.error).toBeNull()
    expect(result.isAdmin).toBe(true)
  })
})
