/**
 * The red Supabase notice must never paint over the phone menu (dev job 362a72a9).
 *
 * On a phone the CRM menu is a drawer (z-50) with a dimmed backdrop (z-40). The notice used to sit at z-95, ABOVE both, so it covered
 * the top of the open drawer and hid its first rows. These pins are relational on purpose: if the drawer, its backdrop or the notice
 * is re-levelled alone, the order breaks and this fails.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

const bar = readFileSync("components/infra/supabase-incident-bar.tsx", "utf8")
const sidebar = readFileSync("components/dashboard/sidebar.tsx", "utf8")

/** The z-index of the phone (no-prefix) class on the line that carries `marker`. */
function phoneZ(source: string, marker: string): number {
  const line = source.split("\n").find((l) => l.includes(marker))
  if (!line) throw new Error(`marker not found: ${marker}`)
  const m = line.match(/(?<![:\w-])z-(?:\[(\d+)\]|(\d+))/)
  if (!m) throw new Error(`no phone z-index on: ${line.trim()}`)
  return Number(m[1] ?? m[2])
}

describe("the red notice and the phone menu", () => {
  const staffLine = 'px-4 py-2 text-sm text-white shadow" data-testid="supabase-incident-bar"'
  const noticeZ = phoneZ(bar, staffLine)
  const backdropZ = phoneZ(sidebar, "fixed inset-0 z-40 bg-black/50 lg:hidden")
  const drawerZ = phoneZ(sidebar, "'fixed inset-y-0 left-0 z-50 w-64")
  const headerZ = phoneZ(sidebar, "fixed top-0 left-0 right-0 z-40 h-14")

  it("on a phone the notice is under the drawer's backdrop, the drawer and the phone header", () => {
    expect(noticeZ).toBeLessThan(backdropZ)
    expect(noticeZ).toBeLessThan(drawerZ)
    expect(noticeZ).toBeLessThan(headerZ)
  })

  it("the drawer is above its own backdrop", () => {
    expect(drawerZ).toBeGreaterThan(backdropZ)
  })

  it("on a computer the notice keeps its old level (there is no drawer there)", () => {
    const line = bar.split("\n").find((l) => l.includes(staffLine)) ?? ""
    expect(line).toContain("lg:z-[95]")
  })

  it("the notice is still above ordinary CRM page content (its sticky headers sit at 30 or below)", () => {
    expect(noticeZ).toBeGreaterThan(30)
  })
})
