import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  buildOpenServices,
  classify,
  excludingCards,
  matchExcludingCard,
  type AccountInput,
  type BuildInput,
  type CardInput,
  type ContactInput,
  type JobInput,
  type StepInput,
} from "@/lib/open-services/build"
import { cardClosesOnlyByFiling } from "@/lib/services/renewal-close"
import { WAITING_ON_VALUES } from "@/lib/services/step-settings"
import { WHO_VALUES } from "@/lib/open-services/types"
import { parseParams } from "@/lib/open-services/params"

/**
 * N1a C3 — the Open services tab: what counts as open, what is excluded, who is waiting, what is late, how groups
 * are formed and ordered. All pure: plain data in, plain data out.
 */

const NOW = new Date("2026-10-07T15:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000 - 3_600_000).toISOString()

const STEPS: StepInput[] = [
  { service_type: "Alpha", stage_name: "One", stage_order: 1, waiting_on: "client", sla_days: 7, completes_service: false },
  { service_type: "Alpha", stage_name: "Two", stage_order: 2, waiting_on: "us", sla_days: 3, completes_service: false },
  { service_type: "Alpha", stage_name: "Three", stage_order: 3, waiting_on: "outside", sla_days: null, completes_service: false },
  { service_type: "Alpha", stage_name: "Booked", stage_order: 4, waiting_on: "date", sla_days: 2, completes_service: false },
  { service_type: "Alpha", stage_name: "Over", stage_order: 5, waiting_on: "none", sla_days: null, completes_service: true },
  { service_type: "Beta", stage_name: "Start", stage_order: 10, waiting_on: null, sla_days: 0, completes_service: false },
  { service_type: "Beta", stage_name: "Next", stage_order: 20, waiting_on: null, sla_days: -3, completes_service: false },
]

const ACCOUNTS: AccountInput[] = [
  { id: "a1", company_name: "Acme LLC", is_test: false, is_internal: false, status: "Active" },
  { id: "a2", company_name: "Müller GmbH", is_test: false, is_internal: false, status: "Active" },
  { id: "a-test", company_name: "Test Co", is_test: true, is_internal: false, status: "Active" },
  { id: "a-int", company_name: "Internal Co", is_test: false, is_internal: true, status: "Active" },
  { id: "a-closed", company_name: "Closed Co", is_test: false, is_internal: false, status: "Closed" },
]
const CONTACTS: ContactInput[] = [
  { id: "c1", full_name: "Maria Rossi", is_test: false },
  { id: "c-test", full_name: "QA Person", is_test: true },
]
const CARDS: CardInput[] = [
  { id: "card-renew", display_name: "Renewal Service", metadata: { closes_only_by_filing: true, delivery_service_type: "Renewal Service" } },
  { id: "card-tax", display_name: "Tax Service", metadata: { hidden_from_open_services: "true", delivery_service_type: "Tax Service" } },
  { id: "card-other", display_name: "Other", metadata: { something: "else" } },
]

let seq = 0
function job(over: Partial<JobInput>): JobInput {
  seq++
  return {
    id: `j${String(seq).padStart(3, "0")}`,
    service_type: "Alpha",
    stage: "One",
    status: "active",
    stage_entered_at: daysAgo(1),
    created_at: daysAgo(100),
    account_id: "a1",
    contact_id: null,
    is_test: false,
    service_type_entry_id: null,
    ...over,
  }
}

function run(jobs: JobInput[], paramsRaw: Record<string, string | string[]> = {}, extra: Partial<BuildInput> = {}) {
  return buildOpenServices({ jobs, steps: STEPS, accounts: ACCOUNTS, contacts: CONTACTS, cards: CARDS, now: NOW, ...extra }, parseParams(paramsRaw))
}
const rowsOf = (m: ReturnType<typeof run>) => m.groups.flatMap(g => g.rows)

describe("vocabulary", () => {
  it("the six states are the five step settings plus 'unset' (drift guard)", () => {
    expect([...WAITING_ON_VALUES, "unset"].sort()).toEqual([...WHO_VALUES].sort())
  })
})

describe("what counts as open", () => {
  it("includes NULL status, 'Active' and blocked; drops terminal statuses in any case/spacing", () => {
    const jobs = [
      job({ status: null }), job({ status: "Active" }), job({ status: "blocked" }),
      job({ status: "completed" }), job({ status: " Cancelled " }), job({ status: "CANCELED" }), job({ status: "inactive" }),
    ]
    expect(classify({ jobs, steps: STEPS, accounts: ACCOUNTS, contacts: CONTACTS, cards: CARDS, now: NOW }).items).toHaveLength(3)
  })

  it("drops test jobs, jobs of test/internal companies and of test contacts; keeps NULL is_test", () => {
    const jobs = [
      job({ is_test: true }), job({ account_id: "a-test" }), job({ account_id: "a-int" }),
      job({ account_id: null, contact_id: "c-test" }), job({ is_test: null }),
      job({ account_id: null, contact_id: "c1" }),
    ]
    expect(classify({ jobs, steps: STEPS, accounts: ACCOUNTS, contacts: CONTACTS, cards: CARDS, now: NOW }).items).toHaveLength(2)
  })

  it("keeps jobs of closed companies, shown with a badge and never late", () => {
    const m = run([job({ account_id: "a-closed", stage_entered_at: daysAgo(400) })])
    const r = rowsOf(m)[0]
    expect(r.badges).toContain("company closed")
    expect(r.lateBy).toBeNull()
    expect(r.followUp).toBe("parked")
  })

  it("blocked and on-hold jobs are badged and never late", () => {
    const rows = rowsOf(run([job({ status: "blocked", stage_entered_at: daysAgo(90) }), job({ status: "on_hold", stage_entered_at: daysAgo(90) })]))
    expect(rows.map(r => r.badges[0]).sort()).toEqual(["blocked", "on hold"])
    expect(rows.every(r => r.lateBy === null && r.followUp === "parked")).toBe(true)
  })
})

describe("exclusion by service card (data, not names)", () => {
  it("matches by card link OR by the job type recorded on the card, like the database rule", () => {
    const ordered = excludingCards(CARDS)
    expect(matchExcludingCard({ service_type: "Whatever", service_type_entry_id: "card-renew" }, ordered)?.id).toBe("card-renew")
    expect(matchExcludingCard({ service_type: "Renewal Service", service_type_entry_id: null }, ordered)?.id).toBe("card-renew")
    expect(matchExcludingCard({ service_type: "Tax Service", service_type_entry_id: null }, ordered)?.id).toBe("card-tax")
    expect(matchExcludingCard({ service_type: "Alpha", service_type_entry_id: null }, ordered)).toBeNull()
    expect(matchExcludingCard({ service_type: "Alpha", service_type_entry_id: "card-other" }, ordered)).toBeNull()
  })

  it("agrees with the renewal rule's own matcher for the same cards and jobs (parity)", () => {
    const sample = [
      { service_type: "Renewal Service", service_type_entry_id: null },
      { service_type: "Other", service_type_entry_id: "card-renew" },
      { service_type: "Tax Service", service_type_entry_id: null },
      { service_type: "Alpha", service_type_entry_id: null },
    ]
    const ordered = excludingCards(CARDS)
    for (const j of sample) {
      const mine = matchExcludingCard(j, ordered)?.metadata?.closes_only_by_filing === true
      expect(mine).toBe(cardClosesOnlyByFiling(CARDS, j.service_type, j.service_type_entry_id))
    }
  })

  it("excluded jobs are counted ONCE each, named from their card, and never listed; a job matching two cards counts under the first", () => {
    const both: CardInput[] = [
      { id: "c-hide", display_name: "Hidden Svc", metadata: { hidden_from_open_services: true, delivery_service_type: "Alpha" } },
      { id: "c-close", display_name: "Closing Svc", metadata: { closes_only_by_filing: "true", delivery_service_type: "Alpha" } },
    ]
    const jobs = [job({ service_type: "Renewal Service" }), job({ service_type: "Renewal Service" }), job({ service_type: "Tax Service" }), job({ service_type: "Alpha" })]
    const m = run(jobs)
    expect(m.excluded).toEqual([{ label: "Renewal Service", count: 2 }, { label: "Tax Service", count: 1 }])
    expect(m.totalOpen).toBe(1)
    const m2 = run([job({ service_type: "Alpha" })], {}, { cards: both })
    expect(m2.excluded).toEqual([{ label: "Closing Svc", count: 1 }])
  })

  it("excluded counts use the same open/test predicates (a completed or test renewal job is not counted)", () => {
    const m = run([job({ service_type: "Renewal Service", status: "completed" }), job({ service_type: "Renewal Service", is_test: true }), job({ service_type: "Renewal Service" })])
    expect(m.excluded).toEqual([{ label: "Renewal Service", count: 1 }])
  })
})

describe("who is waiting", () => {
  it("maps each step setting; an unset or unknown value is 'unset'", () => {
    const m = run([
      job({ stage: "One" }), job({ stage: "Two" }), job({ stage: "Three" }), job({ stage: "Booked" }),
      job({ service_type: "Beta", stage: "Start" }),
    ])
    const by = Object.fromEntries(rowsOf(m).map(r => [r.stage, r.who]))
    expect(by).toEqual({ One: "client", Two: "us", Three: "outside", Booked: "date", Start: "unset" })
  })

  it("an open job sitting on the done step is 'Nobody (close it?)'", () => {
    expect(rowsOf(run([job({ stage: "Over" })]))[0].who).toBe("none")
  })

  it("a job on a step missing from the settings (or with no step) is kept: 'unset' + badge, and a warning is raised", () => {
    const m = run([job({ stage: "Ghost" }), job({ stage: null })])
    const rows = rowsOf(m)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.who === "unset" && r.badges.includes("step not in settings") && r.stepNo === null)).toBe(true)
    expect(m.warnings.join(" ")).toMatch(/not in the service's step list/)
  })

  it("step number comes from the settings list, never from the job", () => {
    const rows = rowsOf(run([job({ stage: "Two" }), job({ service_type: "Beta", stage: "Next" })]))
    expect(Object.fromEntries(rows.map(r => [r.stage, r.stepNo]))).toEqual({ Two: 2, Next: 2 })
  })

  it("duplicate step names are tolerated (lowest step number wins) and reported", () => {
    const dup: StepInput[] = [...STEPS, { service_type: "Alpha", stage_name: "One", stage_order: 9, waiting_on: "us", sla_days: 1, completes_service: false }]
    const m = run([job({ stage: "One" })], {}, { steps: dup })
    expect(rowsOf(m)[0].who).toBe("client")
    expect(m.warnings.join(" ")).toMatch(/duplicated/)
  })

  it("matches the step name exactly first, then ignoring case and spaces", () => {
    expect(rowsOf(run([job({ stage: " two " })]))[0].who).toBe("us")
  })
})

describe("days here and late", () => {
  it("late = days past the follow-up days, only when strictly greater (a job exactly at the limit is not late)", () => {
    const rows = rowsOf(run([
      job({ stage: "Two", stage_entered_at: daysAgo(10) }),
      job({ stage: "Two", stage_entered_at: daysAgo(3) }),
      job({ stage: "Two", stage_entered_at: daysAgo(2) }),
    ]))
    const by = rows.map(r => [r.daysHere, r.lateBy, r.followUp, r.daysLeft])
    expect(by).toContainEqual([10, 7, "late", null])
    expect(by).toContainEqual([3, null, "left", 0])
    expect(by).toContainEqual([2, null, "left", 1])
  })

  it("no step date → never late, 'no-date'; garbage dates are treated as no date; future dates clamp to 0", () => {
    const rows = rowsOf(run([
      job({ stage_entered_at: null }), job({ stage_entered_at: "not a date" }), job({ stage_entered_at: new Date(NOW.getTime() + 5 * 86_400_000).toISOString() }),
    ]))
    expect(rows.filter(r => r.followUp === "no-date")).toHaveLength(2)
    const future = rows.find(r => r.daysHere === 0)
    expect(future?.lateBy).toBeNull()
    expect(rows.every(r => r.lateBy === null)).toBe(true)
  })

  it("steps without follow-up days (null, 0 or negative) are never late and say so", () => {
    const rows = rowsOf(run([
      job({ stage: "Three", stage_entered_at: daysAgo(300) }),
      job({ service_type: "Beta", stage: "Start", stage_entered_at: daysAgo(300) }),
      job({ service_type: "Beta", stage: "Next", stage_entered_at: daysAgo(300) }),
    ]))
    expect(rows.every(r => r.lateBy === null && r.followUp === "no-follow-up" && r.followUpDays === null)).toBe(true)
  })

  it("a step that waits for a date is never called late", () => {
    const r = rowsOf(run([job({ stage: "Booked", stage_entered_at: daysAgo(60) })]))[0]
    expect(r.followUp).toBe("date-step")
    expect(r.lateBy).toBeNull()
  })

  it("the 'since' label is in New York time and carries the year only when it is not this year", () => {
    const r = rowsOf(run([job({ stage_entered_at: "2026-04-07T02:30:00Z" }), job({ stage_entered_at: "2025-04-07T20:00:00Z" })]))
    expect(r.map(x => x.sinceLabel).sort()).toEqual(["Apr 6", "Apr 7, 2025"].sort())
  })
})

describe("names", () => {
  it("company name, or the person's name for a job with no company, with the person flag", () => {
    const rows = rowsOf(run([job({ account_id: "a1" }), job({ account_id: null, contact_id: "c1" }), job({ account_id: null, contact_id: null })]))
    expect(rows.map(r => [r.name, r.isPerson]).sort()).toEqual([["(no company or person)", true], ["Acme LLC", false], ["Maria Rossi", true]].sort())
  })

  it("links to the job's workspace", () => {
    const j = job({})
    expect(rowsOf(run([j]))[0].href).toBe(`/flows/${j.id}`)
  })
})

describe("grouping, ordering, filters", () => {
  const jobs = () => [
    job({ stage: "Two", stage_entered_at: daysAgo(20), account_id: "a1" }),
    job({ stage: "Two", stage_entered_at: daysAgo(5), account_id: "a2" }),
    job({ stage: "One", stage_entered_at: daysAgo(30), account_id: "a2" }),
    job({ stage: "Three", stage_entered_at: null, account_id: "a1" }),
    job({ service_type: "Beta", stage: "Start", stage_entered_at: null, account_id: "a1" }),
    job({ service_type: "Beta", stage: "Next", stage_entered_at: null, account_id: "a2" }),
  ]

  it("who view: groups in the fixed order, most late first inside a group", () => {
    const m = run(jobs())
    expect(m.groups.map(g => g.key)).toEqual(["us", "client", "outside", "unset"])
    const us = m.groups[0].rows
    expect(us.map(r => r.lateBy)).toEqual([17, 2])
  })

  it("service view: groups by service, the one with most late jobs first", () => {
    const m = run(jobs(), { view: "service" })
    expect(m.groups.map(g => g.key)).toEqual(["Alpha", "Beta"])
  })

  it("a group where every job is 'Not set' is collapsed; others are not; a matching filter opens it", () => {
    const m = run(jobs())
    const unset = m.groups.find(g => g.key === "unset")!
    expect(unset.collapsed).toBe(true)
    expect(m.groups.find(g => g.key === "us")!.collapsed).toBe(false)
    const filtered = run(jobs(), { q: "acme" })
    expect(filtered.groups.find(g => g.key === "unset")!.collapsed).toBe(false)
  })

  it("group header facts are plain counts", () => {
    const g = run(jobs()).groups.find(x => x.key === "unset")!
    expect(g.facts).toMatchObject({ total: 2, noDate: 2, notSet: 2, late: 0 })
  })

  it("search is case- and accent-insensitive and matches names only", () => {
    expect(rowsOf(run(jobs(), { q: "MULLER" })).every(r => r.name === "Müller GmbH")).toBe(true)
    expect(rowsOf(run(jobs(), { q: "Two" }))).toHaveLength(0)
    expect(rowsOf(run(jobs(), { q: "müller   gmbh" })).length).toBeGreaterThan(0)
  })

  it("who filter and late filter narrow every count; chips ignore only their own filter", () => {
    const m = run(jobs(), { who: "us", late: "1" })
    expect(m.shown).toBe(2)
    expect(rowsOf(m).every(r => r.who === "us" && r.lateBy !== null)).toBe(true)
    // the 'client' chip still shows what it would add (late filter applied, who filter not)
    expect(m.chips.client).toBe(1)
    expect(m.chips.us).toBe(2)
    expect(m.lateChip).toBe(2)
  })

  it("'Show more': the first 25 rows, then more by a larger limit; the order is stable with ties", () => {
    const many = Array.from({ length: 60 }, (_, i) => job({ stage: "Three", stage_entered_at: null, created_at: daysAgo(100 - (i % 3)), account_id: "a1" }))
    const first = run(many).groups.find(g => g.key === "outside")!
    expect(first.rows).toHaveLength(25)
    expect(first.hasMore).toBe(true)
    expect(first.total).toBe(60)
    const grown = run(many, { more: ["outside~50"] }).groups.find(g => g.key === "outside")!
    expect(grown.rows).toHaveLength(50)
    expect(grown.rows.slice(0, 25).map(r => r.id)).toEqual(first.rows.map(r => r.id))
    expect(new Set(grown.rows.map(r => r.id)).size).toBe(50)
    const all = run(many, { more: ["outside~500"] }).groups.find(g => g.key === "outside")!
    expect(all.hasMore).toBe(false)
    expect(all.rows).toHaveLength(60)
    // reversing the input must not change the order (total order)
    const reversed = run([...many].reverse(), { more: ["outside~500"] }).groups.find(g => g.key === "outside")!
    expect(reversed.rows.map(r => r.id)).toEqual(all.rows.map(r => r.id))
  })

  it("the summary counts follow the filters", () => {
    const m = run(jobs())
    expect(m.totalOpen).toBe(6)
    expect(m.noDate).toBe(3)
    expect(m.late).toBe(3)
  })
})
