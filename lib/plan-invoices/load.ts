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
 * guessed (Antonio, 2026-11-11: "the one who has to pay is the one who originally signed the contract"). An offer that never had an
 * "Invoice to" follows where part 1 actually went (payer.ts).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { validatePaymentPlan, clientFacingPartLabel } from "@/lib/offers/payment-plan"
import { computePlanStatus, type TrancheInvoiceRow } from "@/lib/offers/payment-plan-state"
import { resolveInvoiceTarget, parseBillTo } from "@/lib/offers/bill-to"
import { chosenInvoiceDescription } from "@/lib/offers/invoice-description"
import { classifyPlanPart, stepKey, type OfferJob, type StepOrders } from "@/lib/plan-invoices/classify"
import type { InvoiceToRaiseRow, InvoicesToRaise } from "@/lib/plan-invoices/types"
import { STEP_TRIGGER_SERVICE_TYPES } from "@/lib/plan-invoices/steps"
import { payerOfPartOne, samePayer } from "@/lib/plan-invoices/payer"

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

type PayRow = TrancheInvoiceRow & { tranche_offer_token: string; account_id: string | null; contact_id: string | null; billing_entity_id: string | null }

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

  const stepServices = new Set<string>(STEP_TRIGGER_SERVICE_TYPES)
  let anyStep = false
  for (const o of offers) {
    const v = validatePaymentPlan(o.payment_plan)
    for (const p of v.plan ?? []) if (p.trigger.kind === "step" && p.trigger.service_type) { stepServices.add(p.trigger.service_type); anyStep = true }
  }
  const leadIds = uniq(offers.filter((o) => !o.contact_id).map((o) => o.lead_id))

  // Four independent reads at once (this runs on every Calendar load and every menu-badge refresh — keep it to two round trips).
  // The plan's own invoices (lineage columns postdate the generated types — same edge-cast as payment-plan-state.ts); the offers' jobs
  // (only the ones tied to an offer carry the token); the step numbers a "step" part waits on; a lead's person (known only after signing).
  const payQuery = supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, amount_paid, amount, tranche_seq, tranche_offer_token, due_date, sent_at, card_fee_amount, account_id, contact_id, billing_entity_id" as never)
    .in("tranche_offer_token" as never, tokens as never) as unknown as PromiseLike<{ data: PayRow[] | null; error: { message: string } | null }>
  const [payRes, jobRes, stageRes, leadRes] = await Promise.all([
    payQuery,
    supabaseAdmin.from("service_deliveries").select("service_type, stage_order, status, source_offer_token").in("source_offer_token", tokens),
    anyStep
      ? supabaseAdmin.from("pipeline_stages").select("service_type, stage_name, stage_order").in("service_type", Array.from(stepServices))
      : Promise.resolve({ data: [] as Array<{ service_type: string | null; stage_name: string | null; stage_order: number | null }>, error: null }),
    leadIds.length > 0
      ? supabaseAdmin.from("leads").select("id, converted_to_contact_id").in("id", leadIds)
      : Promise.resolve({ data: [] as Array<{ id: string; converted_to_contact_id: string | null }>, error: null }),
  ])
  if (payRes.error) throw new Error(`the plans' invoices could not be read: ${payRes.error.message}`)
  if (jobRes.error) throw new Error(`the offers' jobs could not be read: ${jobRes.error.message}`)
  if (stageRes.error) throw new Error(`the step lists could not be read: ${stageRes.error.message}`)
  if (leadRes.error) throw new Error(`the leads could not be read: ${leadRes.error.message}`)
  const payRows = payRes.data ?? []

  const jobsByToken = new Map<string, OfferJob[]>()
  for (const j of (jobRes.data ?? []) as OfferJob[]) {
    if (!j.source_offer_token) continue
    const list = jobsByToken.get(j.source_offer_token) ?? []
    list.push(j)
    jobsByToken.set(j.source_offer_token, list)
  }
  const stepOrders: StepOrders = new Map()
  for (const r of stageRes.data ?? []) {
    if (r.service_type && r.stage_name && typeof r.stage_order === "number") stepOrders.set(stepKey(r.service_type, r.stage_name), r.stage_order)
  }
  const personByLead = new Map<string, string>()
  for (const l of leadRes.data ?? []) if (l.converted_to_contact_id) personByLead.set(l.id, l.converted_to_contact_id)

  // Who pays: the offer's "Invoice to" (pure rule). An offer that never had one follows where PART 1 went (see payer.ts).
  const targets = new Map<string, ReturnType<typeof resolveInvoiceTarget>>()
  for (const o of offers) {
    const personId = o.contact_id ?? (o.lead_id ? personByLead.get(o.lead_id) ?? null : null)
    let t = resolveInvoiceTarget({ billTo: o.bill_to ?? null, offerAccountId: o.account_id, contactId: personId })
    if (parseBillTo(o.bill_to ?? null).billTo === null) {
      const one = payerOfPartOne(payRows.filter((r) => r.tranche_offer_token === o.token))
      if (one) t = { ...t, account_id: one.account_id, contact_id: one.contact_id ?? t.contact_id, billing_entity_id: one.billing_entity_id }
    }
    targets.set(o.token, t)
  }
  const contactIds = uniq(Array.from(targets.values()).map((t) => t.contact_id))
  const accountIds = uniq(Array.from(targets.values()).map((t) => t.account_id))
  const entityIds = uniq(Array.from(targets.values()).map((t) => t.billing_entity_id))
  const [contacts, accounts, entities] = await Promise.all([
    contactIds.length ? supabaseAdmin.from("contacts").select("id, full_name, email").in("id", contactIds) : Promise.resolve({ data: [] as Array<{ id: string; full_name: string | null; email: string | null }>, error: null }),
    accountIds.length ? supabaseAdmin.from("accounts").select("id, company_name").in("id", accountIds) : Promise.resolve({ data: [] as Array<{ id: string; company_name: string | null }>, error: null }),
    entityIds.length ? supabaseAdmin.from("billing_entities").select("id, entity_name").in("id", entityIds) : Promise.resolve({ data: [] as Array<{ id: string; entity_name: string | null }>, error: null }),
  ])
  // A failed name read must not quietly turn "Bill to: <the signer>" into the offer's client name — that line is staff's safety net.
  if (contacts.error) throw new Error(`the payers could not be read: ${contacts.error.message}`)
  if (accounts.error) throw new Error(`the payers' companies could not be read: ${accounts.error.message}`)
  if (entities.error) throw new Error(`the billing entities could not be read: ${entities.error.message}`)
  const contactBy = new Map((contacts.data ?? []).map((c) => [c.id, c]))
  const accountBy = new Map((accounts.data ?? []).map((a) => [a.id, a]))
  const entityBy = new Map((entities.data ?? []).map((e) => [e.id, e]))

  const rows: InvoiceToRaiseRow[] = []
  for (const offer of offers) {
    const v = validatePaymentPlan(offer.payment_plan)
    // A stored plan that no longer validates cannot be raised safely — the money rails refuse it too; skip, never guess.
    if (!v.ok || !v.plan) continue
    const offerPays = payRows.filter((r) => r.tranche_offer_token === offer.token)
    const status = computePlanStatus(v.plan, offerPays)
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
      // A Draft that already exists may have been made somewhere else (the company page's own Raise button) for a different payer.
      const draft = c.reason?.kind === "draft" ? offerPays.find((r) => r.id === partStatus.invoice?.id) : undefined
      const payerMismatch = !!draft && !!target && !samePayer(draft, { account_id: target.account_id, contact_id: target.contact_id, billing_entity_id: target.billing_entity_id })
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
        text: payerMismatch ? `${c.text} — but it is addressed to a different payer than this offer's "Invoice to". Check it before sending.` : c.text,
        stepNotFound: c.stepNotFound,
        jobMissing: c.jobMissing,
        payerMismatch,
      })
    }
  }

  // Due first (the longest-overdue date first); then what is coming up, by client name. (A coming-up date is not ranked by date.)
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
