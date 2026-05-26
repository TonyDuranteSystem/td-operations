import type { SupabaseClient } from "@supabase/supabase-js"

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
