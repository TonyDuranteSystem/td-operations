'use client'

/**
 * TD Communication Phase 14 — client "feature my brand" opt-in card.
 *
 * Shown on /portal/td-communication once the client's project is delivered. Calls
 * the client-only showcase-consent route (POST = grant, DELETE = withdraw). Soft:
 * this is the client's choice to be featured publicly; withdrawing removes their
 * work from the public portfolio. Bilingual EN/IT. Errors surfaced (R099).
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Sparkles, Check } from 'lucide-react'

const API = '/api/portal/td-communication/showcase-consent'

export function ShowcaseConsentCard({
  initialConsented,
  consentText,
  locale,
}: {
  initialConsented: boolean
  consentText: string
  locale: 'en' | 'it'
}) {
  const isIt = locale === 'it'
  const [consented, setConsented] = useState(initialConsented)
  const [busy, setBusy] = useState(false)

  async function run(method: 'POST' | 'DELETE') {
    setBusy(true)
    try {
      const res = await fetch(API, { method })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error((d && d.error) || (isIt ? 'Qualcosa è andato storto. Riprova.' : 'Something went wrong. Please try again.'))
      }
      setConsented(method === 'POST')
      toast.success(
        method === 'POST'
          ? (isIt ? 'Grazie! Potremo mostrare il tuo brand.' : 'Thank you! We may feature your brand.')
          : (isIt ? 'Permesso revocato.' : 'Permission withdrawn.'),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isIt ? 'Riprova.' : 'Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  if (consented) {
    return (
      <div className="mt-8 rounded-2xl border border-green-100 bg-green-50/70 px-6 py-5">
        <div className="flex items-center gap-3">
          <Check className="h-5 w-5 shrink-0 text-green-600" />
          <p className="text-sm font-medium text-green-900">
            {isIt ? 'Hai autorizzato TD Communication a mostrare il tuo brand nel portfolio pubblico.' : 'You’ve allowed TD Communication to feature your brand in our public portfolio.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => run('DELETE')}
          disabled={busy}
          className="mt-3 text-xs font-medium text-green-800 underline underline-offset-2 hover:text-green-900 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {isIt ? 'Revoca il permesso' : 'Withdraw permission'}
        </button>
      </div>
    )
  }

  return (
    <div className="mt-8 rounded-2xl border border-blue-200 bg-blue-50/60 px-6 py-6 text-center">
      <Sparkles className="h-6 w-6 mx-auto text-blue-600 mb-2" />
      <h3 className="text-base font-semibold text-blue-900">
        {isIt ? 'Orgoglioso del tuo nuovo brand?' : 'Proud of your new brand?'}
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-blue-900/80">{consentText}</p>
      <button
        type="button"
        onClick={() => run('POST')}
        disabled={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-60"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {isIt ? 'Sì, mostrate il mio brand' : 'Yes, feature my brand'}
      </button>
    </div>
  )
}
