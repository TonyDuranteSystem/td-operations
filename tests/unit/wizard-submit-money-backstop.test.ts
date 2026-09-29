/**
 * wizard-submit money backstop (dev job 89195c68): the server applies the
 * same money rule as the wizard's step gate BEFORE any write — an unanswered
 * "80.000" question, an unreadable amount, more than 2 decimals (a 10.596 that
 * meant 10,596) or a negative in a min-0 field is refused with a bilingual
 * message; clean strings are stored as numbers; pending text in a field the
 * client has since hidden is cleared.
 *
 * Mock setup mirrors wizard-submit-nonblocking.test.ts.
 */
import { describe, it, expect, vi } from "vitest"
import type { NextRequest } from "next/server"

// ── supabase admin: chainable builder that satisfies every call the route makes ──
// The tax path now runs the eligibility resolver (lib/tax/wizard-eligibility,
// PTBT fix) BEFORE any state write, so the mock must describe an ELIGIBLE
// client: active Tax Return SD at "Wizard Available" + an open tax_returns
// row + a formation date before the tax year. `taxEligible` lets the
// rejection test below flip the same mock to a pre-wizard client.
const taxEligible = true
function resolveFor(table: string) {
  if (table.endsWith("_submissions")) return { data: { id: "sub-1" }, error: null }
  if (table === "tax_returns") return { data: { tax_year: 2025 }, error: null }
  if (table === "job_queue")
    return { data: { id: "job-1", job_type: "tax_form_setup", payload: {} }, error: null }
  if (table === "accounts")
    return {
      data: { drive_folder_id: null, company_name: "Acme LLC", state_of_formation: "NM", formation_date: "2020-01-01" },
      error: null,
    }
  return { data: null, error: null }
}
// Array-shaped results for queries awaited WITHOUT .single()/.maybeSingle()
// (the eligibility resolver's lookups).
function resolveListFor(table: string) {
  if (table === "service_deliveries")
    return { data: [{ service_type: "Tax Return", stage: taxEligible ? "Wizard Available" : "1st Installment Paid" }], error: null }
  if (table === "tax_returns")
    return { data: taxEligible ? [{ id: "tr-1", tax_year: 2025 }] : [], error: null }
  if (table === "tax_return_submissions") return { data: [], error: null }
  return { data: [], error: null }
}
function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.is = chain
  b.in = chain
  b.order = chain
  b.limit = chain
  b.neq = chain
  b.update = chain
  b.insert = chain
  b.upsert = chain
  b.single = async () => resolveFor(table)
  b.maybeSingle = async () => resolveFor(table)
  b.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolveListFor(table)).then(onFulfilled)
  return b
}
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "u1", email: "client@example.com", user_metadata: {} } },
      }),
    },
  }),
}))

vi.mock("@/lib/auth", () => ({ isClient: () => true }))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: vi.fn(async () => ({ id: "job-1" })),
  completeJob: vi.fn(async () => {}),
  failJob: vi.fn(async () => {}),
}))

vi.mock("@/lib/jobs/validation", () => ({
  validateWizardData: () => ({ valid: true, errors: [] }),
}))

vi.mock("@/lib/portal/wizard-uploads", () => ({ collectUploadPaths: () => [] }))

vi.mock("@/lib/portal/resolve-portal-identity", () => ({
  resolvePortalIdentity: async () => ({ kind: "contact", contactId: "c1" }),
}))

vi.mock("@/lib/portal/wizard-submit-access", () => ({ canSubmitWizard: () => true }))
vi.mock("@/lib/portal/formation-lead-access", () => ({ formationLeadOwned: () => true }))

// The "slow handler": a promise that never resolves. If the route awaits it
// inline, POST never returns and the race rejects.
vi.mock("@/lib/jobs/handlers/tax-form-setup", () => ({
  handleTaxFormSetup: () => new Promise(() => {}),
}))

import { POST } from "@/app/api/portal/wizard-submit/route"

function req(body: Record<string, unknown>): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

async function postWithDeadline(body: Record<string, unknown>, ms = 2000) {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("route blocked: POST did not resolve — handler awaited inline?")), ms),
  )
  return Promise.race([POST(req(body)), timeout])
}

const base = { company_name: 'Acme LLC', state_of_formation: 'NM' }
const post = (data: Record<string, unknown>) =>
  postWithDeadline({ wizard_type: 'tax', entity_type: 'SMLLC', data, account_id: 'acc-1', contact_id: 'c1', progress_id: 'wp-1' }) as Promise<Response>

describe('wizard-submit money backstop', () => {
  it('refuses an unanswered "80.000" with an EN + IT message', async () => {
    const res = await post({ ...base, distributions_withdrawals: '80.000' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.fields).toEqual([
      {
        field: 'distributions_withdrawals',
        message: 'Which amount did you mean? Choose one of the options under the box.',
        message_it: 'Quale importo intendevi? Scegli una delle opzioni sotto la casella.',
      },
    ])
  })

  it('refuses a number with more than 2 decimals (old number box: 10.596)', async () => {
    const res = await post({ ...base, personal_expenses: 10.596 })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.fields[0].field).toBe('personal_expenses')
    expect(body.fields[0].message).toContain('10.596')
  })

  it('refuses a negative in a min-0 field', async () => {
    const res = await post({ ...base, personal_expenses: -0.03 })
    expect(res.status).toBe(400)
  })

  it('accepts 17.65 (float trap) and settles clean strings to numbers', async () => {
    const data: Record<string, unknown> = { ...base, personal_expenses: 17.65, bank_contributions: '5000', formation_costs: '80,000' }
    const res = await post(data)
    expect(res.status).toBe(200)
    expect(data.bank_contributions).toBe(5000)
    expect(data.formation_costs).toBe(80000)
    expect(data.personal_expenses).toBe(17.65)
  })

  it('clears pending text in a related-party amount the client has hidden, and does not block', async () => {
    const data: Record<string, unknown> = {
      ...base,
      has_related_party_transactions: 'No',
      related_party_transactions_count: 1,
      related_party_transactions_0_rpt_amount: '80.000',
    }
    const res = await post(data)
    expect(res.status).toBe(200)
    expect(data.related_party_transactions_0_rpt_amount).toBe('')
  })

  it('a visible related-party amount still pending is refused', async () => {
    const res = await post({
      ...base,
      has_related_party_transactions: 'Yes',
      related_party_transactions_count: 1,
      related_party_transactions_0_rpt_amount: '1.500',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.fields[0].field).toBe('related_party_transactions_0_rpt_amount')
  })

  it('Corp amounts keep accepting negatives (no min), as before', async () => {
    const res = await postWithDeadline({
      wizard_type: 'tax', entity_type: 'Corp', account_id: 'acc-1', contact_id: 'c1', progress_id: 'wp-1',
      data: { ...base, corp_rental_passive_income: -500 },
    }) as Response
    expect(res.status).toBe(200)
  })

  it('non-tax wizards are untouched', async () => {
    const res = await postWithDeadline({
      wizard_type: 'onboarding', account_id: 'acc-1', contact_id: 'c1', progress_id: 'wp-4',
      data: { company_name: 'Acme LLC', personal_expenses: '80.000' },
    }) as Response
    expect(res.status).toBe(200)
  })
})
