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
  const parts = fullName.trim().split(/\s+/)
  const sanitize = (s: string) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  // Prefer last name; fall back to first name, then "CLIENT" — never produce an
  // empty stem (single-word / non-Latin names would otherwise yield "-YYYY").
  const stem =
    sanitize(parts[parts.length - 1]) || sanitize(parts[0]) || "CLIENT"
  const year = new Date().getFullYear()
  const baseCode = `${stem}-${year}`

  // Check for collisions
  const { data } = await supabase
    .from("contacts")
    .select("referral_code")
    .ilike("referral_code", `${baseCode}%`)

  if (!data || data.length === 0) return baseCode

  const existing = new Set(data.map((r) => r.referral_code?.toUpperCase()))
  if (!existing.has(baseCode.toUpperCase())) return baseCode

  // Find next available suffix
  let suffix = 2
  while (existing.has(`${baseCode}-${suffix}`.toUpperCase())) {
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
      return ((commissionPct || 10) / 100) * setupFeeTotal

    case "price_difference":
      return (agreedPrice || 0) - basePriceForState

    default:
      return 0
  }
}
