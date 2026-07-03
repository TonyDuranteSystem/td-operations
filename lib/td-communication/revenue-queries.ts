/**
 * TD Communication — Phase 13 revenue & payout data layer (server-side, service role).
 *
 * Reuses the firm's existing ledgers (NO new tables):
 *   • client billing → `payments` via createTDInvoice (payment_category='td_communication')
 *   • Cris's payouts → `referral_payouts` (payout_type='td_comm', referral_id IS NULL)
 *
 * Like the rest of td-communication, td_comm_enrollments is RLS ON / NO policy —
 * these use supabaseAdmin after the API authenticated + authorized the caller
 * (ensureAdmin for revenue writes; resolveCommParticipant scoped to the partner's
 * own worker_partner_id for the earnings read).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSubjectsBatch, pickSubjectRef, buildSubject } from './subject'
import { packageLabel } from './pipeline'
import { resolveDefaultCommWorker } from './earning'
import { createTDInvoice } from '@/lib/portal/td-invoice'
import {
  TD_COMM_PAYOUT_TYPE,
  computePartnerBalance,
  canRequestPayout,
  earningAmount,
  isRecognized,
  isAvailable,
  clientPaidState,
  reservesBalance,
  toAmount,
  type RevenueEnrollment,
  type LinkedPayment,
  type TdCommPayoutRow,
  type RevenueProjectRow,
  type RevenueDashboard,
  type PartnerEarningRow,
  type PartnerEarnings,
} from './revenue'
import type { EnrollmentStatus } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Revenue-relevant enrollment columns (superset of the pipeline whitelist). */
const REVENUE_COLUMNS =
  'id, account_id, contact_id, lead_id, partner_id, package_slug, status, partner_amount_usd, earning_locked_at, worker_partner_id, client_payment_id, client_paid_override_at, client_paid_override_by, created_at, updated_at'

/* -------------------------------------------------------------------------- */
/* Row shaping                                                                 */
/* -------------------------------------------------------------------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function revenueEnrollment(r: any): RevenueEnrollment {
  return {
    id: r.id,
    status: r.status as EnrollmentStatus,
    partner_amount_usd: r.partner_amount_usd ?? null,
    earning_locked_at: r.earning_locked_at ?? null,
    worker_partner_id: r.worker_partner_id ?? null,
    client_payment_id: r.client_payment_id ?? null,
    client_paid_override_at: r.client_paid_override_at ?? null,
  }
}

/** Batch-fetch linked payments (id → {id,status,total}); empty map when none. */
async function fetchLinkedPayments(paymentIds: string[]): Promise<Map<string, LinkedPayment>> {
  const ids = Array.from(new Set(paymentIds.filter(Boolean)))
  const map = new Map<string, LinkedPayment>()
  if (ids.length === 0) return map
  const { data, error } = await db.from('payments').select('id, status, total').in('id', ids)
  if (error) throw new Error(error.message)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const p of data ?? []) map.set(p.id, { id: p.id, status: p.status ?? null, total: p.total ?? null })
  return map
}

/** All TD-Comm payouts (optionally for one partner). referral_id IS NULL guards against referral rows. */
async function fetchTdCommPayouts(partnerId?: string): Promise<TdCommPayoutRow[]> {
  let q = db
    .from('referral_payouts')
    .select('id, partner_id, amount, currency, status, payout_method, reference, requested_at, approved_at, paid_at, payout_request, created_at')
    .eq('payout_type', TD_COMM_PAYOUT_TYPE)
    .is('referral_id', null)
    .order('created_at', { ascending: false })
  if (partnerId) q = q.eq('partner_id', partnerId)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((p: any) => ({
    id: p.id,
    partner_id: p.partner_id ?? null,
    amount: toAmount(p.amount),
    currency: p.currency ?? 'USD',
    status: p.status ?? null,
    payout_method: p.payout_method ?? null,
    reference: p.reference ?? null,
    requested_at: p.requested_at ?? null,
    approved_at: p.approved_at ?? null,
    paid_at: p.paid_at ?? null,
    note: readRequestNote(p.payout_request),
    created_at: p.created_at ?? null,
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readRequestNote(payoutRequest: any): string | null {
  if (payoutRequest && typeof payoutRequest === 'object' && typeof payoutRequest.note === 'string') {
    return payoutRequest.note
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Admin dashboard                                                             */
/* -------------------------------------------------------------------------- */

/** Full revenue picture for the CRM Revenue tab (admin-only caller). */
export async function getRevenueDashboard(): Promise<RevenueDashboard> {
  const { data, error } = await db
    .from('td_comm_enrollments')
    .select(REVENUE_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  const rows = data ?? []

  const subjects = await resolveSubjectsBatch(rows)
  const payments = await fetchLinkedPayments(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows.map((r: any) => r.client_payment_id).filter(Boolean),
  )
  const payouts = await fetchTdCommPayouts()

  const emptyMaps = { account: new Map(), contact: new Map(), lead: new Map(), partner: new Map() }
  const projects: RevenueProjectRow[] = []
  const revEnrollments: RevenueEnrollment[] = []
  const paymentFor = new Map<string, LinkedPayment | null>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of rows) {
    const e = revenueEnrollment(r)
    revEnrollments.push(e)
    const payment = e.client_payment_id ? payments.get(e.client_payment_id) ?? null : null
    paymentFor.set(e.id, payment)
    const subject = subjects.get(r.id) ?? buildSubject(pickSubjectRef(r), emptyMaps)
    projects.push({
      id: e.id,
      subjectName: subject.name,
      subjectType: subject.type,
      package_slug: r.package_slug ?? null,
      packageLabel: packageLabel(r.package_slug),
      status: e.status,
      partner_amount_usd: e.partner_amount_usd === null ? null : toAmount(e.partner_amount_usd),
      recognized: isRecognized(e),
      available: isAvailable(e, payment),
      client_payment_id: e.client_payment_id,
      clientPaidState: clientPaidState(payment),
      clientInvoiceTotal: payment ? toAmount(payment.total) : null,
      client_paid_override_at: e.client_paid_override_at,
      worker_partner_id: e.worker_partner_id,
    })
  }

  // Client receivable totals (from the linked invoices).
  let clientCollected = 0
  let clientOutstanding = 0
  for (const p of projects) {
    if (p.clientInvoiceTotal === null) continue
    if (p.clientPaidState === 'paid') clientCollected += p.clientInvoiceTotal
    else clientOutstanding += p.clientInvoiceTotal
  }

  const balance = computePartnerBalance(
    revEnrollments,
    (e) => paymentFor.get(e.id) ?? null,
    payouts,
  )
  const pendingRequests = payouts.filter((p) => reservesBalance(p.status) && p.status !== 'paid').length

  const partnerNames = await fetchPartnerNames(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [...rows.map((r: any) => r.worker_partner_id), ...payouts.map((p) => p.partner_id)].filter(Boolean),
  )

  return {
    projects,
    payouts,
    partnerNames,
    totals: {
      clientCollected,
      clientOutstanding,
      partnerEarnedWaiting: balance.earnedWaiting,
      partnerAvailableGross: balance.availableGross,
      partnerPaidOut: balance.paidOut,
      partnerInRequest: balance.inRequest,
      partnerReadyToWithdraw: balance.readyToWithdraw,
      pendingRequests,
    },
  }
}

async function fetchPartnerNames(ids: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  const out: Record<string, string> = {}
  if (unique.length === 0) return out
  const { data } = await db.from('client_partners').select('id, partner_name, display_title').in('id', unique)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const p of data ?? []) out[p.id] = p.display_title || p.partner_name || 'Partner'
  return out
}

/* -------------------------------------------------------------------------- */
/* Admin writes                                                                */
/* -------------------------------------------------------------------------- */

/** Set Cris's earning for a project (admin). Amount must be a non-negative number. */
export async function setPartnerAmount(enrollmentId: string, amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Amount must be a non-negative number.')
  const { data, error } = await db
    .from('td_comm_enrollments')
    .update({ partner_amount_usd: amount, updated_at: new Date().toISOString() })
    .eq('id', enrollmentId)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Project not found.')
}

/** Admin off-platform "client paid" override — an alternative availability gate. */
export async function markClientPaidOverride(enrollmentId: string, actor: string): Promise<void> {
  const { data, error } = await db
    .from('td_comm_enrollments')
    .update({ client_paid_override_at: new Date().toISOString(), client_paid_override_by: actor, updated_at: new Date().toISOString() })
    .eq('id', enrollmentId)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Project not found.')
}

export interface BillClientResult {
  paymentId: string
  invoiceNumber: string
  total: number
  alreadyBilled: boolean
}

/**
 * Bill the client for a branding project — one TD invoice (payments row) whose
 * total is the frozen agreed price. skip_credit_netting keeps it from being born
 * "Paid" via account credit (which would flip Cris to withdrawable with no cash).
 * Idempotent via idempotency_key: re-billing returns the existing invoice.
 */
export async function billClient(enrollmentId: string): Promise<BillClientResult> {
  const { data: enr, error } = await db
    .from('td_comm_enrollments')
    .select('id, account_id, contact_id, package_slug, client_payment_id')
    .eq('id', enrollmentId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!enr) throw new Error('Project not found.')
  if (!enr.account_id && !enr.contact_id) {
    throw new Error('This project has no client account or contact to bill (lead/partner projects are not billable here).')
  }
  if (!enr.package_slug) throw new Error('This project has no package selected — set one before billing.')

  const { data: pkg } = await db
    .from('td_comm_packages')
    .select('name_en, price_usd')
    .eq('slug', enr.package_slug)
    .maybeSingle()
  const price = toAmount(pkg?.price_usd)
  if (price <= 0) throw new Error('The selected package has no price set — set the package price before billing.')

  const result = await createTDInvoice({
    account_id: enr.account_id ?? undefined,
    contact_id: enr.contact_id ?? undefined,
    line_items: [{ description: `TD Communication — ${pkg?.name_en ?? packageLabel(enr.package_slug)}`, unit_price: price }],
    currency: 'USD',
    payment_category: 'td_communication',
    idempotency_key: `td-comm:${enrollmentId}`,
    skip_credit_netting: true,
  })

  const alreadyBilled = enr.client_payment_id === result.paymentId
  if (enr.client_payment_id !== result.paymentId) {
    await db
      .from('td_comm_enrollments')
      .update({ client_payment_id: result.paymentId, updated_at: new Date().toISOString() })
      .eq('id', enrollmentId)
  }

  return { paymentId: result.paymentId, invoiceNumber: result.invoiceNumber, total: result.total, alreadyBilled }
}

/* -------------------------------------------------------------------------- */
/* Partner earnings (scoped, no client price)                                  */
/* -------------------------------------------------------------------------- */

/**
 * A worker's own earnings + balance + payout history. Selects an explicit, safe
 * column set and NEVER returns client price / invoice total (the partner must not
 * see TD's margin). Availability is derived from the linked payment status server-side.
 */
export async function getPartnerEarnings(workerPartnerId: string): Promise<PartnerEarnings> {
  const { data, error } = await db
    .from('td_comm_enrollments')
    .select('id, package_slug, status, partner_amount_usd, earning_locked_at, worker_partner_id, client_payment_id, client_paid_override_at')
    .eq('worker_partner_id', workerPartnerId)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  const rows = data ?? []

  const payments = await fetchLinkedPayments(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows.map((r: any) => r.client_payment_id).filter(Boolean),
  )
  const payouts = await fetchTdCommPayouts(workerPartnerId)

  const revEnrollments: RevenueEnrollment[] = []
  const paymentFor = new Map<string, LinkedPayment | null>()
  const projects: PartnerEarningRow[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of rows) {
    const e = revenueEnrollment(r)
    revEnrollments.push(e)
    const payment = e.client_payment_id ? payments.get(e.client_payment_id) ?? null : null
    paymentFor.set(e.id, payment)
    projects.push({
      id: e.id,
      packageLabel: packageLabel(r.package_slug),
      status: e.status,
      amount: earningAmount(e),
      recognized: isRecognized(e),
      clientPaid: isAvailable(e, payment), // recognized+paid; safe boolean, no amount
      available: isAvailable(e, payment),
    })
  }

  const balance = computePartnerBalance(revEnrollments, (e) => paymentFor.get(e.id) ?? null, payouts)
  return { balance, projects, payouts }
}

/**
 * Cris requests a payout: re-derive his ready-to-withdraw, reject overdraw, and
 * insert a `referral_payouts` row (payout_type='td_comm', referral_id NULL). The
 * approve/mark-paid lifecycle then runs on the existing partner-actions route.
 */
export async function createTdCommPayoutRequest(
  partnerId: string,
  amount: number,
  note: string | null,
  isTest = false,
): Promise<{ id: string }> {
  const { balance } = await getPartnerEarnings(partnerId)
  if (!canRequestPayout(amount, balance)) {
    throw new Error(
      `Requested amount exceeds your available balance (${Math.max(0, balance.readyToWithdraw)} available).`,
    )
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insert: any = {
    partner_id: partnerId,
    payout_type: TD_COMM_PAYOUT_TYPE,
    referral_id: null,
    amount,
    currency: 'USD',
    status: 'requested',
    requested_at: new Date().toISOString(),
    payout_request: note ? { note } : {},
    is_test: isTest,
  }
  const { data, error } = await db.from('referral_payouts').insert(insert).select('id').single()
  if (error) throw new Error(error.message)
  return { id: data.id }
}

/** Re-export for callers/tests that want the resolver. */
export { resolveDefaultCommWorker }
