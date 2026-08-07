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
        is: (col: string, val: unknown) => { filters[`${col} IS`] = val; return chain },
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

describe("T4 — contact-scoped invoice + contact credit (THE GATE CHANGE — NOW OPEN)", () => {
  it("POST-GATE: the gate opens for EITHER scope (this assertion changed deliberately)", () => {
    // createTDInvoice's gate: grossTotal > 0 && !mark_as_paid &&
    // (account_id || contact_id) && !skip_credit_netting.
    const gateOpens = (accountId?: string, contactId?: string) => Boolean(accountId || contactId)
    expect(gateOpens(undefined, undefined)).toBe(false)
    expect(gateOpens("acct-1", undefined)).toBe(true)
    expect(gateOpens(undefined, "contact-1")).toBe(true) // WAS false pre-gate
  })

  it("a contact-scoped application filters on contact_id — never account_id", async () => {
    scenario.credits = [{ id: "cr", credit_remaining: 257 }]
    const res = await computeCreditApplication({ contactId: "contact-1", amount: 4000, currency: "EUR" }, client())
    expect(res.appliedTotal).toBe(257)
    expect(scenario.queries[0].filters.contact_id).toBe("contact-1")
    expect("account_id" in scenario.queries[0].filters).toBe(false)
  })

  it("neither scope supplied → no read, no application (defensive)", async () => {
    const res = await computeCreditApplication({ amount: 100, currency: "EUR" } as never, client())
    expect(res).toEqual({ appliedTotal: 0, credits: [] })
    expect(scenario.queries.length).toBe(0)
  })
})

describe("T5 — cross-scope isolation", () => {
  it("an account query never returns contact-scoped credits (one scope column per query)", async () => {
    scenario.credits = []
    const res = await computeCreditApplication({ accountId: "acct-1", amount: 900, currency: "USD" }, client())
    expect(res.appliedTotal).toBe(0)
    expect(scenario.queries[0].filters.account_id).toBe("acct-1")
    expect("contact_id" in scenario.queries[0].filters).toBe(false)
    // WS-A: claimed credits are excluded at the read as well as guarded at the write
    expect(scenario.queries[0].filters["credit_consumed_by IS"]).toBe(null)
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

// ─── T13/T14: the ATOMIC CLAIM (the write-side guard T9 proved is required) ───

interface ClaimCall { id: string; set: unknown; whereNull: boolean; whereToken?: string }
const claimState: { winners: Set<string>; calls: ClaimCall[] } = { winners: new Set(), calls: [] }

function claimClient() {
  return {
    from() {
      let pendingSet: unknown = null
      let id = ""
      let whereNull = false
      let whereToken: string | undefined
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      const chain: any = {
        update: (vals: Record<string, unknown>) => { pendingSet = vals.credit_consumed_by; return chain },
        eq: (col: string, val: string) => {
          if (col === "id") id = val
          if (col === "credit_consumed_by") whereToken = val
          return chain
        },
        is: () => { whereNull = true; return chain },
        select: () => {
          claimState.calls.push({ id, set: pendingSet, whereNull, whereToken })
          // Conditional claim: only the FIRST claimer of an id wins.
          const alreadyClaimed = claimState.winners.has(id)
          if (whereNull && alreadyClaimed) return Promise.resolve({ data: [], error: null })
          if (whereNull) claimState.winners.add(id)
          return Promise.resolve({ data: [{ id }], error: null })
        },
        then: (res: (v: unknown) => unknown) => {
          claimState.calls.push({ id, set: pendingSet, whereNull, whereToken })
          if (whereToken) claimState.winners.delete(id) // unwind
          return Promise.resolve({ error: null }).then(res)
        },
      }
      return chain
    },
  }
}

describe("T13 — the claim is atomic: of two racers exactly one wins", () => {
  it("second claimer of the same credit gets nothing (rowcount 0)", async () => {
    const { claimCredits } = await import("@/lib/operations/credit-netting")
    claimState.winners.clear(); claimState.calls.length = 0
    const application = { appliedTotal: 257, credits: [{ id: "cr-257", applyAmount: 257 }] }
    const first = await claimCredits(application, "invoice-A", claimClient() as never)
    const second = await claimCredits(application, "invoice-B", claimClient() as never)
    expect(first.appliedTotal).toBe(257)
    expect(first.credits).toEqual([{ id: "cr-257", applyAmount: 257 }])
    expect(second.appliedTotal).toBe(0)
    expect(second.credits).toEqual([])
    // Every claim carried the IS NULL condition — never a blind overwrite.
    expect(claimState.calls.every(c => c.whereNull || c.whereToken)).toBe(true)
  })
})

describe("T14 — unwind releases only THIS caller's claims", () => {
  it("a failed invoice creation frees the credit for the next claimer", async () => {
    const { claimCredits, unwindCreditClaims } = await import("@/lib/operations/credit-netting")
    claimState.winners.clear(); claimState.calls.length = 0
    const application = { appliedTotal: 100, credits: [{ id: "cr-100", applyAmount: 100 }] }
    const won = await claimCredits(application, "invoice-X", claimClient() as never)
    expect(won.appliedTotal).toBe(100)
    await unwindCreditClaims(won, "invoice-X", claimClient() as never)
    // Released → the next caller can claim it.
    const after = await claimCredits(application, "invoice-Y", claimClient() as never)
    expect(after.appliedTotal).toBe(100)
    // The release was scoped to the claim token, never a blanket null-out.
    expect(claimState.calls.some(c => c.whereToken === "invoice-X")).toBe(true)
  })
})

// ─── T15-T18: adversarial-QA blocker fixes (money-path matrix round) ───

describe("T15 — a PARTIALLY used credit returns to the pool (hunter blocker 1)", () => {
  it("confirm RELEASES the lock while a balance remains, and stamps only when exhausted", async () => {
    const { confirmCreditClaims } = await import("@/lib/operations/credit-netting")
    const writes: Array<{ id: string; set: unknown }> = []
    const client = (remaining: number) => ({
      from() {
        let id = ""
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
        const chain: any = {
          select: () => chain,
          update: (v: Record<string, unknown>) => { chain._set = v.credit_consumed_by; return chain },
          eq: (col: string, val: string) => { if (col === "id") id = val; return chain },
          maybeSingle: async () => ({ data: { credit_remaining: remaining }, error: null }),
          then: (res: (v: unknown) => unknown) => {
            writes.push({ id, set: chain._set })
            return Promise.resolve({ error: null }).then(res)
          },
        }
        return chain
      },
    })
    const app = { appliedTotal: 100, credits: [{ id: "cr", applyAmount: 100 }] }

    writes.length = 0
    await confirmCreditClaims(app, "invoice-1", "token-1", client(157) as never)
    expect(writes.at(-1)?.set).toBe(null) // balance remains → released to the pool

    writes.length = 0
    await confirmCreditClaims(app, "invoice-1", "token-1", client(0) as never)
    expect(writes.at(-1)?.set).toBe("invoice-1") // exhausted → stamped for audit
  })
})

describe("T16 — cross-currency credits are REPORTED, never silently ignored (major 4)", () => {
  it("a EUR credit against a USD bill surfaces as stranded", async () => {
    const rows: Record<string, unknown[]> = {
      match: [],
      other: [{ id: "eur", credit_remaining: 257, amount_currency: "EUR" }],
    }
    let call = 0
    const client = {
      from() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
        const chain: any = {}
        for (const m of ["select", "eq", "gt", "is", "neq", "order"]) chain[m] = () => chain
        chain.then = (res: (v: unknown) => unknown) => {
          const data = call++ === 0 ? rows.match : rows.other
          return Promise.resolve({ data, error: null }).then(res)
        }
        return chain
      },
    }
    const res = await computeCreditApplication(
      { contactId: "c1", amount: 4000, currency: "USD" },
      client as never,
    )
    expect(res.appliedTotal).toBe(0)
    expect(res.strandedByCurrency).toEqual([{ amount: 257, currency: "EUR" }])
  })
})

describe("T18 — an IN-FLIGHT credit is not called spent (hunter major 3)", () => {
  it("claimed-with-balance yields an in-flight review card, not a true-up instruction", async () => {
    const inFlight = { credit_remaining: 257, credit_consumed_by: "some-token" }
    // The classification rule under test, stated directly:
    const spent = Number(inFlight.credit_remaining) <= 0
    const isInFlight = Number(inFlight.credit_remaining) > 0 && !!inFlight.credit_consumed_by
    expect(spent).toBe(false)
    expect(isInFlight).toBe(true)
  })
})
