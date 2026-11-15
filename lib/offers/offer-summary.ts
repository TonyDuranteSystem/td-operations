/**
 * The one-line summary of an offer, shown on the Offers card while it is closed (dev job bbd2e644, Antonio 2026-11-14):
 * "type + status" per offer, plus "Activated" when the contract was turned on — so an offer that is still unsigned,
 * or activated before the money came in, is never hidden just because the card is closed. Pure (no database, client-safe).
 */
import { contractLabel } from '@/lib/signed-contracts/labels'

export interface ActivationShape {
  status: string | null
  activated_at: string | null
  payment_confirmed_at: string | null
}

/** The two facts the Offers card cares about. Single source: the open card uses it too, so the closed and open views never disagree. */
export function activationFlags(pa: ActivationShape | null | undefined): { isActivated: boolean; isPaid: boolean } {
  return {
    isActivated: !!pa?.activated_at || pa?.status === 'activated',
    isPaid: !!pa?.payment_confirmed_at,
  }
}

export type OfferActivation = 'none' | 'activated' | 'activated_unpaid'

export interface OfferSummaryItem {
  id: string
  /** "Formation", "Onboarding", "Annual renewal", ... ("Offer" when the offer has no type) */
  type: string
  /** the offer's status, first letter capital: "Signed", "Draft", ... */
  status: string
  /** the status exactly as stored — what the colour of the chip is chosen by */
  statusKey: string
  activation: OfferActivation
}

export interface OfferSummaryInput {
  id: string
  token: string
  status: string
  contract_type: string | null
  created_at: string
}

export function offerTypeLabel(contractType: string | null | undefined): string {
  if (!contractType || !contractType.trim()) return 'Offer'
  return contractLabel(contractType, null).chip
}

export function offerStatusLabel(status: string | null | undefined): string {
  const s = (status ?? '').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown'
}

/** Newest first — the same order the open card lists them in. */
export function offerSummaryItems(
  offers: OfferSummaryInput[],
  pendingActivations: Record<string, ActivationShape | null | undefined> = {},
): OfferSummaryItem[] {
  return [...offers]
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .map((o) => {
      const { isActivated, isPaid } = activationFlags(pendingActivations[o.token])
      return {
        id: o.id,
        type: offerTypeLabel(o.contract_type),
        status: offerStatusLabel(o.status),
        statusKey: o.status,
        activation: !isActivated ? 'none' : isPaid ? 'activated' : 'activated_unpaid',
      }
    })
}
