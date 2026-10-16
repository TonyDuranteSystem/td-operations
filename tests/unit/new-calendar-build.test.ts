import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  bucketOf,
  buildNewCalendar,
  classifyClosed,
  finishedAt,
  nextText,
  type ClosedJobInput,
  type NewCalendarInput,
} from "@/lib/new-calendar/build"
import type { AccountInput, CardInput, ContactInput, JobInput, StepInput } from "@/lib/open-services/build"
import { assembleWaitKinds, catalogWaitKind, type Row, type WaitKind } from "@/lib/open-services/types"
import { parseParams, type RawSearchParams } from "@/lib/new-calendar/params"
import { BUCKETS, PAGE_SIZE } from "@/lib/new-calendar/types"

/**
 * New Calendar — which list each job lands in, what the chips count, what the Closed list holds. All pure: plain data in,
 * plain data out. Service and step names below are invented test names, never the real ones.
 */

const NOW = new Date("2026-10-16T15:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000 - 3_600_000).toISOString()
const dateDaysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)

const STEPS: StepInput[] = [
  { service_type: "Alpha", stage_name: "One", stage_order: 1, waiting_on: "client", sla_days: 7, completes_service: false },
  { service_type: "Alpha", stage_name: "Two", stage_order: 2, waiting_on: "us", sla_days: 3, completes_service: false },
  { service_type: "Alpha", stage_name: "Three", stage_order: 3, waiting_on: "outside", sla_days: null, completes_service: false },
  { service_type: "Alpha", stage_name: "Booked", stage_order: 4, waiting_on: "date", sla_days: 2, completes_service: false },
  { service_type: "Alpha", stage_name: "Over", stage_order: 5, waiting_on: "none", sla_days: null, completes_service: true },
  { service_type: "Gamma", stage_name: "Start", stage_order: 1, waiting_on: null, sla_days: null, completes_service: false },
  {
    service_type: "Delta",
    stage_name: "Wrap",
    stage_order: 1,
    waiting_on: "us",
    sla_days: null,
    completes_service: false,
    stage_layout: { components: [{ type: "info_panel" }, { type: "closure_wrapup" }] },
  },
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
function done(over: Partial<ClosedJobInput>): ClosedJobInput {
  seq++
  return {
    id: `d${String(seq).padStart(3, "0")}`,
    service_type: "Alpha",
    stage: "Over",
    account_id: "a1",
    contact_id: null,
    is_test: false,
    service_type_entry_id: null,
    end_date: null,
    stage_entered_at: daysAgo(2),
    ...over,
  }
}

function run(jobs: JobInput[], raw: RawSearchParams = {}, closed: ClosedJobInput[] = [], extra: Partial<NewCalendarInput> = {}) {
  return buildNewCalendar(
    { jobs, steps: STEPS, accounts: ACCOUNTS, contacts: CONTACTS, cards: CARDS, closed, now: NOW, ...extra },
    parseParams(raw),
  )
}
const idsOf = (m: ReturnType<typeof run>) => m.rows.map(r => r.id)

describe("which list an open job lands in", () => {
  const cases: Array<[string, Partial<JobInput>, string, string]> = [
    ["a step that is ours", { stage: "Two" }, "work", "Do: Two"],
    ["a step that is ours but past its follow-up days", { stage: "Two", stage_entered_at: daysAgo(10) }, "work", "Follow up: Two"],
    ["a step waiting on the client", { stage: "One" }, "pending", "Waiting on the client: One"],
    ["a client step past its follow-up days comes back to work", { stage: "One", stage_entered_at: daysAgo(12) }, "work", "Follow up: One"],
    ["a step waiting on an outside office", { stage: "Three", stage_entered_at: daysAgo(90) }, "pending", "Waiting on an outside office: Three"],
    ["a step waiting on a date is never late", { stage: "Booked", stage_entered_at: daysAgo(90) }, "pending", "Waiting on a date: Booked"],
    ["the last step (nobody is waiting)", { stage: "Over" }, "work", "Last step reached: close it"],
    ["a step with no waiting-on setting", { service_type: "Gamma", stage: "Start" }, "other", "Waiting-on not set for this step"],
    ["a step that is not in the settings", { stage: "Mystery" }, "other", "Waiting-on not set for this step"],
    ["a blocked job", { stage: "Two", status: "blocked" }, "pending", "Paused: blocked"],
    ["a job on hold", { stage: "Two", status: "on_hold" }, "pending", "Paused: on hold"],
    ["a job of a closed company", { stage: "Two", account_id: "a-closed" }, "pending", "Paused: company closed"],
  ]
  for (const [label, over, bucket, next] of cases) {
    it(`${label} → ${bucket}`, () => {
      const m = run([job(over)], { b: bucket })
      expect(m.rows).toHaveLength(1)
      expect(m.rows[0].bucket).toBe(bucket)
      expect(m.rows[0].next).toBe(next)
    })
  }

  it("a late follow-up shows the Overdue pill and the late days; an ordinary job shows its list's pill", () => {
    const late = run([job({ stage: "One", stage_entered_at: daysAgo(10) })]).rows[0]
    expect(late.pill).toBe("late")
    expect(late.lateBy).toBe(3)
    const plain = run([job({ stage: "Two" })]).rows[0]
    expect(plain.pill).toBe("work")
    expect(plain.lateBy).toBeNull()
  })

  it("a late job with no waiting-on setting stays under Not sorted yet and still shows its late days", () => {
    const m = run([job({ service_type: "Gamma", stage: "Start", stage_entered_at: daysAgo(40) })], { b: "other" })
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0].bucket).toBe("other")
    expect(m.workToday).toBe(0)
  })

  it("bucketOf: a paused job is never counted late and a late job outranks the step's owner", () => {
    // `behaviour` is what the row's kind means (resolved once from the kind list): ours / client / other / date / none, or null = no setting.
    const base = { followUp: "left", lateBy: null, who: "client", behaviour: "client" } as unknown as Row
    expect(bucketOf({ ...base, followUp: "parked", lateBy: 4, who: "us", behaviour: "ours" } as Row)).toBe("pending")
    expect(bucketOf({ ...base, followUp: "late", lateBy: 4, who: "outside", behaviour: "other" } as Row)).toBe("work")
    expect(bucketOf({ ...base, who: "unset", behaviour: null } as Row)).toBe("other")
    // not even a late job with no waiting-on setting is guessed into To work on; a paused one still waits
    expect(bucketOf({ ...base, followUp: "late", lateBy: 9, who: "unset", behaviour: null } as Row)).toBe("other")
    expect(bucketOf({ ...base, followUp: "parked", lateBy: null, who: "unset", behaviour: null } as Row)).toBe("pending")
  })

  it("bucketOf follows the kind's behaviour, not its name: a kind added to the list sorts like its behaviour", () => {
    const base = { followUp: "left", lateBy: null } as unknown as Row
    expect(bucketOf({ ...base, who: "the_bank", behaviour: "other" } as Row)).toBe("pending")
    expect(bucketOf({ ...base, who: "the_notary", behaviour: "date" } as Row)).toBe("pending")
    expect(bucketOf({ ...base, who: "us", behaviour: "ours" } as Row)).toBe("work")
    expect(bucketOf({ ...base, who: "none", behaviour: "none" } as Row)).toBe("work")
  })

  it("nextText says 'No step recorded' for a job with no step", () => {
    expect(nextText({ followUp: "no-date", lateBy: null, who: "unset", behaviour: null, stage: "  ", badges: [] } as unknown as Row)).toBe("No step recorded")
  })

  it("a step that asks for a pop-up gives its row the pop-up (from the layout data, no name in code)", () => {
    const m = run([job({ service_type: "Delta", stage: "Wrap" }), job({ stage: "Two" })])
    const wrap = m.rows.find(r => r.serviceType === "Delta")!
    expect(wrap.popup).toBe("closure_wrapup")
    expect(m.rows.find(r => r.serviceType === "Alpha")!.popup).toBeNull()
  })
})

describe("every open job is in exactly one list, and the people rules hold", () => {
  const jobs = () => [
    job({ stage: "Two" }),
    job({ stage: "Two", stage_entered_at: daysAgo(10) }),
    job({ stage: "One" }),
    job({ stage: "One", stage_entered_at: daysAgo(12) }),
    job({ stage: "Three" }),
    job({ stage: "Booked" }),
    job({ stage: "Over" }),
    job({ service_type: "Gamma", stage: "Start" }),
    job({ stage: "Two", status: "blocked" }),
    job({ stage: "Two", account_id: "a-closed" }),
    job({ stage: "Two", is_test: true }),
    job({ stage: "Two", account_id: "a-test" }),
    job({ stage: "Two", account_id: "a-int" }),
    job({ stage: "Two", account_id: null, contact_id: "c-test" }),
    job({ stage: "Two", status: "completed" }),
    job({ service_type: "Renewal Service", stage: "Filing" }),
    job({ service_type: "Tax Service", stage: "Prep" }),
  ]

  it("the list counts add up to the open jobs on the page", () => {
    const m = run(jobs())
    expect(m.openTotal).toBe(10)
    expect(m.counts.work + m.counts.pending + m.counts.other).toBe(m.openTotal)
    expect(m.counts).toEqual({ work: 4, pending: 5, other: 1, closed: 0 })
    expect(m.workToday).toBe(4)
  })

  it("test jobs, test and internal companies, test people and finished jobs never show; renewal and tax jobs are counted as living elsewhere", () => {
    const m = run(jobs())
    expect(m.excluded.map(e => `${e.label}:${e.count}`).sort()).toEqual(["Renewal Service:1", "Tax Service:1"])
    for (const b of BUCKETS) {
      for (const r of run(jobs(), { b }).rows) {
        expect(["Test Co", "Internal Co", "QA Person"]).not.toContain(r.name)
      }
    }
  })

  it("a job belonging to a person shows the person's name", () => {
    const m = run([job({ stage: "Two", account_id: null, contact_id: "c1" })])
    expect(m.rows[0].name).toBe("Maria Rossi")
    expect(m.rows[0].isPerson).toBe(true)
  })

  it("the morning number ignores search and filters; the list counts follow the search", () => {
    const js = [job({ stage: "Two", account_id: "a1" }), job({ stage: "Two", account_id: "a2" }), job({ stage: "One", account_id: "a2" })]
    const all = run(js)
    const searched = run(js, { q: "muller" })
    expect(searched.workToday).toBe(all.workToday)
    expect(searched.openTotal).toBe(all.openTotal)
    expect(all.counts.work).toBe(2)
    expect(searched.counts).toEqual({ work: 1, pending: 1, other: 0, closed: 0 })
    expect(searched.rows.map(r => r.name)).toEqual(["Müller GmbH"])
  })

  it("search is case- and accent-insensitive and treats typed symbols as plain text", () => {
    const js = [job({ stage: "Two", account_id: "a2" })]
    expect(run(js, { q: "MÜLLER" }).rows).toHaveLength(1)
    expect(run(js, { q: "muller" }).rows).toHaveLength(1)
    expect(run(js, { q: ".*" }).rows).toHaveLength(0)
    expect(run(js, { q: "'; drop table accounts;--" }).rows).toHaveLength(0)
  })
})

describe("order", () => {
  it("most overdue first, then the oldest step date", () => {
    const a = job({ stage: "Two", stage_entered_at: daysAgo(4) }) // 1 d late
    const b = job({ stage: "Two", stage_entered_at: daysAgo(10) }) // 7 d late
    const c = job({ stage: "Two", stage_entered_at: daysAgo(2) }) // not late
    const d = job({ stage: "Over", stage_entered_at: daysAgo(30) }) // no follow-up days, oldest
    expect(idsOf(run([c, a, d, b]))).toEqual([b.id, a.id, d.id, c.id])
  })
})

describe("service and step chips", () => {
  const js = () => [
    job({ stage: "Two" }),
    job({ stage: "Two" }),
    job({ stage: "One" }),
    job({ stage: "One", stage_entered_at: daysAgo(12) }), // late → work
    job({ service_type: "Delta", stage: "Wrap" }),
  ]

  it("service chips describe the chosen list, biggest first", () => {
    const m = run(js())
    expect(m.services).toEqual([{ name: "Alpha", count: 3 }, { name: "Delta", count: 1 }])
    expect(run(js(), { b: "pending" }).services).toEqual([{ name: "Alpha", count: 1 }])
  })

  it("choosing a service narrows the list and shows that service's own steps, in order, with how many jobs sit on each", () => {
    const m = run(js(), { s: "Alpha" })
    expect(m.rows).toHaveLength(3)
    expect(m.steps.map(s => `${s.name}:${s.count}:${s.waitingOn}`)).toEqual([
      "One:2:client",
      "Two:2:us",
      "Three:0:outside",
      "Booked:0:date",
      "Over:0:none",
    ])
  })

  it("no steps are listed until a service is chosen, nor on the Closed list", () => {
    expect(run(js()).steps).toEqual([])
    expect(run(js(), { b: "closed", s: "Alpha" }).steps).toEqual([])
  })

  it("choosing a step shows EVERY open job on that step, whichever list it is in, and no list is the active one", () => {
    const m = run(js(), { s: "Alpha", st: "One" })
    expect(m.active).toBeNull()
    expect(m.rows).toHaveLength(2)
    expect(m.rows.map(r => r.bucket).sort()).toEqual(["pending", "work"])
    expect(m.total).toBe(2)
  })

  it("a step without its service is ignored (the address parser drops it)", () => {
    expect(parseParams({ st: "One" }).st).toBe("")
    expect(run(js(), { st: "One" }).active).toBe("work")
  })

  it("a step name that matches nothing gives an empty list, not an error", () => {
    const m = run(js(), { s: "Alpha", st: "Nope" })
    expect(m.rows).toEqual([])
    expect(m.total).toBe(0)
  })
})

describe("names the web address would alter", () => {
  const STEPS2: StepInput[] = [
    { service_type: "Delta’s  Work", stage_name: "Client’s  review", stage_order: 1, waiting_on: "us", sla_days: null, completes_service: false },
  ]
  it("a service or step with a curly apostrophe or doubled spaces still shows its jobs under its chip (chip, step view and service filter agree)", () => {
    const j = [job({ service_type: "Delta’s  Work", stage: "Client’s  review" })]
    const base = { steps: STEPS2 }
    const chosen = run(j, { s: "Delta's Work" }, [], base)
    expect(chosen.rows).toHaveLength(1)
    expect(chosen.steps).toHaveLength(1)
    expect(chosen.steps[0].count).toBe(1)
    const stepView = run(j, { s: "Delta's Work", st: "Client's review" }, [], base)
    expect(stepView.rows).toHaveLength(1)
    expect(stepView.total).toBe(1)
  })
})

describe("the Closed list", () => {
  it("holds jobs finished in the last 30 days, most recent first, with the day on the row", () => {
    const m = run([], { b: "closed" }, [
      done({ stage_entered_at: daysAgo(20), end_date: null }),
      done({ stage_entered_at: daysAgo(3), end_date: null }),
      done({ stage_entered_at: daysAgo(40), end_date: null }),
    ])
    expect(m.counts.closed).toBe(2)
    expect(m.rows).toHaveLength(2)
    expect(m.rows[0].finishedLabel).toBe("Oct 13")
    expect(m.rows[1].finishedLabel).toBe("Sep 26")
    expect(m.rows.every(r => r.bucket === "closed" && r.pill === "closed" && r.next === "Finished")).toBe(true)
  })

  it("prefers the recorded end date over the day the job reached its last step", () => {
    const j = done({ end_date: dateDaysAgo(5), stage_entered_at: daysAgo(200) })
    expect(finishedAt(j)).toBe(Date.parse(`${dateDaysAgo(5)}T12:00:00Z`))
    expect(run([], { b: "closed" }, [j]).rows).toHaveLength(1)
    const old = done({ end_date: dateDaysAgo(60), stage_entered_at: daysAgo(2) })
    expect(run([], { b: "closed" }, [old]).rows).toHaveLength(0)
  })

  it("a finished job with no date at all is left out rather than guessed", () => {
    expect(finishedAt({ end_date: null, stage_entered_at: null })).toBeNull()
    expect(run([], { b: "closed" }, [done({ end_date: null, stage_entered_at: null })]).rows).toHaveLength(0)
  })

  it("leaves out test jobs, test and internal companies, test people, and jobs that live on another page", () => {
    const closed = [
      done({ is_test: true }),
      done({ account_id: "a-test" }),
      done({ account_id: "a-int" }),
      done({ account_id: null, contact_id: "c-test" }),
      done({ service_type: "Renewal Service" }),
      done({ service_type: "Tax Service" }),
      done({}),
    ]
    expect(classifyClosed({ jobs: [], steps: STEPS, accounts: ACCOUNTS, contacts: CONTACTS, cards: CARDS, closed, now: NOW })).toHaveLength(1)
  })

  it("is filtered by service and by search, and never has step chips", () => {
    const closed = [done({ service_type: "Alpha" }), done({ service_type: "Delta", account_id: "a2" })]
    const m = run([], { b: "closed" }, closed)
    expect(m.services.map(s => s.name).sort()).toEqual(["Alpha", "Delta"])
    expect(run([], { b: "closed", s: "Delta" }, closed).rows).toHaveLength(1)
    expect(run([], { b: "closed", q: "muller" }, closed).rows.map(r => r.name)).toEqual(["Müller GmbH"])
  })

  it("a job read by both the open and the finished read (finished in between) stays in the open list only", () => {
    const j = job({ stage: "Two" })
    const m = run([j], { b: "closed" }, [done({ id: j.id })])
    expect(m.counts.closed).toBe(0)
    expect(m.counts.work).toBe(1)
  })

  it("a step filter on the Closed list is ignored", () => {
    const m = run([], { b: "closed", s: "Alpha", st: "Over" }, [done({})])
    expect(m.active).toBe("closed")
    expect(m.rows).toHaveLength(1)
  })
})

describe("paging", () => {
  const many = (n: number) => Array.from({ length: n }, () => job({ stage: "Two" }))

  it(`shows ${PAGE_SIZE} rows and says how many remain`, () => {
    const m = run(many(PAGE_SIZE + 7))
    expect(m.rows).toHaveLength(PAGE_SIZE)
    expect(m.total).toBe(PAGE_SIZE + 7)
    expect(m.hasMore).toBe(true)
    expect(m.capped).toBe(false)
  })

  it("'n' asks for more; the ceiling is stated, not hidden", () => {
    expect(run(many(PAGE_SIZE + 7), { n: String(PAGE_SIZE * 2) }).rows).toHaveLength(PAGE_SIZE + 7)
    expect(run(many(10), { n: "999999" }).hasMore).toBe(false)
  })
})

describe("the empty database", () => {
  it("is all zeros, with a valid model", () => {
    const m = run([])
    expect(m.workToday).toBe(0)
    expect(m.counts).toEqual({ work: 0, pending: 0, other: 0, closed: 0 })
    expect(m.rows).toEqual([])
    expect(m.hasMore).toBe(false)
  })
})


describe("kinds from the waiting-on list (a kind added later sorts by what it DOES, never by its name)", () => {
  const KINDS: WaitKind[] = assembleWaitKinds([
    catalogWaitKind("outside", "An outside office", "other"),
    catalogWaitKind("date", "A date", "date"),
    catalogWaitKind("the_irs", "The IRS", "other"),
    catalogWaitKind("court_day", "Court day", "date"),
    catalogWaitKind("old_bank", "Old bank", "other", true),
  ])
  const KSTEPS: StepInput[] = [
    { service_type: "Zeta", stage_name: "Filed", stage_order: 1, waiting_on: "the_irs", sla_days: 5, completes_service: false },
    { service_type: "Zeta", stage_name: "Hearing", stage_order: 2, waiting_on: "court_day", sla_days: 2, completes_service: false },
    { service_type: "Zeta", stage_name: "Bank", stage_order: 3, waiting_on: "old_bank", sla_days: 3, completes_service: false },
    { service_type: "Zeta", stage_name: "Lost", stage_order: 4, waiting_on: "gone_kind", sla_days: 3, completes_service: false },
    { service_type: "Zeta", stage_name: "Mine", stage_order: 5, waiting_on: "us", sla_days: 3, completes_service: false },
    { service_type: "Zeta", stage_name: "End", stage_order: 6, waiting_on: "the_irs", sla_days: null, completes_service: true },
  ]
  const krun = (jobs: JobInput[], raw: RawSearchParams = {}) =>
    run(jobs, raw, [], { steps: KSTEPS, waitKinds: KINDS, waitKindProblems: [] })
  const z = (stage: string, over: Partial<JobInput> = {}) => job({ service_type: "Zeta", stage, ...over })

  it("a step on a list kind waits under Pending, says who in the pill and the next step, and is late like any other wait", () => {
    const r = krun([z("Filed")], { b: "pending" }).rows[0]
    expect(r.bucket).toBe("pending")
    expect(r.pillLabel).toBe("Waiting on the IRS")
    expect(r.next).toBe("Waiting on the IRS: Filed")
    expect(r.behaviour).toBe("other")
    const late = krun([z("Filed", { stage_entered_at: daysAgo(9) })]).rows[0]
    expect(late.bucket).toBe("work")
    expect(late.pill).toBe("late")
    expect(late.pillLabel).toBe("Overdue")
  })

  it("a kind with the 'date' behaviour is never late, whatever its name", () => {
    const r = krun([z("Hearing", { stage_entered_at: daysAgo(90) })], { b: "pending" }).rows[0]
    expect(r.bucket).toBe("pending")
    expect(r.lateBy).toBeNull()
    expect(r.pillLabel).toBe("Waiting on Court day")
  })

  it("a RETIRED kind still classifies the steps that use it", () => {
    const r = krun([z("Bank")], { b: "pending" }).rows[0]
    expect(r.behaviour).toBe("other")
    expect(r.pillLabel).toBe("Waiting on Old bank")
  })

  it("a step pointing at a kind that no longer exists is Not sorted AND the page says so (never silent)", () => {
    const m = krun([z("Lost")], { b: "other" })
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0].pillLabel).toBe("Not sorted")
    expect(m.warnings.join(" ")).toMatch(/no longer in the list \("gone_kind"\)/)
  })

  it("problems found while reading the list are shown in the warnings", () => {
    const m = krun([z("Mine")]).warnings
    expect(m).toEqual([])
    const withProblem = run([z("Mine")], {}, [], { steps: KSTEPS, waitKinds: KINDS, waitKindProblems: ['The waiting-on kind "x" has behaviour "banana", which a list kind cannot have; it is ignored.'] })
    expect(withProblem.warnings.join(" ")).toContain("banana")
  })

  it("the done step wins, and finished jobs carry the 'nobody' kind", () => {
    const r = krun([z("End")], { b: "work" }).rows[0]
    expect(r.who).toBe("none")
    expect(r.behaviour).toBe("none")
    const closed = run([], { b: "closed" }, [done({ service_type: "Zeta", stage: "End", end_date: dateDaysAgo(3) })], { steps: KSTEPS, waitKinds: KINDS }).rows[0]
    expect(closed.who).toBe("none")
    expect(closed.pillLabel).toBe("Closed")
  })

  describe("the Waiting on chips (Pending list only)", () => {
    const jobs = () => [z("Filed"), z("Filed"), z("Hearing"), z("Mine", { status: "blocked" }), z("Mine")]
    it("one chip per kind of wait that has jobs, in list order, plus Paused; empty kinds are not shown", () => {
      const m = krun(jobs(), { b: "pending" })
      expect(m.waiting.map(c => [c.key, c.label, c.count])).toEqual([["the_irs", "The IRS", 2], ["court_day", "Court day", 1], ["paused", "Paused", 1]])
      expect(m.total).toBe(4)
    })

    it("choosing a chip shows only those jobs; the chip counts do not move with the chip itself", () => {
      const m = krun(jobs(), { b: "pending", w: "the_irs" })
      expect(m.rows).toHaveLength(2)
      expect(m.waitFilter).toBe("the_irs")
      expect(m.waiting.map(c => c.count)).toEqual([2, 1, 1])
      expect(krun(jobs(), { b: "pending", w: "paused" }).rows.map(r => r.pillLabel)).toEqual(["Paused"])
    })

    it("a chip that is not a real kind of wait (typo, a built-in 'ours' kind, junk) is ignored: nothing is filtered", () => {
      for (const w of ["banana", "us", "none", "unset", "__proto__", "constructor"]) {
        const m = krun(jobs(), { b: "pending", w })
        expect(m.waitFilter, w).toBe("")
        expect(m.rows, w).toHaveLength(4)
      }
    })

    it("the service chips count with the chosen 'Waiting on' chip applied, so a service chip never promises rows the list will not show", () => {
      const mixed = [z("Filed"), z("Filed"), job({ stage: "One" }), job({ stage: "One" }), job({ stage: "One" })]
      // pending: Zeta has 2 on The IRS; Alpha has 3 on the client (default fixture steps)
      const both = (raw: RawSearchParams) => run(mixed, raw, [], { steps: [...STEPS, ...KSTEPS], waitKinds: KINDS })
      const all = both({ b: "pending" })
      expect(all.services.map(c => [c.name, c.count])).toEqual([["Alpha", 3], ["Zeta", 2]])
      const onIrs = both({ b: "pending", w: "the_irs" })
      expect(onIrs.services.map(c => [c.name, c.count])).toEqual([["Zeta", 2]])
      expect(onIrs.rows).toHaveLength(2)
    })

    it("a chosen chip stays visible (so it can be cleared) even when the service filter leaves it empty", () => {
      const m = krun(jobs(), { b: "pending", w: "court_day", s: "Alpha" })
      expect(m.waiting.some(c => c.key === "court_day" && c.count === 0)).toBe(true)
    })

    it("no chips on the other lists, in a step view, or in Closed", () => {
      expect(krun(jobs(), { b: "work" }).waiting).toEqual([])
      expect(krun(jobs(), { b: "closed" }).waiting).toEqual([])
      expect(krun(jobs(), { b: "pending", s: "Zeta", st: "Filed" }).waiting).toEqual([])
    })
  })

  it("a step chip carries the kind's behaviour (its dot colour) and words (its tooltip)", () => {
    const steps = krun([z("Filed")], { s: "Zeta" }).steps
    const by = (n: string) => steps.find(s => s.name === n)!
    expect(by("Filed")).toMatchObject({ waitingOn: "the_irs", behaviour: "other", tip: "Waiting on the IRS" })
    expect(by("Hearing")).toMatchObject({ behaviour: "date", tip: "Waiting on Court day" })
    expect(by("Lost")).toMatchObject({ waitingOn: "unset", behaviour: null })
    expect(by("Lost").tip).toBe('Set to "gone_kind", which is no longer in the waiting-on list')
    expect(by("End")).toMatchObject({ waitingOn: "none", behaviour: "none" })
  })
})
