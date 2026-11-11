/**
 * Reads the "Invoices to raise" list for the Calendar (dev job ae3c19db). READ-ONLY: it never writes, raises or sends anything.
 *
 * One pass, a handful of queries however many plans there are (production had 3 plan offers of 273 on 2026-11-11):
 *   offers with a plan (signed / completed only — a draft is not an agreement yet) → their invoices (the plan's own lineage columns) →
 *   their jobs → the step numbers a "step" part waits on → who pays (names only; nothing is created for a typed payer).
 * Then `classifyPlanPart` (pure) decides due / coming up per part.
 *
 * THE PAYER is the offer's own "Invoice to" (`offers.bill_to`): the person who signed, or a chosen company / billing entity — the same
 * rule `invoiceTargetForOffer` applies when the invoice is created, so the row names exactly who will be billed. A company is never
 * guessed (Antonio, 2026-11-11: "the one who has to pay is the one who originally signed the contract").
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { validatePaymentPlan, clientFacingPartLabel } from "@/lib/offers/payment-plan"
import { computePlanStatus, type TrancheInvoiceRow } from "@/lib/offers/payment-plan-state"
import { resolveInvoiceTarget } from "@/lib/offers/bill-to"
import { chosenInvoiceDescription } from "@/lib/offers/invoice-description"
import { classifyPlanPart, stepKey, type OfferJob, type StepOrders } from "@/lib/plan-invoices/classify"
import type { InvoiceToRaiseRow, InvoicesToRaise } from "@/lib/plan-invoices/types"

export type { InvoiceToRaiseRow, InvoicesToRaise }

interface OfferRow {
  token: string
  client_name: string | null
  client_email: string | null
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  bill_to: unknown
  services: unknown
  invoice_description?: string | null
  payment_plan: unknown
}

const SELECT_OFFERS = "token, client_name, client_email, account_id, contact_id, lead_id, bill_to, services, invoice_description, payment_plan"

const uniq = <T,>(xs: Array<T | null | undefined>): T[] => Array.from(new Set(xs.filter((x): x is T => !!x)))

/** The service names on the offer, joined — only for the row's "what is it for" line. */
function serviceLabelOf(offer: OfferRow): string {
  const chosen = chosenInvoiceDescription(offer)
  if (chosen) return chosen
  if (Array.isArray(offer.services)) {
    const names = (offer.services as Array<{ name?: unknown } | null>)
      .map((s) => (s && typeof s.name === "string" ? s.name.trim() : ""))
      .filter(Boolean)
    if (names.length > 0) return Array.from(new Set(names)).join(" + ")
  }
  return "Setup Fee"
}

export async function loadInvoicesToRaise(todayIso: string): Promise<InvoicesToRaise> {
  const offerQuery = supabaseAdmin
    .from("offers")
    .select(SELECT_OFFERS as never)
    .in("status", ["signed", "completed"])
    .not("payment_plan" as never, "is", null) as unknown as PromiseLike<{ data: OfferRow[] | null; error: { message: string } | null }>
  const { data: offerData, error: offersErr } = await offerQuery
  if (offersErr) throw new Error(`offers with a payment plan could not be read: ${offersErr.message}`)
  const offers = (offerData ?? []).filter((o) => Array.isArray(o.payment_plan))
  if (offers.length === 0) return { rows: [], dueCount: 0 }
  const tokens = offers.map((o) => o.token)

  // The plan's own invoices (lineage columns postdate the generated types — same edge-cast as payment-plan-state.ts).
  const payQuery = supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, amount_paid, amount, tranche_seq, tranche_offer_token, due_date, sent_at, card_fee_amount" as never)
    .in("tranche_offer_token" as never, tokens as never) as unknown as PromiseLike<{ data: Array<TrancheInvoiceRow & { tranche_offer_token: string }> | null; error: { message: string } | null }>
  const { data: payRows, error: payErr } = await payQuery
  if (payErr) throw new Error(`the plans' invoices could not be read: ${payErr.message}`)

  // The offers' jobs (only the ones tied to an offer carry the token).
  const { data: jobRows, error: jobErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("service_type, stage_order, status, source_offer_token")
    .in("source_offer_token", tokens)
  if (jobErr) throw new Error(`the offers' jobs could not be read: ${jobErr.message}`)
  const jobsByToken = new Map<string, OfferJob[]>()
  for (const j of (jobRows ?? []) as OfferJob[]) {
    if (!j.source_offer_token) continue
    const list = jobsByToken.get(j.source_offer_token) ?? []
    list.push(j)
    jobsByToken.set(j.source_offer_token, list)
  }

  // Step numbers for the "step" parts that are in play.
  const stepServices = new Set<string>()
  for (const o of offers) {
    const v = validatePaymentPlan(o.payment_plan)
    for (const p of v.plan ?? []) if (p.trigger.kind === "step" && p.trigger.service_type) stepServices.add(p.trigger.service_type)
  }
  const stepOrders: StepOrders = new Map()
  if (stepServices.size > 0) {
    const { data: stageRows, error: stageErr } = await supabaseAdmin
      .from("pipeline_stages")
      .select("service_type, stage_name, stage_order")
      .in("service_type", Array.from(stepServices))
    if (stageErr) throw new Error(`the step lists could not be read: ${stageErr.message}`)
    for (const r of stageRows ?? []) {
      if (r.service_type && r.stage_name && typeof r.stage_order === "number") stepOrders.set(stepKey(r.service_type, r.stage_name), r.stage_order)
    }
  }

  // Who pays: resolve the offer's "Invoice to" (pure rule) and read the names. A lead's offer only learns its person at signing.
  const leadIds = uniq(offers.filter((o) => !o.contact_id).map((o) => o.lead_id))
  const personByLead = new Map<string, string>()
  if (leadIds.length > 0) {
    const { data: leads } = await supabaseAdmin.from("leads").select("id, converted_to_contact_id").in("id", leadIds)
    for (const l of leads ?? []) if (l.converted_to_contact_id) personByLead.set(l.id, l.converted_to_contact_id)
  }
  const targets = new Map<string, ReturnType<typeof resolveInvoiceTarget>>()
  for (const o of offers) {
    const personId = o.contact_id ?? (o.lead_id ? personByLead.get(o.lead_id) ?? null : null)
    targets.set(o.token, resolveInvoiceTarget({ billTo: o.bill_to ?? null, offerAccountId: o.account_id, contactId: personId }))
  }
  const contactIds = uniq(Array.from(targets.values()).map((t) => t.contact_id))
  const accountIds = uniq(Array.from(targets.values()).map((t) => t.account_id))
  const entityIds = uniq(Array.from(targets.values()).map((t) => t.billing_entity_id))
  const [contacts, accounts, entities] = await Promise.all([
    contactIds.length ? supabaseAdmin.from("contacts").select("id, full_name, email").in("id", contactIds) : Promise.resolve({ data: [] as Array<{ id: string; full_name: string | null; email: string | null }> }),
    accountIds.length ? supabaseAdmin.from("accounts").select("id, company_name").in("id", accountIds) : Promise.resolve({ data: [] as Array<{ id: string; company_name: string | null }> }),
    entityIds.length ? supabaseAdmin.from("billing_entities").select("id, entity_name").in("id", entityIds) : Promise.resolve({ data: [] as Array<{ id: string; entity_name: string | null }> }),
  ])
  const contactBy = new Map((contacts.data ?? []).map((c) => [c.id, c]))
  const accountBy = new Map((accounts.data ?? []).map((a) => [a.id, a]))
  const entityBy = new Map((entities.data ?? []).map((e) => [e.id, e]))

  const rows: InvoiceToRaiseRow[] = []
  for (const offer of offers) {
    const v = validatePaymentPlan(offer.payment_plan)
    // A stored plan that no longer validates cannot be raised safely — the money rails refuse it too; skip, never guess.
    if (!v.ok || !v.plan) continue
    const status = computePlanStatus(v.plan, (payRows ?? []).filter((r) => r.tranche_offer_token === offer.token))
    const jobs = jobsByToken.get(offer.token) ?? []
    const target = targets.get(offer.token)
    const contact = target?.contact_id ? contactBy.get(target.contact_id) : undefined
    const account = target?.account_id ? accountBy.get(target.account_id) : undefined
    const entity = target?.billing_entity_id ? entityBy.get(target.billing_entity_id) : undefined
    const typed = target?.new_entity?.name ?? null
    const payerName = entity?.entity_name ?? typed ?? account?.company_name ?? contact?.full_name ?? offer.client_name ?? null
    const payerHref = account ? `/accounts/${account.id}` : contact ? `/contacts/${contact.id}` : null
    for (const partStatus of status.parts) {
      const c = classifyPlanPart({ status: partStatus, todayIso, offerToken: offer.token, jobs, stepOrders, totalParts: status.plan.length })
      if (!c) continue
      rows.push({
        key: `${offer.token}:${partStatus.part.seq}`,
        offerToken: offer.token,
        seq: partStatus.part.seq,
        totalParts: status.plan.length,
        amount: partStatus.part.amount,
        currency: partStatus.part.currency,
        clientName: offer.client_name ?? offer.client_email ?? offer.token,
        payerName,
        payerEmail: contact?.email ?? null,
        payerHref,
        serviceLabel: serviceLabelOf(offer),
        partText: `Part ${partStatus.part.seq} of ${status.plan.length}`,
        due: c.due,
        reason: c.reason,
        text: c.text,
        stepNotFound: c.stepNotFound,
      })
    }
  }

  // Due first (the longest-overdue date first), then what is coming up — soonest date first, then the rest by name.
  const dueRank = (r: InvoiceToRaiseRow): number => (r.reason?.kind === "date" ? -r.reason.daysLate : -1)
  rows.sort((a, b) => Number(b.due) - Number(a.due) || (a.due ? dueRank(a) - dueRank(b) : 0) || a.clientName.localeCompare(b.clientName) || a.seq - b.seq)
  return { rows, dueCount: rows.filter((r) => r.due).length }
}

/** Just the number for the red counts. Never throws — a failed read shows no number rather than a wrong one (callers pass null on error). */
export async function countInvoicesDue(todayIso: string): Promise<number | null> {
  try {
    return (await loadInvoicesToRaise(todayIso)).dueCount
  } catch (err) {
    console.error("[plan-invoices] count could not be read:", err)
    return null
  }
}

/** The client-visible wording of a part, for the confirm window ("Part 2 of 2, due after the EIN arrives"). */
export { clientFacingPartLabel }
