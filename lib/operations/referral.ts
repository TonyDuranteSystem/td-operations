import type { SupabaseClient } from "@supabase/supabase-js"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { calculateCommission } from "@/lib/referral-utils"

export const REFERRAL_COMMISSION_PCT = 10

export interface PendingReferralParams {
  referrerContactId: string
  referredLeadId: string
  referredName: string
  referredEmail: string
}

export type PendingReferralResult =
  | { created: true; id: string }
  | { created: false; reason: "self_referral" | "duplicate" | "error"; detail?: string }

/**
 * Create a pending referral linking a referring client to a referred lead.
 * Guards:
 *  - self-referral: the referrer cannot refer their own email
 *  - duplicate: one referral per (referrer, referred lead)
 * The referral is created in 'pending' status; it advances to 'converted' when
 * the referred lead becomes a paying client, then 'credited' when the reward is issued.
 */
export async function createPendingReferral(
  params: PendingReferralParams,
  supabase: SupabaseClient
): Promise<PendingReferralResult> {
  const { referrerContactId, referredLeadId, referredName, referredEmail } = params

  // Self-referral guard
  const { data: refContact } = await supabase
    .from("contacts")
    .select("email")
    .eq("id", referrerContactId)
    .maybeSingle()
  if (
    refContact?.email &&
    referredEmail &&
    refContact.email.toLowerCase() === referredEmail.toLowerCase()
  ) {
    return { created: false, reason: "self_referral" }
  }

  // Dedup guard
  const { data: existing } = await supabase
    .from("referrals")
    .select("id")
    .eq("referrer_contact_id", referrerContactId)
    .eq("referred_lead_id", referredLeadId)
    .limit(1)
  if (existing && existing.length > 0) {
    return { created: false, reason: "duplicate" }
  }

  const { data, error } = await supabase
    .from("referrals")
    .insert({
      referrer_contact_id: referrerContactId,
      referred_lead_id: referredLeadId,
      referred_name: referredName,
      referrer_type: "client",
      status: "pending",
    } as Record<string, unknown> as never)
    .select("id")
    .single()

  if (error || !data) {
    return { created: false, reason: "error", detail: error?.message }
  }
  return { created: true, id: (data as { id: string }).id }
}

export interface CreditReferrerParams {
  /** The referred client's lead id (matches referrals.referred_lead_id). */
  referredLeadId: string
  /** Resolved contact/account of the referred client (now a paying client). */
  referredContactId: string | null
  referredAccountId: string | null
  /** The setup fee the referred client paid — basis for the 10% credit. */
  setupFeeTotal: number
  currency?: "EUR" | "USD"
}

export interface CreditReferrerResult {
  issued: boolean
  referralId?: string
  amount?: number
  paymentId?: string
  reason?: string
}

/**
 * Issue a referral reward credit note: a negative-total `payments` row on the
 * referrer's account (USD by default — the figure is taken directly, no FX, so
 * it nets against the referrer's USD installments), tagged
 * `invoice_status='Credit'` with `credit_remaining`, and flip the referral to
 * `credited`. Idempotent per referral via `idempotency_key='referral-credit:<id>'`.
 * Shared by the Calendly-payment path (`creditReferrerForLead`) and the
 * offer-referrer path (activate-service Step 3.5).
 */
export async function issueReferralCreditNote(
  params: {
    referralId: string
    referrerAccountId: string
    amount: number
    currency?: "EUR" | "USD"
    description?: string
  },
  supabase: SupabaseClient
): Promise<{ paymentId: string }> {
  const currency = params.currency || "USD"
  const amount = Math.abs(params.amount)
  const today = new Date().toISOString().split("T")[0]

  const result = await createTDInvoice({
    account_id: params.referrerAccountId,
    line_items: [
      {
        description: params.description || `Referral reward — ${REFERRAL_COMMISSION_PCT}% credit`,
        unit_price: -amount,
        quantity: 1,
      },
    ],
    currency,
    mark_as_paid: true,
    paid_date: today,
    idempotency_key: `referral-credit:${params.referralId}`,
    skip_credit_netting: true, // this IS a credit note — must not net into itself
  })

  // Tag it as a credit and finalize the referral.
  // eslint-disable-next-line no-restricted-syntax -- credit-note status tag on the payments row created via createTDInvoice (sanctioned write path)
  await supabase
    .from("payments")
    .update({ invoice_status: "Credit", credit_remaining: amount })
    .eq("id", result.paymentId)
  await supabase
    .from("referrals")
    .update({ status: "credited", credited_amount: amount })
    .eq("id", params.referralId)

  return { paymentId: result.paymentId }
}

/**
 * Decide whether a referral can be auto-credited at activation: it needs a
 * referrer account to credit and a positive commission amount. Otherwise the
 * caller falls back to a manual "process commission" task so nothing is lost.
 * Pure — unit tested.
 */
export function decideReferralAutoCredit(input: {
  commissionAmount: number | null | undefined
  referrerAccountId: string | null | undefined
}): { autoCredit: boolean; reason: "ok" | "no_referrer_account" | "zero_amount" } {
  if (!input.referrerAccountId) return { autoCredit: false, reason: "no_referrer_account" }
  if (!input.commissionAmount || input.commissionAmount <= 0) return { autoCredit: false, reason: "zero_amount" }
  return { autoCredit: true, reason: "ok" }
}

/**
 * Derive the referral commission (type, pct, amount, currency) from an offer's
 * referrer fields + the referred client's setup-fee total. Mirrors the
 * historical inline logic in activate-service Step 3.5, extracted so it can be
 * unit-tested. Reward currency is always USD (the figure is taken directly from
 * the EUR setup fee, no FX, so it nets against USD installments). Pure.
 */
export function resolveOfferCommission(
  offer: {
    referrer_commission_type?: string | null
    referrer_type?: string | null
    referrer_commission_pct?: number | null
    referrer_agreed_price?: number | null
  },
  setupFeeTotal: number,
): { commissionType: string; commissionPct: number | null; commissionAmount: number; commissionCurrency: "USD" } {
  const commissionType = offer.referrer_commission_type
    || (offer.referrer_type === "partner" ? "price_difference" : "credit_note")
  const commissionPct = offer.referrer_commission_pct ?? (commissionType !== "price_difference" ? 10 : null)
  const commissionAmount = calculateCommission(
    commissionType,
    commissionPct,
    offer.referrer_agreed_price || null,
    setupFeeTotal,
    setupFeeTotal, // basePriceForState = full setup fee for price_difference calc
  )
  return { commissionType, commissionPct, commissionAmount, commissionCurrency: "USD" }
}

/**
 * Called when a referred client's PAYMENT is received (activation). Converts the
 * pending client referral and auto-creates the referrer's reward credit note:
 * a negative-total `payments` row on the referrer's account that nets against
 * their next TD invoice. Idempotent (idempotency_key on the invoice + status
 * gate on the referral) and fail-safe (caller wraps in try/catch).
 */
export async function creditReferrerForLead(
  params: CreditReferrerParams,
  supabase: SupabaseClient
): Promise<CreditReferrerResult> {
  const { referredLeadId, referredContactId, referredAccountId } = params
  // Referral reward is ALWAYS USD so it nets against the referrer's USD installments
  // (setup fees are EUR, installments USD — KB Currency Rule). The 10% figure is
  // taken directly as USD (no FX conversion), per Antonio 2026-05-27.
  const currency = params.currency || "USD"

  // Only act on a pending CLIENT referral for this referred lead.
  const { data: ref } = await supabase
    .from("referrals")
    .select("id, referrer_contact_id, referrer_account_id, status")
    .eq("referred_lead_id", referredLeadId)
    .eq("referrer_type", "client")
    .eq("status", "pending")
    .maybeSingle()

  if (!ref) return { issued: false, reason: "no_pending_referral" }
  const referral = ref as {
    id: string
    referrer_contact_id: string | null
    referrer_account_id: string | null
  }

  const commissionAmount =
    Math.round((REFERRAL_COMMISSION_PCT / 100) * params.setupFeeTotal * 100) / 100

  // Mark converted + link the referred party (regardless of whether a credit issues).
  await supabase
    .from("referrals")
    .update({
      status: "converted",
      referred_contact_id: referredContactId,
      referred_account_id: referredAccountId,
      commission_type: "credit_note",
      commission_pct: REFERRAL_COMMISSION_PCT,
      commission_amount: commissionAmount || null,
      commission_currency: currency,
    })
    .eq("id", referral.id)

  if (commissionAmount <= 0) {
    return { issued: false, reason: "zero_setup_fee", referralId: referral.id }
  }

  // Resolve the referrer's account to credit.
  let referrerAccountId = referral.referrer_account_id
  if (!referrerAccountId && referral.referrer_contact_id) {
    const { data: link } = await supabase
      .from("account_contacts")
      .select("account_id")
      .eq("contact_id", referral.referrer_contact_id)
      .limit(1)
      .maybeSingle()
    referrerAccountId = (link as { account_id: string } | null)?.account_id ?? null
  }
  if (!referrerAccountId) {
    return { issued: false, reason: "no_referrer_account", referralId: referral.id }
  }

  // Auto-create the credit note (negative invoice), idempotent per referral.
  const { paymentId } = await issueReferralCreditNote(
    {
      referralId: referral.id,
      referrerAccountId,
      amount: commissionAmount,
      currency,
      description: `Referral reward — ${REFERRAL_COMMISSION_PCT}% credit`,
    },
    supabase,
  )

  return { issued: true, referralId: referral.id, amount: commissionAmount, paymentId }
}

/**
 * Default referral-reward credit for a manual add: 10% of the referred client's
 * setup-fee total, taken DIRECTLY as USD (no FX), per the referral reward rule.
 * Pure — unit tested. Staff may override the result before confirming.
 */
export function defaultReferralCreditUsd(referredSetupFeeTotal: number | null | undefined): number {
  const base = typeof referredSetupFeeTotal === "number" && referredSetupFeeTotal > 0 ? referredSetupFeeTotal : 0
  return Math.round((REFERRAL_COMMISSION_PCT / 100) * base * 100) / 100
}

export interface ManualReferralParams {
  /** Referrer side — a contact and/or an account (at least one). If only a
   *  contact is given, the credit lands on the contact's linked account. */
  referrerContactId?: string | null
  referrerAccountId?: string | null
  /** Referred side — a contact and/or an account (at least one). */
  referredContactId?: string | null
  referredAccountId?: string | null
  /** 'client' (default) or 'partner' — based on the referrer actor's type. */
  referrerType?: string
  referredName: string
  /** USD credit amount — already resolved (auto 10% default or staff override). */
  creditAmountUsd: number
  note?: string | null
}

export type ManualReferralResult =
  | { created: true; referralId: string; paymentId: string; amount: number }
  | { created: false; reason: "invalid_amount" | "missing_party" | "no_referrer_account" | "self_referral" | "duplicate" | "error"; detail?: string }

/**
 * Manually record a referral (staff-entered) and immediately issue the referrer's
 * USD credit note. Either side may be a CONTACT or an ACCOUNT (any type, incl.
 * Partner). The credit always lands on the referrer's ACCOUNT (resolved from the
 * contact when only a contact is given). Unlike the organic creditReferrerForLead
 * flow, this is for admin-added referrals where the parties already exist.
 *
 * Guards: positive amount; both parties present; referrer resolves to an account;
 * no self-referral; dedup per (referrer, referred). Credit note is idempotent.
 */
export async function createManualReferralCredit(
  params: ManualReferralParams,
  supabase: SupabaseClient,
): Promise<ManualReferralResult> {
  const { referrerContactId, referrerAccountId, referredContactId, referredAccountId, referredName, creditAmountUsd, note } = params
  const referrerType = params.referrerType === "partner" ? "partner" : "client"

  if (!(creditAmountUsd > 0)) return { created: false, reason: "invalid_amount" }
  if (!referrerContactId && !referrerAccountId) return { created: false, reason: "missing_party", detail: "referrer" }
  if (!referredContactId && !referredAccountId) return { created: false, reason: "missing_party", detail: "referred" }

  // Credit the CHOSEN referrer entity DIRECTLY — staff explicitly pick who gets
  // the credit: a company (account) OR an individual (contact). Both can be the
  // active client. NO auto contact→account resolution: whoever was picked is
  // credited and shown as the referrer.
  const creditAccountId = referrerAccountId ?? null
  const creditContactId = creditAccountId ? null : (referrerContactId ?? null)
  if (!creditAccountId && !creditContactId) return { created: false, reason: "no_referrer_account" }
  if (creditAccountId && referredAccountId && creditAccountId === referredAccountId) return { created: false, reason: "self_referral" }

  // Dedup: match on the chosen referrer entity + the strongest referred id.
  let dq = supabase.from("referrals").select("id")
  dq = creditAccountId ? dq.eq("referrer_account_id", creditAccountId) : dq.eq("referrer_contact_id", creditContactId as string)
  if (referredAccountId) dq = dq.eq("referred_account_id", referredAccountId)
  else if (referredContactId) dq = dq.eq("referred_contact_id", referredContactId)
  const { data: existing } = await dq.limit(1)
  if (existing && (existing as unknown[]).length > 0) return { created: false, reason: "duplicate" }

  // Create the USD credit note (negative invoice), idempotent.
  const refKey = creditAccountId || creditContactId
  const rdKey = referredAccountId || referredContactId
  const today = new Date().toISOString().split("T")[0]
  let result
  try {
    result = await createTDInvoice({
      account_id: creditAccountId ?? undefined,
      contact_id: creditContactId ?? undefined,
      line_items: [
        {
          description: `Referral reward — ${REFERRAL_COMMISSION_PCT}% credit (${referredName})`,
          unit_price: -Math.abs(creditAmountUsd),
          quantity: 1,
        },
      ],
      currency: "USD",
      mark_as_paid: true,
      paid_date: today,
      idempotency_key: `manual-referral:${refKey}:${rdKey}`,
      skip_credit_netting: true, // this IS a credit note — must not net into itself
    })
  } catch (e) {
    return { created: false, reason: "error", detail: e instanceof Error ? e.message : String(e) }
  }

  // eslint-disable-next-line no-restricted-syntax -- credit-note status tag, mirrors creditReferrerForLead sanctioned write path
  await supabase
    .from("payments")
    .update({ invoice_status: "Credit", credit_remaining: creditAmountUsd })
    .eq("id", result.paymentId)

  // Record the referral as already credited.
  const { data: ref, error: refErr } = await supabase
    .from("referrals")
    .insert({
      referrer_contact_id: creditContactId,
      referrer_account_id: creditAccountId,
      referred_contact_id: referredContactId ?? null,
      referred_account_id: referredAccountId ?? null,
      referred_name: referredName,
      referrer_type: referrerType,
      status: "credited",
      commission_type: "credit_note",
      commission_pct: REFERRAL_COMMISSION_PCT,
      commission_amount: creditAmountUsd,
      commission_currency: "USD",
      credited_amount: creditAmountUsd,
      notes: note || "Manually added via referrals page",
    } as Record<string, unknown> as never)
    .select("id")
    .single()

  if (refErr || !ref) return { created: false, reason: "error", detail: refErr?.message }

  // Click-to-apply (2026-06-03): the referral credit is NOT auto-applied to an
  // existing invoice. It sits as available credit_remaining and lands on whichever
  // invoice staff click Regenerate on (regenerateInvoice). This prevents a credit
  // earned now from silently reducing an old/overdue invoice instead of the
  // current one (the Wise Strategies bug).
  return { created: true, referralId: (ref as { id: string }).id, paymentId: result.paymentId, amount: creditAmountUsd }
}
