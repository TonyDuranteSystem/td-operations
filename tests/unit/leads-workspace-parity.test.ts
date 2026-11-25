import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * The Leads list moved from the page at /leads into a shared component shown as the Booking page's "Leads" tab (dev job a1839d8b). Antonio's rule: the Leads
 * behaviour must be IDENTICAL. The strongest proof there is: the body below the imports is the SAME TEXT as the old page's body (stored from main before the
 * move in tests/unit/fixtures/leads-page-body-before-move.txt). Same reads, same filters, same counts, same rows — because it is the same code.
 * The only line allowed to differ is the function's own name line.
 */
const ROOT = path.resolve(__dirname, "../..")
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const START = "const NEW_CALL_WINDOW_DAYS = 14"
const bodyOf = (src: string) => src.slice(src.indexOf(START))
// The ONLY other allowed differences: the two header rows now wrap on a phone (dev job b93caec4, 25 Nov 2026 — class names only, nothing the list reads or shows).
// They are mapped back here so every other line is still proved identical.
const PHONE_WRAP: Array<[string, string]> = [
  ['<div className="flex flex-wrap items-center justify-between gap-3 mb-6">', '<div className="flex items-center justify-between mb-6">'],
  ['<div className="flex flex-wrap items-center gap-3">\n          <CreateLeadButton />', '<div className="flex items-center gap-3">\n          <CreateLeadButton />'],
]
const normalise = (s: string) =>
  PHONE_WRAP.reduce((acc, [now, old]) => acc.replace(now, old), s.replace("export default async function LeadsPage({", "export async function LeadsWorkspace({")).replace(/\s+$/g, "")

describe("the Leads list body is the old page's body, moved unchanged", () => {
  const before = read("tests/unit/fixtures/leads-page-body-before-move.txt")
  const after = read("components/leads/leads-workspace.tsx")

  it("the stored original starts where the shared component's body starts", () => {
    expect(before.startsWith(START)).toBe(true)
    expect(after.includes(START)).toBe(true)
  })

  it("every line from the first constant to the end is identical (only the function name differs)", () => {
    const a = normalise(before)
    const b = normalise(bodyOf(after))
    const al = a.split("\n")
    const bl = b.split("\n")
    expect(bl.length).toBe(al.length)
    const diffs = al.map((line, i) => ({ i, line, now: bl[i] })).filter((x) => x.line !== x.now)
    expect(diffs).toEqual([])
  })

  it("the old page file is gone: /leads is a redirect and reads nothing", () => {
    const page = read("app/(dashboard)/leads/page.tsx")
    expect(page).toContain("redirect(leadsListHref(searchParams))")
    expect(page).not.toMatch(/\.from\(|supabase|createClient/)
  })

  it("the imports the body relies on are all still there, with the same names", () => {
    const head = after.slice(0, after.indexOf(START))
    for (const name of ["createClient", "LeadsTable", "ExistingClientNewCalls", "LeadsKanban", "LeadsViewToggle", "LeadsClientFilterToggle", "CreateLeadButton", "NewLeadFromCallButton", "findExistingClientNewCalls", "findLeadIdsByPhone", "leadSearchOrFilter", "buildClientEmailSet", "isLiveClient", "LeadsFilterBar", "LeadWindowProvider", "supabaseAdmin", "loadClientContacts", "loadAnswers", "resolveForLeads", "parseLeadFilters", "filterLeads", "quickCounts", "distinctValues", "upcomingCallsFirst", "todayInNewYork"]) {
      expect(head, name).toContain(name)
    }
  })
})

describe("every control that changes the Leads list address now stays on the Leads tab", () => {
  const files = [
    "components/leads/leads-filter-bar.tsx",
    "components/leads/leads-table.tsx",
    "app/(dashboard)/leads/components/leads-client-filter-toggle.tsx",
    "app/(dashboard)/leads/components/leads-view-toggle.tsx",
  ]
  for (const f of files) {
    it(`${f} builds its address with leadsListHref and never with a bare /leads?`, () => {
      const src = read(f)
      expect(src).toContain("leadsListHref(")
      expect(src).not.toMatch(/[`'"]\/leads\?/)
    })
  }
  it("deleting a lead returns to the Leads tab, not to the old address", () => {
    const src = read("app/(dashboard)/leads/[id]/components/delete-lead-dialog.tsx")
    expect(src).toContain("leadsListHref()")
    expect(src).not.toMatch(/router\.push\(['"]\/leads['"]\)/)
  })
})
