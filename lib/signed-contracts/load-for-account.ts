/**
 * Server side: the signed contracts of the offers the account page already decided belong to this company (dev job 49676dfe).
 * Reads only the columns the line needs — never the passport, the address or the storage path. A failed read throws with its real
 * cause: a company that HAS a signed contract must never be shown "No signed contract in the system" because a lookup timed out
 * (the page then says the contracts could not be read).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildAccountContractLines, type AccountContractLine, type AccountLineContract, type AccountLineOffer } from './account-lines'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function loadSignedContractLinesForOffers(offers: AccountLineOffer[]): Promise<AccountContractLine[]> {
  const tokens = offers.map((o) => o.token).filter(Boolean)
  if (tokens.length === 0) return []

  const contractsRes = await db.from('contracts').select('id, offer_token, signed_at, created_at, pdf_path').in('offer_token', tokens)
  if (contractsRes.error) throw new Error(`Could not read the signed contracts: ${contractsRes.error.message}`)
  const contracts = (contractsRes.data ?? []) as AccountLineContract[]
  if (contracts.length === 0) return []

  const signedTokens = new Set(contracts.map((c) => c.offer_token))
  const renewalTokens = offers.filter((o) => o.contract_type === 'renewal' && signedTokens.has(o.token)).map((o) => o.token)
  const agreementYears: Record<string, number | null> = {}
  if (renewalTokens.length > 0) {
    const agreementsRes = await db.from('annual_agreements').select('token, agreement_year').in('token', renewalTokens)
    if (agreementsRes.error) throw new Error(`Could not read the annual agreements: ${agreementsRes.error.message}`)
    for (const a of (agreementsRes.data ?? []) as Array<{ token: string; agreement_year: number | null }>) agreementYears[a.token] = a.agreement_year
  }

  return buildAccountContractLines({ offers, contracts, agreementYears })
}
