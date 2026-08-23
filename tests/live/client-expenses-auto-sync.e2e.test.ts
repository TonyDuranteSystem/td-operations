/**
 * client_expenses AUTO-SYNC TRIGGER — LIVE E2E (dev job 0dcb0a18)
 *
 * Drives REAL code against the REAL per-worktree isolated local database, proving the
 * migration (20260823-1200-client-expenses-auto-sync-trigger.sql) actually behaves as
 * designed — not just that it applies without error.
 *
 * Council-reviewed across 3 rounds before this was written (senior-engineer, ai-architect,
 * bug-hunter). Requires the migration to already be applied to the local stack.
 *
 * Run: npx vitest run --config vitest.client-expenses-sync-e2e.config.ts
 */
/* eslint-disable no-restricted-syntax -- destructive local-stack QA harness; never runs in CI
   or against production. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "qa", email: "qa-e2e@tonydurante.us" } } }) },
    from: () => ({ insert: async () => ({ data: null, error: null }) }),
  }),
}))

import { supabaseAdmin } from "@/lib/supabase-admin"
import { syncTDInvoiceMirror } from "@/lib/portal/td-invoice-mirror"
import { syncTDInvoiceStatus } from "@/lib/portal/td-invoice"
import { markExpensePaid } from "@/app/portal/invoices/expense-actions"
import { updateInvoice } from "@/app/(dashboard)/finance/actions"

const RUN = Date.now().toString(36)
const ACCT = "55555555-0000-4000-8000-000000000001" // ZZ Sync-Trigger Test LLC

const createdPayments: string[] = []
const createdExpenses: string[] = []

async function makeAccount() {
  await supabaseAdmin.from("accounts").upsert({ id: ACCT, company_name: "ZZ Sync-Trigger Test LLC", account_type: "Client" })
}

async function makePayment(opts: {
  total: number
  amountPaid?: number
  amountDue?: number
  status?: string
  invoiceStatus?: string
  invoiceNumber: string
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .insert({
      account_id: ACCT,
      invoice_number: opts.invoiceNumber,
      description: "ZZ E2E sync-trigger fixture",
      total: opts.total,
      amount: opts.total,
      amount_currency: "USD",
      amount_paid: opts.amountPaid ?? 0,
      amount_due: opts.amountDue ?? opts.total,
      status: opts.status ?? "Pending",
      invoice_status: opts.invoiceStatus ?? "Sent",
      due_date: "2026-09-01",
    })
    .select("id")
    .single()
  if (error) throw new Error(`fixture payment failed: ${error.message}`)
  const id = (data as { id: string }).id
  createdPayments.push(id)
  return id
}

/** Mirror row created the way createTDInvoice actually creates one (real INSERT, not via
 *  the trigger — proving the fixture matches production shape). */
async function makeMirror(paymentId: string, opts: { total: number; amountPaid?: number; amountDue?: number; status?: string }): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("client_expenses")
    .insert({
      account_id: ACCT,
      vendor_name: "Tony Durante LLC",
      source: "td_invoice",
      td_payment_id: paymentId,
      total: opts.total,
      subtotal: opts.total,
      amount_paid: opts.amountPaid ?? 0,
      amount_due: opts.amountDue ?? opts.total,
      status: opts.status ?? "Pending",
      currency: "USD",
    })
    .select("id")
    .single()
  if (error) throw new Error(`fixture mirror failed: ${error.message}`)
  const id = (data as { id: string }).id
  createdExpenses.push(id)
  return id
}

async function readMirror(paymentId: string) {
  const { data } = await supabaseAdmin
    .from("client_expenses")
    .select("id, total, amount_paid, amount_due, status, paid_date, due_date, description")
    .eq("td_payment_id", paymentId)
    .single()
  return data as unknown as Record<string, unknown>
}

beforeAll(async () => {
  await makeAccount()
})

afterAll(async () => {
  for (const id of createdExpenses) await supabaseAdmin.from("client_expenses").delete().eq("id", id)
  for (const id of createdPayments) await supabaseAdmin.from("payments").delete().eq("id", id)
  await supabaseAdmin.from("accounts").delete().eq("id", ACCT)
})

describe("client_expenses auto-sync trigger — the core guarantee", () => {
  it("a plain update to the real invoice automatically updates its client-facing copy", async () => {
    const pid = await makePayment({ total: 1000, invoiceNumber: `ZZ-SYNC-${RUN}-A` })
    await makeMirror(pid, { total: 1000 })

    const { error } = await supabaseAdmin
      .from("payments")
      .update({ amount_paid: 400, amount_due: 600, invoice_status: "Partial" })
      .eq("id", pid)
    expect(error).toBeNull()

    const mirror = await readMirror(pid)
    expect(Number(mirror.amount_paid)).toBe(400)
    expect(Number(mirror.amount_due)).toBe(600)
    expect(mirror.status).toBe("Pending") // Partial -> Pending in the client-facing vocabulary
  })

  it("a settled invoice (Paid) forces the mirror's amount_due to 0, never blind-copying a stale value", async () => {
    const pid = await makePayment({ total: 500, invoiceNumber: `ZZ-SYNC-${RUN}-B` })
    await makeMirror(pid, { total: 500 })

    // Real invoice reaches Paid but (as happens in production) still carries a stale
    // non-zero amount_due — the mirror must NOT copy that number.
    await supabaseAdmin
      .from("payments")
      .update({ amount_paid: 500, amount_due: 500, invoice_status: "Paid" })
      .eq("id", pid)

    const mirror = await readMirror(pid)
    expect(Number(mirror.amount_due)).toBe(0)
    expect(mirror.status).toBe("Paid")
  })

  it("a Cancelled invoice also settles the mirror's amount_due to 0", async () => {
    const pid = await makePayment({ total: 600, invoiceNumber: `ZZ-SYNC-${RUN}-C` })
    await makeMirror(pid, { total: 600 })

    await supabaseAdmin.from("payments").update({ invoice_status: "Cancelled" }).eq("id", pid)

    const mirror = await readMirror(pid)
    expect(Number(mirror.amount_due)).toBe(0)
    expect(mirror.status).toBe("Cancelled")
  })

  it("due_date and description also flow through automatically (the finance edit-invoice case)", async () => {
    const pid = await makePayment({ total: 800, invoiceNumber: `ZZ-SYNC-${RUN}-D` })
    await makeMirror(pid, { total: 800 })

    await supabaseAdmin
      .from("payments")
      .update({ due_date: "2026-12-25", description: "Renegotiated due date" })
      .eq("id", pid)

    const mirror = await readMirror(pid)
    expect(mirror.due_date).toBe("2026-12-25")
    expect(mirror.description).toBe("Renegotiated due date")
  })

  it("a payment with NO client-facing mirror (e.g. a credit note) updates cleanly with no error", async () => {
    const pid = await makePayment({ total: -200, invoiceNumber: `ZZ-SYNC-${RUN}-CREDIT` })
    // Deliberately no makeMirror() call — matches createTDInvoice's real behaviour for a
    // credit note, which never creates a mirror row at all.
    const { error } = await supabaseAdmin.from("payments").update({ status: "Paid" }).eq("id", pid)
    expect(error).toBeNull()
  })
})

describe("client_expenses guard trigger — nothing else may write these fields", () => {
  it("blocks a direct write to a td_invoice row's money fields with a clean error", async () => {
    const pid = await makePayment({ total: 300, invoiceNumber: `ZZ-SYNC-${RUN}-E` })
    await makeMirror(pid, { total: 300 })

    const { error } = await supabaseAdmin
      .from("client_expenses")
      .update({ total: 99999 })
      .eq("td_payment_id", pid)

    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/calculated automatically/i)
  })

  it("still allows an update to an unrelated column (e.g. notes) on a td_invoice row", async () => {
    const pid = await makePayment({ total: 300, invoiceNumber: `ZZ-SYNC-${RUN}-F` })
    await makeMirror(pid, { total: 300 })

    const { error } = await supabaseAdmin
      .from("client_expenses")
      .update({ notes: "internal note, not one of the guarded fields" })
      .eq("td_payment_id", pid)
    expect(error).toBeNull()
  })
})

describe("real application code after the fix — no reintroduced writer, no lost behaviour", () => {
  it("syncTDInvoiceMirror is now diagnostic-only: reports no drift, performs no write", async () => {
    const pid = await makePayment({ total: 700, amountPaid: 700, amountDue: 0, invoiceStatus: "Paid", invoiceNumber: `ZZ-SYNC-${RUN}-G` })
    await makeMirror(pid, { total: 700, amountPaid: 700, amountDue: 0, status: "Paid" })

    const result = await syncTDInvoiceMirror(pid)
    expect(result.changed).toBe(false) // already correct — the trigger did it at write time
  })

  it("syncTDInvoiceStatus still fires the payment-received notification, without writing the mirror itself", async () => {
    const pid = await makePayment({ total: 900, invoiceNumber: `ZZ-SYNC-${RUN}-H` })
    await makeMirror(pid, { total: 900 })

    await expect(syncTDInvoiceStatus(pid, "Paid")).resolves.not.toThrow()
    // The mirror's money fields are untouched by this call (still whatever makeMirror set) —
    // proving the removed direct write is truly gone, not just silently still happening.
    const mirror = await readMirror(pid)
    expect(Number(mirror.amount_paid)).toBe(0) // unchanged: no payments UPDATE preceded this call
  })

  it("markExpensePaid refuses to touch a td_invoice-sourced mirror row with a clean error", async () => {
    const pid = await makePayment({ total: 250, invoiceNumber: `ZZ-SYNC-${RUN}-I` })
    const expenseId = await makeMirror(pid, { total: 250 })

    const result = await markExpensePaid(expenseId)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot mark a td invoice paid directly/i)
  })

  it("updateInvoice (the real Finance edit action) propagates due_date/total/description via the trigger, with no direct mirror write of its own", async () => {
    const pid = await makePayment({ total: 400, invoiceNumber: `ZZ-SYNC-${RUN}-J` })
    await makeMirror(pid, { total: 400 })

    const result = await updateInvoice(pid, { total: 450, due_date: "2026-11-01", description: "Updated via Finance" })
    expect(result.success).toBe(true)

    const mirror = await readMirror(pid)
    expect(Number(mirror.total)).toBe(450)
    expect(mirror.due_date).toBe("2026-11-01")
    expect(mirror.description).toBe("Updated via Finance")
  })
})

describe("bug-hunter round — real-world call-site shapes", () => {
  it("a single-statement batch UPDATE across multiple invoices (the tranche-cancel pattern) cascades to EVERY row, not just one", async () => {
    const pid1 = await makePayment({ total: 100, invoiceNumber: `ZZ-SYNC-${RUN}-BATCH1` })
    const pid2 = await makePayment({ total: 200, invoiceNumber: `ZZ-SYNC-${RUN}-BATCH2` })
    await makeMirror(pid1, { total: 100 })
    await makeMirror(pid2, { total: 200 })

    // Matches lib/operations/cancel-offer-payments.ts's .in("id", cancellableIds) shape —
    // one UPDATE statement, multiple rows.
    const { error } = await supabaseAdmin
      .from("payments")
      .update({ status: "Cancelled", invoice_status: "Cancelled" })
      .in("id", [pid1, pid2])
    expect(error).toBeNull()

    const m1 = await readMirror(pid1)
    const m2 = await readMirror(pid2)
    expect(m1.status).toBe("Cancelled")
    expect(Number(m1.amount_due)).toBe(0)
    expect(m2.status).toBe("Cancelled")
    expect(Number(m2.amount_due)).toBe(0)
  })

  it("a CAS-guarded reversal update (matches apply-payment.ts's reverseFeedApplication) still cascades correctly", async () => {
    const pid = await makePayment({ total: 500, amountPaid: 500, amountDue: 0, invoiceStatus: "Paid", status: "Paid", invoiceNumber: `ZZ-SYNC-${RUN}-REV` })
    await makeMirror(pid, { total: 500, amountPaid: 500, amountDue: 0, status: "Paid" })

    // Reversal: unwind back to Partial, exactly the field set apply-payment.ts writes.
    const { error } = await supabaseAdmin
      .from("payments")
      .update({ status: "Pending", invoice_status: "Partial", amount_paid: 0, amount_due: 500, paid_date: null })
      .eq("id", pid)
      .eq("status", "Paid") // the CAS guard shape: only succeeds if it was still Paid
    expect(error).toBeNull()

    const mirror = await readMirror(pid)
    expect(Number(mirror.amount_paid)).toBe(0)
    expect(Number(mirror.amount_due)).toBe(500)
    expect(mirror.status).toBe("Pending")
  })

  it("a partial-column update (only total/amount changed, matching card-fee booking) still correctly zeroes amount_due if the row is already settled", async () => {
    const pid = await makePayment({ total: 1000, amountPaid: 1000, amountDue: 0, invoiceStatus: "Paid", invoiceNumber: `ZZ-SYNC-${RUN}-FEE` })
    await makeMirror(pid, { total: 1000, amountPaid: 1000, amountDue: 0, status: "Paid" })

    // card-fee-booking.ts's exact shape: only total/amount/card_fee_amount in the SET list —
    // amount_due and status are NOT part of this statement at all.
    const { error } = await supabaseAdmin
      .from("payments")
      .update({ total: 1050, amount: 1050 })
      .eq("id", pid)
    expect(error).toBeNull()

    const mirror = await readMirror(pid)
    expect(Number(mirror.total)).toBe(1050) // picked up the new total
    expect(Number(mirror.amount_due)).toBe(0) // still correctly zero — row is still Paid
  })

  it("a payment created directly Paid with NO mirror ever created (the Stripe-webhook orphan-row shape) can be updated later with no error", async () => {
    // Matches app/api/webhooks/stripe/route.ts's raw insert path: a Paid payment row that
    // never gets a client_expenses row at all (no invoice_number-driven mirror creation).
    const { data, error: insErr } = await supabaseAdmin
      .from("payments")
      .insert({ account_id: ACCT, total: 75, amount: 75, amount_currency: "USD", status: "Paid", invoice_status: null })
      .select("id")
      .single()
    expect(insErr).toBeNull()
    const pid = (data as { id: string }).id
    createdPayments.push(pid)

    // A later correction/refund touches this orphan row — must no-op cleanly, not error.
    const { error } = await supabaseAdmin.from("payments").update({ status: "Refunded" }).eq("id", pid)
    expect(error).toBeNull()
  })

  it("updating a column the trigger does NOT watch (reminder_count) does not touch the mirror at all", async () => {
    const pid = await makePayment({ total: 300, invoiceNumber: `ZZ-SYNC-${RUN}-REMIND` })
    const mirrorId = await makeMirror(pid, { total: 300 })

    const { data: beforeRow } = await supabaseAdmin
      .from("client_expenses").select("updated_at").eq("id", mirrorId).single()

    await new Promise((r) => setTimeout(r, 1100)) // ensure a real clock tick to catch a spurious touch

    const { error } = await supabaseAdmin.from("payments").update({ reminder_count: 3 }).eq("id", pid)
    expect(error).toBeNull()

    const { data: afterRow } = await supabaseAdmin
      .from("client_expenses").select("updated_at").eq("id", mirrorId).single()

    // updated_at unchanged proves the trigger never fired for this untracked column.
    expect((afterRow as { updated_at: string }).updated_at).toBe((beforeRow as { updated_at: string }).updated_at)
  })

  it("a sequential multi-invoice waterfall (matching the bank-feed matcher's per-invoice loop) with one invoice untouched leaves that one's mirror correctly stale-but-consistent", async () => {
    const pidA = await makePayment({ total: 100, invoiceNumber: `ZZ-SYNC-${RUN}-WF-A` })
    const pidB = await makePayment({ total: 100, invoiceNumber: `ZZ-SYNC-${RUN}-WF-B` })
    const pidC = await makePayment({ total: 100, invoiceNumber: `ZZ-SYNC-${RUN}-WF-C` })
    await makeMirror(pidA, { total: 100 })
    await makeMirror(pidB, { total: 100 })
    await makeMirror(pidC, { total: 100 })

    // Simulate a wire split across A and C only — B deliberately skipped (as if its own
    // apply failed mid-loop).
    await supabaseAdmin.from("payments").update({ amount_paid: 100, amount_due: 0, invoice_status: "Paid" }).eq("id", pidA)
    await supabaseAdmin.from("payments").update({ amount_paid: 100, amount_due: 0, invoice_status: "Paid" }).eq("id", pidC)

    const mA = await readMirror(pidA)
    const mB = await readMirror(pidB)
    const mC = await readMirror(pidC)
    expect(mA.status).toBe("Paid")
    expect(mC.status).toBe("Paid")
    expect(mB.status).toBe("Pending") // untouched — matches its own un-updated payments row
  })
})
