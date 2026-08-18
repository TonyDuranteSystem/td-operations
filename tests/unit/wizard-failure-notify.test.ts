/**
 * Unit tests for lib/jobs/wizard-failure-notify.ts
 *
 * Verifies the client failure-notification chokepoint:
 *  - only wizard job types trigger a client message
 *  - the message targets contact (formation/ITIN) or account (tax/onboarding)
 *  - it is idempotent via the job_queue.result marker
 *  - locale follows the client's language
 *  - it never throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mutable fixtures shared with the mocked supabase client ──────────────────
interface Fixtures {
  jobResult: Record<string, unknown>
  contactLanguage: string | null
  accountContacts: Array<{ contact_id: string | null; is_primary: boolean | null }>
  insertError: { message: string } | null
}
const fixtures: Fixtures = {
  jobResult: {},
  contactLanguage: null,
  accountContacts: [{ contact_id: "primary-ctc", is_primary: true }],
  insertError: null,
}
const inserts: Array<Record<string, unknown>> = []

function resolveFor(table: string, op: "select" | "insert" | "update") {
  if (table === "job_queue") {
    if (op === "select") return { data: { result: fixtures.jobResult }, error: null }
    return { data: null, error: null } // marker write
  }
  if (table === "contacts") return { data: { language: fixtures.contactLanguage }, error: null }
  if (table === "account_contacts") return { data: fixtures.accountContacts, error: null }
  if (table === "portal_messages") return { data: null, error: fixtures.insertError }
  return { data: null, error: null }
}

function makeBuilder(table: string) {
  const state: { table: string; op: "select" | "insert" | "update" } = { table, op: "select" }
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.limit = chain
  b.order = chain
  b.neq = chain
  b.update = () => {
    state.op = "update"
    return b
  }
  b.insert = (payload: Record<string, unknown>) => {
    state.op = "insert"
    if (table === "portal_messages") inserts.push(payload)
    return b
  }
  b.maybeSingle = async () => resolveFor(state.table, state.op)
  b.single = async () => resolveFor(state.table, state.op)
  b.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolveFor(state.table, state.op)).then(onFulfilled)
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}))

const reportedErrors: Array<Record<string, unknown>> = []
vi.mock("@/lib/system-errors", () => ({
  reportSystemError: vi.fn(async (e: Record<string, unknown>) => { reportedErrors.push(e) }),
}))

import {
  notifyClientOfWizardJobFailure,
  notifyClientOfStatementIngestFailure,
  isWizardFailureJobType,
  localeFromLanguage,
  WIZARD_FAILURE_JOB_TYPES,
  WIZARD_SUBMITTED_MESSAGE,
} from "@/lib/jobs/wizard-failure-notify"

beforeEach(() => {
  fixtures.jobResult = {}
  fixtures.contactLanguage = null
  fixtures.accountContacts = [{ contact_id: "primary-ctc", is_primary: true }]
  fixtures.insertError = null
  inserts.length = 0
})

describe("WIZARD_FAILURE_JOB_TYPES", () => {
  it("includes the five wizard job types and excludes non-wizard jobs", () => {
    expect(isWizardFailureJobType("formation_setup")).toBe(true)
    expect(isWizardFailureJobType("onboarding_setup")).toBe(true)
    expect(isWizardFailureJobType("tax_form_setup")).toBe(true)
    expect(isWizardFailureJobType("tax_return_intake")).toBe(true)
    expect(isWizardFailureJobType("itin_wizard_setup")).toBe(true)
    expect(isWizardFailureJobType("invoice_reminder")).toBe(false)
    expect(isWizardFailureJobType("document_reprocess")).toBe(false)
    expect(WIZARD_FAILURE_JOB_TYPES.size).toBeGreaterThanOrEqual(5)
  })
})

describe("localeFromLanguage", () => {
  it("maps messy language values to it/en", () => {
    expect(localeFromLanguage("Italian")).toBe("it")
    expect(localeFromLanguage("it")).toBe("it")
    expect(localeFromLanguage("Italiano - Ingle")).toBe("it")
    expect(localeFromLanguage("English")).toBe("en")
    expect(localeFromLanguage("")).toBe("en")
    expect(localeFromLanguage(null)).toBe("en")
  })
})

describe("WIZARD_SUBMITTED_MESSAGE", () => {
  it("never promises a staff review — that step is not actually worked (see docs/systems/tax-returns.md)", () => {
    expect(WIZARD_SUBMITTED_MESSAGE.en(2025)).not.toMatch(/review/i)
    expect(WIZARD_SUBMITTED_MESSAGE.it(2025)).not.toMatch(/revision/i)
  })

  it("includes the tax year, with a single leading space and no double space, in both locales", () => {
    expect(WIZARD_SUBMITTED_MESSAGE.en(2025)).toBe(
      "We've received your information and are processing your 2025 transactions now. If anything needs your input, we'll show it right in your portal.",
    )
    expect(WIZARD_SUBMITTED_MESSAGE.it(2025)).toBe(
      "Abbiamo ricevuto le tue informazioni e stiamo elaborando le tue transazioni 2025. Se qualcosa richiede il tuo intervento, te lo mostreremo direttamente nel portale.",
    )
    expect(WIZARD_SUBMITTED_MESSAGE.en(2025)).not.toMatch(/ {2,}/)
    expect(WIZARD_SUBMITTED_MESSAGE.it(2025)).not.toMatch(/ {2,}/)
  })

  it("reads as a complete, grammatical sentence when the year is unknown (null)", () => {
    expect(WIZARD_SUBMITTED_MESSAGE.en(null)).toBe(
      "We've received your information and are processing your transactions now. If anything needs your input, we'll show it right in your portal.",
    )
    expect(WIZARD_SUBMITTED_MESSAGE.it(null)).toBe(
      "Abbiamo ricevuto le tue informazioni e stiamo elaborando le tue transazioni. Se qualcosa richiede il tuo intervento, te lo mostreremo direttamente nel portale.",
    )
    expect(WIZARD_SUBMITTED_MESSAGE.en(null)).not.toMatch(/ {2,}/)
    expect(WIZARD_SUBMITTED_MESSAGE.it(null)).not.toMatch(/ {2,}/)
  })
})

describe("notifyClientOfWizardJobFailure", () => {
  it("does NOT notify for a non-wizard job type", async () => {
    const r = await notifyClientOfWizardJobFailure({
      id: "j1",
      job_type: "invoice_reminder",
      account_id: "acc-1",
      payload: {},
    })
    expect(r.notified).toBe(false)
    expect(r.reason).toBe("not_a_wizard_job")
    expect(inserts).toHaveLength(0)
  })

  it("does NOT notify when there is no account or contact target", async () => {
    const r = await notifyClientOfWizardJobFailure({
      id: "j2",
      job_type: "tax_form_setup",
      account_id: null,
      payload: {},
    })
    expect(r.notified).toBe(false)
    expect(r.reason).toBe("no_target")
    expect(inserts).toHaveLength(0)
  })

  it("posts an account-scoped message for a tax job (English by default)", async () => {
    const r = await notifyClientOfWizardJobFailure({
      id: "j3",
      job_type: "tax_form_setup",
      account_id: "acc-1",
      payload: {},
    })
    expect(r.notified).toBe(true)
    expect(inserts).toHaveLength(1)
    const msg = inserts[0]
    expect(msg.account_id).toBe("acc-1")
    expect(msg.contact_id).toBeNull()
    expect(msg.sender_type).toBe("system")
    // sender_context is omitted (DB CHECK restricts it to person/company/null)
    expect(msg.sender_context).toBeUndefined()
    expect(String(msg.message)).toContain("technical issue")
  })

  it("posts a contact-scoped message for a formation job in Italian", async () => {
    fixtures.contactLanguage = "Italian"
    const r = await notifyClientOfWizardJobFailure({
      id: "j4",
      job_type: "formation_setup",
      account_id: null,
      payload: { contact_id: "ctc-9" },
    })
    expect(r.notified).toBe(true)
    expect(inserts).toHaveLength(1)
    const msg = inserts[0]
    expect(msg.contact_id).toBe("ctc-9")
    expect(msg.account_id).toBeNull()
    expect(String(msg.message)).toContain("problema tecnico")
  })

  it("falls back to account_id from the payload when the column is null", async () => {
    const r = await notifyClientOfWizardJobFailure({
      id: "j5",
      job_type: "onboarding_setup",
      account_id: null,
      payload: { account_id: "acc-from-payload" },
    })
    expect(r.notified).toBe(true)
    expect(inserts[0].account_id).toBe("acc-from-payload")
  })

  it("is idempotent — skips when the job already carries the notified marker", async () => {
    fixtures.jobResult = { client_failure_notified: true }
    const r = await notifyClientOfWizardJobFailure({
      id: "j6",
      job_type: "tax_form_setup",
      account_id: "acc-1",
      payload: {},
    })
    expect(r.notified).toBe(false)
    expect(r.reason).toBe("already_notified")
    expect(inserts).toHaveLength(0)
  })

  it("reports insert failure without throwing", async () => {
    fixtures.insertError = { message: "boom" }
    const r = await notifyClientOfWizardJobFailure({
      id: "j7",
      job_type: "itin_wizard_setup",
      account_id: "acc-1",
      payload: {},
    })
    expect(r.notified).toBe(false)
    expect(r.reason).toBe("insert_failed")
  })
})


// ── Card 4a39e0fd — the ingest-failure notifier ──────────────────────────────
describe("notifyClientOfStatementIngestFailure", () => {
  const ingestJob = (over: Record<string, unknown> = {}) => ({
    id: "job-i1",
    job_type: "ingest_bank_statement",
    account_id: "acc-1",
    payload: { path: "tax/acc-1/2025/bank_accounts_0_statements_6a008993_Relay_2025-06.csv", tax_year: 2025 },
    ...over,
  })

  beforeEach(() => { reportedErrors.length = 0 })

  it("self-gates: any other job type does nothing", async () => {
    const r = await notifyClientOfStatementIngestFailure(ingestJob({ job_type: "tax_form_setup" }))
    expect(r.notified).toBe(false)
    expect(r.reason).toBe("not_an_ingest_job")
    expect(inserts).toHaveLength(0)
  })

  it("posts a client message naming the CLIENT's filename (upload prefixes stripped) + staff error-audit", async () => {
    const r = await notifyClientOfStatementIngestFailure(ingestJob())
    expect(r.notified).toBe(true)
    expect(inserts).toHaveLength(1)
    const msg = String((inserts[0] as Record<string, unknown>).message)
    expect(msg).toContain("Relay_2025-06.csv")
    expect(msg).not.toContain("bank_accounts_0_statements")
    // Wave 2 (Antonio): the chat message states WHAT is wrong + the FIX — the
    // SAME copy the file card renders — never "no action is needed" for a file
    // the page tells the client to replace (the shipped contradiction).
    expect(msg).not.toContain("no action is needed")
    expect(msg).toContain("remove it below and upload the statement exactly as your bank exports it")
    // staff signal fired
    expect(reportedErrors).toHaveLength(1)
    expect(String(reportedErrors[0].message)).toContain("FAILED ingestion")
  })

  it("quarantined jobs get the calm we-are-confirming copy, not the failure copy", async () => {
    fixtures.jobResult = { steps: [{ detail: 'FORMAT_CONFIRMATION_NEEDED:{"file":"x.csv"}' }] }
    const r = await notifyClientOfStatementIngestFailure(ingestJob())
    expect(r.notified).toBe(true)
    const msg = String((inserts[0] as Record<string, unknown>).message)
    expect(msg).toContain("format")
    expect(msg).not.toContain("could not be read")
  })

  it("idempotent via the job result marker", async () => {
    fixtures.jobResult = { client_failure_notified: true }
    const r = await notifyClientOfStatementIngestFailure(ingestJob())
    expect(r.notified).toBe(false)
    expect(r.reason).toBe("already_notified")
    expect(inserts).toHaveLength(0)
  })

  it("no account target → no message, no throw", async () => {
    const r = await notifyClientOfStatementIngestFailure(ingestJob({ account_id: null, payload: { path: "p" } }))
    expect(r.notified).toBe(false)
    expect(r.reason).toBe("no_target")
  })
})
