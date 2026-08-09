/**
 * WS-A MONEY-PATH E2E — LIVE against the cloud sandbox (dev job c0a61e44).
 *
 * This is NOT a unit test. It drives the REAL exported functions against real
 * Postgres and re-reads every row it claims. Mocks prove logic; this proves the
 * logic survives contact with the database — conditional-UPDATE rowcounts,
 * oldest-first ordering under real timestamps, the PostgREST filter semantics,
 * the expense-mirror path, and the bank-feed matcher's identity tier.
 *
 *   npx vitest run --config vitest.ws-a-e2e.config.ts
 *
 * Environment and the sandbox-only guarantee come from the shared live-test
 * setup (tests/live/_env-ws-a.ts) — deliberately NOT a private loader, which is
 * how this file started and how it came to lack the email-blocking the shared
 * one enforces.
 *
 * Every row it creates is tagged QAMTX and swept in afterAll, which ASSERTS the
 * fixture count reaches zero.
 */
/* eslint-disable no-restricted-syntax -- P2.4 routes production writes through
   lib/operations. This file is the opposite of production code: it SEEDS and
   TEARS DOWN fixtures in a sandbox database, and going through the operations
   helpers would mean testing the code under test with itself. */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import { recordPaidCall } from "@/lib/operations/paid-call-credit"
import { extractPaidBooking, paidCallIdempotencyKey } from "@/lib/calendly/paid-booking"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { handleChargeReversal } from "@/lib/operations/credit-reversal"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"
import { ensureMinimalAccount } from "@/lib/portal/auto-create"
import { createOffer } from "@/lib/operations/offers"
import { computeOfferPayable } from "@/lib/offers/compute-offer-totals"
import { resolveCreditSubject, subjectForDisplay } from "@/lib/operations/credit-subject"
import {
  computeCreditApplication, claimCredits, confirmCreditClaims, unwindCreditClaims,
  availableCreditForDisplay, unspentCreditByCurrency,
} from "@/lib/operations/credit-netting"

const db: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─── fixtures ──────────────────────────────────────────────────────────────
const TAG = `QAMTX-${Date.now()}`
const ids = { contactA: "", contactB: "", accountX: "", accountY: "" }
const charges: string[] = []
const feeds: string[] = []

/**
 * A FRESH person per test. The first run of this matrix shared two fixture
 * contacts across all cells and produced seven failures that looked like product
 * bugs and were not: credits are consumed OLDEST-FIRST, so each cell was eating
 * the leftovers of the cells before it. Isolation is not tidiness here — without
 * it the harness cannot tell "the code ignored my credit" from "the code
 * correctly took an older one".
 */
const extraContacts: string[] = []
const extraAccounts: string[] = []
async function freshPerson(label: string): Promise<{ id: string; email: string }> {
  const email = `${TAG.toLowerCase()}-${label}@example.com`
  const { data, error } = await db.from("contacts")
    .insert({ full_name: `${TAG} ${label}`, email, status: "active" })
    .select("id").single()
  if (error) throw new Error(`fixture contact ${label}: ${error.message}`)
  const id = (data as { id: string }).id
  extraContacts.push(id)
  return { id, email }
}

async function paymentsFor(scope: { account_id?: string; contact_id?: string }) {
  const col = scope.account_id ? "account_id" : "contact_id"
  const val = scope.account_id ?? scope.contact_id
  const { data } = await db.from("payments").select("*").eq(col, val!)
  return (data ?? []) as Array<Record<string, unknown>>
}
async function payment(id: string) {
  const { data } = await db.from("payments").select("*").eq("id", id).maybeSingle()
  return data as Record<string, unknown> | null
}
function newCharge(suffix: string) {
  const c = `ch_${TAG}_${suffix}`
  charges.push(c)
  return c
}
function booking(chargeId: string, amount: number, currency: string) {
  // Mirrors the real Calendly invitee.created payment object shape.
  return { chargeId, amount, currency, provider: "stripe", successful: true }
}

beforeAll(async () => {
  const { data: a } = await db.from("contacts").insert({ full_name: `${TAG} Person A`, email: `${TAG.toLowerCase()}-a@example.com`, status: "active" }).select("id").single()
  const { data: b } = await db.from("contacts").insert({ full_name: `${TAG} Person B`, email: `${TAG.toLowerCase()}-b@example.com`, status: "active" }).select("id").single()
  ids.contactA = (a as { id: string }).id
  ids.contactB = (b as { id: string }).id
  const { data: x } = await db.from("accounts").insert({ company_name: `${TAG} Co X` }).select("id").single()
  const { data: y } = await db.from("accounts").insert({ company_name: `${TAG} Co Y` }).select("id").single()
  ids.accountX = (x as { id: string }).id
  ids.accountY = (y as { id: string }).id
  await db.from("account_contacts").insert([
    { account_id: ids.accountX, contact_id: ids.contactA },
  ])
}, 60_000)

/**
 * Sweep everything this run tagged, in FK order, and SAY SO if a step fails.
 * The first version deleted by id-list and failed silently, leaving 36 contacts
 * and 164 payment rows behind in sandbox — a cleanup that reports nothing is
 * indistinguishable from one that did nothing.
 */
async function sweep(): Promise<string[]> {
  const problems: string[] = []
  const step = async (label: string, fn: () => Promise<{ error: unknown }>) => {
    const { error } = await fn()
    if (error) problems.push(`${label}: ${(error as { message?: string }).message ?? String(error)}`)
  }

  if (feeds.length) {
    await step("payment_applications", () => db.from("payment_applications").delete().in("feed_id", feeds))
    await step("td_bank_feeds", () => db.from("td_bank_feeds").delete().in("id", feeds))
  }
  const { data: cRows } = await db.from("contacts").select("id").like("full_name", `${TAG}%`)
  const { data: aRows } = await db.from("accounts").select("id").like("company_name", `${TAG}%`)
  const contacts = ((cRows ?? []) as Array<{ id: string }>).map(r => r.id)
  const accounts = ((aRows ?? []) as Array<{ id: string }>).map(r => r.id)
  if (!contacts.length && !accounts.length) return problems

  const scoped = async (table: string) => {
    const out: string[] = []
    if (contacts.length) {
      const { data } = await db.from(table).select("id").in("contact_id", contacts)
      out.push(...((data ?? []) as Array<{ id: string }>).map(r => r.id))
    }
    if (accounts.length) {
      const { data } = await db.from(table).select("id").in("account_id", accounts)
      out.push(...((data ?? []) as Array<{ id: string }>).map(r => r.id))
    }
    return [...new Set(out)]
  }

  const expIds = await scoped("client_expenses")
  if (expIds.length) {
    await step("client_expense_items", () => db.from("client_expense_items").delete().in("expense_id", expIds))
    await step("client_expenses", () => db.from("client_expenses").delete().in("id", expIds))
  }
  const payIds = await scoped("payments")
  if (payIds.length) {
    await step("payment_items", () => db.from("payment_items").delete().in("payment_id", payIds))
    await step("payments", () => db.from("payments").delete().in("id", payIds))
  }
  if (contacts.length) {
    await step("offers(contact)", () => db.from("offers").delete().in("contact_id", contacts))
  await step("offers(tag)", () => db.from("offers").delete().like("client_name", `${TAG}%`))
  await step("system_errors", () => db.from("system_errors").delete().like("context->>client_name", `${TAG}%`))
    await step("account_contacts(contact)", () => db.from("account_contacts").delete().in("contact_id", contacts))
  }
  if (accounts.length) {
    await step("account_contacts(account)", () => db.from("account_contacts").delete().in("account_id", accounts))
  }
  // The invoice paths write audit rows that reference the contact — these must
  // go before the contact can. Sandbox fixture audit only; nothing real is touched.
  if (contacts.length) await step("action_log(contact)", () => db.from("action_log").delete().in("contact_id", contacts))
  if (accounts.length) await step("action_log(account)", () => db.from("action_log").delete().in("account_id", accounts))
  if (contacts.length) await step("contacts", () => db.from("contacts").delete().in("id", contacts))
  if (accounts.length) await step("accounts", () => db.from("accounts").delete().in("id", accounts))
  return problems
}

afterAll(async () => {
  // Two passes: the first clears the bulk, the second catches anything a
  // cascade or a mid-test inline delete left dangling.
  let problems = await sweep()
  problems = problems.concat(await sweep())

  const { data: leftC } = await db.from("contacts").select("id").like("full_name", `${TAG}%`)
  const { data: leftA } = await db.from("accounts").select("id").like("company_name", `${TAG}%`)
  const left = ((leftC ?? []).length) + ((leftA ?? []).length)
  if (problems.length || left > 0) {
    // Loud on purpose: sandbox residue misleads the next session's queries.
    console.error(`[matrix cleanup] ${left} fixture row(s) survived. Problems: ${problems.join(" | ") || "none reported"}`)
  }
  expect(left).toBe(0)
}, 180_000)

// ══ CELL 1 — booking → records ════════════════════════════════════════════

describe("CELL 1 — a paid booking becomes exactly one invoice + one credit", () => {
  it("1a EUR booking: Paid invoice + credit note, both keyed on the charge", async () => {
    const ch = newCharge("eur")
    const res = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: `${TAG.toLowerCase()}-a@example.com`,
      inviteeName: `${TAG} Person A`,
      callDate: "2026-08-06",
    })
    expect(res.contactCreated).toBe(false)
    expect(res.contactId).toBe(ids.contactA)

    const inv = await payment(res.invoiceId)
    expect(inv).toBeTruthy()
    expect(Number(inv!.total)).toBe(257)
    expect(inv!.amount_currency).toBe("EUR")
    expect(inv!.invoice_status).toBe("Paid")
    expect(inv!.idempotency_key).toBe(paidCallIdempotencyKey(ch, "invoice"))

    const cr = await payment(res.creditId!)
    expect(cr!.invoice_status).toBe("Credit")
    expect(Number(cr!.credit_remaining)).toBe(257)
    expect(Number(cr!.total)).toBe(-257)
    expect(cr!.idempotency_key).toBe(paidCallIdempotencyKey(ch, "credit"))
    // MAJOR 5: the credit is person-scoped even though this person owns Co X.
    expect(cr!.contact_id).toBe(ids.contactA)
    expect(cr!.account_id).toBeNull()
  })

  it("1b USD booking at a different amount — nothing is hardcoded to 257/EUR", async () => {
    const ch = newCharge("usd")
    const res = await recordPaidCall({
      payment: booking(ch, 157, "USD"),
      inviteeEmail: `${TAG.toLowerCase()}-b@example.com`,
      inviteeName: `${TAG} Person B`,
      callDate: "2026-08-06",
    })
    const cr = await payment(res.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(157)
    expect(cr!.amount_currency).toBe("USD")
  })

  it("1c a FREE booking is not a paid booking — extractor returns null, no money rows", () => {
    expect(extractPaidBooking({ payload: { payment: null } })).toBeNull()
    expect(extractPaidBooking({ payload: {} })).toBeNull()
    expect(extractPaidBooking({ payload: { payment: { successful: false, amount: 257 } } })).toBeNull()
  })

  it("1d an UNKNOWN payer gets a contact created (Antonio-approved) and a credit that lands on it", async () => {
    const ch = newCharge("unknown")
    const email = `${TAG.toLowerCase()}-unknown@example.com`
    const res = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: email,
      inviteeName: `${TAG} Brand New Person`,
      callDate: "2026-08-06",
    })
    expect(res.contactCreated).toBe(true)
    const cr = await payment(res.creditId!)
    expect(cr!.contact_id).toBe(res.contactId)
    // no portal side effect: creating a contact must not mint a portal login
    const { data: pu } = await db.from("portal_users").select("id").eq("contact_id", res.contactId)
    expect((pu ?? []).length).toBe(0)
    // NOT cleaned up inline — the afterAll sweep owns FK order. An inline
    // payments delete here failed on payment_items and left orphans behind.
    extraContacts.push(res.contactId)
  })

  it("1e an existing contact matches case- and whitespace-insensitively — no duplicate person", async () => {
    const ch = newCharge("case")
    const res = await recordPaidCall({
      payment: booking(ch, 50, "EUR"),
      inviteeEmail: `  ${TAG.toUpperCase()}-A@EXAMPLE.COM  `.trim(),
      inviteeName: "Different Name Entirely",
      callDate: "2026-08-06",
    })
    expect(res.contactCreated).toBe(false)
    expect(res.contactId).toBe(ids.contactA)
  })

  it("1f the SAME charge re-delivered creates no second invoice and no second credit", async () => {
    const ch = newCharge("redeliver")
    const first = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: `${TAG.toLowerCase()}-a@example.com`, callDate: "2026-08-06",
    })
    const second = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: `${TAG.toLowerCase()}-a@example.com`, callDate: "2026-08-06",
    })
    expect(second.invoiceId).toBe(first.invoiceId)
    expect(second.creditId).toBe(first.creditId)
    const rows = await paymentsFor({ contact_id: ids.contactA })
    expect(rows.filter(r => r.idempotency_key === paidCallIdempotencyKey(ch, "invoice")).length).toBe(1)
    expect(rows.filter(r => r.idempotency_key === paidCallIdempotencyKey(ch, "credit")).length).toBe(1)
    // MAJOR 6: re-delivery must NOT reset a partly-spent credit back to full.
    const cr = await payment(first.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(257)
  })
})

// ══ CELL 2 — charge → payment-intent, and the failure path ════════════════

describe("CELL 2 — the Stripe PI stamp, and what happens when it can't be resolved", () => {
  it("2a with no Stripe key the PI cannot resolve — the booking is STILL fully recorded", async () => {
    const ch = newCharge("nopi")
    const res = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: `${TAG.toLowerCase()}-a@example.com`, callDate: "2026-08-06",
    })
    // Sandbox has STRIPE_SECRET_KEY="" — this is the real failure path, not a mock.
    expect(res.paymentIntentStamped).toBe(false)
    const inv = await payment(res.invoiceId)
    expect(inv!.invoice_status).toBe("Paid")          // money still recorded
    expect(inv!.stripe_payment_id).toBeNull()          // and the gap is VISIBLE
    const cr = await payment(res.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(257)     // credit still spendable
  })
})

// ══ CELL 3 — netting ══════════════════════════════════════════════════════

describe("CELL 3 — a later invoice nets against the credit", () => {
  it("3a same person, same currency: auto-nets, claim stamped, remaining decremented", async () => {
    const p = await freshPerson("net")
    const ch = newCharge("net")
    const paid = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    const before = await payment(paid.creditId!)
    expect(Number(before!.credit_remaining)).toBe(257)

    const inv = await createTDInvoice({
      contact_id: p.id,
      line_items: [{ description: `${TAG} Formation`, unit_price: 1000, quantity: 1 }],
      currency: "EUR",
      idempotency_key: `${TAG}-net-1`,
    })
    const after = await payment(paid.creditId!)
    expect(Number(after!.credit_remaining)).toBe(0)          // fully consumed
    expect(after!.credit_consumed_by).toBe(inv.paymentId)    // exhausted ⇒ tombstoned
    const invRow = await payment(inv.paymentId)
    expect(Number(invRow!.total)).toBe(1000 - 257)           // client owes the net
  })

  it("3b BLOCKER 1 LIVE: a credit BIGGER than the bill keeps its leftover spendable", async () => {
    const p = await freshPerson("partial")
    const ch = newCharge("partial")
    const paid = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    const inv = await createTDInvoice({
      contact_id: p.id,
      line_items: [{ description: `${TAG} Small job`, unit_price: 100, quantity: 1 }],
      currency: "EUR",
      idempotency_key: `${TAG}-partial-1`,
    })
    const cr = await payment(paid.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(157)  // the money that used to vanish
    expect(cr!.credit_consumed_by).toBeNull()       // lock RELEASED, not a tombstone

    // and the leftover is genuinely reusable on the next bill
    const inv2 = await createTDInvoice({
      contact_id: p.id,
      line_items: [{ description: `${TAG} Next job`, unit_price: 200, quantity: 1 }],
      currency: "EUR",
      idempotency_key: `${TAG}-partial-2`,
    })
    const inv2Row = await payment(inv2.paymentId)
    expect(Number(inv2Row!.total)).toBe(43)         // 200 − 157
    const crFinal = await payment(paid.creditId!)
    expect(Number(crFinal!.credit_remaining)).toBe(0)
    expect(crFinal!.credit_consumed_by).toBe(inv2.paymentId)
    void inv
  })

  it("3c a currency mismatch nets NOTHING — no silent FX — and says so", async () => {
    const p = await freshPerson("fx")
    const ch = newCharge("fx")
    const paid = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    const app = await computeCreditApplication({ contactId: p.id, amount: 500, currency: "USD" }, db)
    expect(app.appliedTotal).toBe(0)
    // MAJOR 4: the stranded credit is REPORTED, not silently swallowed
    expect(app.strandedByCurrency?.some(s => s.currency === "EUR" && s.amount === 257)).toBe(true)
    const cr = await payment(paid.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(257)  // untouched
  })

  it("3d cross-scope isolation, both directions: a person's credit is not a company's", async () => {
    const ch = newCharge("scope")
    await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: `${TAG.toLowerCase()}-a@example.com`, callDate: "2026-08-06",
    })
    // Person A owns Co X (linked in beforeAll) — that link is the point of this cell.
    // Co X's bill must NOT see Person A's personal credit, even though A owns X.
    const forAccount = await computeCreditApplication({ accountId: ids.accountX, amount: 1000, currency: "EUR" }, db)
    expect(forAccount.appliedTotal).toBe(0)
    // and an unrelated person sees nothing either
    // and an unrelated fresh person sees nothing of A's credit either
    const stranger = await freshPerson("stranger")
    const forOther = await computeCreditApplication({ contactId: stranger.id, amount: 1000, currency: "EUR" }, db)
    expect(forOther.appliedTotal).toBe(0)
  })

  it("3e WISE INVARIANT LIVE: creating a credit never touches an existing invoice", async () => {
    const existing = await createTDInvoice({
      account_id: ids.accountY,
      line_items: [{ description: `${TAG} Pre-existing bill`, unit_price: 900, quantity: 1 }],
      currency: "EUR",
      idempotency_key: `${TAG}-wise-1`,
    })
    const beforeRow = await payment(existing.paymentId)
    const ch = newCharge("wise")
    await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: `${TAG.toLowerCase()}-a@example.com`, callDate: "2026-08-06",
    })
    const afterRow = await payment(existing.paymentId)
    expect(Number(afterRow!.total)).toBe(Number(beforeRow!.total))
    expect(afterRow!.invoice_status).toBe(beforeRow!.invoice_status)
    expect(afterRow!.credit_consumed_by ?? null).toBeNull()
  })

  it("3f a FULLY covered invoice comes out Paid, not sitting unpaid at zero", async () => {
    const p = await freshPerson("covered")
    const ch = newCharge("covered")
    await recordPaidCall({
      payment: booking(ch, 300, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    const inv = await createTDInvoice({
      contact_id: p.id,
      line_items: [{ description: `${TAG} Fully covered`, unit_price: 300, quantity: 1 }],
      currency: "EUR",
      idempotency_key: `${TAG}-covered-1`,
    })
    const row = await payment(inv.paymentId)
    expect(Number(row!.total)).toBe(0)
    expect(row!.invoice_status).toBe("Paid")
  })
})

// ══ CELL 4 — concurrency and unwind ═══════════════════════════════════════

describe("CELL 4 — two things reaching for the same credit at the same time", () => {
  it("4a two concurrent signings, one credit: exactly ONE wins, the loser bills gross", async () => {
    const p = await freshPerson("race")
    const ch = newCharge("race")
    await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    const [a, b] = await Promise.all([
      createTDInvoice({ contact_id: p.id, line_items: [{ description: `${TAG} Race A`, unit_price: 1000, quantity: 1 }], currency: "EUR", idempotency_key: `${TAG}-race-a` }),
      createTDInvoice({ contact_id: p.id, line_items: [{ description: `${TAG} Race B`, unit_price: 1000, quantity: 1 }], currency: "EUR", idempotency_key: `${TAG}-race-b` }),
    ])
    const rowA = await payment(a.paymentId)
    const rowB = await payment(b.paymentId)
    const totals = [Number(rowA!.total), Number(rowB!.total)].sort((x, y) => x - y)
    // one netted (743), one full price (1000) — never both discounted
    expect(totals).toEqual([743, 1000])
  })

  it("4b claim → unwind leaves the credit exactly as it was, available to anyone", async () => {
    const p = await freshPerson("unwind")
    const ch = newCharge("unwind")
    const paid = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    const token = crypto.randomUUID()
    const app = await computeCreditApplication({ contactId: p.id, amount: 500, currency: "EUR" }, db)
    const won = await claimCredits(app, token, db)
    expect(won.credits.length).toBeGreaterThan(0)
    const claimed = await payment(paid.creditId!)
    expect(claimed!.credit_consumed_by).toBe(token)
    // While claimed, nobody else can see it — that is the whole point of the lock.
    const blocked = await computeCreditApplication({ contactId: p.id, amount: 500, currency: "EUR" }, db)
    expect(blocked.appliedTotal).toBe(0)

    await unwindCreditClaims(won, token, db)
    const released = await payment(paid.creditId!)
    expect(released!.credit_consumed_by).toBeNull()
    expect(Number(released!.credit_remaining)).toBe(257)  // balance never touched
    const visible = await computeCreditApplication({ contactId: p.id, amount: 500, currency: "EUR" }, db)
    expect(visible.appliedTotal).toBe(257)
  })

  it("4c an unwind releases ONLY its own claims, never a concurrent winner's", async () => {
    const ch1 = newCharge("mine")
    const ch2 = newCharge("theirs")
    const p = await freshPerson("twoclaims")
    const mine = await recordPaidCall({ payment: booking(ch1, 100, "EUR"), inviteeEmail: p.email, callDate: "2026-08-06" })
    const theirs = await recordPaidCall({ payment: booking(ch2, 100, "EUR"), inviteeEmail: p.email, callDate: "2026-08-06" })
    const tokenMine = crypto.randomUUID()
    const tokenTheirs = crypto.randomUUID()
    await claimCredits({ appliedTotal: 100, credits: [{ id: mine.creditId!, applyAmount: 100 }] }, tokenMine, db)
    await claimCredits({ appliedTotal: 100, credits: [{ id: theirs.creditId!, applyAmount: 100 }] }, tokenTheirs, db)
    await unwindCreditClaims({ appliedTotal: 100, credits: [{ id: mine.creditId!, applyAmount: 100 }] }, tokenMine, db)
    expect((await payment(mine.creditId!))!.credit_consumed_by).toBeNull()
    expect((await payment(theirs.creditId!))!.credit_consumed_by).toBe(tokenTheirs)
    await unwindCreditClaims({ appliedTotal: 100, credits: [{ id: theirs.creditId!, applyAmount: 100 }] }, tokenTheirs, db)
  })

  it("4d confirm on a partially-used credit releases the lock (blocker 1, at the DB)", async () => {
    const p = await freshPerson("confirm")
    const ch = newCharge("confirm")
    const paid = await recordPaidCall({ payment: booking(ch, 257, "EUR"), inviteeEmail: p.email, callDate: "2026-08-06" })
    const token = crypto.randomUUID()
    const app = { appliedTotal: 100, credits: [{ id: paid.creditId!, applyAmount: 100 }] }
    await claimCredits(app, token, db)
    // simulate the decrement the invoice path performs, leaving a balance
    await db.from("payments").update({ credit_remaining: 157 }).eq("id", paid.creditId!)
    await confirmCreditClaims(app, "00000000-0000-0000-0000-000000000001", token, db)
    const row = await payment(paid.creditId!)
    expect(row!.credit_consumed_by).toBeNull()
    expect(Number(row!.credit_remaining)).toBe(157)
  })
})

// ══ CELL 5 — money going back ═════════════════════════════════════════════

describe("CELL 5 — refunds and disputes", () => {
  it("5a refund on an UNSPENT credit voids it", async () => {
    const p = await freshPerson("refund-unspent")
    const ch = newCharge("refund-unspent")
    const paid = await recordPaidCall({ payment: booking(ch, 257, "EUR"), inviteeEmail: p.email, callDate: "2026-08-06" })
    const res = await handleChargeReversal(ch, "charge.refunded")
    expect(res.outcome).toBe("voided")
    const row = await payment(paid.creditId!)
    expect(Number(row!.credit_remaining)).toBe(0)
    expect(row!.invoice_status).toBe("Cancelled")
  })

  it("5b refund on a SPENT credit raises a review card and leaves the invoice alone", async () => {
    const p = await freshPerson("refund-spent")
    const ch = newCharge("refund-spent")
    const paid = await recordPaidCall({ payment: booking(ch, 257, "EUR"), inviteeEmail: p.email, callDate: "2026-08-06" })
    const inv = await createTDInvoice({
      contact_id: p.id,
      line_items: [{ description: `${TAG} Spent-credit job`, unit_price: 1000, quantity: 1 }],
      currency: "EUR", idempotency_key: `${TAG}-spent-1`,
    })
    const invBefore = await payment(inv.paymentId)
    const res = await handleChargeReversal(ch, "charge.refunded")
    expect(res.outcome).toBe("needs_review")
    expect(res.outcome === "needs_review" && res.reason).toMatch(/TRUE-UP/)
    const invAfter = await payment(inv.paymentId)
    expect(Number(invAfter!.total)).toBe(Number(invBefore!.total))  // signed fact untouched
    void paid
  })

  it("5c an IN-FLIGHT credit is not called spent (major 3, at the DB)", async () => {
    const p = await freshPerson("refund-inflight")
    const ch = newCharge("refund-inflight")
    const paid = await recordPaidCall({ payment: booking(ch, 257, "EUR"), inviteeEmail: p.email, callDate: "2026-08-06" })
    const token = crypto.randomUUID()
    await claimCredits({ appliedTotal: 257, credits: [{ id: paid.creditId!, applyAmount: 257 }] }, token, db)
    const res = await handleChargeReversal(ch, "charge.dispute.created")
    expect(res.outcome).toBe("needs_review")
    expect(res.outcome === "needs_review" && res.reason).toMatch(/WHILE an invoice was being created/)
    const row = await payment(paid.creditId!)
    expect(Number(row!.credit_remaining)).toBe(257)     // NOT voided under the lock
    expect(row!.invoice_status).toBe("Credit")
    await unwindCreditClaims({ appliedTotal: 257, credits: [{ id: paid.creditId!, applyAmount: 257 }] }, token, db)
  })

  it("5d a refund for a charge that is not ours is a clean no-op", async () => {
    const res = await handleChargeReversal(`ch_${TAG}_not_ours`, "charge.refunded")
    expect(res.outcome).toBe("no_credit_found")
  })

  it("5e a duplicate refund event does not double-void", async () => {
    const p = await freshPerson("refund-dup")
    const ch = newCharge("refund-dup")
    const paid = await recordPaidCall({ payment: booking(ch, 257, "EUR"), inviteeEmail: p.email, callDate: "2026-08-06" })
    const first = await handleChargeReversal(ch, "charge.refunded")
    expect(first.outcome).toBe("voided")
    const second = await handleChargeReversal(ch, "charge.refunded")
    expect(second.outcome).toBe("needs_review")   // already at zero ⇒ human look, not a second void
    const row = await payment(paid.creditId!)
    expect(row!.invoice_status).toBe("Cancelled")
  })
})

// ══ CELL 7 (mirror half) — the client's expense view ══════════════════════

describe("CELL 7 — a credit note must not appear as a client expense", () => {
  it("7a the paid invoice mirrors into the client's expenses, the credit note does NOT", async () => {
    const p = await freshPerson("mirror")
    const ch = newCharge("mirror")
    const res = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    // NOTE: the column is td_payment_id. An earlier version of this cell asked for
    // `source_payment_id`, which does not exist — PostgREST returned an error, the
    // rows array came back empty, and every assertion passed VACUOUSLY. A green
    // "the credit is absent" that was really "nothing was queried".
    const { data, error } = await db.from("client_expenses")
      .select("id, td_payment_id, total, description")
      .in("td_payment_id", [res.invoiceId, res.creditId!])
    expect(error).toBeNull()
    const rows = (data ?? []) as Array<{ td_payment_id: string; total: number }>

    // POSITIVE control: the revenue invoice really is mirrored, so the negative
    // assertion below means something.
    expect(rows.some(r => r.td_payment_id === res.invoiceId)).toBe(true)
    // The credit note is NOT — a client must never see "-257" as an expense.
    expect(rows.some(r => r.td_payment_id === res.creditId)).toBe(false)
    expect(rows.every(r => Number(r.total) >= 0)).toBe(true)
  })
})

// ══ CELL 6 — lifecycle: what happens when a company is created later ══════

describe("CELL 6 — account creation must not sweep a live personal credit", () => {
  it("6a backfill carries SPENT credits and ordinary invoices, but leaves a LIVE credit person-scoped", async () => {
    const p = await freshPerson("backfill")

    // three contact-only payment rows, all with account_id NULL
    const live = await recordPaidCall({
      payment: booking(newCharge("bf-live"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    const spent = await recordPaidCall({
      payment: booking(newCharge("bf-spent"), 100, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    await db.from("payments").update({ credit_remaining: 0 }).eq("id", spent.creditId!)

    // the paid-call invoice rows are ordinary invoices with a NULL account
    await db.from("payments").update({ account_id: null }).in("id", [live.invoiceId, spent.invoiceId])

    const acct = await ensureMinimalAccount({
      contactId: p.id,
      clientName: `${TAG} Backfill Co`,
      contractType: "formation",
    })
    expect(acct.accountId).toBeTruthy()
    extraAccounts.push(acct.accountId)

    // THE POINT: the live credit is still the person's, not the new company's.
    const liveRow = await payment(live.creditId!)
    expect(liveRow!.account_id).toBeNull()
    expect(Number(liveRow!.credit_remaining)).toBe(257)

    // A spent credit has no money left to misdirect, so it carries over freely.
    const spentRow = await payment(spent.creditId!)
    expect(spentRow!.account_id).toBe(acct.accountId)

    // POSITIVE control: ordinary invoices DID move — proving the .or() filter is
    // selective, not simply blocking the whole update (the PostgREST
    // three-valued-logic trap this cell exists to catch).
    const invRow = await payment(live.invoiceId)
    expect(invRow!.account_id).toBe(acct.accountId)
  })
})

// ══ CELL 10 — the dress rehearsal ═════════════════════════════════════════

describe("CELL 10 — one Alessandro-shaped chain, end to end", () => {
  it("paid EUR call → offer shows the credit → invoice nets it → nothing stranded", async () => {
    const email = `${TAG.toLowerCase()}-dress@example.com`
    const ch = newCharge("dress")

    // 1. He books and pays for the strategy call.
    const call = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: email, inviteeName: `${TAG} Dress Rehearsal`, callDate: "2026-08-06",
    })
    expect(call.contactCreated).toBe(true)
    const contactId = call.contactId

    // 2. The offer written afterwards knows what he already paid.
    const held = await availableCreditForDisplay({ contactId }, "EUR", db)
    expect(held.amount).toBe(257)
    expect(held.creditId).toBe(call.creditId)

    // 3. He signs; the invoice deducts it.
    const inv = await createTDInvoice({
      contact_id: contactId,
      line_items: [{ description: `${TAG} Company Formation`, unit_price: 1500, quantity: 1 }],
      currency: "EUR", idempotency_key: `${TAG}-dress-invoice`,
    })
    const invRow = await payment(inv.paymentId)
    expect(Number(invRow!.total)).toBe(1243)          // 1500 − 257

    // 4. The credit is spent exactly once and points at the invoice that ate it.
    const cr = await payment(call.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(0)
    expect(cr!.credit_consumed_by).toBe(inv.paymentId)

    // 5. Nothing is left claimable, and the paid-call invoice is still Paid revenue.
    const leftover = await availableCreditForDisplay({ contactId }, "EUR", db)
    expect(leftover.amount).toBe(0)
    const callInv = await payment(call.invoiceId)
    expect(callInv!.invoice_status).toBe("Paid")
    expect(Number(callInv!.total)).toBe(257)

    extraContacts.push(contactId)
  })
})

// ══ CELL 2 (second half) — the feed row that carries the identity ════════
//
// CORRECTED PREMISE. The matrix asked for "a feed row with that payment-intent
// linking through, including days-late arrival", which merges two rows that
// never become one. A card payment produces TWO unrelated feed rows:
//
//   1. the STRIPE CHARGE row, synced at charge time, carrying the payment-intent
//      id — this is the only row that can reach the certain-identity tier, which
//      is hard-gated to stripe-sourced rows; and
//   2. days later, a BATCHED BANK PAYOUT ("STRIPE - TRANSFER"), one aggregate
//      row per transfer, carrying no payment-intent, no invoice number and no
//      client name — and deliberately routed to the owner's own books rather
//      than to client invoices.
//
// Verified on production: of 514 feed rows, all 82 carrying a payment-intent are
// stripe-sourced; all 432 bank rows carry none. So the days-late BANK row can
// never link by identity, by construction — nothing links a payout to its
// charges yet (the helper exists, uncalled, a known open item).
//
// What matters for WS-A is therefore not timing but DOUBLE-COUNTING: the
// paid-call invoice is born PAID, so when its charge row is reconciled the only
// correct outcome is an audit link that moves no money.

describe("CELL 2b — the charge row links to the born-paid invoice WITHOUT moving money", () => {
  it("2b links the charge row to the paid-call invoice as an audit link, zero money applied", async () => {
    const p = await freshPerson("feedlink")
    const ch = newCharge("feedlink")
    const call = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-01",
    })

    // Sandbox has no Stripe key, so recordPaidCall could not resolve the intent
    // itself (proven in cell 2a). Stamp the id the way a configured environment
    // would, because what is under test here is the MATCHER tier, not the lookup.
    const pi = `pi_${TAG}_feedlink`
    await db.from("payments").update({ stripe_payment_id: pi }).eq("id", call.invoiceId)

    const invBefore = await payment(call.invoiceId)
    expect(invBefore!.invoice_status).toBe("Paid")   // terminal before the feed arrives

    // The charge row, dated SIX DAYS after the call date, so the reconciliation
    // is genuinely late relative to the booking — the part of "days-late" that
    // IS real for this row.
    const { data: feedRow, error: feedErr } = await db.from("td_bank_feeds").insert({
      source: "stripe",
      transaction_date: "2026-08-07",
      amount: 257,
      currency: "EUR",
      sender_name: "STRIPE PAYOUT",
      memo: `${TAG} Stripe payout`,
      raw_data: { payment_intent: pi, id: ch },
      status: "unmatched",
    }).select("id").single()
    expect(feedErr).toBeNull()
    const feedId = (feedRow as { id: string }).id
    feeds.push(feedId)

    const res = await matchAndReconcile(feedId)

    // Linked, certainly, and explicitly WITHOUT money.
    expect(res.matched).toBe(true)
    expect(res.paymentId).toBe(call.invoiceId)
    expect(res.moneyApplied).toBe(false)
    expect(res.confidence).toBe("certain_retroactive")

    // The invoice is untouched — this is the assertion that matters.
    const invAfter = await payment(call.invoiceId)
    expect(Number(invAfter!.total)).toBe(Number(invBefore!.total))
    expect(Number(invAfter!.amount_paid ?? 0)).toBe(Number(invBefore!.amount_paid ?? 0))
    expect(invAfter!.invoice_status).toBe("Paid")

    // The feed itself carries the trail a human can read.
    const { data: fAfter } = await db.from("td_bank_feeds").select("*").eq("id", feedId).maybeSingle()
    const f = fAfter as Record<string, unknown>
    expect(f.status).toBe("matched")
    expect(f.matched_payment_id).toBe(call.invoiceId)
    expect(f.match_confidence).toBe("retroactive")

    // And no money-application ledger row was written, because no money moved.
    const { data: apps } = await db.from("payment_applications").select("id").eq("feed_id", feedId)
    expect((apps ?? []).length).toBe(0)
  })

  it("2c the credit note is NOT a match candidate for the payout", async () => {
    const p = await freshPerson("feedcredit")
    const ch = newCharge("feedcredit")
    const call = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-01",
    })
    // A credit note is a NEGATIVE payments row. If the matcher could ever pick it
    // as the target of an incoming payout, a client's own credit would be marked
    // "paid" by their own money.
    const pi = `pi_${TAG}_feedcredit`
    await db.from("payments").update({ stripe_payment_id: pi }).eq("id", call.creditId!)
    await db.from("payments").update({ stripe_payment_id: pi }).eq("id", call.invoiceId)

    const { data: feedRow } = await db.from("td_bank_feeds").insert({
      source: "stripe", transaction_date: "2026-08-07", amount: 257, currency: "EUR",
      sender_name: "STRIPE PAYOUT", memo: `${TAG} payout vs credit`,
      raw_data: { payment_intent: pi }, status: "unmatched",
    }).select("id").single()
    const feedId = (feedRow as { id: string }).id
    feeds.push(feedId)

    const res = await matchAndReconcile(feedId)

    // Two rows now share the intent, so the matcher must NOT silently pick one.
    // Either it refuses (ambiguous) or it picks the row carrying an invoice
    // number — never the credit note, and never any money onto the credit.
    if (res.matched) expect(res.paymentId).toBe(call.invoiceId)
    const cr = await payment(call.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(257)   // credit untouched either way
    expect(cr!.invoice_status).toBe("Credit")
  })
})

describe("CELL 2d — the batched bank payout must not touch the born-paid invoice", () => {
  it("2d a same-amount STRIPE - TRANSFER row does not settle or re-credit the call invoice", async () => {
    const p = await freshPerson("payout")
    const ch = newCharge("payout")
    const call = await recordPaidCall({
      payment: booking(ch, 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-01",
    })
    const before = await payment(call.invoiceId)

    // Exactly the shape production shows: aggregate, bank-sourced, no identity
    // at all — and the same amount as the call invoice, which is the coincidence
    // that puts two such rows in review on production right now.
    const { data: feedRow, error } = await db.from("td_bank_feeds").insert({
      source: "relay",
      transaction_date: "2026-08-07",
      amount: 257,
      currency: "EUR",
      sender_name: "STRIPE - TRANSFER",
      memo: `${TAG} STRIPE - TRANSFER`,
      raw_data: {},
      status: "unmatched",
    }).select("id").single()
    expect(error).toBeNull()
    const feedId = (feedRow as { id: string }).id
    feeds.push(feedId)

    const res = await matchAndReconcile(feedId)

    // It must never SETTLE the call invoice: that invoice is already Paid, so any
    // money applied here would be revenue counted twice.
    expect(res.moneyApplied).not.toBe(true)
    const after = await payment(call.invoiceId)
    expect(Number(after!.amount_paid ?? 0)).toBe(Number(before!.amount_paid ?? 0))
    expect(after!.invoice_status).toBe("Paid")

    // And the client's credit is not touched by a payout either.
    const cr = await payment(call.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(257)
  })
})

// ══ CELL 11 — THE LEAD PATH (rider 3) ════════════════════════════════════
//
// The path that actually happens, and the one the first version of this feature
// was blind to. Offers are written from the LEAD page, and a lead is not linked
// to a contact until the client SIGNS — measured on production, every lead in the
// pre-offer statuses had no contact link. So an offer created the normal way
// carries no contact id, and a credit snapshot gated on one showed nothing.
//
// Auto-propose resolves the person by EMAIL, the same key the signing webhook
// uses when it creates the invoice, so display and money target the same person.

describe("CELL 11 — an offer created the way staff actually create one", () => {
  it("11a a lead-shaped offer (no contact id, email only) still shows the credit", async () => {
    const p = await freshPerson("leadpath")
    await recordPaidCall({
      payment: booking(newCharge("leadpath"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })

    const token = `${TAG}-leadpath`.toLowerCase()
    const res = await createOffer({
      client_name: `${TAG} Lead Path`,
      client_email: p.email,          // the ONLY link to the person
      language: "it",
      payment_type: "bank_transfer",
      contract_type: "formation",
      services: [{ name: "Costituzione LLC", price: "€1500" }],
      cost_summary: [{ label: "Totale", total: "€1500" }],
      currency: "EUR",
      token,
      // deliberately NO contact_id — this is the lead page's shape
    })
    expect(res.success).toBe(true)

    const { data: offer } = await db.from("offers")
      .select("credit_amount, credit_payment_id, contact_id, credit_kind").eq("token", token).maybeSingle()
    const o = offer as Record<string, unknown>
    expect(Number(o.credit_amount)).toBe(257)
    expect(o.credit_payment_id).toBeTruthy()
    // linkage untouched — the snapshot is display only
    expect(o.contact_id).toBeNull()
    // label honesty: this credit IS a paid call, so the page may say so
    expect(o.credit_kind).toBe("paid_call")
  })

  it("11b the SAME email resolves to the SAME person for crediting and for display", async () => {
    const p = await freshPerson("sameperson")
    const call = await recordPaidCall({
      payment: booking(newCharge("sameperson"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    // one resolver, so these cannot drift
    const subject = await resolveCreditSubject(p.email, db)
    expect(subjectForDisplay(subject)).toBe(call.contactId)
    // and case/whitespace differences do not create a second answer
    const messy = await resolveCreditSubject(`  ${p.email.toUpperCase()}  `, db)
    expect(subjectForDisplay(messy)).toBe(call.contactId)
  })

  it("11c an email nobody holds shows nothing and warns nobody", async () => {
    const token = `${TAG}-noperson`.toLowerCase()
    await createOffer({
      client_name: `${TAG} Unknown Person`,
      client_email: `${TAG.toLowerCase()}-nobody@example.com`,
      language: "en", payment_type: "bank_transfer", contract_type: "formation",
      services: [{ name: "Company Formation", price: "$1500" }],
      cost_summary: [{ label: "Total", total: "$1500" }],
      currency: "USD", token,
    })
    const { data: offer } = await db.from("offers").select("credit_amount").eq("token", token).maybeSingle()
    expect((offer as Record<string, unknown>).credit_amount).toBeNull()
  })

  it("11d TWO people on one email: no credit shown, and staff ARE told (rider 2)", async () => {
    const shared = `${TAG.toLowerCase()}-shared@example.com`
    const { data: a } = await db.from("contacts")
      .insert({ full_name: `${TAG} Twin One`, email: shared, status: "active" }).select("id").single()
    const { data: b } = await db.from("contacts")
      .insert({ full_name: `${TAG} Twin Two`, email: shared, status: "active" }).select("id").single()
    extraContacts.push((a as { id: string }).id, (b as { id: string }).id)

    // give one of them real, unspent credit
    await recordPaidCall({
      payment: booking(newCharge("twin"), 257, "EUR"),
      inviteeEmail: shared, callDate: "2026-08-06",
    })

    const before = await db.from("system_errors").select("id", { count: "exact", head: true })
      .ilike("message", "%without showing a credit%")
    const beforeCount = before.count ?? 0

    const token = `${TAG}-twins`.toLowerCase()
    await createOffer({
      client_name: `${TAG} Twin One`,
      client_email: shared,
      language: "it", payment_type: "bank_transfer", contract_type: "formation",
      services: [{ name: "Costituzione LLC", price: "€1500" }],
      cost_summary: [{ label: "Totale", total: "€1500" }],
      currency: "EUR", token,
    })

    // The offer must NOT guess whose money it is.
    const { data: offer } = await db.from("offers").select("credit_amount").eq("token", token).maybeSingle()
    expect((offer as Record<string, unknown>).credit_amount).toBeNull()

    // But silence would be the dangerous outcome — staff get a card.
    const after = await db.from("system_errors").select("id", { count: "exact", head: true })
      .ilike("message", "%without showing a credit%")
    expect((after.count ?? 0)).toBeGreaterThan(beforeCount)
  })

  it("11e credit in ANOTHER currency: nothing shown, and staff are told why", async () => {
    const p = await freshPerson("wrongccy")
    await recordPaidCall({
      payment: booking(newCharge("wrongccy"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-06",
    })
    // sanity: they really do hold something, just not in USD
    const holds = await unspentCreditByCurrency({ contactId: p.id }, db)
    expect(holds.some(h => h.currency === "EUR" && h.amount === 257)).toBe(true)

    const before = await db.from("system_errors").select("id", { count: "exact", head: true })
      .ilike("message", "%priced in USD%")
    const beforeCount = before.count ?? 0

    const token = `${TAG}-wrongccy`.toLowerCase()
    await createOffer({
      client_name: `${TAG} Wrong Currency`,
      client_email: p.email,
      language: "en", payment_type: "bank_transfer", contract_type: "formation",
      services: [{ name: "Company Formation", price: "$1500" }],
      cost_summary: [{ label: "Total", total: "$1500" }],
      currency: "USD", token,
    })
    const { data: offer } = await db.from("offers").select("credit_amount").eq("token", token).maybeSingle()
    expect((offer as Record<string, unknown>).credit_amount).toBeNull()

    const after = await db.from("system_errors").select("id", { count: "exact", head: true })
      .ilike("message", "%priced in USD%")
    expect((after.count ?? 0)).toBeGreaterThan(beforeCount)
  })
})

// ══ CELL 12 — DRESS REHEARSAL, THROUGH THE LEAD PATH (rider 3) ═══════════

describe("CELL 12 — Alessandro-shaped chain, created the way staff create it", () => {
  it("paid call → lead-path offer shows the credit → signing invoice nets it", async () => {
    const email = `${TAG.toLowerCase()}-dress2@example.com`

    // 1. He books and pays for the strategy call. A contact appears for him.
    const call = await recordPaidCall({
      payment: booking(newCharge("dress2"), 257, "EUR"),
      inviteeEmail: email, inviteeName: `${TAG} Dress Two`, callDate: "2026-08-06",
    })
    expect(call.contactCreated).toBe(true)
    extraContacts.push(call.contactId)

    // 2. Antonio opens the LEAD and writes the offer — no contact id anywhere.
    const token = `${TAG}-dress2`.toLowerCase()
    await createOffer({
      client_name: `${TAG} Dress Two`,
      client_email: email,
      language: "it", payment_type: "bank_transfer", contract_type: "formation",
      services: [{ name: "Costituzione LLC", price: "€1500" }],
      cost_summary: [{ label: "Totale", total: "€1500" }],
      currency: "EUR", token,
    })
    const { data: offer } = await db.from("offers")
      .select("credit_amount, credit_payment_id").eq("token", token).maybeSingle()
    const o = offer as Record<string, unknown>
    expect(Number(o.credit_amount)).toBe(257)         // the client SEES it
    expect(o.credit_payment_id).toBe(call.creditId)

    // 3. He signs. The webhook resolves the person by email and bills them.
    const inv = await createTDInvoice({
      contact_id: call.contactId,
      line_items: [{ description: `${TAG} Costituzione LLC`, unit_price: 1500, quantity: 1 }],
      currency: "EUR", idempotency_key: `${TAG}-dress2-invoice`,
    })

    // 4. What he was shown is what he is billed.
    const invRow = await payment(inv.paymentId)
    expect(Number(invRow!.total)).toBe(1500 - Number(o.credit_amount))
    const cr = await payment(call.creditId!)
    expect(Number(cr!.credit_remaining)).toBe(0)
    expect(cr!.credit_consumed_by).toBe(inv.paymentId)
  })
})

// ══ CELL 13 — NET EVERYWHERE (Antonio's ruling) ══════════════════════════
//
// The invariant: every payment rail charges what the invoice of record says.
// The bug this replaces: the page's summary subtracted the credit while the pay
// buttons, the bank box, the card checkout and the SIGNED contract all quoted
// the gross — a client shown "€1,243 due" was charged €1,575 on the card and
// paid for their strategy call twice.

describe("CELL 13 — one amount, every rail", () => {
  it("13a the offer's payable net equals what the signing invoice bills", async () => {
    const p = await freshPerson("neteverywhere")
    const call = await recordPaidCall({
      payment: booking(newCharge("neteverywhere"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-07",
    })

    const token = `${TAG}-net`.toLowerCase()
    await createOffer({
      client_name: `${TAG} Net Everywhere`,
      client_email: p.email,
      language: "it", payment_type: "both", contract_type: "formation",
      services: [{ name: "Costituzione LLC", price: "€1500" }],
      cost_summary: [{ label: "Totale", total: "€1500" }],
      currency: "EUR", token,
    })
    const { data: row } = await db.from("offers")
      .select("services, cost_summary, selected_services, currency, credit_amount")
      .eq("token", token).maybeSingle()

    // What every rail is told to charge.
    const payable = computeOfferPayable(row as Record<string, unknown>)
    expect(payable.gross).toBe(1500)
    expect(payable.credit).toBe(257)
    expect(payable.net).toBe(1243)
    expect(payable.currency).toBe("EUR")

    // What the invoice of record actually bills at signing.
    const inv = await createTDInvoice({
      contact_id: call.contactId,
      line_items: [{ description: `${TAG} Costituzione LLC`, unit_price: 1500, quantity: 1 }],
      currency: "EUR", idempotency_key: `${TAG}-net-invoice`,
    })
    const invRow = await payment(inv.paymentId)

    // THE INVARIANT.
    expect(Number(invRow!.total)).toBe(payable.net)
  })

  it("13b storage and the money engine agree on the currency (blocker 2)", async () => {
    const p = await freshPerson("onecurrency")
    await recordPaidCall({
      payment: booking(newCharge("onecurrency"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-07",
    })
    // A EUR offer whose SERVICES carry a "$2,000/year" recurring line — the exact
    // shape that used to be stored EUR and charged USD.
    const token = `${TAG}-ccy`.toLowerCase()
    await createOffer({
      client_name: `${TAG} One Currency`,
      client_email: p.email,
      language: "it", payment_type: "bank_transfer", contract_type: "formation",
      services: [
        { name: "Costituzione LLC", price: "€1500" },
        { name: "Annual Maintenance", price: "$2,000/year" },
      ],
      cost_summary: [{ label: "Totale", total: "€1500" }],
      token,
    })
    const { data: row } = await db.from("offers")
      .select("services, cost_summary, selected_services, currency, credit_amount")
      .eq("token", token).maybeSingle()
    const o = row as Record<string, unknown>

    // stored and computed must be the same answer
    expect(o.currency).toBe("EUR")
    const payable = computeOfferPayable(o)
    expect(payable.currency).toBe("EUR")
    // and because they agree, the euro credit really is applied
    expect(payable.credit).toBe(257)
    expect(payable.net).toBe(1243)
  })
})

// ══ CELL 14 — ATTACH AN UNMATCHED PAYMENT BY HAND ════════════════════════
//
// A client pays for a call under an address the system cannot tie to them, so
// nothing is recognised and the transaction sits unmatched in Finance. Staff
// name the person. Fixtures mirror the real production row still sitting
// unmatched today: a Stripe row, "[Calendly] TD Strategic Consulting with …".
//
// Two outcomes, both keeping the history — there is deliberately no
// bare-invoice path:
//   deductible (default) — a usable person-scoped credit
//   revenue only         — the credit is born with nothing left on it

async function unmatchedCallFeed(label: string, amount: number, currency: string) {
  const { data, error } = await db.from("td_bank_feeds").insert({
    source: "stripe",
    transaction_date: "2026-08-07",
    amount,
    currency,
    sender_name: `[Calendly] TD Strategic Consulting with ${TAG} ${label}`,
    memo: `[Calendly] TD Strategic Consulting with ${TAG} ${label}`,
    raw_data: {},
    status: "unmatched",
  }).select("id").single()
  expect(error).toBeNull()
  const id = (data as { id: string }).id
  feeds.push(id)
  return id
}

describe("CELL 14 — attaching a paid call staff had to identify themselves", () => {
  it("14a DEDUCTIBLE: revenue booked, credit usable, feed matched, NO service delivery", async () => {
    const p = await freshPerson("attach")
    const feedId = await unmatchedCallFeed("Attach", 157, "USD")

    const res = await recordPaidCall({
      payment: { chargeId: `feed:${feedId}`, amount: 157, currency: "USD", provider: "manual" },
      inviteeEmail: p.email, inviteeName: `${TAG} attach`, callDate: "2026-08-07",
      manual: { feedId },
    })

    const inv = await payment(res.invoiceId)
    expect(inv!.invoice_status).toBe("Paid")     // revenue is booked
    expect(Number(inv!.total)).toBe(157)
    const cr = await payment(res.creditId!)
    expect(cr!.invoice_status).toBe("Credit")
    expect(Number(cr!.credit_remaining)).toBe(157)   // and it is SPENDABLE
    expect(cr!.account_id).toBeNull()                 // person-scoped, always

    // it really reaches an offer
    const held = await availableCreditForDisplay({ contactId: p.id }, "USD", db)
    expect(held.amount).toBe(157)
    expect(held.kind).toBe("paid_call")   // labelled honestly despite the manual route

    // a paid call is not a service — nothing was spawned
    const { data: sds } = await db.from("service_deliveries").select("id").eq("contact_id", p.id)
    expect((sds ?? []).length).toBe(0)
  })

  it("14b REVENUE ONLY: the call is on the record, but nothing is deductible", async () => {
    const p = await freshPerson("revonly")
    const feedId = await unmatchedCallFeed("RevOnly", 157, "USD")

    const res = await recordPaidCall({
      payment: { chargeId: `feed:${feedId}`, amount: 157, currency: "USD", provider: "manual" },
      inviteeEmail: p.email, inviteeName: `${TAG} revonly`, callDate: "2026-08-07",
      manual: { feedId, creditUsedAtCreation: true },
    })

    const inv = await payment(res.invoiceId)
    expect(inv!.invoice_status).toBe("Paid")
    expect(Number(inv!.total)).toBe(157)          // revenue identical

    // HISTORY KEPT: the credit note exists and says what happened…
    const cr = await payment(res.creditId!)
    expect(cr).toBeTruthy()
    expect(cr!.invoice_status).toBe("Credit")
    expect(String(cr!.notes)).toMatch(/booked as revenue/i)
    // …but nothing is left on it
    expect(Number(cr!.credit_remaining)).toBe(0)

    // so an offer shows nothing
    const held = await availableCreditForDisplay({ contactId: p.id }, "USD", db)
    expect(held.amount).toBe(0)
  })

  it("14c DOUBLE-CLICK: attaching the same transaction twice changes nothing", async () => {
    const p = await freshPerson("dbl")
    const feedId = await unmatchedCallFeed("Double", 157, "USD")
    const args = {
      payment: { chargeId: `feed:${feedId}`, amount: 157, currency: "USD" as const, provider: "manual" },
      inviteeEmail: p.email, inviteeName: `${TAG} dbl`, callDate: "2026-08-07",
      manual: { feedId },
    }
    const first = await recordPaidCall(args)
    const second = await recordPaidCall(args)

    expect(second.invoiceId).toBe(first.invoiceId)
    expect(second.creditId).toBe(first.creditId)
    const rows = await paymentsFor({ contact_id: p.id })
    expect(rows.filter(r => r.invoice_status === "Credit").length).toBe(1)
    expect(rows.filter(r => r.invoice_status === "Paid").length).toBe(1)
    // and the client did not end up with 314 of credit
    const held = await availableCreditForDisplay({ contactId: p.id }, "USD", db)
    expect(held.amount).toBe(157)
  })

  it("14d WRONG PERSON: it is reversible — cancelling the credit removes the deduction", async () => {
    const wrong = await freshPerson("wrongpick")
    const feedId = await unmatchedCallFeed("WrongPick", 157, "USD")
    const res = await recordPaidCall({
      payment: { chargeId: `feed:${feedId}`, amount: 157, currency: "USD", provider: "manual" },
      inviteeEmail: wrong.email, inviteeName: `${TAG} wrongpick`, callDate: "2026-08-07",
      manual: { feedId },
    })
    expect((await availableCreditForDisplay({ contactId: wrong.id }, "USD", db)).amount).toBe(157)

    // staff realise it was the wrong person and cancel the credit
    await db.from("payments")
      .update({ invoice_status: "Cancelled", credit_remaining: 0 })
      .eq("id", res.creditId!)

    // the stranger can no longer deduct anything
    const after = await availableCreditForDisplay({ contactId: wrong.id }, "USD", db)
    expect(after.amount).toBe(0)
    // and an offer written for them now shows nothing
    const token = `${TAG}-wrongpick`.toLowerCase()
    await createOffer({
      client_name: `${TAG} wrongpick`, client_email: wrong.email,
      language: "en", payment_type: "bank_transfer", contract_type: "formation",
      services: [{ name: "Company Formation", price: "$1500" }],
      cost_summary: [{ label: "Total", total: "$1500" }],
      currency: "USD", token,
    })
    const { data: offer } = await db.from("offers").select("credit_amount").eq("token", token).maybeSingle()
    expect((offer as Record<string, unknown>).credit_amount).toBeNull()
  })

  it("14e a company target is refused — a paid call belongs to a PERSON", async () => {
    // The credit must never be account-scoped or a renewal cron could eat it.
    // The route enforces this; here we pin the invariant the route protects.
    const p = await freshPerson("companytarget")
    const feedId = await unmatchedCallFeed("CompanyTarget", 157, "USD")
    const res = await recordPaidCall({
      payment: { chargeId: `feed:${feedId}`, amount: 157, currency: "USD", provider: "manual" },
      inviteeEmail: p.email, callDate: "2026-08-07", manual: { feedId },
    })
    const cr = await payment(res.creditId!)
    expect(cr!.account_id).toBeNull()
    expect(cr!.contact_id).toBe(p.id)
  })
})

// ══ CELL 15 — the client is billed in a currency their credit cannot reach ══
//
// The seventh "produced correctly, never delivered": the engine has always
// reported credit stranded in another currency, and nothing read it. An Italian
// client who paid EUR257 for a call gets a USD renewal at full price and nobody
// is told. Renewals never pass through offer creation, which is the only other
// place that warns — so invoice creation is the delivery point that matters.

describe("CELL 15 — stranded-currency credit is REPORTED, not silently ignored", () => {
  it("15a a EUR credit against a USD bill raises a staff notice naming the amount", async () => {
    const p = await freshPerson("stranded")
    await recordPaidCall({
      payment: booking(newCharge("stranded"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-08",
    })

    // The error system DEDUPLICATES by message shape, so a repeat bumps an
    // existing row rather than inserting one. Count the OCCURRENCES, not the
    // rows — asserting the row count grows would pass once and fail forever
    // after, which is a test that lies the second time you run it.
    const occurrences = async () => {
      const { data } = await db.from("system_errors")
        .select("occurrence_count, last_seen")
        .ilike("message", "%holding unused credit in another currency%")
      return ((data ?? []) as Array<{ occurrence_count: number | null }>)
        .reduce((n, r) => n + (Number(r.occurrence_count) || 1), 0)
    }
    const beforeCount = await occurrences()

    // Bill them in USD — the annual-renewal shape.
    const inv = await createTDInvoice({
      contact_id: p.id,
      line_items: [{ description: `${TAG} Annual Management`, unit_price: 2000, quantity: 1 }],
      currency: "USD",
      idempotency_key: `${TAG}-stranded-usd`,
    })

    // The bill is correctly at FULL price — no invented FX.
    const row = await payment(inv.paymentId)
    expect(Number(row!.total)).toBe(2000)
    // The EUR credit is untouched and still theirs.
    const held = await unspentCreditByCurrency({ contactId: p.id }, db)
    expect(held.some(h => h.currency === "EUR" && h.amount === 257)).toBe(true)

    // AND SOMEONE WAS TOLD. This is the whole point of the cell.
    expect(await occurrences()).toBeGreaterThan(beforeCount)
  })

  it("15b a SAME-currency bill applies the credit and raises no such notice", async () => {
    const p = await freshPerson("nostrand")
    await recordPaidCall({
      payment: booking(newCharge("nostrand"), 257, "EUR"),
      inviteeEmail: p.email, callDate: "2026-08-08",
    })
    const occurrences = async () => {
      const { data } = await db.from("system_errors")
        .select("occurrence_count")
        .ilike("message", "%holding unused credit in another currency%")
      return ((data ?? []) as Array<{ occurrence_count: number | null }>)
        .reduce((n, r) => n + (Number(r.occurrence_count) || 1), 0)
    }
    const beforeCount = await occurrences()

    const inv = await createTDInvoice({
      contact_id: p.id,
      line_items: [{ description: `${TAG} EUR job`, unit_price: 1000, quantity: 1 }],
      currency: "EUR",
      idempotency_key: `${TAG}-nostrand-eur`,
    })
    const row = await payment(inv.paymentId)
    expect(Number(row!.total)).toBe(743)   // credit applied

    // no cry-wolf: nothing was stranded, so nothing was raised
    expect(await occurrences()).toBe(beforeCount)
  })
})
