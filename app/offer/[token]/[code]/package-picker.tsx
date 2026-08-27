'use client'

import { useState } from 'react'
import { computeOfferTotals } from '@/lib/offers/compute-offer-totals'
import { FORMATION_STATE_NAMES, normalizeFormationState } from '@/lib/formation/states'
import type { OfferPackageOption } from '@/lib/types/offer'

const PICKER_LABELS = {
  en: {
    heading: 'Choose your option',
    intro: 'A few different ways to set this up — pick the one that fits.',
    select: 'Select',
    selected: 'Selected',
    confirmHeading: 'Confirm your choice',
    confirmIntro: "You're choosing:",
    confirmWarning: 'This cannot be changed afterward without contacting us.',
    back: 'Back',
    confirmButton: 'Confirm this choice',
    confirming: 'Locking in your choice…',
    errorAlreadyDifferent: 'A choice was already locked in for this offer — reload the page to see it.',
    errorGeneric: 'Something went wrong locking in your choice. Please try again or contact us.',
    setupFee: 'Setup fee',
    perYear: 'renewal, per year (two installments)',
  },
  it: {
    heading: 'Scegli la tua opzione',
    intro: 'Ci sono alcune opzioni diverse — scegli quella più adatta a te.',
    select: 'Seleziona',
    selected: 'Selezionata',
    confirmHeading: 'Conferma la tua scelta',
    confirmIntro: 'Stai scegliendo:',
    confirmWarning: 'Questa scelta non potrà essere cambiata senza contattarci.',
    back: 'Indietro',
    confirmButton: 'Conferma questa scelta',
    confirming: 'Registrazione della scelta…',
    errorAlreadyDifferent: 'Per questa offerta è già stata registrata una scelta — ricarica la pagina per vederla.',
    errorGeneric: 'Si è verificato un errore. Riprova o contattaci.',
    setupFee: 'Costo iniziale',
    perYear: 'rinnovo annuo, in due rate',
  },
} as const

function currencySymbol(currency: string): string {
  return currency === 'EUR' ? '€' : '$'
}

function packageDisplayTotals(pkg: OfferPackageOption) {
  const totals = computeOfferTotals({
    services: pkg.services,
    cost_summary: pkg.cost_summary,
    currency: pkg.currency,
  })
  return { amount: totals.gross, currency: totals.currency }
}

// The authoring screen appends its OWN "Annual Total" summary row alongside
// the two real installment rows (see create-offer-dialog.tsx) — summing every
// row blindly double-counts it (found live: Option 1 showed $4,000 instead of
// $2,000, exactly 1st + 2nd + the pre-computed total). Only ever sum the two
// real installment rows, by label, the same way the account-upgrade helper
// identifies them (lib/operations/onboarding-account-upgrade.ts).
const TOTAL_ROW_RE = /annual\s*total|annuale|^total$/i

function annualRenewalTotal(pkg: OfferPackageOption): number | null {
  const rows = Array.isArray(pkg.recurring_costs) ? pkg.recurring_costs : []
  let sum = 0
  let found = false
  for (const row of rows) {
    if (TOTAL_ROW_RE.test(String(row?.label ?? ''))) continue
    const raw = String(row?.price ?? '')
    const digits = raw.replace(/[^0-9.]/g, '')
    const n = parseFloat(digits)
    if (Number.isFinite(n) && n > 0) { sum += n; found = true }
  }
  return found ? sum : null
}

export interface PackagePickerProps {
  token: string
  accessCode: string
  packages: OfferPackageOption[]
  lang: 'en' | 'it'
  onLocked: () => void
}

export function PackagePicker({ token, accessCode, packages, lang, onLocked }: PackagePickerProps) {
  const L = PICKER_LABELS[lang] || PICKER_LABELS.en
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = packages.find((p) => p.key === selectedKey) || null

  async function handleConfirm() {
    if (!selected) return
    setConfirming(true)
    setError(null)
    try {
      const res = await fetch('/api/offers/pick-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, code: accessCode, package_key: selected.key }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.outcome === 'already_locked_different') {
          setError(L.errorAlreadyDifferent)
        } else {
          setError(data.error || L.errorGeneric)
        }
        setConfirming(false)
        return
      }
      // Locked (or this same client's own retry landed on the same pick) — the
      // parent reloads the offer, which now resolves to the normal
      // single-option flow using the picked package's real numbers.
      onLocked()
    } catch {
      setError(L.errorGeneric)
      setConfirming(false)
    }
  }

  if (selected) {
    const { amount, currency } = packageDisplayTotals(selected)
    const renewal = annualRenewalTotal(selected)
    const stateName = FORMATION_STATE_NAMES[normalizeFormationState(selected.formation_state) || 'NM']
    return (
      <div className="offer-loading" style={{ flexDirection: 'column', gap: 24, padding: '40px 20px' }}>
        <div style={{ maxWidth: 480, width: '100%', background: '#fff', borderRadius: 12, padding: 32, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
          <h2 style={{ marginBottom: 8 }}>{L.confirmHeading}</h2>
          <p style={{ color: '#666', marginBottom: 20 }}>{L.confirmIntro}</p>
          <div style={{ background: '#f7f7f7', borderRadius: 8, padding: 20, marginBottom: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>{selected.label}</div>
            <div style={{ color: '#444', marginBottom: 4 }}>{stateName}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 12 }}>
              {L.setupFee}: {currencySymbol(currency)}{amount.toLocaleString()}
            </div>
            {renewal != null && (
              <div style={{ color: '#666', marginTop: 4 }}>
                {currencySymbol(selected.installment_currency || currency)}{renewal.toLocaleString()} {L.perYear}
              </div>
            )}
          </div>
          <p style={{ fontSize: 13, color: '#b45309', marginBottom: 20 }}>&#9888; {L.confirmWarning}</p>
          {error && <p style={{ color: '#dc2626', marginBottom: 16 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              onClick={() => { setSelectedKey(null); setError(null) }}
              disabled={confirming}
              style={{ flex: 1, padding: '12px 20px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}
            >
              {L.back}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              style={{ flex: 2, padding: '12px 20px', borderRadius: 8, border: 'none', background: '#111', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
            >
              {confirming ? L.confirming : L.confirmButton}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="offer-loading" style={{ flexDirection: 'column', gap: 24, padding: '40px 20px' }}>
      <div style={{ maxWidth: 640, width: '100%' }}>
        <h2 style={{ marginBottom: 4 }}>{L.heading}</h2>
        <p style={{ color: '#666', marginBottom: 24 }}>{L.intro}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {packages.map((pkg) => {
            const { amount, currency } = packageDisplayTotals(pkg)
            const renewal = annualRenewalTotal(pkg)
            const stateName = FORMATION_STATE_NAMES[normalizeFormationState(pkg.formation_state) || 'NM']
            return (
              <div
                key={pkg.key}
                style={{ background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 18 }}>{pkg.label}</div>
                  <div style={{ color: '#666', fontSize: 14 }}>{stateName}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>
                    {currencySymbol(currency)}{amount.toLocaleString()}
                  </div>
                  {renewal != null && (
                    <div style={{ color: '#666', fontSize: 13 }}>
                      {currencySymbol(pkg.installment_currency || currency)}{renewal.toLocaleString()} {L.perYear}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedKey(pkg.key)}
                  style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: '#111', color: '#fff', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                >
                  {L.select}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
