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
 * Shared by the Calendly-payment path (`creditReferrerForLead`), the
 * offer-referrer path (activate-service Step 3.5) and the manual referrals page.
 *
 * The credit target is the referrer's ACCOUNT when one is given (contact id, if
 * also given, is stored alongside for attribution). A contact-only target is
 * allowed for people with no company, but such a personal credit can only be
 * applied to personal (contact-scoped) invoices — credit application is
 * account-keyed (see lib/operations/credit-netting.ts).
 */
export async function issueReferralCreditNote(
  params: {
    referralId: string
    referrerAccountId?: string | null
    referrerContactId?: string | null
    amount: number
    currency?: "EUR" | "USD"
    description?: string
  },
  supabase: SupabaseClient
): Promise<{ paymentId: string }> {
  if (!params.referrerAccountId && !params.referrerContactId) {
    throw new Error("issueReferralCreditNote: a referrer account_id or contact_id is required")
  }
  const currency = params.currency || "USD"
  const amount = Math.abs(params.amount)
  const today = new Date().toISOString().split("T")[0]

  const result = await createTDInvoice({
    account_id: params.referrerAccountId ?? undefined,
    contact_id: params.referrerContactId ?? undefined,
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
 * Self-heal guard: a referral that's already 'converted' but never got its credit
 * (a prior activation was killed between inserting the referral and issuing the
 * credit) should be credited now. Pending referrals are left to the normal flow;
 * already-credited ones are skipped. Pure — unit tested. The actual credit is
 * idempotent (issueReferralCreditNote), so re-running can never double-pay.
 */
export function shouldRecoverReferralCredit(input: {
  status: string | null | undefined
  creditedAmount: number | null | undefined
  commissionAmount: number | null | undefined
}): boolean {
  const status = (input.status || "").toLowerCase()
  return status === "converted" && !input.creditedAmount && !!input.commissionAmount && Number(input.commissionAmount) > 0
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

export interface BacklogReferralInput {
  id: string
  referrer_contact_id: string | null
  referrer_account_id: string | null
  referred_contact_id: string | null
  referred_account_id: string | null
  referred_lead_id: string | null
  referred_name: string | null
  status: string
  commission_amount: number | null
  credited_amount: number | null
}

export type BacklogDecision =
  | { action: "cancel_duplicate"; duplicateOfId: string }
  | { action: "credit"; accountId: string; amount: number }
  | {
      action: "skip"
      reason: "no_amount" | "no_referrer" | "no_account" | "multiple_accounts"
      /** For multiple_accounts: the candidates staff must choose between. */
      accountIds?: string[]
    }

/** Two referral rows point at the same referred person if any hard id matches,
 *  or (fallback) the referred names match case-insensitively. Pure. */
export function sameReferredIdentity(a: BacklogReferralInput, b: BacklogReferralInput): boolean {
  if (a.referred_lead_id && a.referred_lead_id === b.referred_lead_id) return true
  if (a.referred_contact_id && a.referred_contact_id === b.referred_contact_id) return true
  if (a.referred_account_id && a.referred_account_id === b.referred_account_id) return true
  const an = (a.referred_name || "").trim().toLowerCase()
  const bn = (b.referred_name || "").trim().toLowerCase()
  return !!an && an === bn
}

/**
 * Decide what to do with ONE converted-but-uncredited backlog referral. Pure —
 * unit tested; the reconciler script (scripts/reconcile-referral-backlog.ts)
 * supplies the context and executes the decision.
 *
 * Rules (mirror the live auto-credit path):
 *  - A credited/paid sibling for the SAME (referrer → referred) → this row is a
 *    duplicate: cancel it (crediting it would double-pay — the Grifa case).
 *  - Referrer resolves to exactly ONE account + positive amount → credit (USD,
 *    the recorded figure taken directly, no FX — the standard reward rule).
 *  - Anything ambiguous (no referrer, no account, several accounts, no amount)
 *    → skip with the reason; NEVER guessed. Staff decide those.
 */
export function decideBacklogReferral(
  row: BacklogReferralInput,
  ctx: {
    /** Non-cancelled referrals by the same referrer (any scoping), excluding this row. */
    siblingReferrals: BacklogReferralInput[]
    /** Accounts the referrer resolves to: [referrer_account_id] when account-keyed,
     *  else the contact's linked account ids. */
    referrerAccountIds: string[]
  },
): BacklogDecision {
  const duplicate = ctx.siblingReferrals.find(
    (s) => s.id !== row.id && ["credited", "paid"].includes(s.status) && sameReferredIdentity(row, s),
  )
  if (duplicate) return { action: "cancel_duplicate", duplicateOfId: duplicate.id }

  if (!row.referrer_contact_id && !row.referrer_account_id) return { action: "skip", reason: "no_referrer" }

  const accounts = Array.from(new Set(ctx.referrerAccountIds.filter(Boolean)))
  if (accounts.length === 0) return { action: "skip", reason: "no_account" }
  if (accounts.length > 1) return { action: "skip", reason: "multiple_accounts", accountIds: accounts }

  const amount = Number(row.commission_amount) || 0
  if (amount <= 0) return { action: "skip", reason: "no_amount" }

  return { action: "credit", accountId: accounts[0], amount }
}

export interface ManualReferralParams {
  /** Referrer side — a contact and/or an account (at least one). When an account
   *  is given the credit lands on the ACCOUNT (the contact id, if also given, is
   *  kept for attribution + dedup). Contact-only = a personal credit. */
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
  | { created: true; referralId: string; paymentId: string; amount: number; recovered?: boolean }
  | { created: false; reason: "invalid_amount" | "missing_party" | "no_referrer_account" | "self_referral" | "duplicate" | "error"; detail?: string }

/**
 * Manually record a referral (staff-entered) and immediately issue the referrer's
 * USD credit note. Either side may be a CONTACT or an ACCOUNT (any type, incl.
 * Partner). The credit lands on the referrer's ACCOUNT when one was chosen
 * (the UI defaults a person to their company); a contact-only referrer gets a
 * PERSONAL credit, which only nets against contact-scoped invoices.
 *
 * Ordering (2026-07-08): the referral row is inserted FIRST (converted), then the
 * credit note is issued via the shared issueReferralCreditNote (which flips it to
 * credited). If the credit fails, the row remains converted-but-uncredited and a
 * RETRY of the same add goes through the dedup→self-heal path below and issues
 * the credit idempotently — no orphan credit notes, no lost commissions.
 *
 * Guards: positive amount; both parties present; no self-referral; dedup per
 * (referrer, referred) matched across BOTH contact and account scoping, ignoring
 * cancelled rows. Credit note is idempotent per referral (referral-credit:<id>).
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

  const creditAccountId = referrerAccountId ?? null
  const creditContactId = referrerContactId ?? null
  if (creditAccountId && referredAccountId && creditAccountId === referredAccountId) return { created: false, reason: "self_referral" }
  if (creditContactId && referredContactId && creditContactId === referredContactId) return { created: false, reason: "self_referral" }

  // Dedup across scoping: the same referrer may exist contact-keyed on one row
  // and account-keyed on another — match either. Cancelled rows don't block.
  const referrerOr = [
    creditAccountId ? `referrer_account_id.eq.${creditAccountId}` : null,
    creditContactId ? `referrer_contact_id.eq.${creditContactId}` : null,
  ].filter(Boolean).join(",")
  let dq = supabase
    .from("referrals")
    .select("id, status, credited_amount, commission_amount, commission_currency")
    .or(referrerOr)
    .neq("status", "cancelled")
  if (referredAccountId) dq = dq.eq("referred_account_id", referredAccountId)
  else if (referredContactId) dq = dq.eq("referred_contact_id", referredContactId)
  const { data: existing } = await dq.limit(1)
  const existingRow = (existing ?? [])[0] as { id: string; status: string; credited_amount: number | null; commission_amount: number | null; commission_currency: string | null } | undefined

  if (existingRow) {
    // Self-heal: a prior attempt (or the organic path) left this referral
    // converted-but-uncredited — issue the credit now instead of failing.
    const recoverAmount = Number(existingRow.commission_amount) || creditAmountUsd
    if (shouldRecoverReferralCredit({ status: existingRow.status, creditedAmount: existingRow.credited_amount, commissionAmount: recoverAmount })) {
      try {
        const { paymentId } = await issueReferralCreditNote(
          {
            referralId: existingRow.id,
            referrerAccountId: creditAccountId,
            referrerContactId: creditContactId,
            amount: recoverAmount,
            currency: "USD",
            description: `Referral reward — ${REFERRAL_COMMISSION_PCT}% credit (${referredName})`,
          },
          supabase,
        )
        // Keep the recovered row coherent with the USD credit actually issued:
        // fill a missing amount, and stamp the reward currency (a legacy row can
        // carry EUR, which would render "€ paid" for a $ credit).
        if (!existingRow.commission_amount || existingRow.commission_currency !== "USD") {
          await supabase
            .from("referrals")
            .update({ commission_type: "credit_note", commission_pct: REFERRAL_COMMISSION_PCT, commission_amount: recoverAmount, commission_currency: "USD" })
            .eq("id", existingRow.id)
        }
        return { created: true, referralId: existingRow.id, paymentId, amount: recoverAmount, recovered: true }
      } catch (e) {
        return { created: false, reason: "error", detail: e instanceof Error ? e.message : String(e) }
      }
    }
    return { created: false, reason: "duplicate" }
  }

  // Insert the referral row FIRST (converted; issueReferralCreditNote flips it
  // to credited). Both referrer ids are stored when known, so the row stays
  // attributed to the person even when the credit lands on their company.
  const { data: ref, error: refErr } = await supabase
    .from("referrals")
    .insert({
      referrer_contact_id: creditContactId,
      referrer_account_id: creditAccountId,
      referred_contact_id: referredContactId ?? null,
      referred_account_id: referredAccountId ?? null,
      referred_name: referredName,
      referrer_type: referrerType,
      status: "converted",
      commission_type: "credit_note",
      commission_pct: REFERRAL_COMMISSION_PCT,
      commission_amount: creditAmountUsd,
      commission_currency: "USD",
      credited_amount: 0,
      notes: note || "Manually added via referrals page",
    } as Record<string, unknown> as never)
    .select("id")
    .single()

  if (refErr || !ref) return { created: false, reason: "error", detail: refErr?.message }
  const referralId = (ref as { id: string }).id

  try {
    const { paymentId } = await issueReferralCreditNote(
      {
        referralId,
        referrerAccountId: creditAccountId,
        referrerContactId: creditContactId,
        amount: creditAmountUsd,
        currency: "USD",
        description: `Referral reward — ${REFERRAL_COMMISSION_PCT}% credit (${referredName})`,
      },
      supabase,
    )
    // Click-to-apply (2026-06-03): the referral credit is NOT auto-applied to an
    // existing invoice. It sits as available credit_remaining and lands on whichever
    // invoice staff click Regenerate on (regenerateInvoice). This prevents a credit
    // earned now from silently reducing an old/overdue invoice instead of the
    // current one (the Wise Strategies bug).
    return { created: true, referralId, paymentId, amount: creditAmountUsd }
  } catch (e) {
    // The referral row remains converted-but-uncredited: retrying the same add
    // recovers it via the dedup→self-heal path above (idempotent credit).
    return { created: false, reason: "error", detail: e instanceof Error ? e.message : String(e) }
  }
}
