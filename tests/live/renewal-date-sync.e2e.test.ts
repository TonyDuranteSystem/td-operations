/**
 * RENEWAL-DATE SYNC FIX — LIVE E2E (dev job 8bd0e51a)
 *
 * Drives REAL code (setAccountRenewalDate, checkDeadlineDirectWrite,
 * deactivateSD) against the REAL per-worktree isolated local database.
 * Council-reviewed across 3 rounds (senior-engineer, ai-architect,
 * bug-hunter) before this was written.
 *
 * Run: npx vitest run --config vitest.renewal-date-sync-e2e.config.ts
 */
/* eslint-disable no-restricted-syntax -- destructive local-stack QA harness; never runs in CI
   or against production. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

import { supabaseAdmin } from "@/lib/supabase-admin"
import { setAccountRenewalDate, checkDeadlineDirectWrite } from "@/lib/operations/renewal-dates"
import { deactivateSD } from "@/lib/operations/service-delivery"

const ACCT = "55555555-0000-4000-8000-000000000002" // ZZ Renewal-Sync Test LLC

const createdDeadlines: string[] = []
const createdSDs: string[] = []

async function makeAccount() {
  await supabaseAdmin.from("accounts").upsert({
    id: ACCT,
    company_name: "ZZ Renewal-Sync Test LLC",
    account_type: "Client",
    ra_renewal_date: null,
    annual_report_due_date: null,
  })
}

async function resetAccountDates() {
  await supabaseAdmin
    .from("accounts")
    .update({ ra_renewal_date: null, annual_report_due_date: null })
    .eq("id", ACCT)
}

async function clearDeadlines() {
  await supabaseAdmin.from("deadlines").delete().eq("account_id", ACCT)
}

async function makeDeadline(opts: { type: "RA Renewal" | "Annual Report"; due: string; status: string }) {
  const { data, error } = await supabaseAdmin
    .from("deadlines")
    .insert({
      account_id: ACCT,
      deadline_type: opts.type,
      due_date: opts.due,
      status: opts.status,
      year: parseInt(opts.due.slice(0, 4), 10),
      assigned_to: "Luca",
    })
    .select("id")
    .single()
  if (error) throw new Error(`fixture deadline failed: ${error.message}`)
  const id = (data as { id: string }).id
  createdDeadlines.push(id)
  return id
}

async function readDeadlines(type: "RA Renewal" | "Annual Report") {
  const { data } = await supabaseAdmin
    .from("deadlines")
    .select("id, due_date, status, year")
    .eq("account_id", ACCT)
    .eq("deadline_type", type)
    .order("created_at", { ascending: true })
  return data ?? []
}

async function readAccount() {
  const { data } = await supabaseAdmin
    .from("accounts")
    .select("ra_renewal_date, annual_report_due_date, updated_at")
    .eq("id", ACCT)
    .single()
  return data as unknown as { ra_renewal_date: string | null; annual_report_due_date: string | null; updated_at: string }
}

beforeAll(async () => {
  await makeAccount()
})

afterEach(async () => {
  await clearDeadlines()
  await resetAccountDates()
})

afterAll(async () => {
  for (const id of createdSDs) await supabaseAdmin.from("service_deliveries").delete().eq("id", id)
  await supabaseAdmin.from("accounts").delete().eq("id", ACCT)
})

describe("setAccountRenewalDate — the single writer", () => {
  it("no existing deadlines row: writes the account column and inserts a fresh Pending row", async () => {
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-03-15", { summary: "test" })
    expect(result.success).toBe(true)
    expect(result.mirrorWarning).toBeUndefined()

    const acct = await readAccount()
    expect(acct.ra_renewal_date).toBe("2027-03-15")

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(1)
    expect(rows[0].due_date).toBe("2027-03-15")
    expect(rows[0].status).toBe("Pending")
  })

  it("existing open row, same year: corrects that row in place — no duplicate", async () => {
    await makeDeadline({ type: "RA Renewal", due: "2027-03-15", status: "Pending" })
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-04-01", { summary: "test" })
    expect(result.success).toBe(true)

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(1)
    expect(rows[0].due_date).toBe("2027-04-01")
  })

  it("existing open row, date corrected ACROSS a year boundary: still corrects the SAME row (round-1 fix — year-agnostic match)", async () => {
    await makeDeadline({ type: "RA Renewal", due: "2027-12-20", status: "Pending" })
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", "2028-01-05", { summary: "test" })
    expect(result.success).toBe(true)

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(1) // NOT 2 — the year-scoped bug would have forked a second row here
    expect(rows[0].due_date).toBe("2028-01-05")
    expect(rows[0].year).toBe(2028)
  })

  it("clearing (null) with an existing open row: marks it Cancelled, never deletes", async () => {
    const id = await makeDeadline({ type: "RA Renewal", due: "2027-03-15", status: "Pending" })
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", null, { summary: "test" })
    expect(result.success).toBe(true)

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe("Cancelled")

    const acct = await readAccount()
    expect(acct.ra_renewal_date).toBeNull()
  })

  it("clearing (null) with zero existing open rows: explicit no-op, no insert", async () => {
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", null, { summary: "test" })
    expect(result.success).toBe(true)

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(0)
  })

  it("a currently-Blocked row IS matched and gets its date corrected — status is left untouched, not reset to Pending (round-3 finding)", async () => {
    await makeDeadline({ type: "RA Renewal", due: "2027-03-15", status: "Blocked" })
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-05-01", { summary: "test" })
    expect(result.success).toBe(true)

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(1)
    expect(rows[0].due_date).toBe("2027-05-01")
    expect(rows[0].status).toBe("Blocked") // NOT reset — a block reason isn't resolved by fixing the date
  })

  it("a Cancelled row is NEVER revived — a later non-null write inserts a FRESH row instead (round-2 fix)", async () => {
    const cancelledId = await makeDeadline({ type: "RA Renewal", due: "2026-06-21", status: "Cancelled" })
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-08-01", { summary: "test" })
    expect(result.success).toBe(true)

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(2) // the old Cancelled row + a fresh Pending one
    const cancelled = rows.find((r) => r.id === cancelledId)
    const fresh = rows.find((r) => r.id !== cancelledId)
    expect(cancelled?.status).toBe("Cancelled")
    expect(cancelled?.due_date).toBe("2026-06-21") // untouched, not revived
    expect(fresh?.status).toBe("Pending")
    expect(fresh?.due_date).toBe("2027-08-01")
  })

  it("the client-portal query shape (excludes Cancelled) sees only the fresh row after the deactivate→reactivate scenario (round-3 bug-hunter blocker, portal-leak fix)", async () => {
    await makeDeadline({ type: "RA Renewal", due: "2026-06-21", status: "Cancelled" })
    await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-08-01", { summary: "test" })

    // Exactly the query app/portal/deadlines/page.tsx now runs.
    const { data: portalVisible } = await supabaseAdmin
      .from("deadlines")
      .select("id, due_date, status")
      .eq("account_id", ACCT)
      .neq("status", "Cancelled")
    expect(portalVisible?.length).toBe(1)
    expect(portalVisible?.[0].status).toBe("Pending")
    expect(portalVisible?.[0].due_date).toBe("2027-08-01")
  })

  it("more than one open row: does NOT guess — account column still updates, deadlines untouched, mirrorWarning returned, action_log written", async () => {
    const idA = await makeDeadline({ type: "RA Renewal", due: "2027-01-01", status: "Pending" })
    const idB = await makeDeadline({ type: "RA Renewal", due: "2027-06-01", status: "Overdue" })

    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-09-01", { summary: "test" })
    expect(result.success).toBe(true) // account column write still succeeds
    expect(result.mirrorWarning).toBeTruthy()
    expect(result.mirrorWarning).toContain("2 open records")

    const acct = await readAccount()
    expect(acct.ra_renewal_date).toBe("2027-09-01")

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(2)
    expect(rows.find((r) => r.id === idA)?.due_date).toBe("2027-01-01") // untouched
    expect(rows.find((r) => r.id === idB)?.due_date).toBe("2027-06-01") // untouched

    const { data: logRows } = await supabaseAdmin
      .from("action_log")
      .select("id, summary")
      .eq("account_id", ACCT)
      .eq("table_name", "deadlines")
      .order("created_at", { ascending: false })
      .limit(1)
    expect(logRows?.[0]?.summary).toContain("open records")
  })

  it("annual_report_due_date column works identically (independent of ra_renewal_date)", async () => {
    const result = await setAccountRenewalDate(ACCT, "annual_report_due_date", "2027-05-01", { summary: "test" })
    expect(result.success).toBe(true)

    const acct = await readAccount()
    expect(acct.annual_report_due_date).toBe("2027-05-01")
    const rows = await readDeadlines("Annual Report")
    expect(rows.length).toBe(1)
    expect(rows[0].due_date).toBe("2027-05-01")
  })

  it("optimistic lock: a stale expectedUpdatedAt reports the conflict instead of silently overwriting", async () => {
    await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-01-01", { summary: "seed" })
    const staleTimestamp = "2020-01-01T00:00:00.000Z"
    const result = await setAccountRenewalDate(ACCT, "ra_renewal_date", "2027-02-02", {
      summary: "test",
      expectedUpdatedAt: staleTimestamp,
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("stale")

    const acct = await readAccount()
    expect(acct.ra_renewal_date).toBe("2027-01-01") // NOT overwritten
  })
})

describe("checkDeadlineDirectWrite — the reverse-direction guard", () => {
  it("blocks a direct due_date edit on an RA Renewal row", () => {
    const check = checkDeadlineDirectWrite("RA Renewal", { due_date: "2027-01-01" })
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain("account's own renewal-date field")
  })

  it("blocks a direct due_date edit on an Annual Report row", () => {
    const check = checkDeadlineDirectWrite("Annual Report", { due_date: "2027-01-01" })
    expect(check.allowed).toBe(false)
  })

  it("blocks a direct status→Filed edit (skips the roll-forward)", () => {
    const check = checkDeadlineDirectWrite("RA Renewal", { status: "Filed" })
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain("Mark Filed")
  })

  it("blocks a direct status→Completed edit", () => {
    const check = checkDeadlineDirectWrite("RA Renewal", { status: "Completed" })
    expect(check.allowed).toBe(false)
  })

  it("ALLOWS a direct status→Cancelled edit — the escape hatch for resolving a duplicate-row anomaly (round-3 fix)", () => {
    const check = checkDeadlineDirectWrite("RA Renewal", { status: "Cancelled" })
    expect(check.allowed).toBe(true)
  })

  it("ALLOWS a direct status→Blocked edit — a normal, unrelated staff action (round-3 fix)", () => {
    const check = checkDeadlineDirectWrite("RA Renewal", { status: "Blocked", blocked_reason: "waiting on client" })
    expect(check.allowed).toBe(true)
  })

  it("ALLOWS editing notes/assigned_to/confirmation_number with no due_date or terminal status present", () => {
    const check = checkDeadlineDirectWrite("RA Renewal", { notes: "called client", assigned_to: "Luca" })
    expect(check.allowed).toBe(true)
  })

  it("does not apply to non-renewal deadline types (e.g. Tax Filing) — due_date stays directly writable", () => {
    const check = checkDeadlineDirectWrite("Tax Filing", { due_date: "2027-01-01" })
    expect(check.allowed).toBe(true)
  })

  it("does not apply when deadline_type is unknown/null (defensive default: allow)", () => {
    const check = checkDeadlineDirectWrite(null, { due_date: "2027-01-01" })
    expect(check.allowed).toBe(true)
  })
})

describe("deactivateSD wired to setAccountRenewalDate — the real end-to-end path", () => {
  async function makeSD(serviceType: string) {
    const { data, error } = await supabaseAdmin
      .from("service_deliveries")
      .insert({
        service_type: serviceType,
        service_name: `${serviceType} — E2E`,
        account_id: ACCT,
        status: "active",
        stage: "Upcoming",
        stage_order: 1,
        start_date: "2026-05-26",
        stage_entered_at: new Date().toISOString(),
        is_test: true,
      })
      .select("id, updated_at")
      .single()
    if (error || !data) throw new Error(`SD insert failed: ${error?.message}`)
    createdSDs.push(data.id)
    return data
  }

  it("clearing the renewal date on deactivate ALSO cancels the deadlines mirror (was the whole bug: account cleared, deadlines row left stale)", async () => {
    await setAccountRenewalDate(ACCT, "ra_renewal_date", "2026-06-21", { summary: "seed" })
    const sd = await makeSD("State RA Renewal")

    const result = await deactivateSD({ delivery_id: sd.id, reason: "e2e", clear_renewal_date: true })
    expect(result.success).toBe(true)
    expect(result.renewal_date_cleared).toBe(true)

    const acct = await readAccount()
    expect(acct.ra_renewal_date).toBeNull()

    const rows = await readDeadlines("RA Renewal")
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("Cancelled") // no longer stale — this is the fix
  })
})
