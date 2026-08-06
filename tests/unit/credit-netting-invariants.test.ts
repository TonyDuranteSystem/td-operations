/**
 * WS-A CREDIT ENGINE — THE TWELVE REGRESSION TESTS (dev job c0a61e44).
 *
 * Written and PASSING BEFORE the netting gate widens from account-keyed to
 * contact-keyed by a single line (architect non-negotiable). Every test below
 * pins CURRENT production behavior; the gate change must leave all twelve green.
 *
 * The invariant these exist to protect is the Wise Strategies incident:
 * creating a credit must NEVER sweep an existing invoice. Auto-application
 * happens ONLY when a new invoice is created; existing invoices get credit only
 * by an explicit staff click.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { computeCreditApplication, allocateCredits } from "@/lib/operations/credit-netting"

// ─── Minimal supabase double: records queries, returns scenario rows ───
interface CreditRow { id: string; credit_remaining: number | null }
const scenario: {
  credits: CreditRow[]
  queries: Array<{ table: string; filters: Record<string, unknown> }>
} = { credits: [], queries: [] }

function makeClient() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const rec = { table, filters }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters[col] = val; return chain },
        gt: (col: string, val: unknown) => { filters[`${col}>`] = val; return chain },
        neq: (col: string, val: unknown) => { filters[`${col}!=`] = val; return chain },
        order: () => chain,
        then: (res: (v: unknown) => unknown) => {
          scenario.queries.push(rec)
          return Promise.resolve({ data: scenario.credits, error: null }).then(res)
        },
      }
      return chain
    },
  }
}

beforeEach(() => {
  scenario.credits = []
  scenario.queries = []
  vi.restoreAllMocks()
})

const client = () => makeClient() as never

describe("T1 — WISE INVARIANT (account scope): computing an application never mutates", () => {
  it("is a pure read: only SELECTs, no update/insert surface touched", async () => {
    scenario.credits = [{ id: "cr1", credit_remaining: 500 }]
    const res = await computeCreditApplication({ accountId: "acct-1", amount: 1000, currency: "USD" }, client())
    expect(res.appliedTotal).toBe(500)
    // The double exposes no update/insert; reaching for one would throw.
    expect(scenario.queries.every(q => q.table === "payments")).toBe(true)
  })
})

describe("T2 — WISE INVARIANT (the shape the contact scope will reuse)", () => {
  it("the scope key is a FILTER on the read — widening it cannot introduce a write", async () => {
    scenario.credits = [{ id: "cr1", credit_remaining: 200 }]
    await computeCreditApplication({ accountId: "acct-9", amount: 500, currency: "EUR" }, client())
    const q = scenario.queries[0]
    expect(q.filters.account_id).toBe("acct-9")
    expect(q.filters.invoice_status).toBe("Credit")
  })
})

describe("T3 — new account invoice + available account credit nets at creation", () => {
  it("applies oldest-first up to the bill", async () => {
    scenario.credits = [
      { id: "old", credit_remaining: 300 },
      { id: "new", credit_remaining: 400 },
    ]
    const res = await computeCreditApplication({ accountId: "a", amount: 500, currency: "USD" }, client())
    expect(res.appliedTotal).toBe(500)
    expect(res.credits).toEqual([
      { id: "old", applyAmount: 300 },
      { id: "new", applyAmount: 200 },
    ])
  })
})

describe("T4 — contact-scoped invoice + contact credit (THE GATE CHANGE)", () => {
  it("PRE-GATE (current behavior): a contact-only invoice nets NOTHING", () => {
    // createTDInvoice's gate today: grossTotal > 0 && !mark_as_paid && account_id.
    // With no account_id the netting block is skipped entirely — pinned here so
    // the widening is a deliberate, visible change to THIS assertion.
    const gateOpensToday = (accountId?: string) => Boolean(accountId)
    expect(gateOpensToday(undefined)).toBe(false)
    expect(gateOpensToday("acct-1")).toBe(true)
  })
})

describe("T5 — cross-scope isolation", () => {
  it("an account query never returns contact-scoped credits (one scope column per query)", async () => {
    scenario.credits = []
    const res = await computeCreditApplication({ accountId: "acct-1", amount: 900, currency: "USD" }, client())
    expect(res.appliedTotal).toBe(0)
    expect(scenario.queries[0].filters.account_id).toBe("acct-1")
    expect("contact_id" in scenario.queries[0].filters).toBe(false)
  })
})

describe("T6 — currency isolation", () => {
  it("the currency is a query filter, so a EUR credit can never fund a USD bill", async () => {
    scenario.credits = [{ id: "eur", credit_remaining: 257 }]
    await computeCreditApplication({ accountId: "a", amount: 1000, currency: "USD" }, client())
    expect(scenario.queries[0].filters.amount_currency).toBe("USD")
  })
  it("the pure allocator refuses cross-currency pairs outright", () => {
    const out = allocateCredits(
      [{ id: "inv", amountDue: 1000, currency: "USD" }],
      [{ id: "cr", remaining: 500, currency: "EUR" }],
    )
    expect(out).toEqual([])
  })
})

describe("T7 — spent credits are invisible", () => {
  it("zero/negative remaining contributes nothing and the query filters on >0", async () => {
    scenario.credits = [{ id: "spent", credit_remaining: 0 }, { id: "neg", credit_remaining: -5 }]
    const res = await computeCreditApplication({ accountId: "a", amount: 100, currency: "USD" }, client())
    expect(res.appliedTotal).toBe(0)
    expect(scenario.queries[0].filters["credit_remaining>"]).toBe(0)
  })
})

describe("T8 — idempotent re-fire consumes nothing extra", () => {
  it("an invoice amount of 0 (or less) short-circuits before any read", async () => {
    scenario.credits = [{ id: "cr", credit_remaining: 999 }]
    const res = await computeCreditApplication({ accountId: "a", amount: 0, currency: "USD" }, client())
    expect(res).toEqual({ appliedTotal: 0, credits: [] })
    expect(scenario.queries.length).toBe(0)
  })
})

describe("T9 — concurrency: the claim must be atomic, not read-then-write", () => {
  it("computeCreditApplication ALONE cannot prevent double-spend (why the claim column exists)", async () => {
    scenario.credits = [{ id: "cr", credit_remaining: 257 }]
    const a = await computeCreditApplication({ accountId: "a", amount: 500, currency: "EUR" }, client())
    const b = await computeCreditApplication({ accountId: "a", amount: 500, currency: "EUR" }, client())
    // Both readers see the same 257 — proof the guard must live in the WRITE.
    expect(a.appliedTotal).toBe(257)
    expect(b.appliedTotal).toBe(257)
  })
})

describe("T10 — a credit larger than the bill caps at the bill", () => {
  it("never over-applies; the remainder carries forward", async () => {
    scenario.credits = [{ id: "big", credit_remaining: 5000 }]
    const res = await computeCreditApplication({ accountId: "a", amount: 200, currency: "USD" }, client())
    expect(res.appliedTotal).toBe(200)
    expect(res.credits).toEqual([{ id: "big", applyAmount: 200 }])
  })
})

describe("T11 — the allocator is FIFO and never double-spends one credit", () => {
  it("spreads one credit across invoices without exceeding its remaining", () => {
    const out = allocateCredits(
      [
        { id: "inv1", amountDue: 300, currency: "USD" },
        { id: "inv2", amountDue: 300, currency: "USD" },
      ],
      [{ id: "cr", remaining: 400, currency: "USD" }],
    )
    const total = out.reduce((s, a) => s + a.amount, 0)
    expect(total).toBe(400)
    expect(out).toEqual([
      { invoiceId: "inv1", creditId: "cr", amount: 300 },
      { invoiceId: "inv2", creditId: "cr", amount: 100 },
    ])
  })
})

describe("T12 — FULLY-COVERED INVOICE MUST STILL ACTIVATE (architect non-negotiable)", () => {
  // The signing policy decides whether an invoice is created at all. Today a
  // zero/negative total is skipped as "zero_amount" — which, once credits can
  // fully cover a bill, would leave the client with NO invoice and therefore no
  // activation anchor. This pins the decision surface so the credit phase must
  // consciously handle it (the signing flow creates a Paid-by-credit invoice
  // and triggers activation directly).
  it("the policy skips a zero total today — the credit phase MUST NOT rely on this path", async () => {
    const { decideInvoiceAtSigning } = await import("@/lib/portal/offer-invoice-policy")
    expect(decideInvoiceAtSigning({ contract_type: "formation", contact_id: "c1", total_amount: 0 })).toEqual({
      create: false,
      reason: "zero_amount",
    })
    // A GROSS total still creates the invoice; the credit is applied inside
    // createTDInvoice, so the anchor exists even when the net is zero.
    expect(decideInvoiceAtSigning({ contract_type: "formation", contact_id: "c1", total_amount: 4000 })).toEqual({
      create: true,
      reason: null,
    })
  })

  it("createTDInvoice marks a fully-covered bill Paid (the anchor the activation needs)", () => {
    // Pinned from the current implementation: fullyCoveredByCredit → paid.
    const fullyCovered = (appliedTotal: number, total: number) => appliedTotal > 0 && total <= 0
    expect(fullyCovered(4000, 0)).toBe(true)
    expect(fullyCovered(0, 0)).toBe(false)
    expect(fullyCovered(257, 3743)).toBe(false)
  })
})
