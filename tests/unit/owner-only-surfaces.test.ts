/**
 * Owner-only surfaces must agree with their own guards.
 *
 * The bug these exist to prevent (hit 2026-08-29→30): "My Finances" was shown to
 * every admin while its page admitted only the owner, so an admin clicking it was
 * silently redirected home with no explanation. The same divergence existed on the
 * Finance Expenses tab — writes were owner-only, reads were admin-only.
 *
 * The invariant: an entry's VISIBILITY predicate must be at least as strict as the
 * destination's ACCESS predicate. These read the real source so a future edit that
 * loosens one side without the other fails here.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf-8")

describe("My Finances — sidebar visibility matches the page guard", () => {
  const sidebar = read("components/dashboard/sidebar.tsx")
  const ownerPage = read("app/(dashboard)/owner/page.tsx")

  it("the page admits only the owner", () => {
    expect(ownerPage).toMatch(/isOwnerOnly\(user\)/)
    expect(ownerPage).toMatch(/redirect\('\/'\)/)
  })

  it("the nav entry is ownerOnly, NOT merely adminOnly", () => {
    const entry = sidebar.split("\n").find((l) => l.includes("id: 'owner'"))
    expect(entry, "My Finances nav entry not found").toBeTruthy()
    expect(entry).toContain("ownerOnly: true")
    // adminOnly would show it to every admin — the exact dead-link bug.
    expect(entry).not.toContain("adminOnly: true")
  })

  it("the sidebar actually filters on ownerOnly", () => {
    expect(sidebar).toContain("if (item.ownerOnly && !isOwner) return false")
  })
})

describe("Finance Expenses tab — reads and writes agree", () => {
  const financePage = read("app/(dashboard)/finance/page.tsx")
  const dashboard = read("app/(dashboard)/finance/finance-dashboard.tsx")
  const actions = read("app/(dashboard)/finance/expense-actions.ts")

  it("the write actions are owner-only", () => {
    expect(actions).toMatch(/isOwnerOnly\(user\)/)
  })

  it("the expense DATA is withheld from non-owners on the server", () => {
    // The decisive one: hiding the tab is cosmetic, not sending the rows is not.
    expect(financePage).toMatch(/const tdExpenses = userIsOwner/)
    expect(financePage).toMatch(/const userIsOwner = isOwnerOnly\(user\)/)
  })

  it("the Expenses tab is ownerOnly, not adminOnly", () => {
    const entry = dashboard.split("\n").find((l) => l.includes("id: 'expenses'"))
    expect(entry, "Expenses tab entry not found").toBeTruthy()
    expect(entry).toContain("ownerOnly: true")
    expect(entry).not.toContain("adminOnly: true")
  })

  it("the tab strip filters on ownerOnly", () => {
    expect(dashboard).toContain("(!t.ownerOnly || isOwner)")
  })

  it("the expenses panel re-checks the owner, so ?tab=expenses cannot render it", () => {
    // `tab` seeds from the URL, so the tab-strip filter alone is not enough.
    expect(dashboard).toMatch(/tab === 'expenses' && isOwner/)
  })

  it("does NOT tighten the unrelated card-fee switch, which stays admin-level", () => {
    // Guard against over-reach: this fix is about the owner's own money, not
    // about demoting every admin capability on the Finance page.
    expect(financePage).toMatch(/const userIsTrueAdmin = userIsAdmin/)
  })
})
