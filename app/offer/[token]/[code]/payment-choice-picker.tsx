'use client'

import { useState } from 'react'

/**
 * The client's own choice of how to pay the setup fee — full or split — made
 * BEFORE signing (council review, 2026-08-27, second pass). Rendered in place
 * of the "Accept & Sign" button on an offer with allow_split_payment_choice=true
 * that has no payment_choice_made_at yet; see app/offer/[token]/[code]/page.tsx
 * for the gating logic and app/api/offers/choose-payment-split/route.ts for why
 * this moved before signing.
 *
 * English-only vocabulary (Antonio, 2026-08-11 ruling on this feature, carried
 * forward unchanged to the pre-signing version): the split-payment offer reads
 * identically regardless of the offer's language.
 */
const LABELS = {
  title: 'How would you like to pay the setup fee?',
  fullLabel: 'Pay in Full',
  splitLabel: 'Split into 2 Payments',
  // ⛔ REWORDED (bug-hunter, full E2E QA, 2026-08-27): the original wording ("a 5% processing
  // fee applies to both") was accurate in the OLD design, where this note sat next to the card
  // button specifically. Here the choice is made BEFORE the client picks a payment METHOD — they
  // still see both Pay by Card and Bank Transfer afterward — so an unconditional "applies to
  // both" overstates the cost to anyone who ends up paying by wire, where no fee is ever charged.
  splitNote: 'Prefer to split it? 50% now, 50% in 30 days. A processing fee applies only if you pay by card.',
  now: 'now',
  processing: 'One moment…',
  errorAlreadyMade: 'A payment choice was already made for this offer — reload the page to continue.',
  errorGeneric: 'Something went wrong. Please try again or contact us.',
}

export interface PaymentChoicePickerProps {
  token: string
  accessCode: string
  selectedServices: string[]
  /** What the client owes if paying at once (net of any credit) — same figure the
   *  rest of this page's "NET EVERYWHERE" convention shows elsewhere. */
  fullAmount: number
  /**
   * The offer's gross (pre-credit) total. The split is built server-side from THIS
   * figure (choose-payment-split/route.ts, matching the engine's own rule that a
   * plan's total must equal gross — computeOfferPayable's planTotalMatchesGross),
   * so the "now" preview shown here is gross/2, not a credit-adjusted estimate.
   * Any credit still lands correctly on the actual first invoice at signing
   * (resolveDueNow's credit-first rule) — this is a preview, not the final charge.
   */
  grossAmount: number
  currencySymbol: string
  onChosen: () => void
}

export function PaymentChoicePicker({ token, accessCode, selectedServices, fullAmount, grossAmount, currencySymbol, onChosen }: PaymentChoicePickerProps) {
  const [loading, setLoading] = useState<'full' | 'split' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(choice: 'full' | 'split') {
    setLoading(choice)
    setError(null)
    try {
      const res = await fetch('/api/offers/choose-payment-split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, code: accessCode, choice, selected_services: selectedServices }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(res.status === 409 ? LABELS.errorAlreadyMade : ((data as { error?: string }).error || LABELS.errorGeneric))
        setLoading(null)
        return
      }
      // The parent reloads the offer and re-derives the CTA — a locked choice is,
      // by construction, indistinguishable from an ordinary single-plan offer
      // (same pattern as PackagePicker's onLocked).
      onChosen()
    } catch {
      setError(LABELS.errorGeneric)
      setLoading(null)
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '0 auto' }}>
      <p style={{ fontWeight: 600, marginBottom: 16, color: '#fff' }}>{LABELS.title}</p>
      {error && <p style={{ color: '#fca5a5', marginBottom: 12, fontSize: 14 }}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
        <button
          type="button"
          className="offer-payment-btn"
          disabled={loading !== null}
          onClick={() => choose('full')}
        >
          {loading === 'full' ? LABELS.processing : `${LABELS.fullLabel} — ${currencySymbol}${fullAmount.toLocaleString('en-US')}`}
        </button>
        <button
          type="button"
          className="offer-payment-btn offer-payment-btn-bank"
          disabled={loading !== null}
          onClick={() => choose('split')}
        >
          {loading === 'split' ? LABELS.processing : `${LABELS.splitLabel} — ${currencySymbol}${Math.round(grossAmount / 2).toLocaleString('en-US')} ${LABELS.now}`}
        </button>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,.75)', marginTop: 4, textAlign: 'center' }}>{LABELS.splitNote}</p>
      </div>
    </div>
  )
}
