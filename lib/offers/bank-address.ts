/**
 * The bank's own address to print on a bank-transfer box — ONLY for the euro
 * (IBAN) account for now (Antonio 2026-09-29: "change only for the Euro,
 * Airwallex. we will define the rest later").
 *
 * Why only IBAN: for the euro account the stored address IS the bank's
 * (Banking Circle S.A., Copenhagen — see contract/bank-defaults.ts). For the
 * US-dollar accounts the stored address is one of TD's own addresses, so
 * printing it as "Bank address" would be wrong. A client (Stefano Stella,
 * 2026-09-29) needed the bank address for his wire and had to ask for it.
 */
type BankDetailsLike = { iban?: string | null; address?: string | null; bank_address?: string | null } | null | undefined

export function euroBankAddress(b: BankDetailsLike): string | null {
  if (!b || !String(b.iban ?? "").trim()) return null
  const addr = String(b.bank_address ?? b.address ?? "").trim()
  return addr || null
}
