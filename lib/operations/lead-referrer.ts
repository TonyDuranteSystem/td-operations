/**
 * The lead's referrer — ONE place that writes it (dev job 4bc21d49).
 *
 * Two doors lead here:
 *  1. the lead page's Referrer box  (`POST /api/crm/admin-actions/set-lead-referrer`)
 *  2. creating an offer from a lead with a referrer picked in the Create Offer window (`createOffer`)
 *
 * Before this file, door 2 never told the lead: the offer carried the referrer but the lead page showed none, no
 * pending referral existed, and the referrer's own Referrals list stayed empty until the client paid. Both doors now
 * go through `setLeadReferrer`, so the lead, the pending referral and the referrer's message always agree.
 *
 * What setting a referrer does (unchanged from the lead page's behaviour):
 *  - writes referrer name / contact id / account id on the lead;
 *  - reconciles the lead's PENDING referral (only pending rows are ever touched — a converted/credited/paid one never is);
 *  - creates the pending referral for a pinned (contact/account) referrer;
 *  - tells the referrer once per (referrer, lead) — a portal chat message plus an email (`notifyReferrerLinked`).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createPendingReferral, reconcilePendingReferral, type PendingReferralRow } from "@/lib/operations/referral"
import { notifyReferrerLinked } from "@/lib/operations/referral-notify"

export interface SetLeadReferrerInput {
  /** Typed / display name. Null clears the name. */
  referrerName: string | null
  /** A pinned person, and/or a pinned company or partner (the credit target). Both null = free text or cleared. */
  contactId: string | null
  accountId: string | null
}

export interface SetLeadReferrerResult {
  /** False only when nothing was saved (see `reason` + `error`). */
  ok: boolean
  reason?: "lead_not_found" | "update_failed"
  error?: string
  leadName: string | null
  /** Id of the pending referral created by this call, when one was. */
  referralCreated: string | null
  referralCancelled: number
  /** Why no pending referral was created (self_referral, duplicate, …), when none was. */
  referralSkip: string | null
}

/**
 * Set / change / clear a lead's referrer. `notify` (default true) tells the referrer when a NEW pending referral was
 * created; `awaitNotify` waits for that message to be sent (offer creation uses it, so the send is not cut off when
 * the request ends) instead of leaving it running in the background (the lead page's long-standing behaviour).
 */
export async function setLeadReferrer(
  leadId: string,
  input: SetLeadReferrerInput,
  options: { notify?: boolean; awaitNotify?: boolean; supabase?: typeof supabaseAdmin } = {},
): Promise<SetLeadReferrerResult> {
  const supabase = options.supabase ?? supabaseAdmin
  const { referrerName, contactId, accountId } = input

  const { data: lead } = await supabase.from("leads").select("full_name, email").eq("id", leadId).single()
  if (!lead) return { ok: false, reason: "lead_not_found", error: "Lead not found", leadName: null, referralCreated: null, referralCancelled: 0, referralSkip: null }
  const leadRow = lead as { full_name: string | null; email: string | null }

  // 1. Persist the referrer fields on the lead.
  const { error: updErr } = await supabase
    .from("leads")
    .update({
      referrer_name: referrerName,
      referrer_contact_id: contactId,
      referrer_account_id: accountId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)
  if (updErr) return { ok: false, reason: "update_failed", error: updErr.message, leadName: leadRow.full_name, referralCreated: null, referralCancelled: 0, referralSkip: null }

  // 2. Reconcile the lead's pending referral link. Only pending rows are touched.
  const { data: existingRaw } = await supabase
    .from("referrals")
    .select("id, referrer_contact_id, referrer_account_id, status")
    .eq("referred_lead_id", leadId)

  const existing = (existingRaw ?? []) as PendingReferralRow[]
  const next = contactId || accountId ? { contactId, accountId } : null
  const { cancelIds, createFor, updateAccountId } = reconcilePendingReferral(existing, next)

  let referralCancelled = 0
  if (cancelIds.length > 0) {
    const { error: cancelErr } = await supabase.from("referrals").update({ status: "cancelled" }).in("id", cancelIds)
    if (!cancelErr) referralCancelled = cancelIds.length
  }

  // Keep the kept referral's credit target in sync when staff change the "credit goes to" company for the same referrer.
  if (updateAccountId) {
    await supabase.from("referrals").update({ referrer_account_id: updateAccountId.accountId }).eq("id", updateAccountId.id)
  }

  let referralCreated: string | null = null
  let referralSkip: string | null = null
  if (createFor) {
    const res = await createPendingReferral(
      {
        referrerContactId: createFor.contactId,
        referrerAccountId: createFor.accountId,
        referredLeadId: leadId,
        referredName: leadRow.full_name || referrerName || "Lead",
        referredEmail: leadRow.email || "",
      },
      supabase,
    )
    if (res.created) {
      referralCreated = res.id
      if (options.notify !== false) {
        // Tell the referrer (chat + email), once per referrer-per-lead. Never throws.
        const sent = notifyReferrerLinked({
          referralId: res.id,
          referrerContactId: createFor.contactId,
          referrerAccountId: createFor.accountId,
          referredLeadId: leadId,
        })
        if (options.awaitNotify) await sent
        else void sent
      }
    } else if ("reason" in res) {
      referralSkip = res.reason
    }
  }

  return { ok: true, leadName: leadRow.full_name, referralCreated, referralCancelled, referralSkip }
}

// ─── Offer → lead sync ────────────────────────────────────

export interface LeadReferrerFields {
  referrer_name: string | null
  referrer_contact_id: string | null
  referrer_account_id: string | null
}

export type LeadReferrerSyncDecision =
  /** The offer's pinned referrer should be written onto the lead. */
  | { action: "set" }
  /** The lead already points at the same person / company — nothing to do. */
  | { action: "same" }
  /** The lead already points at someone ELSE. Never overwritten. */
  | { action: "conflict"; leadReferrerName: string | null }
  /** Only a typed name (no linked client) — never copied to the lead (see below). */
  | { action: "skip"; reason: "not_pinned" }

/**
 * Decide what creating an offer should do to the lead's referrer.
 *
 * ⛔ Only a PINNED referrer (a person or company picked from the list) is ever copied to the lead. A typed free-text
 * name is NOT: the offer builder auto-fills the lead's name onto every later offer as a 10% credit-note referrer, so
 * copying a marketing answer ("Instagram", "amici") onto the lead would turn it into real commission on later offers.
 *
 * "Pinned on the lead" means a contact or company id. A lead holding only a typed name counts as having no referrer:
 * a picked client is a stronger version of the same fact, and the lead page's own box replaces a typed name the same way.
 * A lead already pinned to a DIFFERENT person/company is never overwritten — the caller warns instead.
 */
export function decideLeadReferrerSync(
  lead: LeadReferrerFields | null,
  offer: { contactId: string | null; accountId: string | null },
): LeadReferrerSyncDecision {
  if (!offer.contactId && !offer.accountId) return { action: "skip", reason: "not_pinned" }
  const leadPinned = !!(lead?.referrer_contact_id || lead?.referrer_account_id)
  if (!lead || !leadPinned) return { action: "set" }
  const sameContact = !!offer.contactId && lead.referrer_contact_id === offer.contactId
  const sameAccount = !!offer.accountId && lead.referrer_account_id === offer.accountId
  if (sameContact || sameAccount) return { action: "same" }
  return { action: "conflict", leadReferrerName: lead.referrer_name }
}

export interface OfferReferrerSyncResult {
  outcome: "set" | "same" | "conflict" | "skipped" | "failed"
  /** Plain sentence for the staff member, when something needs their attention. */
  warning?: string
}

/**
 * After an offer is created from a lead: make the lead carry the offer's pinned referrer. NEVER throws — the offer
 * already exists, so a failure here becomes a warning the author sees, not a failed offer.
 */
export async function syncOfferReferrerToLead(
  leadId: string,
  offer: { referrerName: string | null; contactId: string | null; accountId: string | null },
  options: { supabase?: typeof supabaseAdmin } = {},
): Promise<OfferReferrerSyncResult> {
  try {
    if (!offer.contactId && !offer.accountId) return { outcome: "skipped" }
    const supabase = options.supabase ?? supabaseAdmin

    const { data } = await supabase
      .from("leads")
      .select("referrer_name, referrer_contact_id, referrer_account_id")
      .eq("id", leadId)
      .maybeSingle()
    const lead = (data ?? null) as LeadReferrerFields | null
    if (!lead) return { outcome: "skipped" }

    const decision = decideLeadReferrerSync(lead, { contactId: offer.contactId, accountId: offer.accountId })
    if (decision.action === "skip") return { outcome: "skipped" }
    if (decision.action === "same") return { outcome: "same" }
    if (decision.action === "conflict") {
      const onLead = decision.leadReferrerName?.trim() || "another referrer"
      const onOffer = offer.referrerName?.trim() || "a different referrer"
      return {
        outcome: "conflict",
        warning: `Referrer mismatch: the lead lists ${onLead} but this offer lists ${onOffer}. When the client pays, only ONE referrer is credited — make the lead's Referrer box and the offer match.`,
      }
    }

    const res = await setLeadReferrer(
      leadId,
      { referrerName: offer.referrerName, contactId: offer.contactId, accountId: offer.accountId },
      { notify: true, awaitNotify: true, supabase },
    )
    if (!res.ok) {
      return {
        outcome: "failed",
        warning: `The offer was created with its referrer, but the referrer could not be added to the lead (${res.error}). Set it in the lead's Referrer box.`,
      }
    }
    return { outcome: "set" }
  } catch (err) {
    return {
      outcome: "failed",
      warning: `The offer was created with its referrer, but the referrer could not be added to the lead (${err instanceof Error ? err.message : String(err)}). Set it in the lead's Referrer box.`,
    }
  }
}
