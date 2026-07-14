/* eslint-disable no-console -- CLI QA harness reports its results via stdout. */
/* eslint-disable no-restricted-syntax -- fixture seeding writes raw rows on purpose: the
   whole point is to construct the BROKEN states production actually contains (a paid
   invoice with a blank invoice_status, two same-priced invoices for one client). Routing
   these through lib/operations would sanitise exactly the conditions under test. */
/**
 * SANDBOX QA — payment reconciliation, end to end against a real database.
 *
 * Reproduces the two production failures of 2026-07-14 as live fixtures and proves the
 * new behaviour. Unit tests cover the pure logic; this exercises the actual matcher,
 * the actual money writer, and the actual guard table.
 *
 * Scenarios:
 *   A. SIMPLE HOLDINGS — one client, TWO $50 invoices, TWO genuine same-day card
 *      payments from a cardholder whose name matches nothing. Expect: both payments
 *      identified as belonging to that client (via billing email), neither silently
 *      dropped, and NEITHER auto-credited to the wrong invoice.
 *   B. FAZEKAS — a €3,000 invoice already marked Paid by hand, plus the real card
 *      payment. Expect: the payment attaches to HIS invoice for the audit trail, with
 *      ZERO money re-applied.
 *   C. WRONG-CLIENT GUARD — a stranger's invoice at a near-identical amount must never
 *      be pinned as the candidate for an identified payer's money.
 *   D. DOUBLE-CREDIT GUARD — applying the same transaction to the same invoice twice
 *      must credit it exactly once.
 *   E. ALREADY-PAID INVOICE — an invoice paid via `status` with a NULL invoice_status
 *      (48 of these exist in production) must NOT be a match target.
 *
 * Run:  npx tsx scripts/qa-payment-reconciliation.ts
 * Safe: refuses to run against production; cleans up every row it creates.
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const PROD_REF = "ydzipybqeebtpcvsbtvs"
if (!SUPABASE_URL || SUPABASE_URL.includes(PROD_REF)) {
  console.error("REFUSING TO RUN: this points at production (or no URL is set).")
  process.exit(1)
}
console.log(`DB: ${SUPABASE_URL}\n`)

const db = createClient(SUPABASE_URL, SERVICE_KEY)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = db as any

// NOTE: the tag must NOT appear inside the fixture email addresses AND the company
// names at the same time — the matcher's name-matching would then find the tag token
// inside the email in the memo and score a false "company name match", which is a
// fixture artefact, not product behaviour. Keep the two vocabularies disjoint.
const TAG = "QARECON"
const created = { accounts: [] as string[], contacts: [] as string[], payments: [] as string[], feeds: [] as string[] }

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function seed() {
  // ── Client 1: Simple Holdings (company), paid by a cardholder with a different name
  const { data: acct } = await db
    .from("accounts")
    .insert({ company_name: `${TAG} Simple Holdings`, account_type: "Client" })
    .select("id")
    .single()
  created.accounts.push(acct!.id)

  const { data: contact } = await db
    .from("contacts")
    .insert({ full_name: `${TAG} Shamim Rajan`, email: `fixture-buyer-one@example.com` })
    .select("id")
    .single()
  created.contacts.push(contact!.id)

  await db.from("account_contacts").insert({ account_id: acct!.id, contact_id: contact!.id })

  // Two REAL invoices, same amount, same client.
  const inv = []
  for (const n of ["A", "B"]) {
    const { data } = await db
      .from("payments")
      .insert({
        account_id: acct!.id,
        invoice_number: `QA-INV-${TAG}-${n}`,
        description: `${TAG} Notary ${n}`,
        total: 50, amount: 50, subtotal: 50, amount_due: 50, amount_paid: 0,
        amount_currency: "USD", status: "Pending", invoice_status: "Sent",
      })
      .select("id")
      .single()
    inv.push(data!.id)
    created.payments.push(data!.id)
  }

  // ── Client 2: a STRANGER with a near-identical amount ($51) — the wrong-client trap.
  const { data: stranger } = await db
    .from("accounts")
    .insert({ company_name: `${TAG} SupraEmerge`, account_type: "Client" })
    .select("id")
    .single()
  created.accounts.push(stranger!.id)

  const { data: strangerInv } = await db
    .from("payments")
    .insert({
      account_id: stranger!.id,
      invoice_number: `QA-INV-${TAG}-STRANGER`,
      description: `${TAG} stranger invoice`,
      total: 51, amount: 51, subtotal: 51, amount_due: 51, amount_paid: 0,
      amount_currency: "USD", status: "Overdue", invoice_status: "Overdue",
    })
    .select("id")
    .single()
  created.payments.push(strangerInv!.id)

  // ── Client 3: Fazekas — invoice ALREADY marked Paid by hand (no stripe id on it).
  const { data: fContact } = await db
    .from("contacts")
    // NOTE the CAPITALS. CRM emails are not reliably lowercase. The first version of the
    // matcher compared them case-sensitively, so the identity engine silently resolved
    // NOBODY — and this harness passed anyway, because the fixture happened to be
    // lowercase. Storing it mixed-case here means the harness would now catch that.
    .insert({ full_name: `${TAG} Tamas Fazekas`, email: `Fixture-Buyer-TWO@Example.com` })
    .select("id")
    .single()
  created.contacts.push(fContact!.id)

  const { data: fInv } = await db
    .from("payments")
    .insert({
      contact_id: fContact!.id,
      invoice_number: `QA-INV-${TAG}-EUR`,
      description: `${TAG} Formation + ITIN`,
      total: 3000, amount: 3000, subtotal: 3000, amount_due: 3000, amount_paid: 3000,
      amount_currency: "EUR", status: "Paid", invoice_status: "Paid",
    })
    .select("id")
    .single()
  created.payments.push(fInv!.id)

  // ── Client 4: the LANDMINE — already paid, but invoice_status is NULL.
  const { data: landmineAcct } = await db
    .from("accounts")
    .insert({ company_name: `${TAG} Landmine Co`, account_type: "Client" })
    .select("id")
    .single()
  created.accounts.push(landmineAcct!.id)

  const { data: landmine } = await db
    .from("payments")
    .insert({
      account_id: landmineAcct!.id,
      invoice_number: `QA-INV-${TAG}-LANDMINE`,
      description: `${TAG} already paid, blank invoice_status`,
      total: 777, amount: 777, subtotal: 777, amount_paid: 777,
      amount_currency: "USD", status: "Paid", invoice_status: null,
    })
    .select("id")
    .single()
  created.payments.push(landmine!.id)

  // ── The feeds ────────────────────────────────────────────────────────────
  const mkFeed = async (row: Record<string, unknown>) => {
    const { data, error } = await db.from("td_bank_feeds").insert(row).select("id").single()
    if (error) throw new Error(`feed insert failed: ${error.message}`)
    created.feeds.push(data!.id)
    return data!.id
  }

  // Two genuine same-day, same-amount card payments from the same cardholder.
  const shEmail = `fixture-buyer-one@example.com`
  const feedSH1 = await mkFeed({
    source: "stripe", external_id: `ch_qa_${TAG}_1`, transaction_date: "2026-07-14",
    amount: 50, currency: "USD", sender_name: "Bilaal Rajan",
    memo: `email: ${shEmail} | visa ••••9765`, status: "unmatched",
    raw_data: { payment_intent: `pi_qa_${TAG}_1`, metadata: {}, billing_details: { email: shEmail, name: "Bilaal Rajan" } },
  })
  const feedSH2 = await mkFeed({
    source: "stripe", external_id: `ch_qa_${TAG}_2`, transaction_date: "2026-07-14",
    amount: 50, currency: "USD", sender_name: "Bilaal Rajan",
    memo: `email: ${shEmail} | visa ••••9765`, status: "unmatched",
    raw_data: { payment_intent: `pi_qa_${TAG}_2`, metadata: {}, billing_details: { email: shEmail, name: "Bilaal Rajan" } },
  })

  // The same, but WITH the invoice number now carried on the payment intent (the fix).
  const feedSHRef = await mkFeed({
    source: "stripe", external_id: `ch_qa_${TAG}_ref`, transaction_date: "2026-07-15",
    amount: 50, currency: "USD", sender_name: "Bilaal Rajan",
    memo: `email: ${shEmail}`, status: "unmatched",
    raw_data: {
      payment_intent: { id: `pi_qa_${TAG}_ref`, metadata: { invoice_number: `QA-INV-${TAG}-B` } },
      metadata: {},
      billing_details: { email: shEmail },
    },
  })

  // Fazekas: name truncated to "Fazek", invoice already paid by hand.
  const fEmail = `fixture-buyer-two@example.com`
  const feedFaz = await mkFeed({
    source: "stripe", external_id: `ch_qa_${TAG}_eur`, transaction_date: "2026-07-14",
    amount: 3000, currency: "EUR", sender_name: "Fazek",
    memo: `email: ${fEmail} | mastercard ••••6367`, status: "unmatched",
    raw_data: { payment_intent: `pi_qa_${TAG}_eur`, metadata: {}, billing_details: { email: fEmail } },
  })

  // A wire for the landmine amount — must NOT be applied to the already-paid invoice.
  const feedLandmine = await mkFeed({
    source: "relay", external_id: `wire_qa_${TAG}_landmine`, transaction_date: "2026-07-14",
    amount: 777, currency: "USD", sender_name: `${TAG} Landmine Co`,
    memo: "wire", status: "unmatched",
    raw_data: {},
  })

  // ── The FISCALOT case: an invoice whose `status` says Cancelled but which is
  // genuinely part-paid and STILL OWES money. Three of these exist in production. A
  // rule that treated `status` as an absolute veto made the outstanding balance
  // impossible to receive — matcher ignored it, staff couldn't select it, and a manual
  // attempt reported success while moving nothing.
  const { data: fiscalotAcct } = await db
    .from("accounts")
    .insert({ company_name: `${TAG} Fiscalot`, account_type: "Client" })
    .select("id")
    .single()
  created.accounts.push(fiscalotAcct!.id)

  const { data: partPaid } = await db
    .from("payments")
    .insert({
      account_id: fiscalotAcct!.id,
      invoice_number: `QA-INV-${TAG}-PARTPAID`,
      description: `${TAG} part-paid, status Cancelled, still owes 500`,
      total: 2200, amount: 2200, subtotal: 2200, amount_paid: 1700, amount_due: 500,
      amount_currency: "USD", status: "Cancelled", invoice_status: "Partial",
    })
    .select("id")
    .single()
  created.payments.push(partPaid!.id)

  const feedPartPaid = await mkFeed({
    source: "relay", external_id: `wire_qa_${TAG}_partpaid`, transaction_date: "2026-07-15",
    amount: 500, currency: "USD", sender_name: `${TAG} Fiscalot`,
    memo: `QA-INV-${TAG}-PARTPAID final balance`, status: "unmatched",
    raw_data: {},
  })

  // A CANCELLED invoice — a manual match onto it must be REJECTED, not silently
  // recorded as a link with no money.
  const { data: cancelled } = await db
    .from("payments")
    .insert({
      account_id: fiscalotAcct!.id,
      invoice_number: `QA-INV-${TAG}-CANCELLED`,
      description: `${TAG} cancelled invoice`,
      total: 900, amount: 900, subtotal: 900, amount_paid: 0, amount_due: 900,
      amount_currency: "USD", status: "Cancelled", invoice_status: "Cancelled",
    })
    .select("id")
    .single()
  created.payments.push(cancelled!.id)

  // An OVERPAYMENT: $650 against a $500 invoice. The invoice must record $500 (capped),
  // and the ledger must record what was actually credited — not the raw wire amount.
  const { data: smallInv } = await db
    .from("payments")
    .insert({
      account_id: fiscalotAcct!.id,
      invoice_number: `QA-INV-${TAG}-OVERPAY`,
      description: `${TAG} 500 invoice paid with 650`,
      total: 500, amount: 500, subtotal: 500, amount_paid: 0, amount_due: 500,
      amount_currency: "USD", status: "Pending", invoice_status: "Sent",
    })
    .select("id")
    .single()
  created.payments.push(smallInv!.id)

  const feedOverpay = await mkFeed({
    source: "relay", external_id: `wire_qa_${TAG}_overpay`, transaction_date: "2026-07-15",
    amount: 650, currency: "USD", sender_name: `${TAG} Fiscalot`,
    memo: "overpayment", status: "unmatched",
    raw_data: {},
  })

  // A payment that NAMES its invoice but pays the WRONG AMOUNT. The old code threw the
  // invoice away on the amount check before it ever looked at the reference — making the
  // whole "carry the invoice number" fix useless the moment the figures didn't line up.
  const { data: refInv } = await db
    .from("payments")
    .insert({
      account_id: fiscalotAcct!.id,
      invoice_number: `QA-INV-${TAG}-REFMISMATCH`,
      description: `${TAG} referenced but underpaid`,
      total: 1000, amount: 1000, subtotal: 1000, amount_paid: 0, amount_due: 1000,
      amount_currency: "USD", status: "Pending", invoice_status: "Sent",
    })
    .select("id")
    .single()
  created.payments.push(refInv!.id)

  const feedRefMismatch = await mkFeed({
    source: "relay", external_id: `wire_qa_${TAG}_refmismatch`, transaction_date: "2026-07-15",
    amount: 400, currency: "USD", sender_name: "Unknown Payer",
    memo: `payment for QA-INV-${TAG}-REFMISMATCH`, status: "unmatched",
    raw_data: {},
  })

  return {
    acct: acct!.id, invA: inv[0], invB: inv[1], strangerInv: strangerInv!.id,
    fInv: fInv!.id, landmine: landmine!.id,
    partPaid: partPaid!.id, cancelled: cancelled!.id, smallInv: smallInv!.id, refInv: refInv!.id,
    feedSH1, feedSH2, feedSHRef, feedFaz, feedLandmine, feedPartPaid, feedOverpay, feedRefMismatch,
  }
}

async function getPayment(id: string) {
  const { data } = await db.from("payments").select("invoice_status, status, amount_paid, amount_due, total").eq("id", id).single()
  return data!
}
async function getFeed(id: string) {
  const { data } = await db.from("td_bank_feeds").select("status, matched_payment_id, match_confidence, review_metadata").eq("id", id).single()
  return data!
}
async function getApplications(feedId: string, paymentId: string): Promise<Array<{ amount: number }>> {
  const { data } = await anyDb
    .from("payment_applications")
    .select("amount")
    .eq("feed_id", feedId)
    .eq("payment_id", paymentId)
  return (data ?? []) as Array<{ amount: number }>
}

async function cleanup() {
  await anyDb.from("payment_applications").delete().in("feed_id", created.feeds)
  await db.from("td_bank_feeds").delete().in("id", created.feeds)
  await db.from("payments").delete().in("id", created.payments)
  await db.from("account_contacts").delete().in("account_id", created.accounts)
  await db.from("contacts").delete().in("id", created.contacts)
  await db.from("accounts").delete().in("id", created.accounts)
}

async function main() {
  const { matchAndReconcile, manualMatch } = await import("../lib/bank-feed-matcher")

  console.log("Seeding sandbox fixtures…")
  const f = await seed()
  console.log("Seeded.\n")

  try {
    // ── A. Simple Holdings: two genuine payments, ambiguous target ──────────
    console.log("A. SIMPLE HOLDINGS — two real $50 payments, two $50 invoices")
    const rSH1 = await matchAndReconcile(f.feedSH1)
    const feedSH1 = await getFeed(f.feedSH1)

    check(
      "payment is NOT auto-credited (two same-priced invoices = genuinely ambiguous)",
      rSH1.matched === false && feedSH1.status === "needs_review",
      `matched=${rSH1.matched} status=${feedSH1.status}`,
    )
    check(
      "the suggested invoice belongs to the PAYER, not a stranger",
      feedSH1.matched_payment_id === f.invA || feedSH1.matched_payment_id === f.invB,
      `candidate=${feedSH1.matched_payment_id} (stranger=${f.strangerInv})`,
    )
    check(
      "the stranger's $51 invoice is never the candidate (C. wrong-client guard)",
      feedSH1.matched_payment_id !== f.strangerInv,
    )

    // ── B. The fix: invoice number carried ON the payment → exact, automatic ──
    console.log("\nB. SAME PAYER, invoice number now carried on the payment")
    const rRef = await matchAndReconcile(f.feedSHRef)
    const feedRef = await getFeed(f.feedSHRef)
    const invB = await getPayment(f.invB)

    check(
      "auto-matched with no human involved",
      rRef.matched === true && feedRef.status === "matched",
      `matched=${rRef.matched} status=${feedRef.status}`,
    )
    check("credited to the RIGHT invoice", feedRef.matched_payment_id === f.invB)
    check(
      "invoice is coherently closed: Paid, nothing owed, amount recorded",
      invB.invoice_status === "Paid" && Number(invB.amount_due) === 0 && Number(invB.amount_paid) === 50,
      `invoice_status=${invB.invoice_status} due=${invB.amount_due} paid=${invB.amount_paid}`,
    )
    check("the payment status column agrees (no half-closed row)", invB.status === "Paid", `status=${invB.status}`)

    // ── D. Double-credit guard ─────────────────────────────────────────────
    console.log("\nD. DOUBLE-CREDIT GUARD — apply the same transaction twice")
    const before = await getPayment(f.invA)
    await manualMatch(f.feedSH1, f.invA)
    const afterFirst = await getPayment(f.invA)
    await manualMatch(f.feedSH1, f.invA) // second click
    const afterSecond = await getPayment(f.invA)

    check(
      "first application credits the invoice",
      Number(afterFirst.amount_paid) === 50 && afterFirst.invoice_status === "Paid",
      `paid=${afterFirst.amount_paid} status=${afterFirst.invoice_status} (was ${before.amount_paid})`,
    )
    check(
      "second application credits NOTHING (money applied exactly once)",
      Number(afterSecond.amount_paid) === 50,
      `paid=${afterSecond.amount_paid} — a double credit would show 100`,
    )

    // ── B2. Fazekas: already paid by hand, no stripe id on the invoice ──────
    console.log("\nE. FAZEKAS — €3,000 invoice already marked Paid by hand")
    const rFaz = await matchAndReconcile(f.feedFaz)
    const feedFaz = await getFeed(f.feedFaz)
    const fInv = await getPayment(f.fInv)

    check(
      "the payment finally attaches to his invoice (it never could before)",
      feedFaz.status === "matched" && feedFaz.matched_payment_id === f.fInv,
      `status=${feedFaz.status} linked=${feedFaz.matched_payment_id}`,
    )
    check(
      "NO money is re-applied — the invoice was already paid",
      Number(fInv.amount_paid) === 3000 && fInv.invoice_status === "Paid",
      `paid=${fInv.amount_paid} (a double credit would show 6000)`,
    )
    check(
      "it is recorded as an audit link, not a fresh settlement",
      rFaz.moneyApplied === false,
      `moneyApplied=${rFaz.moneyApplied} confidence=${feedFaz.match_confidence}`,
    )

    // ── F. The landmine: already paid, blank invoice_status ────────────────
    console.log("\nF. LANDMINE — invoice paid via `status` with a blank invoice_status")
    const rLand = await matchAndReconcile(f.feedLandmine)
    const landmine = await getPayment(f.landmine)

    check(
      "the already-paid invoice is NOT credited a second time",
      Number(landmine.amount_paid) === 777,
      `paid=${landmine.amount_paid} — a double credit would show 1554`,
    )
    check(
      "no money is applied to it (audit link at most, never a settlement)",
      rLand.moneyApplied === false,
      `matched=${rLand.matched} moneyApplied=${rLand.moneyApplied}`,
    )
    check(
      "its invoice_status is left alone (still blank — we did not invent one)",
      landmine.invoice_status === null,
      `invoice_status=${landmine.invoice_status}`,
    )

    // ── G. The FISCALOT case — the receivable my first rule made unpayable ──
    console.log("\nG. PART-PAID invoice whose status says Cancelled — still owes $500")
    const rPart = await manualMatch(f.feedPartPaid, f.partPaid)
    const partPaid = await getPayment(f.partPaid)

    check(
      "the outstanding $500 CAN still be received",
      rPart.matched === true && rPart.moneyApplied === true,
      `matched=${rPart.matched} moneyApplied=${rPart.moneyApplied} — treating the payment status as an absolute veto would make this money impossible to book`,
    )
    check(
      "the invoice closes properly: fully paid, nothing owed",
      Number(partPaid.amount_paid) === 2200 && Number(partPaid.amount_due) === 0 && partPaid.invoice_status === "Paid",
      `paid=${partPaid.amount_paid} due=${partPaid.amount_due} status=${partPaid.invoice_status}`,
    )

    // ── H. A cancelled invoice must REJECT money, loudly ────────────────────
    console.log("\nH. CANCELLED invoice — a manual match must be refused, not faked")
    const rCancel = await manualMatch(f.feedOverpay, f.cancelled)
    const cancelledInv = await getPayment(f.cancelled)

    check(
      "the match is REFUSED with a real reason (not a green tick and no money)",
      rCancel.matched === false && !!rCancel.error,
      `matched=${rCancel.matched} error=${rCancel.error ?? "(none)"}`,
    )
    check(
      "nothing was credited to the cancelled invoice",
      Number(cancelledInv.amount_paid) === 0,
      `paid=${cancelledInv.amount_paid}`,
    )

    // ── J. Overpayment: cap the invoice, and record what was really credited ──
    console.log("\nJ. OVERPAYMENT — $650 wire against a $500 invoice")
    const rOver = await manualMatch(f.feedOverpay, f.smallInv)
    const smallInv = await getPayment(f.smallInv)
    const ledger = await getApplications(f.feedOverpay, f.smallInv)

    check(
      "the invoice records $500 — never more than it is worth",
      Number(smallInv.amount_paid) === 500 && Number(smallInv.amount_due) === 0,
      `paid=${smallInv.amount_paid} due=${smallInv.amount_due}`,
    )
    check(
      "the ledger records the $500 actually credited, not the $650 that arrived",
      ledger.length === 1 && Number(ledger[0].amount) === 500,
      `ledger=${JSON.stringify(ledger.map(l => l.amount))} — recording 650 would make the ledger disagree with the invoice`,
    )
    check(
      "matched=true and money was applied",
      rOver.matched === true && rOver.moneyApplied === true,
      `matched=${rOver.matched} moneyApplied=${rOver.moneyApplied}`,
    )

    // ── K. The invoice number must beat the amount ──────────────────────────
    console.log("\nK. Payment NAMES its invoice but pays the wrong amount")
    const rRefMis = await matchAndReconcile(f.feedRefMismatch)
    const feedRefMis = await getFeed(f.feedRefMismatch)
    const refInv = await getPayment(f.refInv)

    check(
      "the referenced invoice is NOT thrown away just because the figures differ",
      feedRefMis.matched_payment_id === f.refInv,
      `candidate=${feedRefMis.matched_payment_id} — the old code discarded it on the amount check before ever reading the reference`,
    )
    check(
      "but it is NOT auto-settled — how much to apply is a human's call",
      rRefMis.matched === false && feedRefMis.status === "needs_review",
      `matched=${rRefMis.matched} status=${feedRefMis.status}`,
    )
    check(
      "no money moved without a human",
      Number(refInv.amount_paid) === 0,
      `paid=${refInv.amount_paid}`,
    )
  } finally {
    console.log("\nCleaning up fixtures…")
    await cleanup()
    console.log("Cleaned.\n")
  }

  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error("QA RUN CRASHED:", err)
  await cleanup()
  process.exit(1)
})
