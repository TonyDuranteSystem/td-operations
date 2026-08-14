/**
 * Referral Utilities — Commission calculation and referral code generation
 */

import type { SupabaseClient } from "@supabase/supabase-js"

// Base prices for commission calculation (EUR)
export const BASE_PRICES = {
  SMLLC: 2500,
  MMLLC: 3000,
  DE_FL_SURCHARGE: 300,
} as const

/**
 * Generate a unique referral code from a contact's full name.
 * Format: LASTNAME-YYYY (e.g., GREPPI-2026)
 * Handles collisions by appending -2, -3, etc.
 */
export async function generateReferralCode(
  fullName: string,
  supabase: SupabaseClient
): Promise<string> {
  // Format: first-last, lowercase, hyphenated (e.g. "marco-rossi"). No year —
  // uniqueness is guaranteed by the DB index + the collision suffix below.
  const clean = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  const first = clean(parts[0] || "")
  const rest = parts.slice(1).map(clean).join("") // join any middle/last names
  // Fallbacks: single-word name → just that word; unusable (non-Latin) → "client".
  const baseCode = first && rest ? `${first}-${rest}` : first || "client"

  // Check for collisions (case-insensitive)
  const { data } = await supabase
    .from("contacts")
    .select("referral_code")
    .ilike("referral_code", `${baseCode}%`)

  if (!data || data.length === 0) return baseCode

  const existing = new Set(data.map((r) => r.referral_code?.toLowerCase()))
  if (!existing.has(baseCode.toLowerCase())) return baseCode

  // Find next available suffix
  let suffix = 2
  while (existing.has(`${baseCode}-${suffix}`.toLowerCase())) {
    suffix++
  }
  return `${baseCode}-${suffix}`
}

/**
 * Ensure a contact has a referral_code, generating one on-demand if missing.
 * Idempotent: returns the existing code if present, otherwise generates from
 * the contact's full_name, persists it, and returns it. Returns null only when
 * the contact has no usable name to generate from.
 */
export async function ensureReferralCode(
  contactId: string,
  supabase: SupabaseClient
): Promise<string | null> {
  const { data: contact } = await supabase
    .from("contacts")
    .select("referral_code, full_name")
    .eq("id", contactId)
    .single()

  if (contact?.referral_code) return contact.referral_code
  if (!contact?.full_name) return null

  const code = await generateReferralCode(contact.full_name, supabase)
  // eslint-disable-next-line no-restricted-syntax -- referral_code-only write; mirrors the existing partner path (portal.ts). Not a tier/identity field; no lib/operations helper needed.
  const { error } = await supabase
    .from("contacts")
    .update({ referral_code: code })
    .eq("id", contactId)
    .is("referral_code", null) // guard: don't clobber a code set concurrently

  if (error) {
    // Lost a race (unique index) — re-read whatever landed.
    const { data: again } = await supabase
      .from("contacts")
      .select("referral_code")
      .eq("id", contactId)
      .single()
    return again?.referral_code ?? null
  }
  return code
}

/** Minimal shape needed to de-duplicate referral rows. */
export interface DedupeReferralInput {
  id: string
  referrer_contact_id: string | null
  referrer_account_id: string | null
  referred_contact_id: string | null
  referred_account_id: string | null
  referred_name: string | null
  status: string
  created_at: string
}

// Higher rank = more progressed; the most-progressed row wins a duplicate pair.
const REFERRAL_STATUS_RANK: Record<string, number> = {
  paid: 5,
  credited: 4,
  converted: 3,
  pending: 2,
}
const referralRank = (status: string): number => REFERRAL_STATUS_RANK[status] ?? 1

/**
 * De-duplicate referral rows down to one per (referrer → referred person)
 * relationship, dropping cancelled rows entirely.
 *
 * Why: historic bulk imports created a "pending" row and later a SEPARATE
 * "converted" row for the SAME pair, which double-counted the referrer in the
 * dashboard ("2 referrals" when there was really 1). This collapses such pairs,
 * keeping the most-progressed row (paid > credited > converted > pending), and
 * preserves input order (callers pass newest-first). Rows missing a referrer or
 * referred identity can't be safely compared, so they are kept as-is (keyed by id).
 */
export function dedupeActiveReferrals<T extends DedupeReferralInput>(rows: T[]): T[] {
  const referrerKeyOf = (r: T) => r.referrer_contact_id || r.referrer_account_id || ""
  const referredKeyOf = (r: T) =>
    r.referred_contact_id || r.referred_account_id || r.referred_name || ""
  const dupKeyOf = (r: T) => {
    const rk = referrerKeyOf(r)
    const dk = referredKeyOf(r)
    return rk && dk ? `${rk}::${dk}` : `id:${r.id}`
  }

  const winners = new Map<string, T>()
  const order: string[] = []
  for (const r of rows) {
    if (r.status === "cancelled") continue
    const k = dupKeyOf(r)
    const existing = winners.get(k)
    if (!existing) {
      winners.set(k, r)
      order.push(k)
    } else if (referralRank(r.status) > referralRank(existing.status)) {
      winners.set(k, r)
    }
  }
  return order.map((k) => winners.get(k) as T)
}

/**
 * Calculate commission amount based on type.
 * - percentage: pct/100 × setupFeeTotal
 * - price_difference: agreedPrice - basePriceForState
 * - credit_note: same as percentage
 */
export function calculateCommission(
  commissionType: string,
  commissionPct: number | null,
  agreedPrice: number | null,
  setupFeeTotal: number,
  basePriceForState: number
): number {
  switch (commissionType) {
    case "percentage":
    case "credit_note":
      // ⛔ NULLISH, NOT `||` (bug-hunter, 2026-08-14) — `commissionPct || 10` treated an explicit,
      // deliberate 0% (a comped/waived referral) as "not set" and silently substituted the 10%
      // default, overpaying a referrer who was agreed to receive nothing. `resolveOfferCommission`
      // already correctly preserves a real 0 on the way in (`?? 10`, not `|| 10`); this function
      // undid that the moment it touched the value. Only `null`/`undefined` should fall back.
      return ((commissionPct ?? 10) / 100) * setupFeeTotal

    case "price_difference":
      return (agreedPrice || 0) - basePriceForState

    default:
      return 0
  }
}
