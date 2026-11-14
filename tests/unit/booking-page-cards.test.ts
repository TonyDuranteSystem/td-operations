import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Antonio, 14 Nov: there are TWO calendars. The day-to-day work Calendar (New Calendar) must not change; everything for booking lives on the Booking page.
 * "Calls to check" is therefore a section of the Booking page, and these checks pin both halves of that.
 */
const ROOT = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8")
const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))

describe("the day-to-day Calendar knows nothing about the Booking page", () => {
  const files = [...walk("lib/new-calendar"), ...walk("components/new-calendar"), "app/(dashboard)/new-calendar/page.tsx"]
  it("no Calendar file imports the booking code or the Calls to check component, or mentions a calls tab", () => {
    for (const f of files) {
      const text = read(f)
      expect(text, f).not.toMatch(/lib\/booking|calls-to-check|\/api\/booking|tab=calls|CallsToCheck/)
    }
  })
  it("the Calendar's tab list is the one on main (no 'calls' tab)", () => {
    expect(read("lib/new-calendar/params.ts")).toContain('export const TABS = ["jobs", "news", "payments", "applications", "invoices"] as const')
  })
})

describe("the Booking page carries the cards", () => {
  const page = read("app/(dashboard)/booking/page.tsx")
  const workspace = read("components/booking/booking-workspace.tsx")
  it("reads them only after the admin check and the switch, and hands them to the workspace", () => {
    const gate = page.indexOf("isSecureAdmin(user ?? null)")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(page.indexOf("loadOpenChecks("))
    expect(page).toContain("cards={")
  })
  it("shows them as a section of the page, with the count, and never links to the Calendar", () => {
    expect(workspace).toContain("<CallsToCheckTab cards={cards} off={off} />")
    expect(workspace).toContain('data-testid="calls-count"')
    expect(workspace).not.toMatch(/new-calendar|your Calendar/)
    expect(page).not.toMatch(/open-services|requireOpenServicesAccess/)
  })
  it("the answer buttons call the booking route", () => {
    expect(read("components/calls-to-check/calls-tab.tsx")).toContain("/api/booking/checks/")
  })
})
