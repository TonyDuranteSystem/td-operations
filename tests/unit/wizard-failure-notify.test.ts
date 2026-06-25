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

import {
  notifyClientOfWizardJobFailure,
  isWizardFailureJobType,
  localeFromLanguage,
  WIZARD_FAILURE_JOB_TYPES,
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
