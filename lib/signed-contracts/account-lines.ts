/**
 * The "Signed contract" line(s) on a company's page (dev job 49676dfe) — one short line per signed offer of THIS company, each with an
 * Open button that shows the signed PDF in the floating document window. Pure (no database, client-safe): the rules are unit-tested.
 *
 * Which offers count is decided by the account page itself (offers filed on the company, plus a linked person's offers that no OTHER
 * company has claimed — dev job b1e0cb99), never by the Contact card's wider rule, which would show another company's contract.
 *
 * Order: the contract the client signed when they became a client (formation / onboarding) first, then everything else, newest first.
 * An annual renewal agreement is shown, clearly named as one — Antonio (2026-11-14): "Yes, show labelled".
 */
import { etDay } from '@/lib/accounts/became-client'
import { contractLabel } from './labels'
import { hasUsablePath, newestPerOffer } from './entries'
import { signedAgreementsLabel } from '@/lib/offers/signed-agreements'

export interface AccountLineOffer {
  token: string
  contract_type: string | null
}
export interface AccountLineContract {
  id: string
  offer_token: string
  signed_at: string | null
  created_at: string | null
  pdf_path: string | null
  /** what the contract contained when it was signed (contracts.agreements); null/absent = signed before this was recorded */
  agreements?: unknown
}

export interface AccountContractLine {
  /** contracts.id — what the open route takes */
  id: string
  /** "Onboarding contract", "Formation contract", "Annual renewal agreement 2026", ... */
  name: string
  /** the New York day it was signed (YYYY-MM-DD), or null when the record has no date */
  signedOn: string | null
  /** the contract the client signed when they became a client (formation / onboarding) */
  isMain: boolean
  /** the signed PDF is recorded; false = the line shows but Open is greyed out */
  fileAvailable: boolean
}

/** The name shown on the line. Short on purpose: the full agreement titles are long. */
export function accountLineName(contractType: string | null | undefined, year: number | string | null | undefined): string {
  if (contractType === 'formation') return 'Formation contract'
  if (contractType === 'onboarding') return 'Onboarding contract'
  const { title } = contractLabel(contractType, year)
  return title
}

const MAIN_TYPES = ['formation', 'onboarding']

export function buildAccountContractLines(input: {
  offers: AccountLineOffer[]
  contracts: AccountLineContract[]
  /** annual_agreements.agreement_year by offer token (renewals only) */
  agreementYears: Record<string, number | null>
}): AccountContractLine[] {
  const offerByToken = new Map(input.offers.map((o) => [o.token, o]))
  const lines: AccountContractLine[] = []
  for (const c of newestPerOffer(input.contracts)) {
    const offer = offerByToken.get(c.offer_token)
    if (!offer) continue
    const signedOn = etDay(c.signed_at)
    const year = offer.contract_type === 'renewal' ? (input.agreementYears[c.offer_token] ?? (signedOn ? Number(signedOn.slice(0, 4)) : null)) : null
    lines.push({
      id: c.id,
      // what the contract CONTAINS, when that was recorded at signing; else the old name from the offer's main type (dev job 0a60f416)
      name: signedAgreementsLabel(c.agreements)?.title ?? accountLineName(offer.contract_type, year),
      signedOn,
      isMain: MAIN_TYPES.includes(offer.contract_type ?? ''),
      fileAvailable: hasUsablePath(c.pdf_path),
    })
  }
  return lines.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    return String(b.signedOn ?? '').localeCompare(String(a.signedOn ?? ''))
  })
}
