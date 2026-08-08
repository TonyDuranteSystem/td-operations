/**
 * SANDBOX QA SEEDER for WS-A (dev job c0a61e44).
 *
 * Not a test — a fixture builder. It runs the REAL paid-call code against the
 * sandbox so Antonio has something to click through, because nothing in sandbox
 * has ever paid for a call (the QA harness deletes everything it creates, and
 * the only two real payers are on production).
 *
 * It deliberately LEAVES the rows behind. Everything is tagged QASEED, which the
 * money-path harness's QAMTX sweep never touches.
 *
 * Names are obviously fake on purpose: seeding QA state onto anything shaped like
 * a real client is how a test once corrupted a live account.
 *
 *   npx vitest run --config vitest.ws-a-seed.config.ts
 */
/* eslint-disable no-restricted-syntax -- sandbox fixture builder; see the money-path harness for the same rationale */

import { describe, it, expect } from "vitest"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { recordPaidCall } from "@/lib/operations/paid-call-credit"

const db: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const MATCH_EMAIL = "qaseed.paidcall@tdsandbox.test"
const MISMATCH_BOOKING_EMAIL = "qaseed.personal@tdsandbox.test"
const MISMATCH_LEAD_EMAIL = "qaseed.business@tdsandbox.test"

async function wipePrevious() {
  const { data: cs } = await db.from("contacts").select("id").like("full_name", "QASEED%")
  const ids = ((cs ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length) {
    const { data: ps } = await db.from("payments").select("id").in("contact_id", ids)
    const pids = ((ps ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (pids.length) {
      const { data: es } = await db.from("client_expenses").select("id").in("td_payment_id", pids)
      const eids = ((es ?? []) as Array<{ id: string }>).map((r) => r.id)
      if (eids.length) {
        await db.from("client_expense_items").delete().in("expense_id", eids)
        await db.from("client_expenses").delete().in("id", eids)
      }
      await db.from("payment_items").delete().in("payment_id", pids)
      await db.from("payments").delete().in("id", pids)
    }
    await db.from("offers").delete().in("contact_id", ids)
    await db.from("action_log").delete().in("contact_id", ids)
    await db.from("contacts").delete().in("id", ids)
  }
  await db.from("leads").delete().like("full_name", "QASEED%")
}

describe("seed the sandbox so the paid-call credit can be clicked through", () => {
  it("builds both lead scenarios and reports where to go", async () => {
    await wipePrevious()

    // ── SCENARIO 1 — the happy path. Italian, the shape of a real paid call.
    const paid = await recordPaidCall({
      payment: { chargeId: `ch_qaseed_${Date.now()}`, amount: 257, currency: "EUR", provider: "stripe", successful: true },
      inviteeEmail: MATCH_EMAIL,
      inviteeName: "QASEED Cliente Pagante",
      callDate: "2026-08-06",
    })
    const { data: lead1, error: l1 } = await db.from("leads").insert({
      full_name: "QASEED Cliente Pagante",
      email: MATCH_EMAIL,
      status: "Call Done",
      language: "Italian",
      source: "QA seed — WS-A paid-call credit",
    }).select("id").single()
    expect(l1).toBeNull()

    // ── SCENARIO 2 — booked with a personal address, offer written to the
    // business one. The case that used to be completely silent.
    const paid2 = await recordPaidCall({
      payment: { chargeId: `ch_qaseed_mismatch_${Date.now()}`, amount: 257, currency: "EUR", provider: "stripe", successful: true },
      inviteeEmail: MISMATCH_BOOKING_EMAIL,
      inviteeName: "QASEED Email Diversa",
      callDate: "2026-08-06",
    })
    const { data: lead2, error: l2 } = await db.from("leads").insert({
      full_name: "QASEED Email Diversa",
      email: MISMATCH_LEAD_EMAIL,      // different address on purpose
      status: "Call Done",
      language: "Italian",
      source: "QA seed — WS-A email-mismatch warning",
    }).select("id").single()
    expect(l2).toBeNull()

    // prove the credits really exist and are spendable
    const { data: credits } = await db.from("payments")
      .select("invoice_number, credit_remaining, amount_currency, invoice_status")
      .in("id", [paid.creditId!, paid2.creditId!])
    const rows = (credits ?? []) as Array<Record<string, unknown>>
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.invoice_status === "Credit" && Number(r.credit_remaining) === 257)).toBe(true)

    console.warn(`
╔══════════════════════════════════════════════════════════════════╗
  SANDBOX QA FIXTURES READY

  1) CREDIT SHOWS — lead "QASEED Cliente Pagante"
     lead id: ${(lead1 as { id: string }).id}
     holds EUR257 unspent. Create an offer from this lead's page:
     the credit should appear WITHOUT you doing anything.

  2) WARNING FIRES — lead "QASEED Email Diversa"
     lead id: ${(lead2 as { id: string }).id}
     booked the call under a DIFFERENT address, so no credit can
     attach. Creating an offer should show NO credit line but WARN
     you that they may be owed one.
╚══════════════════════════════════════════════════════════════════╝`)
  })
})
