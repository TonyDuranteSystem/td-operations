/**
 * Unit tests for lib/finance/owner-transaction-link.ts — the two-step flow
 * (rebuilt 2026-09-11 after Antonio corrected the design: the pick-invoice /
 * note / write-off popup lives in Finance, not in My Finances; then a second
 * bug-hunter + senior-engineer + ai-architect pass on this exact rebuild
 * found and fixed a double-credit gap and a write-off that silently failed
 * on multi-line invoices — see the module's own doc comment):
 *
 *   1. sendOwnerTransactionToFinance — a My Finances transaction becomes a
 *      normal, visible td_bank_feeds row, stamped so the automatic
 *      "maybe a client payment" sweep can't reclaim it before step 2.
 *   2. linkFeedTransactionToInvoice — the Finance-side popup: pick the
 *      invoice, write a note, optionally write off whatever's left.
 *
 * applyMoneyToInvoice, updateInvoice, and updateFeed are mocked as
 * already-tested dependencies (covered by apply-payment-currency-guard.test.ts,
 * the updateInvoice suite, and process-bank-feed-matches.test.ts respectively)
 * — this file tests this module's own orchestration and guards.
 * isTerminalInvoice/terminalReason are left real (pure, simple, and the point
 * is testing this module composes with them correctly).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

interface BooksTxFixture {
  id: string
  amount: number
  currency: string | null
  transaction_date: string
  bank_name: string | null
  description: string | null
  counterparty: string | null
  moved_to_feed_id: string | null
}
interface FeedFixture {
  id: string
  amount: number
  currency: string | null
  transaction_date: string
  status: string
  source?: string
  external_id?: string | null
}
interface PaymentFixture {
  id: string
  invoice_number: string | null
  invoice_status: string | null
  status: string | null
  total: number | null
  amount: number | null
  amount_paid: number | null
  amount_currency: string | null
  notes?: string | null
}

let txFixture: BooksTxFixture | null = null
let txReadError: { message: string } | null = null
let txMarkError: { message: string } | null = null
const txUpdateLog: Array<Record<string, unknown>> = []

let feedByIdFixture: FeedFixture | null = null
let feedReadError: { message: string } | null = null
let feedByExternalIdFixture: { id: string } | null = null

let upsertData: { id: string } | null = null
let upsertError: { message: string } | null = null
const upsertLog: Array<Record<string, unknown>> = []

let paymentFixture: PaymentFixture | null = null
let paymentReadError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "td_books_transactions") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: txFixture, error: txReadError }),
            }),
          }),
          update: (patch: Record<string, unknown>) => {
            txUpdateLog.push(patch)
            const result = { error: txMarkError }
            // This chain is used two different ways by the module under test:
            //   sendOwnerTransactionToFinance:      .update(...).eq(...).is(...)
            //   linkFeedTransactionToInvoice:        .update(...).eq(...)   (bare await, ignored)
            // so .eq() must be BOTH awaitable directly and further chainable.
            const eqResult = Promise.resolve(result) as Promise<typeof result> & { is: () => Promise<typeof result> }
            eqResult.is = () => Promise.resolve(result)
            return { eq: () => eqResult }
          },
        }
      }
      if (table === "td_bank_feeds") {
        return {
          select: () => ({
            eq: (col: string) => ({
              maybeSingle: () =>
                col === "id"
                  ? Promise.resolve({ data: feedByIdFixture, error: feedReadError })
                  : Promise.resolve({ data: feedByExternalIdFixture, error: null }),
            }),
          }),
          upsert: (rows: Record<string, unknown>[]) => {
            upsertLog.push(...rows)
            return {
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: upsertData, error: upsertError }),
              }),
            }
          },
        }
      }
      if (table === "payments") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: paymentFixture, error: paymentReadError }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))

const applyMoneyToInvoiceMock = vi.fn()
vi.mock("@/lib/finance/apply-payment", () => ({
  applyMoneyToInvoice: (...args: unknown[]) => applyMoneyToInvoiceMock(...args),
}))

const updateInvoiceMock = vi.fn()
vi.mock("@/app/(dashboard)/finance/actions", () => ({
  updateInvoice: (...args: unknown[]) => updateInvoiceMock(...args),
}))

const updateFeedMock = vi.fn()
vi.mock("@/lib/finance/feed-write", () => ({
  updateFeed: (...args: unknown[]) => updateFeedMock(...args),
}))

const closePaymentWithWriteOffMock = vi.fn()
vi.mock("@/lib/operations/payment", () => ({
  closePaymentWithWriteOff: (...args: unknown[]) => closePaymentWithWriteOffMock(...args),
}))

const isChargeRefundedNowMock = vi.fn()
vi.mock("@/lib/stripe-sync", () => ({
  isChargeRefundedNow: (...args: unknown[]) => isChargeRefundedNowMock(...args),
}))

const reportSystemErrorMock = vi.fn()
vi.mock("@/lib/system-errors", () => ({
  reportSystemError: (...args: unknown[]) => reportSystemErrorMock(...args),
}))

import { sendOwnerTransactionToFinance, linkFeedTransactionToInvoice } from "@/lib/finance/owner-transaction-link"

const baseTx: BooksTxFixture = {
  id: "tx-1",
  amount: 600.02,
  currency: "USD",
  transaction_date: "2026-09-10",
  bank_name: "Chase Total Checking",
  description: "Wire in",
  counterparty: "Ambition Holding LLC",
  moved_to_feed_id: null,
}
const baseFeed: FeedFixture = {
  id: "feed-1",
  amount: 600.02,
  currency: "USD",
  transaction_date: "2026-09-10",
  status: "unmatched",
  source: "manual",
  external_id: null,
}
const basePayment: PaymentFixture = {
  id: "pay-1",
  invoice_number: "INV-002181",
  invoice_status: "Overdue",
  status: "Pending",
  total: 1200,
  amount: 1200,
  amount_paid: 0,
  amount_currency: "USD",
  notes: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  txUpdateLog.length = 0
  upsertLog.length = 0
  txFixture = { ...baseTx }
  txReadError = null
  txMarkError = null
  feedByIdFixture = { ...baseFeed }
  feedReadError = null
  feedByExternalIdFixture = null
  upsertData = { id: "feed-1" }
  upsertError = null
  paymentFixture = { ...basePayment }
  paymentReadError = null
  applyMoneyToInvoiceMock.mockResolvedValue({
    applied: true,
    invoiceNumber: "INV-002181",
    newStatus: "Partial",
    newAmountPaid: 600.02,
    newAmountDue: 599.98,
  })
  updateInvoiceMock.mockResolvedValue({ success: true })
  updateFeedMock.mockResolvedValue({ ok: true })
  closePaymentWithWriteOffMock.mockResolvedValue({ success: true })
  isChargeRefundedNowMock.mockResolvedValue("ok")
  reportSystemErrorMock.mockResolvedValue(null)
})

describe("sendOwnerTransactionToFinance", () => {
  it("creates a Finance-side feed row and marks the source transaction", async () => {
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(true)
    expect(result.feedId).toBe("feed-1")
    expect(upsertLog).toHaveLength(1)
    expect(upsertLog[0]).toMatchObject({
      external_id: "books:tx-1",
      amount: 600.02,
      currency: "USD",
      status: "unmatched",
      sender_name: "Ambition Holding LLC",
    })
    // Stamped so the automatic sweep can't reclaim it before step 2.
    const meta = upsertLog[0].review_metadata as { client_payment_claim: { by: string; at: string } }
    expect(meta.client_payment_claim.by).toBe("dashboard:antonio")
    expect(typeof meta.client_payment_claim.at).toBe("string")
    expect(txUpdateLog).toContainEqual({ moved_to_feed_id: "feed-1" })
  })

  it("refuses when the transaction is not found", async () => {
    txFixture = null
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(upsertLog).toHaveLength(0)
  })

  it("surfaces a read error instead of proceeding", async () => {
    txReadError = { message: "connection reset" }
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/connection reset/)
    expect(upsertLog).toHaveLength(0)
  })

  it("refuses a transaction already sent to Finance — the double-click guard", async () => {
    txFixture = { ...baseTx, moved_to_feed_id: "feed-already" }
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already been sent/)
    expect(upsertLog).toHaveLength(0)
  })

  it("refuses outgoing (negative) money", async () => {
    txFixture = { ...baseTx, amount: -130 }
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/coming IN/)
    expect(upsertLog).toHaveLength(0)
  })

  it("refuses a zero-amount transaction", async () => {
    txFixture = { ...baseTx, amount: 0 }
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/coming IN/)
  })

  it("re-reads by external_id when the upsert hits ignoreDuplicates (idempotent retry)", async () => {
    upsertData = null // simulates a conflicting row already existing
    feedByExternalIdFixture = { id: "feed-existing" }
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(true)
    expect(result.feedId).toBe("feed-existing")
    expect(txUpdateLog).toContainEqual({ moved_to_feed_id: "feed-existing" })
  })

  it("fails if the upsert hit a duplicate AND the re-read finds nothing", async () => {
    upsertData = null
    feedByExternalIdFixture = null
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not confirm/i)
  })

  it("surfaces an upsert error", async () => {
    upsertData = null
    upsertError = { message: "unique violation on something else" }
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not create/i)
  })

  it("still returns ok:true (money is safely in Finance) if the moved_to_feed_id write fails, but reports it", async () => {
    txMarkError = { message: "row lock timeout" }
    const result = await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(result.ok).toBe(true)
    expect(result.feedId).toBe("feed-1")
    expect(reportSystemErrorMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["Chase Total Checking", "chase"],
    ["JPMorgan Chase Bank", "chase"],
    ["Mercury Business Checking", "mercury_api"],
    ["Relay Financial", "relay"],
    ["Airwallex Global Account", "airwallex_api"],
    ["Revolut Business", "revolut"],
    [null, "manual"],
    ["Some Other Bank", "manual"],
  ])("maps bank_name %s to feed source %s (guessFeedSource, tested through its only caller)", async (bankName, expectedSource) => {
    txFixture = { ...baseTx, bank_name: bankName }
    await sendOwnerTransactionToFinance("tx-1", "dashboard:antonio")
    expect(upsertLog[0]?.source).toBe(expectedSource)
  })
})

describe("linkFeedTransactionToInvoice", () => {
  const baseParams = {
    feedId: "feed-1",
    paymentId: "pay-1",
    note: "Settled by court agreement — $600 closes the $1,200 invoice.",
    writeOffRemaining: true,
    actor: "dashboard:antonio",
  }

  it("refuses when the feed transaction is not found", async () => {
    feedByIdFixture = null
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
  })

  it("surfaces a feed read error", async () => {
    feedReadError = { message: "timeout" }
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timeout/)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
  })

  it("refuses a feed transaction that already settled an invoice", async () => {
    feedByIdFixture = { ...baseFeed, status: "matched" }
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already settled/)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
  })

  it("refuses when the invoice is not found", async () => {
    paymentFixture = null
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invoice not found/i)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
  })

  // Paid is no longer a flat refusal (2026-09-15, Antonio hit this live: an
  // invoice marked paid manually, no bank transaction ever linked, had no way
  // back once its one prior audit-link was undone) — see the two audit-link
  // tests below. Voided/Cancelled/Credit/Split still refuse outright.
  it.each(["Voided", "Cancelled", "Credit", "Split"])(
    "refuses a terminal (already closed, non-Paid) invoice — %s",
    async (terminalStatus) => {
      paymentFixture = { ...basePayment, invoice_status: terminalStatus, status: terminalStatus }
      const result = await linkFeedTransactionToInvoice(baseParams)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(new RegExp(`already ${terminalStatus}`))
      expect(result.invoiceNumber).toBe("INV-002181")
      expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
      expect(updateFeedMock).not.toHaveBeenCalled()
    },
  )

  it("audit-links (does not refuse) an already-Paid invoice — no money applied, the record-only case Antonio hit live", async () => {
    paymentFixture = { ...basePayment, invoice_status: "Paid", status: "Paid", amount_paid: 1200 }
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(true)
    expect(result.invoiceNumber).toBe("INV-002181")
    expect(result.newAmountDue).toBe(0)
    expect(result.auditLink).toBe(true)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
    expect(updateFeedMock).toHaveBeenCalledWith(
      "feed-1",
      expect.objectContaining({
        matched_payment_id: "pay-1",
        match_confidence: "manual",
        status: "matched",
        review_metadata: expect.objectContaining({ audit_link: true, money_applied: false }),
      }),
      "link-feed-transaction-to-invoice:audit-link",
    )
    // Mirrored onto the source My Finances row too, same as the money-applying path.
    expect(txUpdateLog).toContainEqual(
      expect.objectContaining({ linked_payment_id: "pay-1", linked_note: baseParams.note, linked_by: "dashboard:antonio" }),
    )
  })

  it("audit-links via the coarse `status` column when invoice_status is absent — the 48-row production case", async () => {
    paymentFixture = { ...basePayment, invoice_status: null, status: "Paid" }
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(true)
    expect(result.auditLink).toBe(true)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
  })

  // Senior-engineer finding, 2026-09-15: isPaidInvoice's first draft (this
  // same day) reused wasFullyPaid, whose "trust invoice_status completely
  // whenever present" rule reads "Overdue" as NOT paid and never falls
  // through to check `status` at all — reproducing the exact dead-end this
  // feature exists to fix, for any invoice whose document was never updated
  // to Paid even though the ledger already shows it. Fixed by matching
  // isTerminalInvoice's own precedence instead: an open-looking invoice_status
  // falls back to the coarse status rather than vetoing it.
  it("audit-links an invoice whose invoice_status is stale (Overdue) but whose ledger status already reads Paid", async () => {
    paymentFixture = { ...basePayment, invoice_status: "Overdue", status: "Paid" }
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(true)
    expect(result.auditLink).toBe(true)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
  })

  it("still returns ok:true (audit-linked) when the My Finances mirror write fails, but reports it", async () => {
    paymentFixture = { ...basePayment, invoice_status: "Paid", status: "Paid" }
    txMarkError = { message: "row lock timeout" }
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(true)
    expect(reportSystemErrorMock).toHaveBeenCalledTimes(1)
  })

  // The landmine this whole design had to route around, closed at its root
  // (lib/finance/invoice-matchability.ts's isPaidInvoice itself, 2026-09-15,
  // not by avoiding it here) rather than by picking a different predicate: a
  // credit note's coarse `status` column often also reads "Paid" — an
  // artifact of that column's default for the document type, not a signal
  // that TD received money (confirmed against real production Credit rows,
  // every one a negative-amount referral reward, refund, or paid-call
  // credit — see isPaidInvoice's own doc comment). The OLD, unfixed
  // isPaidInvoice ORed that coarse column in unconditionally and would have
  // audit-linked this as "money already received", exactly backwards.
  it("does NOT audit-link a credit note even though its `status` column also reads Paid", async () => {
    paymentFixture = { ...basePayment, invoice_status: "Credit", status: "Paid" }
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already Credit/)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
    expect(updateFeedMock).not.toHaveBeenCalled()
  })

  it("applies money through a REAL feedId — inheriting applyMoneyToInvoice's own double-credit lock instead of a bespoke one", async () => {
    await linkFeedTransactionToInvoice(baseParams)
    expect(applyMoneyToInvoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        mode: "apply",
        appliedAmount: 600.02,
        paidDate: "2026-09-10",
        actor: "dashboard:antonio",
        feedId: "feed-1",
      }),
    )
  })

  // bug-hunter, second review round, 2026-09-11: the UI only disables the
  // "Link with a note" button once a feed is ALREADY flagged refunded — this
  // is the only place that actually settles money, so it must re-verify
  // itself server-side, mirroring manualMatch's own gate for the same reason.
  it("does not re-check Stripe for a non-Stripe feed", async () => {
    await linkFeedTransactionToInvoice(baseParams)
    expect(isChargeRefundedNowMock).not.toHaveBeenCalled()
    expect(applyMoneyToInvoiceMock).toHaveBeenCalled()
  })

  it("re-checks Stripe for a Stripe-sourced feed and proceeds when the charge is still ours", async () => {
    feedByIdFixture = { ...baseFeed, source: "stripe", external_id: "ch_123" }
    await linkFeedTransactionToInvoice(baseParams)
    expect(isChargeRefundedNowMock).toHaveBeenCalledWith("ch_123")
    expect(applyMoneyToInvoiceMock).toHaveBeenCalled()
  })

  it("refuses and flags the feed when Stripe confirms the charge was refunded — never applies money", async () => {
    feedByIdFixture = { ...baseFeed, source: "stripe", external_id: "ch_123" }
    isChargeRefundedNowMock.mockResolvedValue("refunded")
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/refunded or disputed/i)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
    expect(updateFeedMock).toHaveBeenCalledWith(
      "feed-1",
      expect.objectContaining({
        status: "needs_review",
        matched_payment_id: "pay-1",
        review_metadata: expect.objectContaining({ refunded_or_disputed: true }),
      }),
      expect.any(String),
    )
  })

  it("refuses (without flagging) when Stripe verification is deferred — a transient failure, not a confirmed refund", async () => {
    feedByIdFixture = { ...baseFeed, source: "stripe", external_id: "ch_123" }
    isChargeRefundedNowMock.mockResolvedValue("defer")
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/try again/i)
    expect(applyMoneyToInvoiceMock).not.toHaveBeenCalled()
    expect(updateFeedMock).not.toHaveBeenCalled()
  })

  it("proceeds when Stripe verification is unchecked (no key / unknown charge) — same exposure as before the check existed", async () => {
    feedByIdFixture = { ...baseFeed, source: "stripe", external_id: "ch_123" }
    isChargeRefundedNowMock.mockResolvedValue("unchecked")
    await linkFeedTransactionToInvoice(baseParams)
    expect(applyMoneyToInvoiceMock).toHaveBeenCalled()
  })

  it("refuses and does not touch the invoice when applyMoneyToInvoice refuses", async () => {
    applyMoneyToInvoiceMock.mockResolvedValue({ applied: false, reason: "already_applied", detail: "already applied by this transaction" })
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("already applied by this transaction")
    expect(updateInvoiceMock).not.toHaveBeenCalled()
    expect(updateFeedMock).not.toHaveBeenCalled()
  })

  it("marks the feed matched after a successful link — the double-credit guard (bug-hunter + senior-engineer, 2026-09-11)", async () => {
    await linkFeedTransactionToInvoice(baseParams)
    expect(updateFeedMock).toHaveBeenCalledWith(
      "feed-1",
      expect.objectContaining({
        matched_payment_id: "pay-1",
        match_confidence: "manual",
        matched_by: "dashboard:antonio",
        status: "matched",
      }),
      expect.any(String),
    )
  })

  it("still returns ok:true (money is safely applied) when marking the feed matched fails, but reports it", async () => {
    updateFeedMock.mockResolvedValue({ ok: false, error: "constraint violation" })
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(true)
    expect(reportSystemErrorMock).toHaveBeenCalledTimes(1)
  })

  it("closes the invoice (write-off) via closePaymentWithWriteOff when writeOffRemaining is true and money is left owing — the Ambition Holding case", async () => {
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(true)
    expect(result.newStatus).toBe("Paid")
    expect(result.newAmountDue).toBe(0)
    // newAmountPaid reflects what was ACTUALLY collected — the write-off
    // never rewrites amount_paid to look like the invoice was paid in full.
    expect(result.newAmountPaid).toBe(600.02)
    // ai-architect, 2026-09-11: a write-off must NEVER go through
    // updateInvoice({total: ...}) — that path routes through
    // adjustSingleServiceLineForTotal, which refuses outright on any invoice
    // with more than one adjustable line or a fee line. closePaymentWithWriteOff
    // (lib/operations/payment.ts) is the dedicated, narrow alternative —
    // mocked here as an already-tested dependency, so this only asserts it's
    // called with the right arguments, not its own internals.
    expect(closePaymentWithWriteOffMock).toHaveBeenCalledWith({
      paymentId: "pay-1",
      notes: expect.stringContaining("Settled by court agreement"),
    })
    expect(updateInvoiceMock).not.toHaveBeenCalled()
  })

  it("does NOT reduce the invoice total when writeOffRemaining is false — a plain partial payment", async () => {
    const result = await linkFeedTransactionToInvoice({ ...baseParams, writeOffRemaining: false })
    expect(result.ok).toBe(true)
    expect(result.newStatus).toBe("Partial")
    expect(result.newAmountDue).toBe(599.98)
    expect(updateInvoiceMock).toHaveBeenCalledWith(
      "pay-1",
      expect.not.objectContaining({ total: expect.anything() }),
    )
  })

  it("does NOT reduce the invoice total when writeOffRemaining is true but nothing is left owing", async () => {
    applyMoneyToInvoiceMock.mockResolvedValue({
      applied: true, invoiceNumber: "INV-002181", newStatus: "Paid", newAmountPaid: 1200, newAmountDue: 0,
    })
    await linkFeedTransactionToInvoice(baseParams)
    expect(updateInvoiceMock).toHaveBeenCalledWith("pay-1", expect.not.objectContaining({ total: expect.anything() }))
  })

  it("appends to an existing note rather than overwriting it — write-off path (via closePaymentWithWriteOff)", async () => {
    paymentFixture = { ...basePayment, notes: "2026-06-01: original installment note." }
    await linkFeedTransactionToInvoice(baseParams)
    const notes = closePaymentWithWriteOffMock.mock.calls[0][0].notes as string
    expect(notes).toContain("2026-06-01: original installment note.")
    expect(notes).toContain("Settled by court agreement")
  })

  it("appends to an existing note rather than overwriting it — plain partial-payment path (via updateInvoice)", async () => {
    paymentFixture = { ...basePayment, notes: "2026-06-01: original installment note." }
    await linkFeedTransactionToInvoice({ ...baseParams, writeOffRemaining: false })
    const call = updateInvoiceMock.mock.calls[0][1] as { notes: string }
    expect(call.notes).toContain("2026-06-01: original installment note.")
    expect(call.notes).toContain("Settled by court agreement")
  })

  it("mirrors the outcome back onto the source My Finances row", async () => {
    await linkFeedTransactionToInvoice(baseParams)
    expect(txUpdateLog).toContainEqual(
      expect.objectContaining({ linked_payment_id: "pay-1", linked_note: baseParams.note, linked_by: "dashboard:antonio" }),
    )
  })

  it("still returns ok:true (money applied, feed consumed) when the My Finances mirror write fails, but reports it", async () => {
    txMarkError = { message: "row lock timeout" }
    const result = await linkFeedTransactionToInvoice({ ...baseParams, writeOffRemaining: false })
    expect(result.ok).toBe(true)
    expect(reportSystemErrorMock).toHaveBeenCalledTimes(1)
  })

  it("keeps the invoice correctly Partial (no rollback) when closePaymentWithWriteOff fails after money was applied", async () => {
    closePaymentWithWriteOffMock.mockResolvedValue({ success: false, error: "some transient failure" })
    const result = await linkFeedTransactionToInvoice(baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/was applied/)
    expect(result.newAmountDue).toBe(599.98)
    // The money and the feed-consumption guard are unaffected by this later failure.
    expect(applyMoneyToInvoiceMock).toHaveBeenCalled()
    expect(updateFeedMock).toHaveBeenCalled()
  })

  it("still returns ok:true (money applied) when only the plain note-write fails, but reports it", async () => {
    updateInvoiceMock.mockResolvedValue({ success: false, error: "some transient failure" })
    const result = await linkFeedTransactionToInvoice({ ...baseParams, writeOffRemaining: false })
    expect(result.ok).toBe(true)
    expect(reportSystemErrorMock).toHaveBeenCalledTimes(1)
  })
})
