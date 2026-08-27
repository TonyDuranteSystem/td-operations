/**
 * /api/crm/admin-actions/activate-now — decoupled activation route tests.
 *
 * activate-now turns a signed contract on WITHOUT recording a payment. It
 * resolves the offer (by offer_token or account_id), finds-or-creates a
 * pending_activation, then calls runActivation() directly. It must never
 * write a payment and must be idempotent on an already-activated contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

interface TableState {
  selectMaybeSingle?: { data: unknown; error: { message: string } | null }
  selectSingle?: { data: unknown; error: { message: string } | null }
  insertResult?: { data: unknown; error: { message: string } | null }
  lastInsert?: Record<string, unknown>
}

const tables: Record<string, TableState> = {}
function resetTables() { for (const k of Object.keys(tables)) delete tables[k] }
function setTable(name: string, state: TableState) { tables[name] = { ...(tables[name] ?? {}), ...state } }

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const state: TableState = (tables[table] ??= {})
      const chain: Record<string, unknown> = {}
      const noop = () => chain
      chain.select = noop
      chain.eq = noop
      chain.neq = noop
      chain.order = noop
      chain.limit = noop
      chain.maybeSingle = () => Promise.resolve(state.selectMaybeSingle ?? { data: null, error: null })
      chain.single = () => Promise.resolve(state.selectSingle ?? state.selectMaybeSingle ?? { data: null, error: null })
      chain.insert = (payload: Record<string, unknown>) => {
        state.lastInsert = payload
        return {
          select: () => ({
            single: () => Promise.resolve(state.insertResult ?? { data: { id: `${table}-new` }, error: null }),
          }),
        }
      }
      return chain
    },
  },
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "admin-1", email: "admin@tonydurante.us" } }, error: null }) },
  }),
}))

let _canPerform = true
vi.mock("@/lib/permissions", () => ({ canPerform: () => _canPerform }))

vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))

let lastActivationId: string | null = null
let _activationReturn: unknown = { ok: true, message: "activated" }
vi.mock("@/lib/operations/activate-service", () => ({
  runActivation: vi.fn(async (id: string) => { lastActivationId = id; return _activationReturn }),
}))

beforeEach(() => {
  resetTables()
  lastActivationId = null
  _canPerform = true
  _activationReturn = { ok: true, message: "activated" }
})

import { POST } from "@/app/api/crm/admin-actions/activate-now/route"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/crm/admin-actions/activate-now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const signedOffer = {
  token: "nexo-agency-llc-2026",
  status: "signed",
  client_name: "Nexo Agency LLC",
  client_email: "info@laurelagency.co",
  account_id: "acct-1",
  lead_id: null,
}

describe("activate-now", () => {
  it("rejects when not permitted", async () => {
    _canPerform = false
    const res = await POST(makeRequest({ account_id: "acct-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
  })

  it("rejects when no identifier is provided", async () => {
    const res = await POST(makeRequest({}) as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
  })

  it("returns 404 when the offer token does not exist", async () => {
    setTable("offers", { selectMaybeSingle: { data: null, error: null } })
    const res = await POST(makeRequest({ offer_token: "missing" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(404)
  })

  it("activates an existing awaiting_payment activation without recording payment", async () => {
    setTable("offers", { selectMaybeSingle: { data: signedOffer, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: { id: "pa-nexo", status: "awaiting_payment", activated_at: null }, error: null },
    })
    const res = await POST(makeRequest({ account_id: "acct-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(lastActivationId).toBe("pa-nexo")
    // Never created a payment
    expect(tables.payments?.lastInsert).toBeUndefined()
  })

  it("is idempotent — returns already_activated when activated_at is set", async () => {
    setTable("offers", { selectMaybeSingle: { data: signedOffer, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: { id: "pa-nexo", status: "activated", activated_at: "2026-05-19T22:00:00Z" }, error: null },
    })
    const res = await POST(makeRequest({ offer_token: "nexo-agency-llc-2026" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.already_activated).toBe(true)
    // runActivation NOT called
    expect(lastActivationId).toBeNull()
  })

  it("creates a pending_activation (awaiting_payment) when none exists, then activates", async () => {
    setTable("offers", { selectMaybeSingle: { data: signedOffer, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-created" }, error: null },
    })
    const res = await POST(makeRequest({ account_id: "acct-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(lastActivationId).toBe("pa-created")
    const ins = tables.pending_activations.lastInsert as Record<string, unknown>
    expect(ins.status).toBe("awaiting_payment")
    expect(ins.offer_token).toBe("nexo-agency-llc-2026")
    // No payment fields written (decoupled)
    expect(ins.payment_confirmed_at).toBeUndefined()
    expect(ins.amount).toBeUndefined()
  })

  // Council QA (dev job 3c1bb5fa follow-up): this route had the identical gap
  // as confirm-payment's own fallback-insert branch — the offer's picked
  // formation state was never carried onto a freshly-created activation, so
  // the formation wizard silently defaulted to New Mexico regardless of what
  // the client actually chose. Pin the fix here too.
  it("carries the offer's formation_state onto a newly-created activation", async () => {
    setTable("offers", { selectMaybeSingle: { data: { ...signedOffer, formation_state: "FL" }, error: null } })
    setTable("pending_activations", {
      selectMaybeSingle: { data: null, error: null },
      insertResult: { data: { id: "pa-created" }, error: null },
    })
    const res = await POST(makeRequest({ account_id: "acct-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect((tables.pending_activations.lastInsert as Record<string, unknown>).formation_state).toBe("FL")
  })
})
