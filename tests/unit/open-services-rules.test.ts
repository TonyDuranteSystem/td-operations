import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  PARKING_COMPANY_STATUSES,
  buildOpenServices,
  classify,
  type AccountInput,
  type BuildInput,
  type CardInput,
  type ContactInput,
  type JobInput,
  type StepInput,
} from "@/lib/open-services/build"
import { MAX_LIMIT, PAGE_SIZE } from "@/lib/open-services/types"
import { parseParams } from "@/lib/open-services/params"

/**
 * N1a C3 — the rules the first test file only touched at the edges (found by the post-build review): company-status
 * parking, "every job lands in exactly one place", the tie-breaks of the order, a hand-opened collapsed group, and the
 * paging ceiling. Plain data in, plain data out.
 */

const NOW = new Date("2026-10-07T15:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000 - 3_600_000).toISOString()

const STEPS: StepInput[] = [
  { service_type: "Alpha", stage_name: "One", stage_order: 1, waiting_on: "client", sla_days: 7, completes_service: false },
  { service_type: "Alpha", stage_name: "Two", stage_order: 2, waiting_on: "us", sla_days: 3, completes_service: false },
  { service_type: "Alpha", stage_name: "Three", stage_order: 3, waiting_on: "outside", sla_days: null, completes_service: false },
  { service_type: "Alpha", stage_name: "Booked", stage_order: 4, waiting_on: "date", sla_days: 2, completes_service: false },
  { service_type: "Alpha", stage_name: "Over", stage_order: 5, waiting_on: "none", sla_days: null, completes_service: true },
  { service_type: "Beta", stage_name: "Start", stage_order: 10, waiting_on: null, sla_days: 5, completes_service: false },
  { service_type: "Gamma", stage_name: "Go", stage_order: 1, waiting_on: "us", sla_days: 4, completes_service: false },
  { service_type: "Delta", stage_name: "Go", stage_order: 1, waiting_on: "us", sla_days: 4, completes_service: false },
]

const COMPANY_STATUSES = ["Active", "Pending Formation", "Delinquent", "Suspended", "Offboarding", "Cancelled", "Closed"]
const ACCOUNTS: AccountInput[] = [
  ...COMPANY_STATUSES.map(s => ({ id: `acc-${s.toLowerCase().replace(/\s+/g, "-")}`, company_name: `${s} Co`, is_test: false, is_internal: false, status: s })),
  { id: "acc-null", company_name: "No Status Co", is_test: false, is_internal: false, status: null },
  { id: "acc-shout", company_name: "Shout Co", is_test: false, is_internal: false, status: "ACTIVE " },
]
const CONTACTS: ContactInput[] = [{ id: "c1", full_name: "Maria Rossi", is_test: false }]
const CARDS: CardInput[] = []

let seq = 0
function job(over: Partial<JobInput>): JobInput {
  seq++
  return {
    id: `j${String(seq).padStart(6, "0")}`,
    service_type: "Alpha",
    stage: "One",
    status: "active",
    stage_entered_at: daysAgo(1),
    created_at: daysAgo(100),
    account_id: "acc-active",
    contact_id: null,
    is_test: false,
    service_type_entry_id: null,
    ...over,
  }
}

function inputOf(jobs: JobInput[]): BuildInput {
  return { jobs, steps: STEPS, accounts: ACCOUNTS, contacts: CONTACTS, cards: CARDS, now: NOW }
}
function run(jobs: JobInput[], paramsRaw: Record<string, string | string[]> = {}) {
  return buildOpenServices(inputOf(jobs), parseParams(paramsRaw))
}
const rowsOf = (m: ReturnType<typeof run>) => m.groups.flatMap(g => g.rows)

describe("company status: which companies park their jobs", () => {
  it("only a company that is not operating parks its jobs (suspended / offboarding / cancelled / closed)", () => {
    expect([...PARKING_COMPANY_STATUSES].sort()).toEqual(["cancelled", "closed", "offboarding", "suspended"])
    for (const id of ["acc-suspended", "acc-offboarding", "acc-cancelled", "acc-closed"]) {
      const r = rowsOf(run([job({ account_id: id, stage_entered_at: daysAgo(90) })]))[0]
      expect(r.followUp, id).toBe("parked")
      expect(r.lateBy, id).toBeNull()
      expect(r.badges.some(b => b.startsWith("company ")), id).toBe(true)
    }
  })

  it("a company that is pending formation or delinquent is LIVE work: its job can be late, and it is still badged", () => {
    for (const id of ["acc-pending-formation", "acc-delinquent"]) {
      const m = run([job({ account_id: id, service_type: "Alpha", stage: "Two", stage_entered_at: daysAgo(30) })])
      const r = rowsOf(m)[0]
      expect(r.followUp, id).toBe("late")
      expect(r.lateBy, id).toBe(27) // 30 days there (+1 h) minus the 3-day follow-up
      expect(r.badges.some(b => b.startsWith("company ")), id).toBe(true)
      expect(m.late, id).toBe(1)
    }
  })

  it("an active company (any case/spacing) and a company with no recorded status are not parked and carry no company badge", () => {
    for (const id of ["acc-active", "acc-shout", "acc-null"]) {
      const r = rowsOf(run([job({ account_id: id, stage: "Two", stage_entered_at: daysAgo(10) })]))[0]
      expect(r.followUp, id).toBe("late")
      expect(r.badges.some(b => b.startsWith("company ")), id).toBe(false)
    }
  })
})

describe("every open job lands in exactly one place", () => {
  const mixed = (): JobInput[] => [
    job({ stage: "One" }), job({ stage: "Two", stage_entered_at: daysAgo(20) }), job({ stage: "Three" }),
    job({ stage: "Booked" }), job({ stage: "Over" }), job({ stage: "Not a real step" }), job({ stage: null }),
    job({ service_type: "Beta", stage: "Start" }), job({ service_type: "Gamma", stage: "Go", stage_entered_at: null }),
    job({ service_type: "Delta", stage: "Go", account_id: "acc-closed" }), job({ status: "blocked" }),
    job({ status: null }), job({ account_id: null, contact_id: "c1", service_type: "Gamma", stage: "Go" }),
    job({ account_id: null, contact_id: null, service_type: "Delta", stage: "Go" }),
    job({ is_test: true }), job({ status: "completed" }), job({ status: "cancelled" }),
  ]

  for (const view of ["who", "service"] as const) {
    it(`${view} view, no filter: group totals add up to the open jobs, and each job id appears in one group only`, () => {
      const jobs = mixed()
      const open = classify(inputOf(jobs)).items.length
      const m = run(jobs, { view, more: ["client~5000", "us~5000", "outside~5000", "date~5000", "none~5000", "unset~5000", "Alpha~5000", "Beta~5000", "Gamma~5000", "Delta~5000"] })
      expect(open).toBe(14) // 17 jobs minus the test, completed and cancelled ones
      expect(m.totalOpen).toBe(open)
      expect(m.shown).toBe(open)
      expect(m.groups.reduce((n, g) => n + g.total, 0)).toBe(open)
      const ids = rowsOf(m).map(r => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.length).toBe(open)
    })

    it(`${view} view, with filters: group totals add up to the number shown`, () => {
      const jobs = mixed()
      for (const raw of [{ late: "1" }, { who: "us,client" }, { q: "co" }, { late: "1", who: "us" }, { q: "no-such-name-xyz" }] as Record<string, string>[]) {
        const m = run(jobs, { view, ...raw })
        expect(m.groups.reduce((n, g) => n + g.total, 0), JSON.stringify(raw)).toBe(m.shown)
      }
    })
  }
})

describe("the order inside a group", () => {
  const clientRows = (jobs: JobInput[]) => run(jobs).groups.find(g => g.key === "client")!.rows.map(r => r.id)

  it("most late first; then the longest on the step; then the oldest job; then the id; a job with no date last", () => {
    const late10 = job({ stage_entered_at: daysAgo(17) })           // 17 days on a 7-day step → 10 late
    const late3 = job({ stage_entered_at: daysAgo(10) })            // 3 late
    const notLateOld = job({ stage_entered_at: daysAgo(6) })        // within the follow-up
    const notLateNew = job({ stage_entered_at: daysAgo(2) })
    const noDate = job({ stage_entered_at: null })
    expect(clientRows([noDate, notLateNew, late3, notLateOld, late10])).toEqual([late10.id, late3.id, notLateOld.id, notLateNew.id, noDate.id])
  })

  it("equal lateness and equal step date: the OLDER job (created earlier) comes first; then the smaller id", () => {
    const entered = daysAgo(10)
    const newer = job({ stage_entered_at: entered, created_at: daysAgo(5) })
    const older = job({ stage_entered_at: entered, created_at: daysAgo(50) })
    expect(clientRows([newer, older])).toEqual([older.id, newer.id])
    const a = job({ stage_entered_at: entered, created_at: daysAgo(30) })
    const b = job({ stage_entered_at: entered, created_at: daysAgo(30) })
    expect(clientRows([b, a])).toEqual([a.id, b.id])
  })

  it("a job with no creation date sorts after one that has it", () => {
    const entered = daysAgo(10)
    const dated = job({ stage_entered_at: entered, created_at: daysAgo(50) })
    const undated = job({ stage_entered_at: entered, created_at: null })
    expect(clientRows([undated, dated])).toEqual([dated.id, undated.id])
  })

  it("service view: groups with the same number of late jobs are listed alphabetically; more late jobs first", () => {
    const m = run(
      [job({ service_type: "Delta", stage: "Go" }), job({ service_type: "Gamma", stage: "Go" }), job({ service_type: "Beta", stage: "Start", stage_entered_at: daysAgo(30) })],
      { view: "service" },
    )
    expect(m.groups.map(g => g.key)).toEqual(["Beta", "Delta", "Gamma"]) // Beta has a late job, then D before G
  })
})

describe("a group where nobody's waiting-on is set", () => {
  const betaJobs = () => [job({ service_type: "Beta", stage: "Start" }), job({ service_type: "Beta", stage: "Start" })]

  it("is collapsed by default, open when the visitor opened it by hand, and open when a filter matches inside it", () => {
    expect(run(betaJobs()).groups[0].collapsed).toBe(true)
    expect(run(betaJobs(), { more: "unset~25" }).groups[0].collapsed).toBe(false)
    expect(run(betaJobs(), { who: "unset" }).groups[0].collapsed).toBe(false)
  })

  it("stays collapsed when a filter matches nothing inside it, and a group with any set job is never collapsed", () => {
    const m = run([...betaJobs(), job({ stage: "One" })], { q: "no-such-name-xyz" })
    expect(m.groups).toHaveLength(0)
    const mixedGroup = run([...betaJobs(), job({ stage: "One" })])
    expect(mixedGroup.groups.every(g => g.collapsed === (g.key === "unset"))).toBe(true)
  })

  it("'collapsible' is about the WHOLE group, so a filter cannot make a mixed group offer 'Hide jobs'", () => {
    // Alpha: one job on a real step (waiting on the client) and one on a step that is not in the settings (Not set).
    const mixed = [job({ stage: "One" }), job({ stage: "No such step" })]
    // The filter keeps only the 'Not set' job of the mixed group: the group is still not all-unset.
    const filtered = run(mixed, { view: "service", who: "unset" }).groups.find(g => g.key === "Alpha")!
    expect(filtered.rows).toHaveLength(1)
    expect(filtered.collapsible).toBe(false)
    expect(filtered.facts.notSet).toBe(filtered.facts.total) // the old test of the button: true here, so it wrongly showed
    expect(run(mixed, { view: "service" }).groups.find(g => g.key === "Alpha")!.collapsible).toBe(false)
    expect(run(betaJobs(), { view: "service" }).groups[0].collapsible).toBe(true)
    expect(run(betaJobs(), { view: "service", who: "unset" }).groups[0].collapsible).toBe(true)
  })
})

describe("the paging ceiling", () => {
  const many = (n: number) => Array.from({ length: n }, () => job({ stage: "One" }))

  it("'Show more' keeps working past 500 rows: a group of 532 can be shown whole", () => {
    let m = run(many(532))
    let g = m.groups.find(x => x.key === "client")!
    expect(g.rows).toHaveLength(PAGE_SIZE)
    expect(g.hasMore).toBe(true)
    let guard = 0
    while (g.hasMore && !g.capped && guard++ < 200) {
      m = run(many(532), { more: `client~${g.nextLimit}` })
      g = m.groups.find(x => x.key === "client")!
    }
    expect(g.rows).toHaveLength(532)
    expect(g.hasMore).toBe(false)
    expect(g.capped).toBe(false)
  })

  it("a group larger than the ceiling says so (capped) instead of offering a button that does nothing", () => {
    const g = run(many(MAX_LIMIT + 3), { more: `client~${MAX_LIMIT}` }).groups.find(x => x.key === "client")!
    expect(g.rows).toHaveLength(MAX_LIMIT)
    expect(g.hasMore).toBe(true)
    expect(g.capped).toBe(true)
    expect(g.total - g.rows.length).toBe(3)
    expect(g.nextLimit).toBe(MAX_LIMIT)
  })

  it("a group exactly at the ceiling is whole, not capped", () => {
    const g = run(many(MAX_LIMIT), { more: `client~${MAX_LIMIT}` }).groups.find(x => x.key === "client")!
    expect(g.hasMore).toBe(false)
    expect(g.capped).toBe(false)
  })
})
