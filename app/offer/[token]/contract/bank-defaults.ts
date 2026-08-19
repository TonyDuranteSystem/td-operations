/**
 * Bank Details Defaults
 *
 * Auto-selects correct bank account based on currency.
 * EUR → Airwallex (IBAN)
 * USD → Relay (Account + Routing)
 *
 * Used by all contract pages to ensure real bank details
 * are always shown after signing, even if the offer has
 * placeholder values.
 */

export interface BankDetails {
  beneficiary?: string
  iban?: string
  bic?: string
  bank_name?: string
  account_number?: string
  routing_number?: string
  amount?: string
  reference?: string
  address?: string
}

const AIRWALLEX_EUR: BankDetails = {
  beneficiary: "TONY DURANTE L.L.C.",
  iban: "DK8989000023658198",
  bic: "SXPYDKKK",
  bank_name: "Banking Circle S.A. (via Airwallex)",
  // The BANK's own registered address (Banking Circle S.A., Denmark) — was
  // wrongly set to Tony Durante LLC's own Florida office address. This value
  // is snapshotted into offers.bank_details at offer-creation time
  // (getBankDetailsByPreference, called from lib/operations/offers.ts) and IS
  // rendered live to real clients: app/offer/[token]/[code]/page.tsx's
  // "Coordinate Bancarie" panel (shown after signing, before payment) prints
  // it unlabeled as "Indirizzo"/"Address" directly under the bank name. This
  // was reported by a real client seeing TD's own address presented as the
  // bank's (2026-08-18). All 49 pre-existing offers with the wrong value
  // baked into their stored bank_details were backfilled in production on
  // 2026-08-18 — see docs/systems/offers.md.
  address: "Amerika Plads, 38, Copenhagen, Denmark, 2100",
}

const RELAY_USD: BankDetails = {
  beneficiary: "TONY DURANTE L.L.C.",
  account_number: "200000306770",
  routing_number: "064209588",
  bank_name: "Relay Financial",
  address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
}

const MERCURY_USD: BankDetails = {
  beneficiary: "TONY DURANTE L.L.C.",
  account_number: "202236384517",
  routing_number: "091311229",
  bank_name: "Choice Financial Group (via Mercury)",
  address: "11761 80th Ave, Seminole, FL 33772",
}

const REVOLUT_USD: BankDetails = {
  beneficiary: "TONY DURANTE L.L.C.",
  account_number: "214414489805",
  routing_number: "101019644",
  bank_name: "Revolut",
  address: "11761 80th Ave, Seminole, FL 33772",
}

export type BankPreference = "auto" | "relay" | "mercury" | "airwallex" | "revolut"

export const BANK_ACCOUNTS: Record<BankPreference, { label: string; currency: string }> = {
  auto: { label: "Auto (by currency)", currency: "auto" },
  relay: { label: "Relay (USD)", currency: "USD" },
  mercury: { label: "Mercury (USD)", currency: "USD" },
  revolut: { label: "Revolut (USD)", currency: "USD" },
  airwallex: { label: "Airwallex (EUR)", currency: "EUR" },
}

/**
 * Get bank details for a specific bank preference.
 * Used by create-offer API and MCP tool when a specific bank is selected.
 */
export function getBankDetailsByPreference(preference: BankPreference, currency?: string): BankDetails {
  switch (preference) {
    case "relay": return { ...RELAY_USD }
    case "mercury": return { ...MERCURY_USD }
    case "revolut": return { ...REVOLUT_USD }
    case "airwallex": return { ...AIRWALLEX_EUR }
    case "auto":
    default:
      return currency === "USD" ? { ...RELAY_USD } : { ...AIRWALLEX_EUR }
  }
}

/**
 * Check if bank details contain placeholder or empty values
 */
function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true
  const lower = value.toLowerCase()
  return (
    lower.includes("dettagli forniti") ||
    lower.includes("details provided") ||
    lower.includes("da definire") ||
    lower.includes("tbd") ||
    lower.includes("n/a") ||
    value.trim().length < 3
  )
}

/**
 * Detect currency from amount string or cost summary
 */
function detectCurrency(bankDetails?: BankDetails, costSummary?: unknown[]): "EUR" | "USD" {
  // Check amount field
  const amount = bankDetails?.amount || ""
  if (amount.includes("\u20ac") || amount.toUpperCase().includes("EUR")) return "EUR"
  if (amount.includes("$") || amount.toUpperCase().includes("USD")) return "USD"

  // Check cost summary first section
  if (Array.isArray(costSummary) && costSummary.length > 0) {
    const total = String((costSummary[0] as Record<string, unknown>)?.total || "")
    if (total.includes("\u20ac") || total.toUpperCase().includes("EUR")) return "EUR"
  }

  // Default to EUR (most clients pay in EUR first)
  return "EUR"
}

/**
 * Ensure real bank details are always available.
 * If the offer has valid details, use them.
 * If placeholder/empty, fall back to correct default based on currency.
 */
export function ensureBankDetails(
  offerBankDetails?: BankDetails,
  costSummary?: unknown[]
): BankDetails {
  if (!offerBankDetails) {
    const currency = detectCurrency(undefined, costSummary)
    return currency === "EUR" ? { ...AIRWALLEX_EUR } : { ...RELAY_USD }
  }

  const hasRealIban = !isPlaceholder(offerBankDetails.iban)
  const hasRealAccount = !isPlaceholder(offerBankDetails.account_number)

  // If has real IBAN or account number, the details are valid
  if (hasRealIban || hasRealAccount) {
    return offerBankDetails
  }

  // Placeholder detected — substitute with correct default
  const currency = detectCurrency(offerBankDetails, costSummary)
  const defaults = currency === "EUR" ? AIRWALLEX_EUR : RELAY_USD

  return {
    ...defaults,
    amount: offerBankDetails.amount, // keep the amount from the offer
    reference: offerBankDetails.reference, // keep the reference
  }
}
