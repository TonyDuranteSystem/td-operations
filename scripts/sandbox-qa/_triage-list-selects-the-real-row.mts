/**
 * CELL 0 — does the triage list actually SELECT the row it exists for?
 *
 * Dev jobs `ae8b8bb1` / `c0a61e44`. Every other cell in the gate tests what happens once a row
 * is on the screen. None of them test whether it gets there — which is exactly how the WS-A
 * offer-credit display shipped perfect and dead, because the query feeding it was gated on a
 * contact that offers created from leads never have. The feature was fine; the path in wasn't.
 *
 * So this fixtures Domenico's ACTUAL production row into sandbox with its exact field values —
 * id, source, status, amount, currency, payer name, the memo carrying only a name and a
 * per-transaction reference, null matched_payment_id, null review_metadata, null matched_by,
 * and the real Airwallex raw payload — and proves the list picks it up.
 *
 * Then the inverse, which matters just as much: a genuine owner-money row (a Stripe payout, a
 * Relay partner payout) must NOT appear. A triage screen that surfaces TD's own money is worse
 * than one that surfaces nothing.
 *
 * Nothing is normalised to make it work. If a field had to be filled in, the fixture would be
 * lying and the cell would be worthless.
 */
import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error("REFUSING: this script writes rows and must only ever run against sandbox.")
  process.exit(1)
}

const { supabaseAdmin } = await import("@/lib/supabase-admin")
const { listMisroutedClientPaymentCandidates } = await import("@/lib/finance/owner-ledger-projection")

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables not all in generated types
const db = supabaseAdmin as any
const TD_ENTITY = "00000000-0000-0000-0000-000000000001"

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

/** Domenico's row, copied field-for-field from production. */
const DOMENICO_FEED = {
  id: "ecee2924-34fb-4059-b411-1c4b2f1538cb",
  source: "airwallex_api",
  status: "owner_ledger",
  amount: 1250,
  currency: "EUR",
  sender_name: "Domenico Pio Cristiano",
  memo: "Domenico Pio Cristiano — 010F345262220F28_1",
  sender_reference: "010F345262220F28_1",
  matched_payment_id: null,
  match_confidence: null,
  matched_by: null,
  review_metadata: null,
  transaction_date: "2026-08-07",
  external_id: "airwallex_a8b7d587-63f1-4a90-8b21-e469ca48dff3",
  raw_data: {
    type: "BANK_TRANSFER",
    amount: 1250,
    source: { type: "GA", global_account_id: "94361dc2-78e3-4d3f-945f-f15021d6a4d0" },
    status: "SETTLED",
    currency: "EUR",
    created_at: "2026-08-07T20:50:00+0000",
    deposit_id: "a8b7d587-63f1-4a90-8b21-e469ca48dff3",
    payer_name: "Domenico Pio Cristiano",
    settled_at: "2026-08-07T20:50:13+0000",
    statement_ref: "010F345262220F28_1",
  },
}

/** TD's OWN money — the inverse cases. Real descriptors from the production book. */
const STRIPE_PAYOUT = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "relay",
  status: "owner_ledger",
  amount: 1019.25,
  currency: "USD",
  sender_name: "STRIPE - TRANSFER",
  memo: "STRIPE - TRANSFER",
  transaction_date: "2026-07-24",
  external_id: "qa-cell0-stripe-payout",
  raw_data: {},
}
const RELAY_PAYOUT = {
  id: "22222222-2222-4222-8222-222222222222",
  source: "relay",
  status: "owner_ledger",
  amount: 1220.39,
  currency: "USD",
  sender_name: "Relay Financial US Corp - May 2026 Partner Payout Program",
  memo: "Relay Financial US Corp - May 2026 Partner Payout Program",
  transaction_date: "2026-06-15",
  external_id: "qa-cell0-relay-payout",
  raw_data: {},
}

const FEED_IDS = [DOMENICO_FEED.id, STRIPE_PAYOUT.id, RELAY_PAYOUT.id]
let contactId: string | null = null
let paymentId: string | null = null

const cleanup = async () => {
  await db.from("td_books_transactions").delete().in("transaction_ref", FEED_IDS.map((i) => `feed:${i}`))
  await db.from("td_bank_feeds").delete().in("id", FEED_IDS)
  if (paymentId) await db.from("payments").delete().eq("id", paymentId)
  if (contactId) await db.from("contacts").delete().eq("id", contactId)
}

await cleanup() // idempotent re-run

try {
  // ── The surrounding state that exists in production too ───────────────────
  // His contact and his open EUR2,500 invoice are REAL in production. Reproducing them is
  // reproducing the environment, not tidying the fixture — and their absence would make this
  // prove nothing about the live path.
  const { data: contact, error: cErr } = await db
    .from("contacts")
    .insert({ full_name: "Domenico Cristiano", email: `cell0-domenico-${Date.now()}@example.invalid`, status: "active" })
    .select("id").single()
  if (cErr) throw new Error(`contact fixture failed: ${cErr.message}`)
  contactId = contact.id

  const { data: pay, error: pErr } = await db
    .from("payments")
    .insert({
      contact_id: contactId,
      description: "Company Formation — cell 0 fixture",
      total: 2500, amount: 2500, amount_paid: 0, amount_currency: "EUR",
      status: "Pending", invoice_status: "Sent", is_test: false,
    })
    .select("id").single()
  if (pErr) throw new Error(`invoice fixture failed: ${pErr.message}`)
  paymentId = pay.id

  // ── The three feed rows, with their books copies (direction of record) ─────
  for (const feed of [DOMENICO_FEED, STRIPE_PAYOUT, RELAY_PAYOUT]) {
    const { error } = await db.from("td_bank_feeds").insert(feed)
    if (error) throw new Error(`feed fixture ${feed.id} failed: ${error.message}`)
    const { error: bErr } = await db.from("td_books_transactions").insert({
      entity_id: TD_ENTITY,
      tax_year: Number(feed.transaction_date.slice(0, 4)),
      transaction_date: feed.transaction_date,
      description: feed.memo,
      counterparty: feed.sender_name,
      amount: feed.amount, // POSITIVE — money in
      currency: feed.currency,
      bank_name: feed.source === "airwallex_api" ? "Airwallex" : "Relay",
      transaction_ref: `feed:${feed.id}`,
      category: "uncategorized",
    })
    if (bErr) throw new Error(`books copy for ${feed.id} failed: ${bErr.message}`)
  }

  // Confirm the fixture really is field-for-field, not a tidied approximation.
  const { data: back } = await db
    .from("td_bank_feeds")
    .select("source, status, amount, currency, sender_name, memo, sender_reference, matched_payment_id, match_confidence, matched_by, review_metadata")
    .eq("id", DOMENICO_FEED.id).single()
  check(
    "fixture is field-for-field identical to production",
    back.source === "airwallex_api" && back.status === "owner_ledger" && Number(back.amount) === 1250 &&
      back.currency === "EUR" && back.sender_name === "Domenico Pio Cristiano" &&
      back.memo === DOMENICO_FEED.memo && back.sender_reference === "010F345262220F28_1" &&
      back.matched_payment_id === null && back.match_confidence === null &&
      back.matched_by === null && back.review_metadata === null,
    JSON.stringify(back),
  )

  // ── THE CELL ──────────────────────────────────────────────────────────────
  const result = await listMisroutedClientPaymentCandidates()
  check("the list query ran", result.ok, result.error ?? "")

  const domenico = result.candidates.find((c) => c.feedId === DOMENICO_FEED.id)
  check("⛔ CELL 0: the list SELECTS Domenico's real row", !!domenico, `considered ${result.considered} owner-money rows`)
  if (domenico) {
    console.log(`      reason: ${domenico.reason}`)
    console.log(`      why:    ${domenico.detail}`)
    console.log(`      payer:  ${domenico.payer}`)
    console.log(`      client: ${domenico.suspectedClientName ?? "(none suggested)"}`)
    check("...and it reads correctly: right amount, currency and payer",
      domenico.amount === 1250 && domenico.currency === "EUR" && domenico.payer === "Domenico Pio Cristiano")
    check("...and it is not mistaken for a human's deliberate claim", domenico.filedBy === "unknown")
  }

  // ── THE INVERSE ───────────────────────────────────────────────────────────
  const stripe = result.candidates.find((c) => c.feedId === STRIPE_PAYOUT.id)
  const relay = result.candidates.find((c) => c.feedId === RELAY_PAYOUT.id)
  check("a Stripe payout is NOT offered as client money", !stripe, stripe ? `WRONGLY LISTED: ${stripe.detail}` : "")
  check("a Relay partner payout is NOT offered as client money", !relay, relay ? `WRONGLY LISTED: ${relay.detail}` : "")
} catch (err) {
  check("fixture/setup completed", false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
  const { count } = await db.from("td_bank_feeds").select("id", { count: "exact", head: true }).in("id", FEED_IDS)
  check("fixtures cleaned up", (count ?? 0) === 0, `leftover=${count}`)
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
