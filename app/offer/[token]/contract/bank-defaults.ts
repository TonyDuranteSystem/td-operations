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
  address: "10225 Ulmerton Rd, 3D, Largo, FL 33771",
}

const RELAY_USD: BankDetails = {
  beneficiary: "TONY DURANTE L.L.C.",
  account_number: "200000306770",
  routing_number: "064209588",
  bank_name: "Relay Financial",
  address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
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
