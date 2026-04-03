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
  const lastName = parts[parts.length - 1].toUpperCase().replace(/[^A-Z]/g, "")
  const year = new Date().getFullYear()
  const baseCode = `${lastName}-${year}`

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
