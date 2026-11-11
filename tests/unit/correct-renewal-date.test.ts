import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"

/**
 * correctRenewalDate — the Calendar's "correct this date" write. The database
 * layer is a small recording fake: every query keeps its filters, so the tests
 * assert WHICH company / job type / status was asked about, not just that
 * something came back (bug-hunter finding 16, 2026-11-10).
 */

type Row = Record<string, unknown>
type Filter = [op: string, col: string, val: unknown]

const state: {
  account: Row | null
  closing: Row[]
  jobs: Row[]
  deadlines: Row[]
  firstStage: string | null
  jobUpdates: Array<{ id: unknown; patch: Row }>
  cardResolves: Array<{ filters: Filter[]; patch: Row }>
  queries: Array<{ table: string; filters: Filter[] }>
  setDate: Mock<(...args: unknown[]) => Promise<unknown>>
  deactivate: Mock<(...args: unknown[]) => Promise<unknown>>
} = {
  account: null, closing: [], jobs: [], deadlines: [], firstStage: "Upcoming",
  jobUpdates: [], cardResolves: [], queries: [],
  setDate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  deactivate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}

function has(filters: Filter[], op: string, col: string, val?: unknown) {
  return filters.some(f => f[0] === op && f[1] === col && (val === undefined || JSON.stringify(f[2]) === JSON.stringify(val)))
}

vi.mock("@/lib/supabase-admin", () => {
  const from = (table: string) => {
    const filters: Filter[] = []
    let patch: Row | null = null
    const rows = (): Row[] => {
      state.queries.push({ table, filters: [...filters] })
      if (table === "service_deliveries") return has(filters, "in", "service_type") ? state.closing : state.jobs
      if (table === "deadlines") return state.deadlines
      return []
    }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = (c: string, v: unknown) => { filters.push(["eq", c, v]); return b }
    b.in = (c: string, v: unknown) => { filters.push(["in", c, v]); return b }
    b.is = (c: string, v: unknown) => { filters.push(["is", c, v]); return b }
    b.order = () => b
    b.limit = () => b
    b.maybeSingle = () => {
      state.queries.push({ table, filters: [...filters] })
      if (table === "accounts") return Promise.resolve({ data: state.account, error: null })
      if (table === "pipeline_stages") return Promise.resolve({ data: state.firstStage ? { stage_name: state.firstStage } : null, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    b.update = (p: Row) => { patch = p; return b }
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (patch) {
        if (table === "message_actions") state.cardResolves.push({ filters: [...filters], patch })
        if (table === "service_deliveries") {
          const idFilter = filters.find(f => f[1] === "id")
          state.jobUpdates.push({ id: idFilter?.[2], patch })
        }
        return Promise.resolve({ error: null }).then(resolve, reject)
      }
      return Promise.resolve({ data: rows(), error: null }).then(resolve, reject)
    }
    return b
  }
  return { supabaseAdmin: { from } }
})

vi.mock("@/lib/operations/renewal-dates", async () => {
  const actual = await vi.importActual<typeof import("@/lib/operations/renewal-dates")>("@/lib/operations/renewal-dates")
  return { ...actual, setAccountRenewalDate: (...args: unknown[]) => state.setDate(...args) }
})

vi.mock("@/lib/operations/service-delivery", () => ({
  deactivateSD: (...args: unknown[]) => state.deactivate(...args),
}))

import { correctRenewalDate, validateCorrection, movesPastDueDateForward } from "@/lib/operations/correct-renewal-date"

const TODAY = "2026-11-10"
// SD Int. shape: onboarded (Client Since filled), stored on the Formation anniversary, due in 30 days.
const BASE = {
  accountId: "acct-1",
  from: "2026-12-10",
  to: "2027-02-19",
  reason: "matches_rule",
  note: null,
  actor: "luca@example.com",
  today: TODAY,
}

beforeEach(() => {
  state.account = {
    id: "acct-1", company_name: "Test Co LLC", state_of_formation: "Delaware", updated_at: "2026-11-02T20:40:41.332522+00:00",
    ra_renewal_date: "2026-12-10", annual_report_due_date: "2027-06-01", client_since: "2026-02-19", formation_date: "2021-12-10",
  }
  state.closing = []
  state.jobs = [{ id: "job-1", due_date: "2026-12-10", stage: "Upcoming" }]
  state.deadlines = [{ id: "dl-1", due_date: "2027-02-19", status: "Not Started" }]
  state.firstStage = "Upcoming"
  state.jobUpdates = []
  state.cardResolves = []
  state.queries = []
  state.setDate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, outcome: "updated" })
  state.deactivate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, outcome: "deactivated", delivery_id: "job-1" })
})

describe("movesPastDueDateForward", () => {
  it("a past date moved to today or later hides an overdue flag", () => {
    expect(movesPastDueDateForward("2026-11-01", "2027-02-19", TODAY)).toBe(true)
    expect(movesPastDueDateForward("2026-11-01", TODAY, TODAY)).toBe(true)
  })
  it("a future date, or a past date moved to another past date, does not", () => {
    expect(movesPastDueDateForward("2026-12-10", "2027-02-19", TODAY)).toBe(false)
    expect(movesPastDueDateForward("2026-11-01", "2026-10-15", TODAY)).toBe(false)
  })
})

describe("validateCorrection", () => {
  it("accepts a complete correction", () => {
    expect(validateCorrection(BASE, TODAY)).toBeNull()
  })
  it("refuses: same date, unknown reason, 'other' without a note, silly date, long note", () => {
    expect(validateCorrection({ ...BASE, to: BASE.from }, TODAY)).toMatch(/already stored/)
    expect(validateCorrection({ ...BASE, reason: "because" }, TODAY)).toMatch(/why/i)
    expect(validateCorrection({ ...BASE, reason: "other", note: "  " }, TODAY)).toMatch(/Explain/)
    expect(validateCorrection({ ...BASE, to: "2099-01-01" }, TODAY)).toMatch(/far from today/)
    expect(validateCorrection({ ...BASE, note: "x".repeat(501) }, TODAY)).toMatch(/too long/)
  })
  it("'other' with a note is fine", () => {
    expect(validateCorrection({ ...BASE, reason: "other", note: "Harbor invoice says Feb" }, TODAY)).toBeNull()
  })
  it("only the Registered Agent reasons exist (the annual report is not part of this)", () => {
    expect(validateCorrection({ ...BASE, reason: "state_shows" }, TODAY)).toMatch(/why/i)
    expect(validateCorrection({ ...BASE, reason: "harbor_shows" }, TODAY)).toBeNull()
  })
  it("a PAST-DUE date moved forward needs the confirmation and a real reason (never 'matches the rule')", () => {
    const pastDue = { ...BASE, from: "2026-11-01", to: "2027-02-19" }
    expect(validateCorrection({ ...pastDue, reason: "matches_rule", confirmOverdue: true }, TODAY)).toMatch(/not proof/)
    expect(validateCorrection({ ...pastDue, reason: "harbor_shows" }, TODAY)).toMatch(/past due/)
    expect(validateCorrection({ ...pastDue, reason: "harbor_shows", confirmOverdue: true }, TODAY)).toBeNull()
  })
})

describe("correctRenewalDate — the reason must be true", () => {
  it("'matches the rule' with the rule date is saved (Client Since 19 Feb 2026 → 19 Feb 2027)", async () => {
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(true)
  })
  it("'matches the rule' with a DIFFERENT date is refused and nothing is written (the bug-hunter #1 case)", async () => {
    const r = await correctRenewalDate({ ...BASE, to: "2027-03-05" })
    expect(r.ok).toBe(false)
    if (r.ok === false) { expect(r.status).toBe(400); expect(r.error).toMatch(/not the rule date \(2027-02-19\)/) }
    expect(state.setDate).not.toHaveBeenCalled()
  })
  it("the same different date with 'Harbor shows' is fine", async () => {
    const r = await correctRenewalDate({ ...BASE, to: "2027-03-05", reason: "harbor_shows" })
    expect(r.ok).toBe(true)
    expect(state.setDate.mock.calls[0][2]).toBe("2027-03-05")
  })
  it("a company we created (Client Since empty) is measured from Formation", async () => {
    state.account = { ...state.account!, client_since: null, formation_date: "2023-12-12", ra_renewal_date: "2026-12-10" }
    const r = await correctRenewalDate({ ...BASE, to: "2026-12-12" })
    expect(r.ok).toBe(true)
  })
})

describe("correctRenewalDate — what is written", () => {
  it("writes through the one sanctioned writer, with the audit text and the optimistic lock", async () => {
    await correctRenewalDate(BASE)
    expect(state.setDate).toHaveBeenCalledTimes(1)
    const [accountId, column, value, opts] = state.setDate.mock.calls[0] as [string, string, string, Record<string, unknown> & { summary: string; details: Record<string, unknown> }]
    expect(accountId).toBe("acct-1")
    expect(column).toBe("ra_renewal_date")
    expect(value).toBe("2027-02-19")
    expect(opts.expectedUpdatedAt).toBe("2026-11-02T20:40:41.332522+00:00")
    expect(opts.actor).toBe("luca@example.com")
    expect(opts.summary).toMatch(/2026-12-10 → 2027-02-19/)
    expect(opts.details).toMatchObject({ from: "2026-12-10", to: "2027-02-19", reason: "matches_rule", source: "calendar-renewal-details" })
  })

  it("only the Registered Agent date is touched: its own column, job type and deadline type", async () => {
    await correctRenewalDate(BASE)
    expect(state.setDate.mock.calls[0][1]).toBe("ra_renewal_date")
    expect(state.queries.some(q => q.table === "service_deliveries" && has(q.filters, "eq", "service_type", "State RA Renewal"))).toBe(true)
    expect(state.queries.some(q => q.table === "service_deliveries" && has(q.filters, "eq", "service_type", "State Annual Report"))).toBe(false)
    expect(state.queries.some(q => q.table === "deadlines" && has(q.filters, "eq", "deadline_type", "RA Renewal"))).toBe(true)
  })

  it("moving a PAST-DUE date forward records that it was confirmed", async () => {
    state.account = { ...state.account!, ra_renewal_date: "2026-11-01" }
    await correctRenewalDate({ ...BASE, from: "2026-11-01", to: "2027-02-19", reason: "harbor_shows", confirmOverdue: true })
    const opts = state.setDate.mock.calls[0][3] as { details: Record<string, unknown> }
    expect(opts.details.confirmed_past_due).toBe(true)
  })
})

describe("correctRenewalDate — refusals", () => {
  it("a stale pop-up (the CRM date changed) is refused and writes NOTHING", async () => {
    state.account = { ...state.account!, ra_renewal_date: "2027-01-01" }
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(false)
    if (r.ok === false) { expect(r.status).toBe(409); expect(r.error).toMatch(/changed while the pop-up was open/) }
    expect(state.setDate).not.toHaveBeenCalled()
    expect(state.jobUpdates).toHaveLength(0)
    expect(state.deactivate).not.toHaveBeenCalled()
  })

  it("a company that is being closed is refused (and the closure check asks about THIS company and active closures)", async () => {
    state.closing = [{ id: "closure-1" }]
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(false)
    if (r.ok === false) { expect(r.status).toBe(409); expect(r.error).toMatch(/being closed/) }
    expect(state.setDate).not.toHaveBeenCalled()
    const q = state.queries.find(x => x.table === "service_deliveries" && has(x.filters, "in", "service_type"))!
    expect(has(q.filters, "eq", "account_id", "acct-1")).toBe(true)
    expect(has(q.filters, "in", "service_type", ["Company Closure", "Client Offboarding"])).toBe(true)
    expect(has(q.filters, "eq", "status", "active")).toBe(true)
  })

  it("a lost optimistic lock inside the writer is reported as a conflict and no job is touched", async () => {
    state.setDate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: false, outcome: "stale", error: "lock" })
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.status).toBe(409)
    expect(state.jobUpdates).toHaveLength(0)
    expect(state.deactivate).not.toHaveBeenCalled()
  })

  it("unknown company → 404", async () => {
    state.account = null
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.status).toBe(404)
  })
})

describe("correctRenewalDate — the early renewal job and its To-Do card", () => {
  it("new date MORE than 30 days away + job not started → job cancelled, its card resolved, no re-stamp (the cron makes them again 30 days before)", async () => {
    const r = await correctRenewalDate(BASE) // 2027-02-19 is far outside the window
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.message).toMatch(/removed; they are created again 30 days before/)
    expect(state.deactivate).toHaveBeenCalledTimes(1)
    const arg = state.deactivate.mock.calls[0][0] as Record<string, unknown>
    expect(arg.delivery_id).toBe("job-1")
    expect(arg.clear_renewal_date).toBeUndefined() // the date we just saved must NOT be cleared
    expect(state.cardResolves).toHaveLength(1)
    expect(has(state.cardResolves[0].filters, "eq", "source_ref", "ra_renewal:job-1")).toBe(true)
    expect(has(state.cardResolves[0].filters, "is", "resolved_at", null)).toBe(true)
    expect(state.cardResolves[0].patch.resolved_at).toBeTruthy()
    expect(state.jobUpdates).toHaveLength(0)
  })

  it("new date INSIDE the 30 days → the job stays and just gets the new date", async () => {
    const r = await correctRenewalDate({ ...BASE, to: "2026-11-25", reason: "harbor_shows" })
    expect(r.ok).toBe(true)
    expect(state.deactivate).not.toHaveBeenCalled()
    expect(state.cardResolves).toHaveLength(0)
    expect(state.jobUpdates).toHaveLength(1)
    expect(state.jobUpdates[0]).toMatchObject({ id: "job-1", patch: { due_date: "2026-11-25" } })
  })

  it("exactly 30 days away is still inside the window (job kept and re-stamped); 31 days away is outside", async () => {
    state.account = { ...state.account!, ra_renewal_date: "2026-12-05" }
    state.jobs = [{ id: "job-1", due_date: "2026-12-05", stage: "Upcoming" }]
    const inside = await correctRenewalDate({ ...BASE, from: "2026-12-05", to: "2026-12-10", reason: "harbor_shows" })
    expect(inside.ok).toBe(true)
    expect(state.deactivate).not.toHaveBeenCalled()
    expect(state.jobUpdates[0]).toMatchObject({ patch: { due_date: "2026-12-10" } })

    state.jobUpdates = []
    state.account = { ...state.account!, ra_renewal_date: "2026-12-05" }
    const outside = await correctRenewalDate({ ...BASE, from: "2026-12-05", to: "2026-12-11", reason: "harbor_shows" })
    expect(outside.ok).toBe(true)
    expect(state.deactivate).toHaveBeenCalledTimes(1)
  })

  it("work already started on the job → it is KEPT with a warning, even when the new date is far away", async () => {
    state.jobs = [{ id: "job-1", due_date: "2026-12-10", stage: "Renewal" }]
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(true)
    expect(state.deactivate).not.toHaveBeenCalled()
    expect(state.cardResolves).toHaveLength(0)
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/already started/)
    expect(state.jobUpdates[0]).toMatchObject({ patch: { due_date: "2027-02-19" } })
  })

  it("a job with no step recorded counts as not started; the first step is read from the pipeline (names differ between environments)", async () => {
    state.firstStage = "Renewal Due"
    state.jobs = [{ id: "job-1", due_date: "2026-12-10", stage: "Renewal Due" }]
    await correctRenewalDate(BASE)
    expect(state.deactivate).toHaveBeenCalledTimes(1)

    state.deactivate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, outcome: "deactivated", delivery_id: "job-1" })
    state.account = { ...state.account!, ra_renewal_date: "2026-12-10" }
    state.jobs = [{ id: "job-1", due_date: "2026-12-10", stage: null }]
    await correctRenewalDate(BASE)
    expect(state.deactivate).toHaveBeenCalledTimes(1)

    state.deactivate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, outcome: "deactivated", delivery_id: "job-1" })
    state.jobs = [{ id: "job-1", due_date: "2026-12-10", stage: "Upcoming" }] // a stage name that is not this environment's first step
    await correctRenewalDate(BASE)
    expect(state.deactivate).not.toHaveBeenCalled()
  })

  it("the stage lookup asks the right pipeline, and the job query asks about THIS company, THIS job type, open statuses only", async () => {
    await correctRenewalDate(BASE)
    const q = state.queries.find(x => x.table === "service_deliveries" && has(x.filters, "eq", "service_type", "State RA Renewal"))!
    expect(has(q.filters, "eq", "account_id", "acct-1")).toBe(true)
    expect(has(q.filters, "in", "status", ["active", "blocked"])).toBe(true)
    const st = state.queries.find(x => x.table === "pipeline_stages")!
    expect(has(st.filters, "eq", "service_type", "State RA Renewal")).toBe(true)
  })

  it("a failed cancel is reported, not hidden", async () => {
    state.deactivate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: false, outcome: "error", delivery_id: "job-1", error: "boom" })
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/could not be removed \(boom\)/)
  })

  it("two open jobs: the date is saved, NO job is touched, and the user is told", async () => {
    state.jobs = [{ id: "job-1", due_date: "2026-12-10", stage: "Upcoming" }, { id: "job-2", due_date: "2026-12-10", stage: "Upcoming" }]
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(true)
    expect(state.deactivate).not.toHaveBeenCalled()
    expect(state.jobUpdates).toHaveLength(0)
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/2 open .* jobs/)
  })

  it("no open job: fine, nothing to do", async () => {
    state.jobs = []
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(true)
    expect(state.deactivate).not.toHaveBeenCalled()
    expect(state.jobUpdates).toHaveLength(0)
  })
})

describe("correctRenewalDate — the client's portal deadline is checked, not assumed", () => {
  it("shows the new date → no warning", async () => {
    const r = await correctRenewalDate(BASE)
    expect(r.ok && r.warnings).toEqual([])
  })
  it("still shows the OLD date → warned", async () => {
    state.deadlines = [{ id: "dl-1", due_date: "2026-12-10", status: "Not Started" }]
    const r = await correctRenewalDate(BASE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/portal deadline does not show 2027-02-19/)
  })
  it("no open deadline row at all → warned", async () => {
    state.deadlines = [{ id: "dl-1", due_date: "2026-12-10", status: "Filed" }]
    const r = await correctRenewalDate(BASE)
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/portal deadline/)
  })
  it("the writer's own duplicate-row warning is passed back, not swallowed", async () => {
    state.setDate = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, outcome: "updated", mirrorWarning: "RA Renewal: found 2 open records" })
    const r = await correctRenewalDate(BASE)
    expect(r.ok && r.warnings).toContain("RA Renewal: found 2 open records")
  })
})
