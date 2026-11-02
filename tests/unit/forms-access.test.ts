/**
 * Forms area access (dev job 6baa1bfc, Antonio 2026-11-02): administrators plus TWO named staff logins
 * (luca@ and support@) may use the Forms page, the bank-application list and the routes behind them.
 * Nobody else — not the rest of the `team` role, not clients/partners/marketing — and no other admin-only page opens.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FORMS_ACCESS_EMAILS, FORMS_AREA_PATHS, hasFormsAccess, isFormsAreaPath } from "@/lib/auth/forms-access"
import { canUseForms } from "@/lib/auth"

const makeUser = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "test-id",
    email: "test@test.com",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-01-01",
    ...overrides,
  }) as any // eslint-disable-line @typescript-eslint/no-explicit-any

describe("the named list", () => {
  it("is exactly Luca and the support login, all lower-case (a typo or widening shows up here)", () => {
    expect([...FORMS_ACCESS_EMAILS]).toEqual(["luca@tonydurante.us", "support@tonydurante.us"])
    for (const e of FORMS_ACCESS_EMAILS) expect(e).toBe(e.toLowerCase())
  })
})

describe("hasFormsAccess", () => {
  it("allows the two named logins with the team role", () => {
    expect(hasFormsAccess("luca@tonydurante.us", "team")).toBe(true)
    expect(hasFormsAccess("support@tonydurante.us", "team")).toBe(true)
  })

  it("ignores letter case and stray spaces in the address", () => {
    expect(hasFormsAccess("  Luca@TonyDurante.us ", "team")).toBe(true)
    expect(hasFormsAccess("SUPPORT@tonydurante.US", "team")).toBe(true)
  })

  it("needs a staff role: a client, partner, marketing, empty or missing role gets nothing even with a listed address", () => {
    for (const role of ["client", "partner", "marketing", "", "  ", "owner", null, undefined]) {
      expect(hasFormsAccess("luca@tonydurante.us", role)).toBe(false)
      expect(hasFormsAccess("support@tonydurante.us", role)).toBe(false)
    }
  })

  it("does not open for anyone else on the team role", () => {
    expect(hasFormsAccess("someone.new@tonydurante.us", "team")).toBe(false)
    expect(hasFormsAccess("rocco@tonydurante.us", "team")).toBe(false)
    expect(hasFormsAccess("jodi@tonydurante.us", "team")).toBe(false)
  })

  it("does not accept look-alike addresses", () => {
    for (const e of [
      "luca@tonydurante.us.evil.com",
      "xluca@tonydurante.us",
      "luca@tonydurante.com",
      "luca.degasper@gmail.com",
      "support@tonydurante.us ,other@x.com",
      "luca@tonydurante.us​",
    ]) {
      expect(hasFormsAccess(e, "team")).toBe(false)
    }
  })

  it("denies an empty or missing address", () => {
    expect(hasFormsAccess("", "team")).toBe(false)
    expect(hasFormsAccess("   ", "team")).toBe(false)
    expect(hasFormsAccess(null, "team")).toBe(false)
    expect(hasFormsAccess(undefined, "team")).toBe(false)
  })
})

describe("isFormsAreaPath", () => {
  it("covers the Forms page, the bank-application list, and everything under them", () => {
    for (const p of ["/forms", "/forms/", "/forms/bank-application/preview", "/bofa-intake", "/bofa-intake/anything"]) {
      expect(isFormsAreaPath(p)).toBe(true)
    }
  })

  it("matches whole path segments only", () => {
    for (const p of ["/", "/formation-form", "/formsx", "/forms-hub", "/bofa-intakes", "/portal/forms", "/api/bofa-intake-admin"]) {
      expect(isFormsAreaPath(p)).toBe(false)
    }
  })

  it("never covers the other administrator-only pages", () => {
    for (const p of ["/research", "/team-management", "/dev-tools", "/dev-tools/x", "/marketing-leads", "/code-tasks"]) {
      expect(isFormsAreaPath(p)).toBe(false)
    }
  })

  it("is exactly the two pages the middleware list protects", () => {
    expect([...FORMS_AREA_PATHS]).toEqual(["/forms", "/bofa-intake"])
  })
})

describe("canUseForms (the answer the menu item and the two staff routes use)", () => {
  it("keeps administrators in", () => {
    expect(canUseForms(makeUser({ email: "antonio.durante@tonydurante.us" }))).toBe(true)
    expect(canUseForms(makeUser({ email: "jodi@tonydurante.us", app_metadata: { role: "admin" } }))).toBe(true)
  })

  it("lets in Luca and the support login", () => {
    expect(canUseForms(makeUser({ email: "luca@tonydurante.us", app_metadata: { role: "team" } }))).toBe(true)
    expect(canUseForms(makeUser({ email: "support@tonydurante.us", app_metadata: { role: "team" } }))).toBe(true)
  })

  it("keeps everyone else out", () => {
    expect(canUseForms(makeUser({ email: "other.staff@tonydurante.us", app_metadata: { role: "team" } }))).toBe(false)
    expect(canUseForms(makeUser({ email: "luca@tonydurante.us", app_metadata: { role: "client" } }))).toBe(false)
    expect(canUseForms(makeUser({ email: "luca@tonydurante.us", app_metadata: { role: "marketing" } }))).toBe(false)
    expect(canUseForms(makeUser({ email: "luca@tonydurante.us", app_metadata: { role: "partner" } }))).toBe(false)
    expect(canUseForms(null)).toBe(false)
  })

  it("ignores a role the account holder wrote into user_metadata", () => {
    expect(canUseForms(makeUser({ email: "luca@tonydurante.us", app_metadata: {}, user_metadata: { role: "team" } }))).toBe(false)
    expect(canUseForms(makeUser({ email: "mallory@x.com", app_metadata: { role: "team" }, user_metadata: { role: "admin" } }))).toBe(false)
  })
})

describe("all three locks use the same rule (a lock left behind is a dead link for the named people)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

  it("the menu item stays administrator-only by default and opens only for the ids the layout passes", () => {
    const sidebar = read("components/dashboard/sidebar.tsx")
    expect(sidebar).toMatch(/id: 'forms'[^\n]*adminOnly: true/)
    expect(sidebar).toContain("item.adminOnly && !isAdmin && !extraNavIds.includes(item.id)")
    const layout = read("app/(dashboard)/layout.tsx")
    expect(layout).toContain("canUseForms(user) ? ['forms'] : []")
    expect(layout).toContain("extraNavIds={extraNavIds}")
  })

  it("the page guard still lists both pages, and only lets the named people past on those two", () => {
    const mw = read("middleware.ts")
    expect(mw).toMatch(/ADMIN_ONLY_PATHS = \[[^\]]*'\/bofa-intake'[^\]]*'\/forms'[^\]]*\]/)
    expect(mw).toContain("isFormsAreaPath(pathname) && hasFormsAccess(user.email, user.app_metadata?.role)")
    expect(mw).toContain("!namedForFormsArea")
  })

  it("both staff routes use canUseForms, not the administrator-only check", () => {
    for (const f of ["app/api/bofa-intake-admin/route.ts", "app/api/bofa-intake-admin/[id]/route.ts"]) {
      const src = read(f)
      expect(src).toContain("canUseForms(user)")
      expect(src).not.toContain("isSecureAdmin")
    }
  })
})
