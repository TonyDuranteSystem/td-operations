/**
 * /api/crm/admin-actions/confirm-payment — route tests for the 4-identifier
 * resolution model.
 *
 * The route accepts ONE of: lead_id, account_id, contact_id, offer_token.
 * It resolves the offer first when possible, then fans out to the activation
 * chain. These tests verify the resolution branches and the rejection paths.
 *
 * Strategy: mock supabaseAdmin per-table with a helper that lets each test
 * configure what each query returns. Mock createTDInvoice + runActivation
 * so the route runs end-to-end without side effects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ── Per-table fixtures ──────────────────────────────────────────────────────

type FixtureValue = unknown

interface TableState {
  selectMaybeSingle?: { data: FixtureValue; error: { message: string } | null }
  selectSingle?: { data: FixtureValue; error: { message: string } | null }
  insertResult?: { data: FixtureValue; error: { message: string } | null }
  updateResult?: { data: FixtureValue; error: { message: string } | null }
  // Capture writes
  lastInsert?: Record<string, unknown>
  lastUpdate?: Record<string, unknown>
}

const tables: Record<string, TableState> = {}

function resetTables() {
  for (const k of Object.keys(tables)) delete tables[k]
}

function setTable(name: string, state: TableState) {
  tables[name] = { ...(tables[name] ?? {}), ...state }
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const state: TableState = (tables[table] ??= {})
      const chain: Record<string, unknown> = {}
      const noop = () => chain
      chain.select = noop
      chain.eq = noop
      chain.neq = noop
      chain.in = noop
      chain.ilike = noop
      chain.order = noop
      chain.limit = noop
      chain.maybeSingle = () =>
        Promise.resolve(state.selectMaybeSingle ?? { data: null, error: null })
      chain.single = () =>
        Promise.resolve(state.selectSingle ?? state.selectMaybeSingle ?? { data: null, error: null })
      chain.insert = (payload: Record<string, unknown>) => {
        state.lastInsert = payload
        return {
          select: () => ({
            single: () => Promise.resolve(state.insertResult ?? { data: { id: `${table}-new` }, error: null }),
          }),
          ...{
            then: undefined,
          },
        }
      }
      chain.update = (payload: Record<string, unknown>) => {
        state.lastUpdate = payload
        return {
          eq: () => ({
            in: () => ({
              select: () => ({
                single: () => Promise.resolve(state.updateResult ?? { data: { id: `${table}-updated` }, error: null }),
              }),
            }),
            select: () => ({
              single: () => Promise.resolve(state.updateResult ?? { data: { id: `${table}-updated` }, error: null }),
            }),
            then: (cb: (v: unknown) => unknown) => Promise.resolve(state.updateResult ?? { data: null, error: null }).then(cb),
          }),
          then: (cb: (v: unknown) => unknown) => Promise.resolve(state.updateResult ?? { data: null, error: null }).then(cb),
        }
      }
      return chain
    },
  },
}))

// ── Auth + permission ──────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: "admin-1", email: "admin@tonydurante.us" } }, error: null }),
    },
  }),
}))

vi.mock("@/lib/permissions", () => ({
  canPerform: () => true,
}))

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn(() => Promise.resolve({ data: null, error: null })),
}))

vi.mock("@/lib/tax-return-context", () => ({
  findTaxReturnService: () => ({ status: "found", service_context: "business" }),
}))

let _lastTDInvoice: Record<string, unknown> | null = null
vi.mock("@/lib/portal/td-invoice", () => ({
  createTDInvoice: vi.fn((args: Record<string, unknown>) => {
    _lastTDInvoice = args
    return Promise.resolve({ paymentId: "pay-1", invoiceNumber: "INV-TEST-001" })
  }),
}))

// runActivation — capture the pending_activation_id passed to it
let lastActivationId: string | null = null

vi.mock("@/lib/operations/activate-service", () => ({
  runActivation: vi.fn(async (id: string) => {
    lastActivationId = id
    return { ok: true, contract_type: "onboarding" }
  }),
}))

beforeEach(() => {
  resetTables()
  _lastTDInvoice = null
  lastActivationId = null
  process.env.API_SECRET_TOKEN = "test-secret"
  process.env.NEXT_PUBLIC_APP_URL = "https://test.example.com"
})

// ── Route under test ───────────────────────────────────────────────────────

import { POST } from "@/app/api/crm/admin-actions/confirm-payment/route"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/crm/admin-actions/confirm-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const baseBody = {
  payment_method: "wire",
  payment_date: "2026-05-06",
  amount: 1000,
  currency: "USD" as const,
  contract_type: "onboarding" as const,
  bundled_pipelines: [] as string[],
}

// ── Validation ─────────────────────────────────────────────────────────────

describe("confirm-payment — input validation", () => {
  it("rejects when no identifier is provided", async () => {
    const res = await POST(makeRequest({ ...baseBody }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Provide one of: lead_id, account_id, contact_id, offer_token/)
  })

  it("rejects when amount is missing (undefined)", async () => {
    const { amount: _omit, ...noAmount } = baseBody
    const res = await POST(
      makeRequest({ ...noAmount, lead_id: "lead-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Missing or invalid fields/)
  })

  it("rejects a negative amount", async () => {
    const res = await POST(
      makeRequest({ ...baseBody, lead_id: "lead-1", amount: -5 }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Missing or invalid fields/)
  })

  // $0 is a valid amount now: free / already-settled activations (e.g. a
  // $0-setup onboarding contract). The activation must run, but NO invoice
  // should be created for a zero amount.
  it("accepts amount = 0 and creates no invoice", async () => {
    setTable("offers", { selectMaybeSingle: { data: null, error: null } })
    setTable("leads", {
      selectSingle: {
        data: { id: "lead-1", full_name: "Free Client", email: "free@example.com", phone: null, language: "en", status: "Qualified" },
        error: null,
      },
    })
    setTable("contacts", { selectMaybeSingle: { data: null, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-free" }, error: null },
    })

    const res = await POST(
      makeRequest({ ...baseBody, lead_id: "lead-1", amount: 0 }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)
    expect(lastActivationId).toBe("pa-free")
    // No invoice for a $0 activation
    expect(_lastTDInvoice).toBeNull()
  })
})

// ── account_id path ────────────────────────────────────────────────────────

describe("confirm-payment — account_id path", () => {
  it("resolves the latest non-expired offer for the account", async () => {
    setTable("offers", {
      selectMaybeSingle: {
        data: {
          token: "offer-mojo-2026",
          status: "signed",
          contract_type: "onboarding",
          bundled_pipelines: [],
          cost_summary: [],
          client_email: "sanjin@example.com",
          client_name: "Mojo Labs LLC",
          services: [],
          account_id: "account-1",
          lead_id: null,
        },
        error: null,
      },
    })
    setTable("contacts", {
      selectMaybeSingle: { data: { id: "contact-1" }, error: null },
    })
    setTable("account_contacts", {
      selectMaybeSingle: { data: { account_id: "account-1" }, error: null },
    })
    setTable("pending_activations", {
      // no existing activation → falls into "create new" branch
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-1" }, error: null },
    })

    const res = await POST(
      makeRequest({ ...baseBody, account_id: "account-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // runActivation was called with the new activation id
    expect(lastActivationId).toBe("pa-1")
    // The new pending_activation referenced the offer's token
    expect((tables.pending_activations.lastInsert as Record<string, unknown>).offer_token).toBe("offer-mojo-2026")
    // No lead → no lead_id on the activation row
    expect((tables.pending_activations.lastInsert as Record<string, unknown>).lead_id).toBeNull()
  })

  it("returns 404 when no offer exists for the account", async () => {
    setTable("offers", { selectMaybeSingle: { data: null, error: null } })
    const res = await POST(
      makeRequest({ ...baseBody, account_id: "account-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/No offer found for account/)
  })

  // Bug 1 fix (master 9e27e14f, sysdoc ops-2026-05-07-onetime-to-active-journey-fix-plan):
  // confirm-payment must write the new invoice's paymentId back onto the
  // activation BEFORE invoking activate-service. Otherwise activate-service
  // Step 3 sees portal_invoice_id=null and falls through to its own
  // createTDInvoice fallback — second invoice lands. Mojo sandbox 2026-05-07:
  // INV-002192 + INV-002193 both Paid $2000 for one wire.
  it("links the newly created invoice to the activation before calling activate-service", async () => {
    setTable("offers", {
      selectMaybeSingle: {
        data: {
          token: "offer-mojo-2026",
          status: "signed",
          contract_type: "onboarding",
          bundled_pipelines: [],
          cost_summary: [],
          client_email: "sanjin@example.com",
          client_name: "Mojo Labs LLC",
          services: [],
          account_id: "account-1",
          lead_id: null,
        },
        error: null,
      },
    })
    setTable("contacts", {
      selectMaybeSingle: { data: { id: "contact-1" }, error: null },
    })
    setTable("account_contacts", {
      selectMaybeSingle: { data: { account_id: "account-1" }, error: null },
    })
    setTable("pending_activations", {
      // No existing activation — falls into create branch
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-mojo" }, error: null },
    })

    const res = await POST(
      makeRequest({ ...baseBody, account_id: "account-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)

    // The invoice was created
    expect(_lastTDInvoice).not.toBeNull()
    // AND the activation row was updated with the invoice's paymentId — this
    // is what stops activate-service Step 3 from creating a duplicate invoice.
    const upd = tables.pending_activations.lastUpdate as Record<string, unknown> | undefined
    expect(upd).toBeDefined()
    expect(upd?.portal_invoice_id).toBe("pay-1")
  })
})

// ── contact_id path ────────────────────────────────────────────────────────

describe("confirm-payment — contact_id path", () => {
  it("resolves the offer via contact email match", async () => {
    setTable("contacts", {
      selectSingle: { data: { id: "contact-1", email: "buyer@example.com" }, error: null },
      selectMaybeSingle: { data: { id: "contact-1" }, error: null },
    })
    setTable("offers", {
      selectMaybeSingle: {
        data: {
          token: "offer-direct-buyer",
          status: "signed",
          contract_type: "onboarding",
          bundled_pipelines: [],
          cost_summary: [],
          client_email: "buyer@example.com",
          client_name: "Direct Buyer",
          services: [],
          account_id: null,
          lead_id: null,
        },
        error: null,
      },
    })
    setTable("account_contacts", {
      selectMaybeSingle: { data: null, error: null }, // no linked account
    })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-direct" }, error: null },
    })

    const res = await POST(
      makeRequest({ ...baseBody, contact_id: "contact-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)
    expect(lastActivationId).toBe("pa-direct")
  })

  it("returns 404 when contact has no email", async () => {
    setTable("contacts", {
      selectSingle: { data: { id: "contact-1", email: null }, error: null },
    })
    const res = await POST(
      makeRequest({ ...baseBody, contact_id: "contact-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/Contact not found or has no email/)
  })

  it("returns 404 when no offer matches the contact's email", async () => {
    setTable("contacts", {
      selectSingle: { data: { id: "contact-1", email: "lonely@example.com" }, error: null },
    })
    setTable("offers", { selectMaybeSingle: { data: null, error: null } })
    const res = await POST(
      makeRequest({ ...baseBody, contact_id: "contact-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/No offer found for contact/)
  })
})

// ── offer_token path ───────────────────────────────────────────────────────

describe("confirm-payment — offer_token path", () => {
  it("uses the offer directly", async () => {
    setTable("offers", {
      selectMaybeSingle: {
        data: {
          token: "explicit-token",
          status: "signed",
          contract_type: "onboarding",
          bundled_pipelines: [],
          cost_summary: [],
          client_email: "x@example.com",
          client_name: "Direct",
          services: [],
          account_id: "account-X",
          lead_id: null,
        },
        error: null,
      },
    })
    setTable("contacts", { selectMaybeSingle: { data: null, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-tok" }, error: null },
    })

    const res = await POST(
      makeRequest({ ...baseBody, offer_token: "explicit-token" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)
    expect(lastActivationId).toBe("pa-tok")
  })

  it("returns 404 when offer_token doesn't exist", async () => {
    setTable("offers", { selectMaybeSingle: { data: null, error: null } })
    const res = await POST(
      makeRequest({ ...baseBody, offer_token: "missing" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/Offer not found/)
  })
})

// ── lead_id path (regression) ──────────────────────────────────────────────

describe("confirm-payment — lead_id path (existing behavior)", () => {
  it("resolves the latest offer for the lead and runs the chain", async () => {
    // Lead resolution via offer's lead_id field
    setTable("offers", {
      selectMaybeSingle: {
        data: {
          token: "lead-offer",
          status: "signed",
          contract_type: "onboarding",
          bundled_pipelines: [],
          cost_summary: [],
          client_email: "lead@example.com",
          client_name: "Lead Buyer",
          services: [],
          account_id: null,
          lead_id: "lead-1",
        },
        error: null,
      },
    })
    setTable("leads", {
      selectSingle: {
        data: {
          id: "lead-1",
          full_name: "Lead Buyer",
          email: "lead@example.com",
          phone: null,
          language: "en",
          status: "Offer Sent",
        },
        error: null,
      },
    })
    setTable("contacts", { selectMaybeSingle: { data: { id: "contact-1" }, error: null } })
    setTable("account_contacts", { selectMaybeSingle: { data: null, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-lead" }, error: null },
    })

    const res = await POST(
      makeRequest({ ...baseBody, lead_id: "lead-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)
    expect(lastActivationId).toBe("pa-lead")
    // Lead status update fired (captured on the leads table)
    expect((tables.leads.lastUpdate as Record<string, unknown> | undefined)?.status).toBe("Converted")
  })

  it("rejects Mode 2 (no offer + no bundled_pipelines) gracefully", async () => {
    setTable("offers", { selectMaybeSingle: { data: null, error: null } })
    setTable("leads", {
      selectSingle: {
        data: { id: "lead-1", full_name: "X", email: "x@example.com", phone: null, language: "en", status: "Qualified" },
        error: null,
      },
    })
    setTable("contacts", { selectMaybeSingle: { data: null, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-mode2" }, error: null },
    })

    // Mode 2 with no offer + no pipelines should still succeed (legacy lead, no info)
    const res = await POST(
      makeRequest({ ...baseBody, lead_id: "lead-1" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)
  })
})

// ── Cross-cutting: no lead → no lead-status update ─────────────────────────

describe("confirm-payment — lead-status update is skipped when no lead", () => {
  it("does not flip a lead that doesn't exist (account_id path)", async () => {
    setTable("offers", {
      selectMaybeSingle: {
        data: {
          token: "no-lead-offer",
          status: "signed",
          contract_type: "onboarding",
          bundled_pipelines: [],
          cost_summary: [],
          client_email: "b@example.com",
          client_name: "Acct Owner",
          services: [],
          account_id: "account-Y",
          lead_id: null,
        },
        error: null,
      },
    })
    setTable("contacts", { selectMaybeSingle: { data: null, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-Y" }, error: null },
    })

    const res = await POST(
      makeRequest({ ...baseBody, account_id: "account-Y" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(200)
    // The leads table should never have been updated
    expect(tables.leads?.lastUpdate).toBeUndefined()
  })
})
