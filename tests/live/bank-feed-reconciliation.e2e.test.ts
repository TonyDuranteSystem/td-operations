/**
 * BANK-FEED RECONCILIATION — FULL END-TO-END QA (dev job 878558ff)
 *
 * Drives the REAL code against a REAL database (the per-worktree isolated local stack):
 * the real matcher, the real single money writer, the real reversal, the real server actions,
 * the real feed writer, the real note emitter/retirer, the real dunning filter and the real
 * owner-books router. Only Next.js's request-scoped boundaries are mocked, exactly as the
 * existing live harnesses do — nothing in the money path is stubbed.
 *
 * Every scenario is one of: the production incident of 2026-07-22, a Council-named failure
 * mode, or a behaviour that MUST NOT regress. Fixture companies are obviously fake and every
 * row created is deleted in teardown.
 *
 * Run: npx vitest run --config vitest.bankfeed-e2e.config.ts
 */
/* eslint-disable no-restricted-syntax -- destructive local-stack QA harness: it plants and
   removes raw fixture rows on purpose, and never runs in CI or against production. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) =>
      (globalThis as unknown as { __qaAdmin: { from: (t: string) => unknown } }).__qaAdmin.from(table),
    auth: {
      auth: {},
      getUser: async () => ({
        data: { user: { id: "00000000-0000-4000-8000-00000000qa01".replace("qa01", "0a01"), email: "qa-e2e@tonydurante.us" } },
      }),
    },
  }),
}))
// The Stripe refund gate must not reach the network. "no charge id" is the honest local
// answer for a wire (the gate only applies to Stripe-sourced rows), and the auto path already
// proceeds-with-warning in that case.
vi.mock("@/lib/stripe-sync", () => ({
  isChargeRefundedNow: async () => ({ refunded: false, checked: false }),
}))
// Never let the activation chain run: it is a separate subsystem with its own emails.
vi.mock("@/lib/operations/activate-service", () => ({ runActivation: async () => ({ ok: true }) }))

import { supabaseAdmin } from "@/lib/supabase-admin"
;(globalThis as unknown as { __qaAdmin: unknown }).__qaAdmin = supabaseAdmin

import { matchAndReconcile, manualMatch } from "@/lib/bank-feed-matcher"
import { unlinkPayment, deletePayment } from "@/app/(dashboard)/finance/actions"
import { reverseFeedApplication, listConfirmedApplications } from "@/lib/finance/apply-payment"
import {
  readContestedCandidates,
  readContestedTotal,
  readRejectedPairs,
  CONTESTED_SAMPLE_LIMIT,
} from "@/lib/finance/feed-vocabulary"
import { updateFeed } from "@/lib/finance/feed-write"
import { isClientInvoicePayment } from "@/lib/finance/owner-ledger-projection"
import { emitPaymentReceivedEvent, retirePaymentReceivedNote } from "@/lib/portal/chat-events"

// ── Fixtures: unmistakably fake, and unique per run so a crashed run cannot collide ──
const RUN = Date.now().toString(36)
const ACCT_A = "44444444-0000-4000-8000-000000000001" // ZZ Alpha Widgets LLC
const ACCT_B = "44444444-0000-4000-8000-000000000002" // ZZ Beta Marketing Solutions LLC
const ACCT_C = "44444444-0000-4000-8000-000000000003" // ZZ Gamma Marketing Consulting LLC

const createdPayments: string[] = []
const createdFeeds: string[] = []
const createdAccounts = [ACCT_A, ACCT_B, ACCT_C]

function today(offsetDays = 0): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().split("T")[0]
}

async function makeAccount(id: string, name: string) {
  await supabaseAdmin.from("accounts").upsert({ id, company_name: name, account_type: "Client" })
}

async function makeInvoice(opts: {
  account: string
  total: number
  invoiceNumber: string
  invoiceStatus?: string
  status?: string
  amountPaid?: number
  dueDate?: string | null
  sentAt?: string | null
  installment?: string | null
  description?: string
  year?: number | null
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .insert({
      account_id: opts.account,
      invoice_number: opts.invoiceNumber,
      description: opts.description ?? "ZZ E2E fixture",
      total: opts.total,
      amount: opts.total,
      amount_currency: "USD",
      amount_paid: opts.amountPaid ?? 0,
      amount_due: opts.total - (opts.amountPaid ?? 0),
      invoice_status: opts.invoiceStatus ?? "Sent",
      status: opts.status ?? "Pending",
      due_date: opts.dueDate === undefined ? today(-30) : opts.dueDate,
      sent_at: opts.sentAt === undefined ? new Date().toISOString() : opts.sentAt,
      installment: opts.installment ?? null,
      year: opts.year ?? null,
    })
    .select("id")
    .single()
  if (error) throw new Error(`fixture invoice failed: ${error.message}`)
  const id = (data as { id: string }).id
  createdPayments.push(id)
  return id
}

async function makeFeed(opts: {
  amount: number
  senderName: string
  memo?: string
  status?: string
  matchedPaymentId?: string | null
  label: string
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("td_bank_feeds")
    .insert({
      source: "mercury_api",
      external_id: `zz-e2e-${RUN}-${opts.label}`,
      transaction_date: today(-1),
      amount: opts.amount,
      currency: "USD",
      sender_name: opts.senderName,
      memo: opts.memo ?? opts.senderName,
      sender_reference: opts.memo ?? opts.senderName,
      status: opts.status ?? "unmatched",
      matched_payment_id: opts.matchedPaymentId ?? null,
      raw_data: { counterpartyName: opts.senderName },
    })
    .select("id")
    .single()
  if (error) throw new Error(`fixture feed failed: ${error.message}`)
  const id = (data as { id: string }).id
  createdFeeds.push(id)
  return id
}

async function readPayment(id: string) {
  const { data } = await supabaseAdmin
    .from("payments")
    .select("invoice_number, status, invoice_status, total, amount_paid, amount_due, paid_date")
    .eq("id", id)
    .single()
  return data as unknown as Record<string, unknown>
}

async function readFeed(id: string) {
  const { data } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("status, matched_payment_id, match_confidence, review_metadata")
    .eq("id", id)
    .single()
  return data as unknown as Record<string, unknown>
}

async function readMirror(paymentId: string) {
  const { data } = await supabaseAdmin
    .from("client_expenses")
    .select("status, total, amount_paid, amount_due")
    .eq("td_payment_id", paymentId)
    .maybeSingle()
  return data as unknown as Record<string, unknown> | null
}

async function ledgerRows(paymentId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- not in generated types
  const db = supabaseAdmin as any
  const { data } = await db
    .from("payment_applications")
    .select("id, feed_id, amount, confirmed_at")
    .eq("payment_id", paymentId)
  return (data ?? []) as Array<{ id: string; feed_id: string; amount: number; confirmed_at: string | null }>
}

beforeAll(async () => {
  await makeAccount(ACCT_A, "ZZ Alpha Widgets LLC")
  await makeAccount(ACCT_B, "ZZ Beta Marketing Solutions LLC")
  await makeAccount(ACCT_C, "ZZ Gamma Marketing Consulting LLC")
})

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- not in generated types
  const db = supabaseAdmin as any
  for (const p of createdPayments) {
    await db.from("payment_applications").delete().eq("payment_id", p)
    await supabaseAdmin.from("client_expenses").delete().eq("td_payment_id", p)
    await supabaseAdmin.from("portal_messages").delete().like("message", `%payments:${p}%`)
  }
  for (const f of createdFeeds) {
    await db.from("payment_applications").delete().eq("feed_id", f)
    await supabaseAdmin.from("td_bank_feeds").delete().eq("id", f)
  }
  for (const p of createdPayments) await supabaseAdmin.from("payments").delete().eq("id", p)
  for (const a of createdAccounts) await supabaseAdmin.from("accounts").delete().eq("id", a)
})

// ══════════════════════════════════════════════════════════════════════════════════════
describe("1 — the production incident: two clients, one amount, a generic shared word", () => {
  // ⚠️ FIXTURE NOTE (found by running this harness): the first version of this test gave the
  // two companies DISTINCTIVE names ("Beta", "Gamma"), so the matcher correctly identified the
  // real payer and settled the right invoice — it was testing the opposite of the incident and
  // "failing" for the right reason. The real names reduced to a shared generic word and
  // nothing else: "Aces Marketing Solutions LLC" → {aces}; "LC Marketing Consulting LLC" → {}
  // (two-letter prefix, everything else generic). These fixtures reproduce that exactly.
  it("does NOT settle either invoice, and records BOTH candidates for a human", async () => {
    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Aces Marketing Solutions LLC" }).eq("id", ACCT_B)
    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Marketing Consulting LLC" }).eq("id", ACCT_C)

    const aces = await makeInvoice({ account: ACCT_B, total: 1000, invoiceNumber: `ZZ-${RUN}-ACES` })
    const lc = await makeInvoice({ account: ACCT_C, total: 1000, invoiceNumber: `ZZ-${RUN}-LC` })
    const feed = await makeFeed({
      amount: 1000,
      senderName: "ZZ Marketing Consulting",
      memo: "ZZ Marketing Consulting — From ZZ Marketing Consulting via mercury.com",
      label: "incident",
    })

    const res = await matchAndReconcile(feed)

    // NEITHER company is credited — not even the one that really paid, because its name is
    // made entirely of generic words and cannot identify it.
    const a = await readPayment(aces)
    const l = await readPayment(lc)
    expect(Number(a.amount_paid ?? 0)).toBe(0)
    expect(Number(l.amount_paid ?? 0)).toBe(0)
    expect(a.invoice_status).not.toBe("Paid")
    expect(l.invoice_status).not.toBe("Paid")
    expect(res.matched).toBe(false)

    const f = await readFeed(feed)
    expect(f.status).toBe("needs_review")
    const contested = readContestedCandidates(f.review_metadata)
    const total = readContestedTotal(f.review_metadata)
    expect(contested.length).toBeGreaterThanOrEqual(2)
    // ⚠️ FOUND BY RUNNING THIS (not by reasoning): against a real book of invoices an
    // amount-only tie is not a pair — this $1,000 wire ties with EVERY open $1,000 invoice,
    // which was dozens of rows. So the recorded set is a capped sample plus a true count, and
    // the assertion is containment, not equality.
    expect(total).toBeGreaterThanOrEqual(2)
    expect(contested.length).toBeLessThanOrEqual(CONTESTED_SAMPLE_LIMIT)
    const tiedIds = new Set(contested.map((c) => c.payment_id))
    expect(total).toBeGreaterThanOrEqual(tiedIds.size)
    // The human must see WHOSE invoices these are without a lookup.
    expect(contested.every((c) => c.client_name !== undefined)).toBe(true)

    // And no money was recorded anywhere.
    expect(await ledgerRows(aces)).toHaveLength(0)
    expect(await ledgerRows(lc)).toHaveLength(0)

    // Restore the fixture names for the tests that rely on them being distinctive.
    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Beta Marketing Solutions LLC" }).eq("id", ACCT_B)
    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Gamma Marketing Consulting LLC" }).eq("id", ACCT_C)
  })

  it("settles the RIGHT client when their name actually identifies them", async () => {
    // The other half of the same rule: same ambiguous amount, but this payer's name carries a
    // distinctive word, so automation still works and the wrong client is untouched.
    // An amount nothing else in the book shares, so this asserts the NAME rule rather than
    // colliding with the mirrored dataset's many round-number invoices.
    const AMOUNT = 1013.37
    const distinctive = await makeInvoice({ account: ACCT_C, total: AMOUNT, invoiceNumber: `ZZ-${RUN}-IDENT` })
    const bystander = await makeInvoice({ account: ACCT_B, total: AMOUNT, invoiceNumber: `ZZ-${RUN}-BYST` })
    const feed = await makeFeed({
      amount: AMOUNT,
      senderName: "ZZ GAMMA MARKETING CONSULTING LLC",
      label: "identified",
    })

    const res = await matchAndReconcile(feed)

    expect(res.matched).toBe(true)
    expect(res.paymentId).toBe(distinctive)
    expect(Number((await readPayment(distinctive)).amount_paid)).toBe(1013.37)
    expect(Number((await readPayment(bystander)).amount_paid ?? 0)).toBe(0)
  })
})

describe("2 — the near-miss the tie guard alone would have missed", () => {
  it("does not settle a DIFFERENT client whose amount happens to match exactly", async () => {
    // Council finding: $1,000 wire, wrong client at $1,000 (95) vs right client at $1,020
    // (70) is not a tie. It is the name rule, not the tie guard, that must stop this.
    const wrongClient = await makeInvoice({ account: ACCT_B, total: 1000, invoiceNumber: `ZZ-${RUN}-NEAR-W` })
    const rightClient = await makeInvoice({ account: ACCT_C, total: 1020, invoiceNumber: `ZZ-${RUN}-NEAR-R` })
    const feed = await makeFeed({
      amount: 1000,
      senderName: "ZZ Gamma Marketing Consulting",
      label: "nearmiss",
    })

    await matchAndReconcile(feed)

    const w = await readPayment(wrongClient)
    expect(Number(w.amount_paid ?? 0)).toBe(0)
    expect(w.invoice_status).not.toBe("Paid")
    const r = await readPayment(rightClient)
    expect(Number(r.amount_paid ?? 0)).toBe(0)
  })
})

describe("3 — automation that MUST keep working", () => {
  it("a distinctive name + exact amount still auto-settles, end to end", async () => {
    // "Alpha Widgets" is distinctive: both significant words appear on the payment.
    const inv = await makeInvoice({ account: ACCT_A, total: 777, invoiceNumber: `ZZ-${RUN}-ALPHA` })
    const feed = await makeFeed({
      amount: 777,
      senderName: "ZZ ALPHA WIDGETS LLC",
      label: "distinctive",
    })

    const res = await matchAndReconcile(feed)

    expect(res.matched).toBe(true)
    const p = await readPayment(inv)
    expect(Number(p.amount_paid)).toBe(777)
    expect(Number(p.amount_due)).toBe(0)
    expect(p.invoice_status).toBe("Paid")
    expect(p.status).toBe("Paid")
    // The money is recorded, once, and confirmed.
    const rows = await ledgerRows(inv)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(777)
    expect(rows[0].confirmed_at).not.toBeNull()
    const f = await readFeed(feed)
    expect(f.status).toBe("matched")
  })

  it("the invoice number on the payment wins outright THROUGH a tie", async () => {
    // Two same-priced invoices for different clients — but the memo names one of them.
    const named = await makeInvoice({ account: ACCT_B, total: 555, invoiceNumber: `INV-990001` })
    const other = await makeInvoice({ account: ACCT_C, total: 555, invoiceNumber: `INV-990002` })
    const feed = await makeFeed({
      amount: 555,
      senderName: "SOMEONE ELSE ENTIRELY",
      memo: "payment for INV-990001",
      label: "reference",
    })

    const res = await matchAndReconcile(feed)

    expect(res.matched).toBe(true)
    expect(res.paymentId).toBe(named)
    expect(Number((await readPayment(named)).amount_paid)).toBe(555)
    expect(Number((await readPayment(other)).amount_paid ?? 0)).toBe(0)
  })

  it("REFUSES a duplicate-row tie too, and pins the numbered row as the suggestion", async () => {
    // This asserted "the numbered row wins" until the Bug-Hunter broke that exemption on the
    // finished code: an un-numbered row is NOT reliably an orphan — production holds real
    // matchable obligations with no invoice number (a $1,250 unnumbered "First Installment"),
    // and paired with the same client's numbered second installment the exemption settled the
    // WRONG installment and fired the installment handler for it. So a tie is a tie; the
    // transaction waits for one visible human click instead.
    const real = await makeInvoice({ account: ACCT_A, total: 321, invoiceNumber: `ZZ-${RUN}-DUP` })
    const orphan = await supabaseAdmin
      .from("payments")
      .insert({
        account_id: ACCT_A,
        invoice_number: null,
        description: "ZZ E2E orphan row",
        total: 321,
        amount: 321,
        amount_currency: "USD",
        amount_paid: 0,
        amount_due: 321,
        invoice_status: "Sent",
        status: "Pending",
      })
      .select("id")
      .single()
    const orphanId = (orphan.data as { id: string }).id
    createdPayments.push(orphanId)

    const feed = await makeFeed({ amount: 321, senderName: "ZZ ALPHA WIDGETS LLC", label: "dup" })
    const res = await matchAndReconcile(feed)

    expect(res.matched).toBe(false)
    expect(res.paymentId).toBe(real) // pinned as the starting suggestion, NOT settled
    expect(Number((await readPayment(real)).amount_paid ?? 0)).toBe(0)
    expect(Number((await readPayment(orphanId)).amount_paid ?? 0)).toBe(0)
    const f = await readFeed(feed)
    expect(f.status).toBe("needs_review")
    expect(readContestedCandidates(f.review_metadata).length).toBeGreaterThanOrEqual(2)
  })
})

describe("4 — the retroactive audit-link pass (the path the first plan missed)", () => {
  // ⚠️ FIXTURE NOTE (found by running this harness): the first version used two differently
  // named companies, so only ONE passed the name rule and the link to that ONE was correct —
  // it proved nothing about ambiguity. Two accounts sharing a company name is the real shape
  // (the CRM genuinely holds duplicate accounts), and it makes both candidates equally valid.
  it("does not audit-link a payment when two already-paid invoices fit equally", async () => {
    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Duplicate Studio" }).eq("id", ACCT_B)
    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Duplicate Studio" }).eq("id", ACCT_C)

    await makeInvoice({
      account: ACCT_B, total: 1400, invoiceNumber: `ZZ-${RUN}-RETRO-B`,
      invoiceStatus: "Paid", status: "Paid", amountPaid: 1400,
    })
    await makeInvoice({
      account: ACCT_C, total: 1400, invoiceNumber: `ZZ-${RUN}-RETRO-C`,
      invoiceStatus: "Paid", status: "Paid", amountPaid: 1400,
    })
    const feed = await makeFeed({
      amount: 1400,
      senderName: "ZZ DUPLICATE STUDIO",
      label: "retro",
    })

    const res = await matchAndReconcile(feed)
    const f = await readFeed(feed)

    // An audit link moves no money, but it marks the transaction matched, drops it out of the
    // review queue, and permanently consumes that invoice's slot — so the wrong one is not a
    // harmless mistake.
    expect(res.confidence).not.toBe("retroactive")
    expect(f.status).not.toBe("matched")
    expect(f.status).toBe("needs_review")
    expect(readContestedCandidates(f.review_metadata).length).toBeGreaterThanOrEqual(2)

    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Beta Marketing Solutions LLC" }).eq("id", ACCT_B)
    await supabaseAdmin.from("accounts").update({ company_name: "ZZ Gamma Marketing Consulting LLC" }).eq("id", ACCT_C)
  })

  it("still audit-links when exactly ONE already-paid invoice fits", async () => {
    // The legitimate case must keep working: a card charge tied to the invoice its own webhook
    // already closed, so the transaction stops sitting unmatched for ever.
    const paid = await makeInvoice({
      account: ACCT_A, total: 1450, invoiceNumber: `ZZ-${RUN}-RETRO-ONE`,
      invoiceStatus: "Paid", status: "Paid", amountPaid: 1450,
    })
    const feed = await makeFeed({ amount: 1450, senderName: "ZZ ALPHA WIDGETS LLC", label: "retro-one" })

    const res = await matchAndReconcile(feed)

    expect(res.matched).toBe(true)
    expect(res.confidence).toBe("retroactive")
    expect(res.moneyApplied).toBe(false)
    // No money moved: the invoice is untouched.
    expect(Number((await readPayment(paid)).amount_paid)).toBe(1450)
    expect(await ledgerRows(paid)).toHaveLength(0)
  })
})

describe("5 — un-matching actually reverses (the money half)", () => {
  it("takes off ONLY this transaction's money and keeps a part-payment from another rail", async () => {
    // $2,200 invoice: $1,700 already paid by card (no feed), $500 by wire. Un-matching the
    // wire must leave $1,700. The old code wrote amount_paid = 0 and erased it.
    const inv = await makeInvoice({
      account: ACCT_A, total: 2200, invoiceNumber: `ZZ-${RUN}-PARTIAL`,
      invoiceStatus: "Partial", amountPaid: 1700,
    })
    const feed = await makeFeed({ amount: 500, senderName: "ZZ ALPHA WIDGETS LLC", label: "partial" })

    const match = await manualMatch(feed, inv)
    expect(match.matched).toBe(true)
    expect(Number((await readPayment(inv)).amount_paid)).toBe(2200)

    const res = await unlinkPayment(inv)
    expect(res.success).toBe(true)

    const p = await readPayment(inv)
    expect(Number(p.amount_paid)).toBe(1700)
    expect(Number(p.amount_due)).toBe(500)
    expect(p.paid_date).not.toBeNull() // money remains, so the date must remain
    // ⚠️ FIXTURE NOTE: this fixture is PAST its due date, and the restore ladder puts a
    // past-due invoice at Overdue ahead of Partial — deliberately, per the 2026-07-10 rule
    // that the debt is real whatever the label. The first version of this test asserted
    // "Partial" and failed for that reason. The balance is what matters and it is exact.
    expect(p.invoice_status).toBe("Overdue")
  })

  it("returns a NOT-yet-due part-paid invoice as Partial", async () => {
    const inv = await makeInvoice({
      account: ACCT_A, total: 2200, invoiceNumber: `ZZ-${RUN}-PARTIAL-FUTURE`,
      invoiceStatus: "Partial", amountPaid: 1700, dueDate: today(30),
    })
    const feed = await makeFeed({ amount: 500, senderName: "ZZ ALPHA WIDGETS LLC", label: "partial-future" })
    await manualMatch(feed, inv)
    await unlinkPayment(inv)

    const p = await readPayment(inv)
    expect(Number(p.amount_paid)).toBe(1700)
    expect(Number(p.amount_due)).toBe(500)
    expect(p.invoice_status).toBe("Partial")
  })

  it("restores a SENT/OVERDUE invoice to its real state, never to Draft", async () => {
    const inv = await makeInvoice({
      account: ACCT_A, total: 900, invoiceNumber: `ZZ-${RUN}-OVERDUE`,
      invoiceStatus: "Overdue", status: "Overdue", dueDate: today(-40),
    })
    const feed = await makeFeed({ amount: 900, senderName: "ZZ ALPHA WIDGETS LLC", label: "overdue" })
    await manualMatch(feed, inv)

    await unlinkPayment(inv)

    const p = await readPayment(inv)
    expect(p.invoice_status).not.toBe("Draft")
    expect(p.invoice_status).toBe("Overdue")
    expect(Number(p.amount_paid)).toBe(0)
    expect(Number(p.amount_due)).toBe(900)
    expect(p.paid_date).toBeNull() // nothing paid ⇒ no paid date
  })

  it("un-confirms the money record instead of deleting it, and the client copy agrees", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 640, invoiceNumber: `ZZ-${RUN}-LEDGER` })
    const feed = await makeFeed({ amount: 640, senderName: "ZZ ALPHA WIDGETS LLC", label: "ledger" })
    await manualMatch(feed, inv)
    expect((await ledgerRows(inv))[0].confirmed_at).not.toBeNull()

    await unlinkPayment(inv)

    const rows = await ledgerRows(inv)
    expect(rows).toHaveLength(1) // history preserved — NOT deleted
    expect(rows[0].confirmed_at).toBeNull() // and no longer counts as applied
    const mirror = await readMirror(inv)
    if (mirror) {
      expect(Number(mirror.amount_paid ?? 0)).toBe(0)
      expect(Number(mirror.amount_due ?? 0)).toBe(640)
      expect(mirror.status).not.toBe("Paid")
    }
  })

  it("leaves a genuinely paid invoice ALONE when the transaction applied no money", async () => {
    // The audit-link case: the invoice was settled elsewhere and the transaction is linked for
    // the trail only. The first draft of this fix would have re-opened it and chased the client.
    const inv = await makeInvoice({
      account: ACCT_A, total: 480, invoiceNumber: `ZZ-${RUN}-AUDITLINK`,
      invoiceStatus: "Paid", status: "Paid", amountPaid: 480,
    })
    const feed = await makeFeed({
      amount: 480, senderName: "ZZ ALPHA WIDGETS LLC",
      status: "matched", matchedPaymentId: inv, label: "auditlink",
    })
    expect(await ledgerRows(inv)).toHaveLength(0) // no money was ever applied from a feed

    const res = await unlinkPayment(inv)
    expect(res.success).toBe(true)

    const p = await readPayment(inv)
    expect(p.invoice_status).toBe("Paid")
    expect(Number(p.amount_paid)).toBe(480)
    expect(p.status).toBe("Paid")
    // The pointer is cleared, the invoice untouched.
    expect((await readFeed(feed)).matched_payment_id).toBeNull()
  })
})

describe("6 — a human's NO must stick", () => {
  it("the automatic matcher does not re-credit a pair a person just un-matched", async () => {
    // This is the 15-minute re-credit window. Un-match, then run the matcher again on the
    // very same transaction: it must refuse to re-propose that invoice.
    const inv = await makeInvoice({ account: ACCT_A, total: 1111, invoiceNumber: `ZZ-${RUN}-REJECT` })
    const feed = await makeFeed({ amount: 1111, senderName: "ZZ ALPHA WIDGETS LLC", label: "reject" })
    await manualMatch(feed, inv)
    await unlinkPayment(inv)

    const f1 = await readFeed(feed)
    expect(f1.status).toBe("unmatched")
    expect(readRejectedPairs(f1.review_metadata).map((r) => r.payment_id)).toContain(inv)

    const again = await matchAndReconcile(feed)

    expect(again.matched).toBe(false)
    const p = await readPayment(inv)
    expect(Number(p.amount_paid ?? 0)).toBe(0)
    expect(p.invoice_status).not.toBe("Paid")
  })

  it("keeps the rejection when a LATER matcher write touches the same transaction", async () => {
    // The merge fix: six writers used to replace review_metadata wholesale, so the memory
    // died on the next pass. Plant a rejection, then make the matcher park the row.
    const rejected = await makeInvoice({ account: ACCT_A, total: 1234, invoiceNumber: `ZZ-${RUN}-MERGE-A` })
    const feed = await makeFeed({ amount: 1234, senderName: "ZZ ALPHA WIDGETS LLC", label: "merge" })
    await manualMatch(feed, rejected)
    await unlinkPayment(rejected)

    // A second candidate for the same amount, so the next pass has something to park on.
    await makeInvoice({ account: ACCT_A, total: 1234, invoiceNumber: `ZZ-${RUN}-MERGE-B` })
    await matchAndReconcile(feed)

    const f = await readFeed(feed)
    expect(readRejectedPairs(f.review_metadata).map((r) => r.payment_id)).toContain(rejected)
  })

  it("a human can still match a rejected pair BY HAND (only the machine is bound)", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 860, invoiceNumber: `ZZ-${RUN}-MANUAL` })
    const feed = await makeFeed({ amount: 860, senderName: "ZZ ALPHA WIDGETS LLC", label: "manualagain" })
    await manualMatch(feed, inv)
    await unlinkPayment(inv)

    // Changed their mind, with the evidence in front of them.
    const res = await manualMatch(feed, inv)

    expect(res.matched).toBe(true)
    expect(res.moneyApplied).toBe(true)
    const p = await readPayment(inv)
    expect(Number(p.amount_paid)).toBe(860)
    expect(p.invoice_status).toBe("Paid")
  })
})

describe("7 — the silent-success class this work exists to kill", () => {
  it("a re-match after an un-match moves REAL money, not a $0 success", async () => {
    // The leftover confirmed record used to make manualMatch report success while applying
    // nothing. The un-confirm + the corroboration check together close it.
    const inv = await makeInvoice({ account: ACCT_A, total: 505, invoiceNumber: `ZZ-${RUN}-ZERO` })
    const feed = await makeFeed({ amount: 505, senderName: "ZZ ALPHA WIDGETS LLC", label: "zero" })
    await manualMatch(feed, inv)
    await unlinkPayment(inv)
    expect(Number((await readPayment(inv)).amount_paid)).toBe(0)

    const res = await manualMatch(feed, inv)

    expect(res.matched).toBe(true)
    expect(res.moneyApplied).toBe(true)
    expect(Number((await readPayment(inv)).amount_paid)).toBe(505) // money REALLY moved
  })

  it("refuses to report success when the record says paid but the invoice does not", async () => {
    // Simulate the residual hole: money reversed, record left CONFIRMED (a dead second write).
    const inv = await makeInvoice({ account: ACCT_A, total: 400, invoiceNumber: `ZZ-${RUN}-DISAGREE` })
    const feed = await makeFeed({ amount: 400, senderName: "ZZ ALPHA WIDGETS LLC", label: "disagree" })
    await manualMatch(feed, inv)

    // Take the money off by hand WITHOUT touching the record — the disagreement.
    await supabaseAdmin
      .from("payments")
      .update({ amount_paid: 0, amount_due: 400, invoice_status: "Sent", status: "Pending", paid_date: null })
      .eq("id", inv)
    const rows = await ledgerRows(inv)
    expect(rows[0].confirmed_at).not.toBeNull()

    // A retry must NOT claim the money is already there.
    const res = await manualMatch(feed, inv)
    const p = await readPayment(inv)
    const claimsMoney = res.matched && res.moneyApplied === true
    if (claimsMoney) {
      expect(Number(p.amount_paid)).toBe(400) // if it claims money, the money must be there
    } else {
      expect(res.matched === false || res.moneyApplied === false).toBe(true)
    }
  })

  it("never credits the same transaction to the same invoice twice", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 250, invoiceNumber: `ZZ-${RUN}-TWICE` })
    const feed = await makeFeed({ amount: 250, senderName: "ZZ ALPHA WIDGETS LLC", label: "twice" })
    await manualMatch(feed, inv)
    await manualMatch(feed, inv)
    await matchAndReconcile(feed)

    const p = await readPayment(inv)
    expect(Number(p.amount_paid)).toBe(250) // not 500, not 750
    const confirmed = (await ledgerRows(inv)).filter((r) => r.confirmed_at !== null)
    expect(confirmed).toHaveLength(1)
  })
})

describe("8 — the transaction's own status must not be trampled", () => {
  it("un-matching does not resurrect an IGNORED or OUTGOING transaction into the queue", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 300, invoiceNumber: `ZZ-${RUN}-STATUS` })
    const paying = await makeFeed({ amount: 300, senderName: "ZZ ALPHA WIDGETS LLC", label: "status-pay" })
    await manualMatch(paying, inv)
    // Two stale pointers an operator had already triaged.
    const ignored = await makeFeed({
      amount: 300, senderName: "ZZ ALPHA WIDGETS LLC",
      status: "ignored", matchedPaymentId: inv, label: "status-ign",
    })
    const outgoing = await makeFeed({
      amount: 300, senderName: "ZZ ALPHA WIDGETS LLC",
      status: "outgoing", matchedPaymentId: inv, label: "status-out",
    })

    await unlinkPayment(inv)

    expect((await readFeed(paying)).status).toBe("unmatched")
    expect((await readFeed(ignored)).status).toBe("ignored")
    expect((await readFeed(outgoing)).status).toBe("outgoing")
    expect((await readFeed(ignored)).matched_payment_id).toBeNull()
    expect((await readFeed(outgoing)).matched_payment_id).toBeNull()
  })
})

describe("9 — deleting an invoice that holds bank money", () => {
  it("is refused, with a message that says what to do instead", async () => {
    const inv = await makeInvoice({
      account: ACCT_A, total: 1200, invoiceNumber: `ZZ-${RUN}-DELETE`,
      invoiceStatus: "Partial",
    })
    const feed = await makeFeed({ amount: 600, senderName: "ZZ ALPHA WIDGETS LLC", label: "delete" })
    await manualMatch(feed, inv)
    expect((await readPayment(inv)).invoice_status).toBe("Partial")

    const res = await deletePayment(inv)

    expect(res.success).toBe(false)
    expect(String(res.error)).toMatch(/un-?match/i)
    expect(await readPayment(inv)).toBeTruthy() // still there
  })
})

describe("10 — the stale 'invoice paid' note (Luca's report)", () => {
  it("is retired on reversal, and a genuine payment can announce itself afterwards", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 1000, invoiceNumber: `ZZ-${RUN}-NOTE` })
    const feed = await makeFeed({ amount: 1000, senderName: "ZZ ALPHA WIDGETS LLC", label: "note" })

    await manualMatch(feed, inv)
    // The note is emitted by the mirror sync on the way to Paid.
    const { data: afterMatch } = await supabaseAdmin
      .from("portal_messages")
      .select("id, deleted_at")
      .like("message", `%payments:${inv}%`)
    expect((afterMatch ?? []).length).toBeGreaterThanOrEqual(1)

    await unlinkPayment(inv)

    const { data: afterUnlink } = await supabaseAdmin
      .from("portal_messages")
      .select("id, deleted_at")
      .like("message", `%payments:${inv}%`)
    expect((afterUnlink ?? []).every((m) => (m as { deleted_at: string | null }).deleted_at !== null)).toBe(true)

    // And the invoice is no longer permanently barred from announcing a real payment.
    const emitted = await emitPaymentReceivedEvent({ payment_id: inv, method_hint: "Zelle" })
    expect(emitted.emitted).toBe(true)
  })

  it("retiring is idempotent and safe when there is no note", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 10, invoiceNumber: `ZZ-${RUN}-NONOTE` })
    const first = await retirePaymentReceivedNote({ paymentId: inv })
    expect(first.retired).toBe(0)
    const second = await retirePaymentReceivedNote({ paymentId: inv })
    expect(second.retired).toBe(0)
  })
})

describe("11 — a reversed transaction must not drift into the owner's books", () => {
  it("stays in Finance because a person has triaged it against a client invoice", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 1500, invoiceNumber: `ZZ-${RUN}-OWNER` })
    const feed = await makeFeed({ amount: 1500, senderName: "ZZ ALPHA WIDGETS LLC", label: "owner" })
    await manualMatch(feed, inv)
    await unlinkPayment(inv)

    const { data: row } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("id, transaction_date, amount, currency, source, sender_name, memo, sender_reference, raw_data, status, external_id, matched_payment_id, review_metadata")
      .eq("id", feed)
      .single()

    // No email, no invoice number, no pointer left — the sweep would otherwise treat a real
    // client payment as unrecognised and hide it in My Finances, double-counting the money.
    expect(isClientInvoicePayment(row as never, [])).toBe(true)
  })
})

describe("12 — the reversal helper's own contract", () => {
  it("reports 'no_application' rather than touching an invoice it never paid", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 99, invoiceNumber: `ZZ-${RUN}-NOAPP` })
    const feed = await makeFeed({ amount: 99, senderName: "ZZ ALPHA WIDGETS LLC", label: "noapp" })

    const res = await reverseFeedApplication({ feedId: feed, paymentId: inv, actor: "qa", today: today() })

    expect(res.reversed).toBe(false)
    expect(res.reason).toBe("no_application")
    const p = await readPayment(inv)
    expect(p.invoice_status).toBe("Sent")
  })

  it("is idempotent — reversing twice does not go below zero", async () => {
    const inv = await makeInvoice({ account: ACCT_A, total: 700, invoiceNumber: `ZZ-${RUN}-IDEM` })
    const feed = await makeFeed({ amount: 700, senderName: "ZZ ALPHA WIDGETS LLC", label: "idem" })
    await manualMatch(feed, inv)

    const first = await reverseFeedApplication({ feedId: feed, paymentId: inv, actor: "qa", today: today() })
    expect(first.reversed).toBe(true)
    const second = await reverseFeedApplication({ feedId: feed, paymentId: inv, actor: "qa", today: today() })
    expect(second.reversed).toBe(false)
    expect(second.reason).toBe("no_application")

    const p = await readPayment(inv)
    expect(Number(p.amount_paid)).toBe(0)
    expect(Number(p.amount_due)).toBe(700)
  })

  it("finds work through the money record, not the transaction pointer", async () => {
    // A wire funding several invoices points at only the FIRST one, so a reversal that
    // searched by pointer would leave invoices 2..N credited with nothing behind them.
    const inv = await makeInvoice({ account: ACCT_A, total: 200, invoiceNumber: `ZZ-${RUN}-PTR` })
    const feed = await makeFeed({ amount: 200, senderName: "ZZ ALPHA WIDGETS LLC", label: "ptr" })
    await manualMatch(feed, inv)

    // Strip the pointer, as a multi-invoice match does for its 2nd..Nth invoice.
    await updateFeed(feed, { matched_payment_id: null }, "qa:strip-pointer")

    const apps = await listConfirmedApplications(inv)
    expect(apps).toHaveLength(1)
    expect(apps[0].feed_id).toBe(feed)

    const res = await unlinkPayment(inv)
    expect(res.success).toBe(true)
    expect(Number((await readPayment(inv)).amount_paid)).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════
// 13 — THE THREE BLOCKERS THE BUG-HUNTER FOUND ON THE FINISHED CODE (2026-07-29).
// Each of these passed review, passed the unit tests, and passed the first 27 E2E scenarios.
// ══════════════════════════════════════════════════════════════════════════════════════
describe("13 — a rejected pair must not be AUDIT-LINKED either", () => {
  it("does not re-link a pair a human rejected, even once the invoice is Paid", async () => {
    // The rejected-pair filter originally sat at the auto-settle decision — AFTER the
    // retroactive block returns. So the machine could still re-attach the rejected pair as an
    // audit link: transaction marked matched, gone from the review queue, and that invoice's
    // slot permanently consumed so the transaction that really belongs there can never link.
    const inv = await makeInvoice({ account: ACCT_A, total: 1690, invoiceNumber: `ZZ-${RUN}-RETRO-REJ` })
    const feed = await makeFeed({ amount: 1690, senderName: "ZZ ALPHA WIDGETS LLC", label: "retro-rej" })

    await manualMatch(feed, inv)
    await unlinkPayment(inv) // records the rejection
    // The invoice is then genuinely settled another way (card, Zelle, by hand).
    await supabaseAdmin
      .from("payments")
      .update({ invoice_status: "Paid", status: "Paid", amount_paid: 1690, amount_due: 0 })
      .eq("id", inv)

    const res = await matchAndReconcile(feed)
    const f = await readFeed(feed)

    expect(res.confidence).not.toBe("retroactive")
    expect(f.matched_payment_id).not.toBe(inv)
    expect(f.status).not.toBe("matched")
  })
})

describe("13b — voiding must not set a funded transaction free", () => {
  it("keeps the transaction attached, so its money cannot also settle another invoice", async () => {
    // Voiding deliberately KEEPS amount_paid (real cash, restored on reactivate). But it also
    // reset every matched transaction to `unmatched` — so the same wire went back to the matcher
    // at full amount while its money was still recorded on the cancelled invoice. Settle
    // anything else with it and one $1,000 wire is booked twice, with the per-invoice invariant
    // intact on both rows so nothing detects it.
    const { voidInvoice } = await import("@/app/(dashboard)/finance/actions")
    const inv = await makeInvoice({ account: ACCT_A, total: 1790, invoiceNumber: `ZZ-${RUN}-VOID` })
    const feed = await makeFeed({ amount: 1790, senderName: "ZZ ALPHA WIDGETS LLC", label: "void" })
    await manualMatch(feed, inv)

    const res = await voidInvoice(inv)
    expect(res.success).toBe(true)

    const f = await readFeed(feed)
    expect(f.status).toBe("matched")
    expect(f.matched_payment_id).toBe(inv)
    // And the money record is intact, so reactivating finds everything as it was.
    const rows = await ledgerRows(inv)
    expect(rows).toHaveLength(1)
    expect(rows[0].confirmed_at).not.toBeNull()

    // The matcher must not be able to spend it again.
    const other = await makeInvoice({ account: ACCT_A, total: 1790, invoiceNumber: `ZZ-${RUN}-VOID-OTHER` })
    await matchAndReconcile(feed)
    expect(Number((await readPayment(other)).amount_paid ?? 0)).toBe(0)
  })
})

describe("13c — the audit panel's suggestion list uses the same name rule", () => {
  it("does not present a generic-word-only match as a confident company-name hit", async () => {
    // This screen suggests "deposits that look like they belong to this client", and one click
    // there CREATES A PAID INVOICE — so the incident was reachable through it even after the
    // matcher was fixed. It had its own stop-word list, also missing "marketing", and hit on a
    // single token. It now shares the matcher's rule, and a partial hit SAYS it is partial.
    const { findFeedsForAccount } = await import("@/lib/audit/bank-feed-cascade")

    const hits = findFeedsForAccount(
      { id: ACCT_B, company_name: "ZZ Aces Marketing Solutions LLC" },
      [],
      [],
      [{
        id: "zz-cascade-feed",
        source: "mercury_api",
        transaction_date: today(-1),
        amount: 1000,
        currency: "USD",
        sender_name: "ZZ Marketing Consulting",
        memo: "From ZZ Marketing Consulting via mercury.com",
        sender_reference: null,
        status: "unmatched",
        raw_data: null,
      }],
    )

    // "marketing" is generic and "aces" is absent, so this is not a company-name match at all.
    expect(hits.filter((h) => h.rule === "company_name_match")).toHaveLength(0)
  })

  it("still surfaces a partial person-name hint, labelled as partial", async () => {
    const { findFeedsForAccount } = await import("@/lib/audit/bank-feed-cascade")
    const hits = findFeedsForAccount(
      { id: ACCT_A, company_name: "ZZ Alpha Widgets LLC" },
      [{ id: "zz-c1", full_name: "Maria Bianchi", email: null }],
      [],
      [{
        id: "zz-cascade-feed-2",
        source: "mercury_api",
        transaction_date: today(-1),
        amount: 500,
        currency: "USD",
        sender_name: "BIANCHI WIRE",
        memo: null,
        sender_reference: null,
        status: "unmatched",
        raw_data: null,
      }],
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].match_evidence).toContain("partial name")
  })
})
