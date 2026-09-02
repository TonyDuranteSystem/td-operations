/**
 * /owner — every tab that holds fetched rows in state MUST re-fetch on a year change.
 *
 * The bug (observed live 2026-08-30): the year <select> does a router.push, which
 * re-renders the server component and delivers fresh props — but the tabs are NOT
 * remounted, and `useState(initialRows)` is not re-initialised by a prop change.
 * Switching to 2025 left all 78 rows of 2026 data on screen under a 2025 header.
 *
 * Not cosmetic: the modal, the bulk bar and "apply to all like this" act on the rows
 * currently in state, so categorizing from a stale list writes to the OTHER year's
 * records while the page claims otherwise — breaking the hard 2025/2026 separation.
 *
 * These read the real source so removing either reset fails here.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf-8")

describe("Transactions tab re-fetches on year change", () => {
  const src = read("app/(dashboard)/owner/transactions-tab.tsx")

  it("has an effect that depends on year", () => {
    expect(src).toMatch(/useEffect\([\s\S]*?\}, \[year, load\]\)/)
  })

  it("calls load() rather than re-seeding from initialRows", () => {
    // Re-seeding would silently drop the operator's live category filter, since
    // the server always fetches uncategorized-only.
    const effect = src.slice(src.indexOf("const seenYearRef"))
    expect(effect).toContain("load(0)")
    expect(effect).not.toContain("setRows(initialRows)")
  })

  it("clears selection and any open dialog so the previous year cannot be acted on", () => {
    const effect = src.slice(src.indexOf("const seenYearRef"), src.indexOf("}, [year, load])"))
    expect(effect).toContain("setSelected(new Set())")
    expect(effect).toContain("setModal(null)")
    expect(effect).toContain("setOffset(0)")
  })

  it("guards the first run so mount does not duplicate the server fetch", () => {
    expect(src).toContain("if (seenYearRef.current === year) return")
  })
})

describe("P&L tab drops its comparison on year change", () => {
  const src = read("app/(dashboard)/owner/pnl-tab.tsx")

  it("resets both the toggle and the fetched prior-year figures", () => {
    const m = src.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[year\]\)/)
    expect(m, "no effect keyed on year").toBeTruthy()
    expect(m![1]).toContain("setCompare(false)")
    expect(m![1]).toContain("setPriorPnl(null)")
  })
})

describe("Tabs that render straight from props must stay that way", () => {
  // These follow the year correctly BECAUSE they hold no fetched state. If one
  // ever gains useState/fetch, it inherits the stale-year bug and needs the same
  // effect — this test is the tripwire for that.
  for (const tab of ["dashboard-tab", "cashflow-tab", "tax-tab"]) {
    it(`${tab} holds no client state or fetching`, () => {
      const src = read(`app/(dashboard)/owner/${tab}.tsx`)
      expect(src).not.toContain("useState")
      expect(src).not.toContain("fetch(")
    })
  }
})
