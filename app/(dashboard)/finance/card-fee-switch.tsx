'use client'

/**
 * Card processing fee — global on/off switch (admin-only card on Finance → Overview).
 *
 * Council-approved Phase A (2026-07-15). This is the watcher's abort tool for the
 * card-fee go-live: one tap turns the fee off for EVERY card payment, no redeploy.
 * Two-step inline confirm (no modal — thumb-friendly at 380px). Honest copy: the
 * flip takes effect within ~1 minute and already-issued payment links keep their
 * price (per-instance config cache + links are priced at creation).
 */

import { useState, useTransition } from 'react'
import { CreditCard, Loader2, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toggleCardFee } from './actions'

interface Props {
  initialEnabled: boolean
  ratePercent: number
}

export function CardFeeSwitch({ initialEnabled, ratePercent }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const applyFlip = () => {
    const next = !enabled
    setError(null)
    startTransition(async () => {
      const res = await toggleCardFee(next)
      if (res.success) {
        setEnabled(next)
        setConfirming(false)
      } else {
        setError(res.error || 'Could not change the switch — try again.')
      }
    })
  }

  return (
    <div className="rounded-lg border">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium">Card Processing Fee</h3>
        <span
          className={cn(
            'ml-auto text-xs font-semibold px-2 py-0.5 rounded-full',
            enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
          )}
        >
          {enabled ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          {enabled
            ? `Card payments are charged +${ratePercent}% on top of the invoice amount. Bank transfers are never affected.`
            : `No client is charged the card fee right now. Proposals still show +${ratePercent}% until turned back on.`}
        </p>

        {!confirming ? (
          <button
            onClick={() => { setConfirming(true); setError(null) }}
            className={cn(
              'w-full sm:w-auto px-4 py-2 rounded-md text-sm font-medium border transition-colors',
              enabled
                ? 'border-red-300 text-red-700 hover:bg-red-50'
                : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50',
            )}
          >
            {enabled ? `Turn the ${ratePercent}% fee OFF` : `Turn the ${ratePercent}% fee ON`}
          </button>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-900">
                This changes what <strong>every client</strong> pays by card. It takes
                effect within about 1 minute. Payment links already sent to clients keep
                their original price.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={applyFlip}
                disabled={pending}
                className={cn(
                  'px-4 py-2 rounded-md text-sm font-medium text-white transition-colors inline-flex items-center justify-center gap-2',
                  enabled ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700',
                  pending && 'opacity-60',
                )}
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                {enabled ? 'Yes — turn the fee OFF' : 'Yes — turn the fee ON'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="px-4 py-2 rounded-md text-sm font-medium border hover:bg-muted transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  )
}
