/**
 * Payment links and the sales record (server; TD Marketing, dev job 9aec66fa). The team id always comes from the guard (or, for the
 * Stripe webhook, from the sale row itself), never from a request body. Decisions are in sales.ts (pure); this file loads facts,
 * writes with "nothing changed meanwhile" conditions, and writes the lead's history.
 */
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { readPaged } from "@/lib/marketing/paged"
import { getTeamLead } from "@/lib/marketing/leads-read"
import { getMarketingSetting, listCommissionTerms } from "@/lib/marketing/settings"
import { termInForce } from "@/lib/marketing/commission"
import {
  applyTermToSale, canPayOut, formatMoney, planLink, planPaid, planRefund, snapshotForSale, stageForPaidSale,
  type LinkInput, type PaidFacts, type SaleRow,
} from "@/lib/marketing/sales"
import { PAYMENT_KIND_META_KEY, PAYMENT_KIND_MARKETING } from "@/lib/payments/payment-kind"

export const SALE_COLS = "id, team_id, lead_id, kind, amount_cents, currency, note, status, created_by, created_by_user_id, term_id, seller_pct, td_pct, term_basis, payee_account_id, seller_cents, td_cents, stripe_session_id, stripe_payment_intent, checkout_url, link_expires_at, paid_at, paid_amount_cents, refunded_at, refunded_cents, needs_attention, paid_out_at, paid_out_reference, paid_out_by, created_at"

export type SaleResult<T = unknown> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409 | 500 | 502; error: string; needsConfirm?: boolean }

export interface CheckoutParams { saleId: string; leadId: string; teamId: string; amountCents: number; currency: string; kindLabel: string; leadName: string | null; email: string | null }
/** Makes the Stripe Checkout Session. Injected so tests never reach Stripe. */
export type CreateSession = (p: CheckoutParams) => Promise<{ success: boolean; sessionId?: string; checkoutUrl?: string; expiresAt?: Date; error?: string }>

async function loadLinkSettings(teamId: string) {
  const [kinds, currencies, confirmAbove] = await Promise.all([
    getMarketingSetting("sale_kinds", teamId), getMarketingSetting("allowed_currencies", teamId), getMarketingSetting("confirm_above_amount", teamId),
  ])
  return { kinds, currencies, confirmAbove } as { kinds: { key: string; label: string }[]; currencies: string[]; confirmAbove: number | null }
}

async function addEvent(db: Db, leadId: string, kind: string, actor: string, data: Record<string, unknown>) {
  await db.from("marketing_lead_events").insert({ lead_id: leadId, kind, actor, data })
}

/** Create a sale row, then the Stripe link for it, then store the link. A Stripe failure marks the row "failed" (it never shows as a live link). */
export async function createSaleLink(
  db: Db, ctx: { teamId: string; userId: string; email: string | null; viaViewAs?: boolean }, leadId: string, input: LinkInput, createSession: CreateSession, now = new Date(),
): Promise<SaleResult<{ saleId: string; url: string }>> {
  const lead = await getTeamLead(db, ctx.teamId, leadId)
  if (!lead) return { ok: false, status: 404, error: "Lead not found." }
  const settings = await loadLinkSettings(ctx.teamId)
  const plan = planLink(input, settings)
  if (plan.ok === false) return { ok: false, status: 400, error: plan.error, needsConfirm: plan.needsConfirm }
  const terms = await listCommissionTerms(ctx.teamId)
  const snap = snapshotForSale(terms, { teamId: ctx.teamId, kind: plan.kind, personRef: ctx.userId, amountCents: plan.amountCents, at: now })
  const actor = ctx.email ?? ctx.userId
  const { data: row, error: insErr } = await db.from("marketing_sales").insert({
    team_id: ctx.teamId, lead_id: lead.id, status: "link_created", kind: plan.kind, amount_cents: plan.amountCents, currency: plan.currency, note: plan.note,
    created_by: actor, created_by_user_id: ctx.userId, ...snap,
  }).select("id").single()
  if (insErr || !row) return { ok: false, status: 500, error: "Could not create the sale. Please try again." }
  const saleId = (row as { id: string }).id
  const kindLabel = settings.kinds.find(k => k.key === plan.kind)?.label ?? plan.kind
  let made: Awaited<ReturnType<CreateSession>>
  try {
    made = await createSession({ saleId, leadId: lead.id, teamId: ctx.teamId, amountCents: plan.amountCents, currency: plan.currency, kindLabel, leadName: lead.full_name, email: lead.email })
  } catch (e) {
    made = { success: false, error: e instanceof Error ? e.message : "Stripe failed" }
  }
  if (!made.success || !made.sessionId || !made.checkoutUrl) {
    await db.from("marketing_sales").update({ status: "failed", needs_attention: "The payment link could not be created.", updated_at: now.toISOString() }).eq("id", saleId)
    return { ok: false, status: 502, error: "The payment link could not be created. Nothing was sent to the client. Try again in a moment." }
  }
  const { error: upErr } = await db.from("marketing_sales").update({
    stripe_session_id: made.sessionId, checkout_url: made.checkoutUrl, link_expires_at: made.expiresAt?.toISOString() ?? null, updated_at: now.toISOString(),
  }).eq("id", saleId)
  if (upErr) return { ok: false, status: 500, error: "The link was made but could not be saved. Tell Antonio." }
  await addEvent(db, lead.id, "payment_link_created", actor, { sale_id: saleId, kind: plan.kind, amount_cents: plan.amountCents, currency: plan.currency, terms_set: snap.seller_cents !== null, ...(ctx.viaViewAs ? { via_view_as: true } : {}) })
  return { ok: true, saleId, url: made.checkoutUrl }
}

/** Metadata stamped on the Stripe session (and its payment). `payment_kind` keeps the client-sales machinery out of it. */
export function saleMetadata(p: Pick<CheckoutParams, "saleId" | "leadId" | "teamId">): Record<string, string> {
  return { [PAYMENT_KIND_META_KEY]: PAYMENT_KIND_MARKETING, marketing_sale_id: p.saleId, marketing_lead_id: p.leadId, marketing_team_id: p.teamId, source: "td-marketing" }
}

/** Stripe says the link was paid. Safe to run twice (Stripe redelivers): the second run changes nothing. */
export async function recordPaidSession(db: Db, session: { id: string; payment_intent: string | null; amount_total: number | null; currency: string | null; payment_status?: string | null; metadata: Record<string, string> | null }, now = new Date()): Promise<{ recorded: boolean; reason?: string }> {
  const saleId = session.metadata?.marketing_sale_id
  if (!saleId || !/^[0-9a-f-]{36}$/i.test(saleId)) return { recorded: false, reason: "no sale id on the payment" }
  const { data: sale } = await db.from("marketing_sales").select(SALE_COLS).eq("id", saleId).maybeSingle()
  if (!sale) return { recorded: false, reason: "sale not found" }
  const facts: PaidFacts = { sessionId: session.id, paymentIntent: session.payment_intent, amountCents: session.amount_total, currency: session.currency, paymentStatus: session.payment_status ?? null, at: now }
  const plan = planPaid(sale as SaleRow, facts)
  if (plan.action === "ignore") return { recorded: false, reason: plan.reason }
  const { data: changed, error } = await db.from("marketing_sales").update(plan.patch).eq("id", saleId).eq("status", (sale as SaleRow).status).select("id")
  if (error) throw new Error(`marketing sale ${saleId}: could not record payment: ${error.message}`)
  if (!changed || changed.length === 0) return { recorded: false, reason: "changed meanwhile" }
  const s = sale as SaleRow
  await addEvent(db, s.lead_id, "payment_received", "stripe", { sale_id: s.id, amount_cents: facts.amountCents, currency: facts.currency })
  await moveLeadAfterPaid(db, s)
  return { recorded: true }
}

/** The lead moves to the stage for its kind of sale. Failing here never undoes the recorded payment. */
export async function moveLeadAfterPaid(db: Db, sale: Pick<SaleRow, "id" | "team_id" | "lead_id" | "kind">) {
  try {
    const [map, stages] = await Promise.all([getMarketingSetting("sale_kind_stages", sale.team_id), getMarketingSetting("pipeline_stages", sale.team_id)])
    const stage = stageForPaidSale(sale.kind, map as Record<string, string>, stages as { key: string }[])
    if (!stage) return
    // Only if the lead is still where we just read it (nothing moved it meanwhile); a promised call back is done once the client has paid. If it moved meanwhile, read again once;
    // if it still cannot be moved, leave a line in the history so a person knows (the payment itself is already recorded).
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: lead } = await db.from("marketing_leads").select("status, callback_at").eq("id", sale.lead_id).eq("team_id", sale.team_id).maybeSingle()
      if (!lead) return
      if (lead.status === stage) {
        if (lead.callback_at) await db.from("marketing_leads").update({ callback_at: null, updated_at: new Date().toISOString() }).eq("id", sale.lead_id).eq("team_id", sale.team_id)
        return
      }
      const { data: moved } = await db.from("marketing_leads").update({ status: stage, callback_at: null, updated_at: new Date().toISOString() }).eq("id", sale.lead_id).eq("team_id", sale.team_id).eq("status", lead.status).select("id")
      if (moved && moved.length > 0) { await addEvent(db, sale.lead_id, "status_changed", "stripe", { from: lead.status, to: stage, reason: "sale paid" }); return }
    }
    await addEvent(db, sale.lead_id, "stage_not_moved", "stripe", { wanted: stage, reason: "the lead was changed at the same moment the payment arrived" })
  } catch (e) {
    console.error("[marketing-sales] could not move the lead after payment:", e instanceof Error ? e.message : e)
  }
}

/** A refund (from Stripe's charge.refunded). Finds the sale by the payment, never by anything typed. */
export async function recordRefund(db: Db, paymentIntent: string | null, refundedCents: number, now = new Date()): Promise<{ recorded: boolean; reason?: string }> {
  if (!paymentIntent) return { recorded: false, reason: "no payment id" }
  const { data: sale } = await db.from("marketing_sales").select(SALE_COLS).eq("stripe_payment_intent", paymentIntent).maybeSingle()
  if (!sale) return { recorded: false, reason: "not a marketing sale" }
  const s = sale as SaleRow
  const plan = planRefund(s, refundedCents, now)
  if (plan.action === "ignore") return { recorded: false, reason: plan.reason }
  const { data: changed, error } = await db.from("marketing_sales").update(plan.patch).eq("id", s.id).eq("status", s.status).select("id")
  if (error) throw new Error(`marketing sale ${s.id}: could not record refund: ${error.message}`)
  if (!changed || changed.length === 0) return { recorded: false, reason: "changed meanwhile" }
  await addEvent(db, s.lead_id, "sale_refunded", "stripe", { sale_id: s.id, refunded_cents: refundedCents, full: plan.patch.status === "refunded" })
  return { recorded: true }
}

/** A dispute was opened on the payment: flag it for Antonio, change nothing else. */
export async function recordDispute(db: Db, paymentIntent: string | null, now = new Date()): Promise<void> {
  if (!paymentIntent) return
  await db.from("marketing_sales").update({ needs_attention: "The client opened a dispute with their bank on this payment. Do not pay out until it is settled.", updated_at: now.toISOString() }).eq("stripe_payment_intent", paymentIntent)
}

export async function listTeamSales(db: Db, teamId: string, opts: { mineUserId?: string; limit?: number } = {}): Promise<SaleRow[]> {
  const { rows } = await readPaged<SaleRow>((from, to) => {
    let q = db.from("marketing_sales").select(SALE_COLS).eq("team_id", teamId)
    if (opts.mineUserId) q = q.eq("created_by_user_id", opts.mineUserId)
    return q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to)
  }, opts.limit ?? 500)
  return rows
}

export async function listAllSales(db: Db, limit = 1000): Promise<SaleRow[]> {
  const { data } = await db.from("marketing_sales").select(SALE_COLS).order("created_at", { ascending: false }).limit(limit)
  return ((data ?? []) as SaleRow[])
}

/** Antonio marks a sale's seller share as paid out (date + reference). Only once, only for a paid + split sale. */
export async function markPaidOut(db: Db, saleId: string, input: { reference: string; paidOn: string }, actor: string, now = new Date()): Promise<SaleResult> {
  const reference = (input.reference ?? "").trim().slice(0, 200)
  if (!reference) return { ok: false, status: 400, error: "Type the bank reference of the transfer." }
  const when = new Date(input.paidOn)
  if (Number.isNaN(when.getTime()) || when.getTime() > now.getTime() + 86_400_000) return { ok: false, status: 400, error: "That date is not valid." }
  const { data: sale } = await db.from("marketing_sales").select(SALE_COLS).eq("id", saleId).maybeSingle()
  if (!sale) return { ok: false, status: 404, error: "Sale not found." }
  if (!canPayOut(sale as SaleRow)) return { ok: false, status: 409, error: "This sale cannot be marked as paid out (it is not paid, has no split yet, or was already paid out)." }
  const { data: changed, error } = await db.from("marketing_sales").update({ paid_out_at: when.toISOString(), paid_out_reference: reference, paid_out_by: actor, updated_at: now.toISOString() }).eq("id", saleId).is("paid_out_at", null).select("id")
  if (error) return { ok: false, status: 500, error: "Could not save. Please try again." }
  if (!changed || changed.length === 0) return { ok: false, status: 409, error: "This sale was just marked as paid out by someone else." }
  const s = sale as SaleRow
  await addEvent(db, s.lead_id, "sale_paid_out", actor, { sale_id: s.id, reference, seller_cents: s.seller_cents })
  return { ok: true }
}

/** Antonio applies the terms in force TODAY to a sale that was saved as "terms not set". */
export async function applyTermsNow(db: Db, saleId: string, actor: string, now = new Date()): Promise<SaleResult<{ sellerCents: number; tdCents: number }>> {
  const { data: sale } = await db.from("marketing_sales").select(SALE_COLS).eq("id", saleId).maybeSingle()
  if (!sale) return { ok: false, status: 404, error: "Sale not found." }
  const s = sale as SaleRow
  if (s.seller_cents !== null) return { ok: false, status: 409, error: "This sale already has its split." }
  if (s.status !== "paid" && s.status !== "link_created") return { ok: false, status: 409, error: "Only a paid sale or an open link can get its split." }
  const terms = await listCommissionTerms(s.team_id)
  const snap = applyTermToSale(s, terms, s.team_id, s.created_by_user_id, now)
  if (!snap || snap.seller_cents === null || snap.td_cents === null) return { ok: false, status: 409, error: "There are no usable terms for this kind of sale yet. Set the split first." }
  const { data: changed, error } = await db.from("marketing_sales").update({ ...snap, updated_at: now.toISOString() }).eq("id", saleId).is("seller_cents", null).select("id")
  if (error) return { ok: false, status: 500, error: "Could not save. Please try again." }
  if (!changed || changed.length === 0) return { ok: false, status: 409, error: "This sale changed meanwhile. Reload and try again." }
  await addEvent(db, s.lead_id, "sale_terms_applied", actor, { sale_id: s.id, seller_cents: snap.seller_cents, td_cents: snap.td_cents })
  return { ok: true, sellerCents: snap.seller_cents, tdCents: snap.td_cents }
}

export { formatMoney }

/** What the payment-link box on a lead needs: the kinds, currencies, the split in force per kind for THIS seller, and this lead's sales. */
export async function loadPaymentLinkView(db: Db, ctx: { teamId: string; userId: string }, leadId: string, now = new Date()) {
  const [settings, terms, sales] = await Promise.all([
    loadLinkSettings(ctx.teamId),
    listCommissionTerms(ctx.teamId),
    db.from("marketing_sales").select(SALE_COLS).eq("team_id", ctx.teamId).eq("lead_id", leadId).order("created_at", { ascending: false }).limit(20),
  ])
  const splits: Record<string, { sellerPct: number; tdPct: number; basis: string } | null> = {}
  for (const k of settings.kinds) {
    const t = termInForce(terms, { teamId: ctx.teamId, kind: k.key, personRef: ctx.userId, at: now })
    splits[k.key] = t ? { sellerPct: t.seller_pct, tdPct: t.td_pct, basis: t.basis } : null
  }
  return { ...settings, splits, sales: ((sales.data ?? []) as SaleRow[]) }
}
