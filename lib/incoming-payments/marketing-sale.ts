/**
 * A waiting payment that was really a TD Marketing sale (incoming-payments Phase 3, dev job 40a58d9a). SERVER-ONLY.
 *
 * Marketing's own links are labelled and recorded by `recordPaidSession`. This is for the payment that arrived through a link with
 * NO label (a hand-made Stripe link — Monica Germani, 2026-10-23): staff pick the marketing lead and the kind of sale, and the sale
 * is written to the SAME ledger, already "paid", under the same rules:
 *   - the split is the term in force on the DAY THE MONEY ARRIVED (not today): `snapshotForSale` with `at` = the payment time. No term
 *     then = "terms not set" and Antonio applies terms later, exactly as for any marketing sale.
 *   - it creates NO client payment row and touches no client record (a marketing sale is not a client sale).
 *   - the lead moves to the stage of its kind (setting `sale_kind_stages`) and gets history lines, like a paid link.
 *   - idempotent: one sale per Stripe session (unique index), so a retry or a double click records nothing twice.
 * The sale belongs to the TEAM (no seller person is attached: a hand-made link has none), so the owner sees it; a member's own "my sales"
 * list will not.
 */

import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { getMarketingSetting, listCommissionTerms } from "@/lib/marketing/settings"
import { snapshotForSale, formatMoney } from "@/lib/marketing/sales"
import { moveLeadAfterPaid } from "@/lib/marketing/sales-server"
import type { WaitingPayment } from "@/lib/incoming-payments/classify"

export interface MarketingSaleResult {
  ok: boolean
  status?: number
  error?: string
  saleId?: string
  alreadyRecorded?: boolean
  termsSet?: boolean
  leadName?: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function recordMarketingSaleFromPayment(
  input: { payment: WaitingPayment; marketingLeadId: string; kind: string; actor: string },
  db: Db = leadDb(),
): Promise<MarketingSaleResult> {
  const { payment, actor } = input
  if (!UUID_RE.test(input.marketingLeadId)) return { ok: false, status: 400, error: "Pick the marketing lead this sale belongs to." }
  const kind = String(input.kind ?? "").trim()
  if (!kind) return { ok: false, status: 400, error: "Pick what kind of sale this was." }

  // Already recorded for this Stripe session (retry, double click)?
  const { data: existing, error: exErr } = await db.from("marketing_sales").select("id").eq("stripe_session_id", payment.sessionId).maybeSingle()
  if (exErr) return { ok: false, status: 500, error: `Could not check whether this sale was already recorded: ${exErr.message}` }
  if (existing) return { ok: true, alreadyRecorded: true, saleId: (existing as { id: string }).id }

  const { data: lead, error: leadErr } = await db.from("marketing_leads").select("id, team_id, full_name, email").eq("id", input.marketingLeadId).maybeSingle()
  if (leadErr) return { ok: false, status: 500, error: `Could not read the marketing lead: ${leadErr.message}` }
  if (!lead) return { ok: false, status: 404, error: "Marketing lead not found." }
  const l = lead as { id: string; team_id: string | null; full_name: string | null; email: string | null }
  if (!l.team_id) return { ok: false, status: 400, error: "This marketing lead is not assigned to a team yet. Assign it to a team in TD Marketing first, then record the sale." }

  const kinds = (await getMarketingSetting("sale_kinds", l.team_id)) as { key: string; label: string }[]
  if (!kinds.some((k) => k.key === kind)) return { ok: false, status: 400, error: "That kind of sale is not one of this team's kinds. Pick one from the list." }

  const amountCents = Math.round(payment.amount * 100)
  const paidAt = new Date(payment.paidAt)
  const terms = await listCommissionTerms(l.team_id)
  const snap = snapshotForSale(terms, { teamId: l.team_id, kind, personRef: null, amountCents, at: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt })
  const note = `Recorded afterwards by ${actor}: the payment arrived through a Stripe link with no marketing label (${payment.email ?? "no email"}, ${formatMoney(amountCents, payment.currency)}).`
  const nowIso = new Date().toISOString()

  const { data: row, error: insErr } = await db.from("marketing_sales").insert({
    team_id: l.team_id, lead_id: l.id, status: "paid", kind, amount_cents: amountCents, currency: payment.currency, note,
    created_by: actor, created_by_user_id: null, ...snap,
    stripe_session_id: payment.sessionId, stripe_payment_intent: payment.paymentIntentId,
    paid_at: payment.paidAt, paid_amount_cents: amountCents, updated_at: nowIso,
  }).select("id").single()
  if (insErr || !row) {
    // 23505 = another run recorded this session a moment ago (unique index on the Stripe session): that is success.
    if (insErr && (insErr as { code?: string }).code === "23505") return { ok: true, alreadyRecorded: true }
    return { ok: false, status: 500, error: `Could not record the sale: ${insErr?.message ?? "no row returned"}` }
  }
  const saleId = (row as { id: string }).id

  await db.from("marketing_lead_events").insert({
    lead_id: l.id, kind: "payment_received", actor,
    data: { sale_id: saleId, amount_cents: amountCents, currency: payment.currency, recorded_late: true, stripe_session_id: payment.sessionId },
  })
  await moveLeadAfterPaid(db, { id: saleId, team_id: l.team_id, lead_id: l.id, kind })
  return { ok: true, saleId, termsSet: snap.seller_cents !== null, leadName: l.full_name }
}
