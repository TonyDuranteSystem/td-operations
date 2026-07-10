/**
 * LIVE end-to-end QA for cancel ↔ reactivate, against the SANDBOX database.
 *
 * Drives the REAL server actions (`voidInvoice`, `voidInvoicePreview`,
 * `reactivateInvoice`, `reactivateInvoicePreview`) and the REAL invoice
 * creator (`createTDInvoice`), so every write — payments, the client_expenses
 * mirror, action_log, td_bank_feeds — actually lands and is asserted.
 *
 * Not part of `test:unit` / CI (needs the network + sandbox creds). Run:
 *   npx vitest run --config vitest.esign-live.config.ts tests/live/invoice-reactivate.live.test.ts
 *
 * Mocks are limited to the two Next.js request-scoped boundaries that cannot
 * exist outside a request. `createClient()` (used by safeAction for the audit
 * row) is pointed at the service-role client so audit rows REALLY land — the
 * reactivate path reads them back to find its snapshot.
 */
/* eslint-disable no-restricted-syntax -- live QA harness: it must set up and
   tear down raw fixture rows; it never runs in CI or against production. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

// vi.mock factories are hoisted above the imports, so the service-role client
// is handed over via globalThis once the real module has loaded (below).
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => (globalThis as unknown as { __qaAdmin: { from: (t: string) => unknown } }).__qaAdmin.from(table),
    auth: { getUser: async () => ({ data: { user: { email: "qa-live@tonydurante.us" } } }) },
  }),
}))

import { supabaseAdmin } from "@/lib/supabase-admin"
;(globalThis as unknown as { __qaAdmin: unknown }).__qaAdmin = supabaseAdmin
import { createTDInvoice } from "@/lib/portal/td-invoice"
import {
  voidInvoice,
  reactivateInvoice,
  reactivateInvoicePreview,
} from "@/app/(dashboard)/finance/actions"

/** QA fixture account — never a mirror of a real client. */
const QA_ACCOUNT = "22222222-2222-4222-8222-222222222201" // QA One LLC

const created: string[] = []
const createdFeeds: string[] = []

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split("T")[0]
}

async function makeInvoice(opts: {
  total: number
  due_date?: string
  mark_as_paid?: boolean
}): Promise<string> {
  const res = await createTDInvoice({
    account_id: QA_ACCOUNT,
    line_items: [{ description: "QA live reactivate", quantity: 1, unit_price: opts.total }],
    currency: "USD",
    due_date: opts.due_date,
    mark_as_paid: opts.mark_as_paid ?? false,
    skip_credit_netting: true, // never let an account credit mutate the fixture
  })
  created.push(res.paymentId)
  return res.paymentId
}

async function readPayment(id: string) {
  const { data } = await supabaseAdmin
    .from("payments")
    .select("invoice_number, status, invoice_status, total, amount_due, amount_paid, paid_date, sent_at, reminder_count")
    .eq("id", id)
    .single()
  return data as unknown as Record<string, unknown>
}

async function readMirror(id: string) {
  const { data } = await supabaseAdmin
    .from("client_expenses")
    .select("status, total, amount_due, amount_paid")
    .eq("td_payment_id", id)
    .maybeSingle()
  return data as unknown as Record<string, unknown> | null
}

async function setPayment(id: string, patch: Record<string, unknown>) {
  await supabaseAdmin.from("payments").update(patch).eq("id", id)
}

/** safeAction writes action_log fire-and-forget; give it a moment to land. */
async function settleAudit() {
  await new Promise((r) => setTimeout(r, 700))
}

async function makeFeed(paymentId: string, status: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("td_bank_feeds")
    .insert({
      source: "qa_live",
      external_id: `qa-live-${status}-${paymentId.slice(0, 8)}-${created.length}-${createdFeeds.length}`,
      transaction_date: isoDaysFromNow(-5),
      amount: 100,
      currency: "USD",
      status,
      matched_payment_id: paymentId,
      match_confidence: "medium",
    })
    .select("id")
    .single()
  const id = (data as { id: string }).id
  createdFeeds.push(id)
  return id
}

async function readFeed(id: string) {
  const { data } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("status, matched_payment_id, match_confidence")
    .eq("id", id)
    .single()
  return data as unknown as Record<string, unknown>
}

beforeAll(() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) {
    throw new Error(`REFUSING TO RUN: not the sandbox database (${url})`)
  }
})

afterAll(async () => {
  if (createdFeeds.length) await supabaseAdmin.from("td_bank_feeds").delete().in("id", createdFeeds)
  if (created.length) {
    await supabaseAdmin.from("client_expenses").delete().in("td_payment_id", created)
    await supabaseAdmin.from("payment_items").delete().in("payment_id", created)
    await supabaseAdmin.from("action_log").delete().in("record_id", created)
    await supabaseAdmin.from("payments").delete().in("id", created)
  }
}, 60_000)

describe("cancel → reactivate, round trip (recorded snapshot)", () => {
  it("restores a Sent invoice EXACTLY as it was, and re-syncs the client's copy", async () => {
    const id = await makeInvoice({ total: 500, due_date: isoDaysFromNow(30) })
    await setPayment(id, { invoice_status: "Sent", status: "Pending", sent_at: new Date().toISOString() })

    const before = await readPayment(id)

    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()

    expect(await readPayment(id)).toMatchObject({ status: "Cancelled", invoice_status: "Cancelled" })
    expect(await readMirror(id)).toMatchObject({ status: "Cancelled", amount_due: 0 })

    const preview = await reactivateInvoicePreview(id)
    expect(preview.success).toBe(true)
    expect(preview.preview?.blocker).toBeUndefined()
    expect(preview.preview?.items[0].details?.join(" ")).toContain("exactly as it was")

    const res = await reactivateInvoice(id)
    expect(res.success).toBe(true)
    expect(res.data?.source).toBe("recorded")

    const after = await readPayment(id)
    expect(after.status).toBe(before.status)
    expect(after.invoice_status).toBe("Sent")
    expect(Number(after.amount_due)).toBe(Number(before.amount_due))
    expect(Number(after.amount_paid)).toBe(Number(before.amount_paid))

    // Mirror follows: a live Sent invoice reads as Pending to the client.
    expect(await readMirror(id)).toMatchObject({ status: "Pending", amount_due: 500 })
  }, 60_000)

  it("restores a PAID invoice with its paid_date intact", async () => {
    const id = await makeInvoice({ total: 250, mark_as_paid: true })
    const before = await readPayment(id)
    expect(before.invoice_status).toBe("Paid")

    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()
    const res = await reactivateInvoice(id)
    expect(res.success).toBe(true)

    const after = await readPayment(id)
    expect(after.invoice_status).toBe("Paid")
    expect(Number(after.amount_paid)).toBe(250)
    expect(after.paid_date).toBe(before.paid_date)
    expect(await readMirror(id)).toMatchObject({ status: "Paid", amount_due: 0 })
  }, 60_000)
})

describe("reactivate with NO snapshot (invoices cancelled before this shipped)", () => {
  /** Cancel by hand, exactly as the old code did — no audit snapshot. */
  async function cancelWithoutSnapshot(id: string) {
    await setPayment(id, { status: "Cancelled", invoice_status: "Cancelled" })
    await supabaseAdmin.from("action_log").delete().eq("record_id", id)
  }

  it("derives Overdue for a past-due unpaid invoice that was never emailed", async () => {
    const id = await makeInvoice({ total: 600, due_date: isoDaysFromNow(-39) })
    await cancelWithoutSnapshot(id)

    const preview = await reactivateInvoicePreview(id)
    expect(preview.preview?.items[0].label).toContain("Overdue")
    expect(preview.preview?.items[0].details?.join(" ")).toContain("reconstructed")
    expect(preview.preview?.warnings?.join(" ")).toContain("never emailed")

    const res = await reactivateInvoice(id)
    expect(res.success).toBe(true)
    expect(res.data?.source).toBe("derived")
    expect(await readPayment(id)).toMatchObject({ status: "Overdue", invoice_status: "Overdue" })
    expect(await readMirror(id)).toMatchObject({ status: "Overdue", amount_due: 600 })
  }, 60_000)

  it("derives Draft for a never-emailed invoice not yet due", async () => {
    const id = await makeInvoice({ total: 120, due_date: isoDaysFromNow(30) })
    await cancelWithoutSnapshot(id)
    expect((await reactivateInvoice(id)).success).toBe(true)
    expect(await readPayment(id)).toMatchObject({ status: "Pending", invoice_status: "Draft" })
  }, 60_000)

  it("derives Partial and recomputes the balance from real cash", async () => {
    const id = await makeInvoice({ total: 600, due_date: isoDaysFromNow(30) })
    await setPayment(id, { amount_paid: 200, amount_due: 400, sent_at: new Date().toISOString() })
    await cancelWithoutSnapshot(id)

    expect((await reactivateInvoice(id)).success).toBe(true)
    const after = await readPayment(id)
    expect(after.invoice_status).toBe("Partial")
    expect(Number(after.amount_due)).toBe(400)
    expect(Number(after.amount_paid)).toBe(200)
  }, 60_000)

  it("derives Paid when cash already covers the total, and never leaves a negative balance", async () => {
    const id = await makeInvoice({ total: 300, due_date: isoDaysFromNow(-10) })
    await setPayment(id, { amount_paid: 350, amount_due: 300 })
    await cancelWithoutSnapshot(id)

    expect((await reactivateInvoice(id)).success).toBe(true)
    const after = await readPayment(id)
    expect(after.invoice_status).toBe("Paid")
    expect(Number(after.amount_due)).toBe(0)
  }, 60_000)
})

describe("the reminder-burst warning", () => {
  it("warns that a long-overdue invoice will fire two chase emails", async () => {
    const prev = await supabaseAdmin.from("app_settings").select("value").eq("key", "dunning_autosend").single()
    await supabaseAdmin.from("app_settings").update({ value: { enabled: true, cap: 40 } }).eq("key", "dunning_autosend")
    await supabaseAdmin.from("accounts").update({ dunning_pause: false, dunning_pause_until: null }).eq("id", QA_ACCOUNT)

    const id = await makeInvoice({ total: 600, due_date: isoDaysFromNow(-39) })
    await setPayment(id, { status: "Cancelled", invoice_status: "Cancelled", reminder_count: 0 })
    await supabaseAdmin.from("action_log").delete().eq("record_id", id)

    const preview = await reactivateInvoicePreview(id)
    expect(preview.preview?.affected.reminder_emails).toBe(2)
    expect(preview.preview?.warnings?.join(" ")).toContain("2 \"Payment Overdue\" email")

    // ...and stays silent once the client's reminders are paused.
    await supabaseAdmin.from("accounts").update({ dunning_pause: true }).eq("id", QA_ACCOUNT)
    const paused = await reactivateInvoicePreview(id)
    expect(paused.preview?.affected.reminder_emails).toBe(0)

    await supabaseAdmin.from("accounts").update({ dunning_pause: false }).eq("id", QA_ACCOUNT)
    await supabaseAdmin.from("app_settings").update({ value: (prev.data as { value: { enabled: boolean; cap: number } }).value }).eq("key", "dunning_autosend")
  }, 60_000)
})

describe("bank feeds", () => {
  it("cancelling resets ONLY confirmed matches; ignored and outgoing keep their status", async () => {
    const id = await makeInvoice({ total: 400, due_date: isoDaysFromNow(10) })
    const matched = await makeFeed(id, "matched")
    const ignored = await makeFeed(id, "ignored")
    const outgoing = await makeFeed(id, "outgoing")

    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()

    expect(await readFeed(matched)).toMatchObject({ status: "unmatched", matched_payment_id: null, match_confidence: null })
    expect(await readFeed(ignored)).toMatchObject({ status: "ignored", matched_payment_id: null, match_confidence: null })
    expect(await readFeed(outgoing)).toMatchObject({ status: "outgoing", matched_payment_id: null, match_confidence: null })
  }, 60_000)

  it("reactivating does NOT relink any bank feed, and says so", async () => {
    const id = await makeInvoice({ total: 400, due_date: isoDaysFromNow(10) })
    const matched = await makeFeed(id, "matched")

    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()

    const preview = await reactivateInvoicePreview(id)
    expect(preview.preview?.warnings?.join(" ")).toContain("NOT relinked")

    expect((await reactivateInvoice(id)).success).toBe(true)
    expect(await readFeed(matched)).toMatchObject({ matched_payment_id: null })
  }, 60_000)
})

describe("guards", () => {
  it("refuses to reactivate an invoice that is not cancelled", async () => {
    const id = await makeInvoice({ total: 100, due_date: isoDaysFromNow(10) })
    const res = await reactivateInvoice(id)
    expect(res.success).toBe(false)
    expect(res.error).toContain("Only a cancelled invoice")

    const preview = await reactivateInvoicePreview(id)
    expect(preview.preview?.blocker).toContain("not cancelled")
  }, 60_000)

  it("refuses to cancel an already-cancelled invoice", async () => {
    const id = await makeInvoice({ total: 100, due_date: isoDaysFromNow(10) })
    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()
    const second = await voidInvoice(id)
    expect(second.success).toBe(false)
    expect(second.error).toContain("already cancelled")
  }, 60_000)

  it("a double-click cannot reactivate twice (the second call loses the race)", async () => {
    const id = await makeInvoice({ total: 100, due_date: isoDaysFromNow(10) })
    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()

    const [a, b] = await Promise.all([reactivateInvoice(id), reactivateInvoice(id)])
    const wins = [a, b].filter((r) => r.success).length
    expect(wins).toBe(1)
  }, 60_000)

  it("refuses to reactivate a Split parent", async () => {
    const id = await makeInvoice({ total: 100, due_date: isoDaysFromNow(10) })
    await setPayment(id, { status: "Cancelled", invoice_status: "Split" })
    const res = await reactivateInvoice(id)
    expect(res.success).toBe(false)
    expect(res.error?.toLowerCase()).toContain("split parent")
  }, 60_000)

  it("refuses to reactivate a missing invoice", async () => {
    const res = await reactivateInvoice("00000000-0000-4000-8000-000000000000")
    expect(res.success).toBe(false)
    expect(res.error).toContain("not found")
  }, 60_000)
})

describe("edge cases", () => {
  it("an immediate cancel→reactivate still finds its snapshot (the audit row is written fire-and-forget)", async () => {
    const id = await makeInvoice({ total: 700, due_date: isoDaysFromNow(-30) })
    await setPayment(id, { invoice_status: "Draft", status: "Pending", sent_at: null })

    expect((await voidInvoice(id)).success).toBe(true)
    // NO settleAudit() — simulate an operator clicking Reactivate straight away.
    const res = await reactivateInvoice(id)
    expect(res.success).toBe(true)

    // If the snapshot lost the race, this comes back Overdue (derived from the
    // past due date) instead of the Draft it actually was.
    expect(res.data?.source).toBe("recorded")
    expect(await readPayment(id)).toMatchObject({ invoice_status: "Draft" })
  }, 60_000)

  it("an invoice with no account (contact-only) reactivates without a reminder projection", async () => {
    const { data: contact } = await supabaseAdmin.from("contacts").select("id").limit(1).single()
    const res = await createTDInvoice({
      contact_id: (contact as { id: string }).id,
      line_items: [{ description: "QA contact-only", quantity: 1, unit_price: 90 }],
      currency: "USD",
      due_date: isoDaysFromNow(-20),
      skip_credit_netting: true,
    })
    created.push(res.paymentId)

    expect((await voidInvoice(res.paymentId)).success).toBe(true)
    await settleAudit()

    const preview = await reactivateInvoicePreview(res.paymentId)
    expect(preview.success).toBe(true)
    expect(preview.preview?.affected.reminder_emails).toBe(0)
    expect((await reactivateInvoice(res.paymentId)).success).toBe(true)
  }, 60_000)

  it("an invoice that already used up its 2 reminders warns of no further emails", async () => {
    const prev = await supabaseAdmin.from("app_settings").select("value").eq("key", "dunning_autosend").single()
    await supabaseAdmin.from("app_settings").update({ value: { enabled: true, cap: 40 } }).eq("key", "dunning_autosend")
    await supabaseAdmin.from("accounts").update({ dunning_pause: false }).eq("id", QA_ACCOUNT)

    const id = await makeInvoice({ total: 600, due_date: isoDaysFromNow(-39) })
    await setPayment(id, { status: "Cancelled", invoice_status: "Cancelled", reminder_count: 2 })
    await supabaseAdmin.from("action_log").delete().eq("record_id", id)

    const preview = await reactivateInvoicePreview(id)
    expect(preview.preview?.affected.reminder_emails).toBe(0)

    await supabaseAdmin.from("app_settings").update({ value: (prev.data as { value: { enabled: boolean; cap: number } }).value }).eq("key", "dunning_autosend")
  }, 60_000)

  it("cancel → reactivate → cancel again snapshots the NEW state, not the old one", async () => {
    const id = await makeInvoice({ total: 300, due_date: isoDaysFromNow(20) })
    await setPayment(id, { invoice_status: "Sent", status: "Pending", sent_at: new Date().toISOString() })

    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()
    expect((await reactivateInvoice(id)).success).toBe(true)
    expect(await readPayment(id)).toMatchObject({ invoice_status: "Sent" })

    // Now it is Partial. Cancel again, reactivate — must come back Partial.
    await setPayment(id, { invoice_status: "Partial", amount_paid: 100, amount_due: 200 })
    expect((await voidInvoice(id)).success).toBe(true)
    await settleAudit()
    const res = await reactivateInvoice(id)
    expect(res.success).toBe(true)
    expect(res.data?.source).toBe("recorded")

    const after = await readPayment(id)
    expect(after.invoice_status).toBe("Partial")
    expect(Number(after.amount_paid)).toBe(100)
    expect(Number(after.amount_due)).toBe(200)
  }, 60_000)
})

describe("credit notes", () => {
  it("does not silently turn a cancelled credit note into an ordinary Draft invoice", async () => {
    const id = await makeInvoice({ total: 100, due_date: isoDaysFromNow(10) })
    // Shape it like a credit note: negative total, Credit status, CN- number.
    await setPayment(id, {
      total: -200, amount: -200, subtotal: -200, amount_paid: -200, amount_due: 0,
      status: "Cancelled", invoice_status: "Cancelled", credit_remaining: 0,
    })
    await supabaseAdmin.from("action_log").delete().eq("record_id", id)

    const res = await reactivateInvoice(id)
    // Either it is blocked, or it comes back AS A CREDIT — never as a Draft
    // invoice claiming the client owes -$200.
    if (res.success) {
      const after = await readPayment(id)
      expect(after.invoice_status).toBe("Credit")
    } else {
      expect(res.error?.toLowerCase()).toContain("credit")
    }
  }, 60_000)
})
