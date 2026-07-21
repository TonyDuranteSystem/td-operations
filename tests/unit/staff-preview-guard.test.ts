/**
 * Regression guard for the 2026-07-21 credential-free bypass.
 *
 * Nine public token-gated routes accepted `preview=td` from the REQUEST as proof
 * of staff identity and skipped the access-code check. Combined with tokens
 * derived from the company name + year (public in state registries), that was an
 * unauthenticated path to a client's ITIN — and, on the upload routes, to
 * overwriting a signed IRS form.
 *
 * These tests assert two things:
 *   1. the guard itself fails closed;
 *   2. no route ever again decides admin-preview straight from request data.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

const ROOT = process.cwd()

const getUser = vi.fn()
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser } }),
}))

import { isStaffPreview } from "@/lib/auth/staff-preview"

describe("isStaffPreview — fails closed", () => {
  beforeEach(() => {
    getUser.mockReset()
  })

  it("returns false when the caller did not ask for preview, without even checking the session", async () => {
    getUser.mockResolvedValue({ data: { user: { app_metadata: {} } }, error: null })
    expect(await isStaffPreview(false)).toBe(false)
    expect(getUser).not.toHaveBeenCalled()
  })

  it("returns false when there is no session — the flag alone grants nothing", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await isStaffPreview(true)).toBe(false)
  })

  it("returns false when auth errors", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "boom" } })
    expect(await isStaffPreview(true)).toBe(false)
  })

  it("returns false when auth throws (cookies unavailable)", async () => {
    getUser.mockRejectedValue(new Error("no cookie store"))
    expect(await isStaffPreview(true)).toBe(false)
  })

  it("returns false for a CLIENT-role user", async () => {
    getUser.mockResolvedValue({
      data: { user: { app_metadata: { role: "client" } } },
      error: null,
    })
    expect(await isStaffPreview(true)).toBe(false)
  })

  it("returns true only for a real staff session that asked for preview", async () => {
    getUser.mockResolvedValue({
      data: { user: { app_metadata: { role: "admin" } } },
      error: null,
    })
    expect(await isStaffPreview(true)).toBe(true)
  })
})

/**
 * The routes that carried the bypass. If a new one is added, add it here.
 */
const GUARDED_ROUTES = [
  "app/api/ss4/[token]/pdf/route.ts",
  "app/api/ss4/[token]/upload-signed/route.ts",
  "app/api/8832/[token]/pdf/route.ts",
  "app/api/8832/[token]/upload-signed/route.ts",
  "app/api/signature-request/[token]/upload-signed/route.ts",
  "app/api/sign/[token]/fetch/route.ts",
  "app/api/sign/[token]/pdf/route.ts",
  "app/api/sign/[token]/submit/route.ts",
  "app/api/sign/[token]/decline/route.ts",
]

describe("no route decides admin preview from request data", () => {
  it.each(GUARDED_ROUTES)("%s routes its preview flag through isStaffPreview", (rel) => {
    const path = join(ROOT, rel)
    expect(existsSync(path), `${rel} moved or was deleted — update this list`).toBe(true)
    const src = readFileSync(path, "utf8")

    // It must use the guard.
    expect(src, `${rel} must import the staff-preview guard`).toContain(
      'from "@/lib/auth/staff-preview"',
    )

    // And EVERY admin/preview decision in the file must be produced by the
    // guard. Checked by extracting each assignment and asserting what it is
    // assigned FROM — a negative-lookahead regex is not used here on purpose:
    // `\s*` backtracks and silently false-passes.
    const assignments = [...src.matchAll(/const\s+(is(?:Admin|Preview))\s*=\s*([^\n]*)/g)]
    expect(
      assignments.length,
      `${rel} has no isAdmin/isPreview assignment — did the flag move?`,
    ).toBeGreaterThan(0)

    for (const [, name, expr] of assignments) {
      expect(
        expr.trimStart().startsWith("await isStaffPreview("),
        `${rel}: \`${name}\` is assigned from \`${expr.trim()}\` — it must go through await isStaffPreview()`,
      ).toBe(true)
    }
  })
})
