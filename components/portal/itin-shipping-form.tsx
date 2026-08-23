'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Truck, ExternalLink, Loader2, Pencil } from 'lucide-react'
import { COURIERS, courierTrackingUrl } from '@/lib/flows/courier'
import { confirmItinMailed } from '@/app/portal/itin-documents/actions'
import { useLocale } from '@/lib/portal/use-locale'

/**
 * Client-facing ITIN shipping form, embedded in the "Client Signing" card on
 * the portal flow page. The client picks the courier, enters the tracking
 * number for the package they mailed to the TD office, and confirms they have
 * sent it — ONE action that both records the tracking and moves their
 * application forward.
 *
 * Why it does both (Antonio, 2026-07-22): the client's side of the ITIN had
 * been split across two pages. This form saved a tracking number and advanced
 * NOTHING — the stage sat at "Client Signing" forever and nobody was told —
 * while the only button that actually moved the application ("I have mailed
 * the documents") lived on a different page, /portal/itin-documents, which had
 * no tracking field. Worse, the action-required email we send at this exact
 * moment deep-links HERE. So a client could do everything asked of them, on
 * the page we sent them to, and from the staff side it looked like they never
 * did anything. Saving and confirming are one act for the client, so they are
 * one act here.
 *
 * Order matters: the tracking POST runs FIRST and is harmless on its own, so a
 * failure in the advance leaves a saved tracking number and a retryable button
 * rather than a half-advanced application. Surfaces the server's real error
 * (R099) rather than a generic failure.
 */
export function ItinShippingForm({
  serviceDeliveryId,
  initialCourier,
  initialTracking,
}: {
  serviceDeliveryId: string
  initialCourier: string | null
  initialTracking: string | null
}) {
  const { t: translate } = useLocale()
  const t = {
    heading: translate('itinShippingForm.heading'),
    courier: translate('itinShippingForm.courier'),
    choose: translate('itinShippingForm.choose'),
    tracking: translate('itinShippingForm.tracking'),
    save: translate('itinShippingForm.save'),
    saving: translate('itinShippingForm.saving'),
    edit: translate('itinShippingForm.edit'),
    savedHeading: translate('itinShippingForm.savedHeading'),
    savedNote: translate('itinShippingForm.savedNote'),
    via: translate('itinShippingForm.via'),
    track: translate('itinShippingForm.track'),
    errFallback: translate('itinShippingForm.errFallback'),
    confirm: translate('itinShippingForm.confirm'),
  }

  const [courier, setCourier] = useState(initialCourier ?? '')
  const [tracking, setTracking] = useState(initialTracking ?? '')
  const [saved, setSaved] = useState<{ courier: string; tracking: string } | null>(
    initialCourier && initialTracking ? { courier: initialCourier, tracking: initialTracking } : null,
  )
  const [editing, setEditing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A tracking number already on the record means this client has confirmed
  // mailing before — a later Edit is a correction, not a second confirmation.
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(Boolean(initialTracking))
  const router = useRouter()

  async function handleSave() {
    setError(null)
    if (!courier) { setError(t.choose); return }
    if (!tracking.trim()) { setError(t.tracking); return }
    // Same confirmation the standalone button asked for — this now moves the
    // application forward, so it must not fire on a stray click.
    if (!alreadyConfirmed && !window.confirm(t.confirm)) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/portal/flows/${serviceDeliveryId}/shipping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courier, tracking_number: tracking.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || t.errFallback)
      }
      setSaved({ courier, tracking: tracking.trim() })
      setEditing(false)

      // Then move the application on. Skipped when the client is merely
      // correcting a tracking number they already confirmed — advancing twice
      // would be wrong, and the server guards it anyway.
      if (!alreadyConfirmed) {
        const advanced = await confirmItinMailed()
        if (!advanced.success) {
          // The tracking IS saved; only the advance failed. Say so plainly and
          // leave the button retryable rather than pretending it all worked.
          setError(advanced.error || t.errFallback)
          return
        }
        setAlreadyConfirmed(true)
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.errFallback)
    } finally {
      setSubmitting(false)
    }
  }

  // Read-only summary (saved and not editing).
  if (saved && !editing) {
    const url = courierTrackingUrl(saved.courier, saved.tracking)
    return (
      <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Truck className="h-4 w-4 text-emerald-700" />
            <span className="text-sm font-semibold text-emerald-900">{t.savedHeading}</span>
          </div>
          <button
            type="button"
            onClick={() => { setEditing(true); setError(null) }}
            className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t.edit}
          </button>
        </div>
        <p className="text-sm text-zinc-700">
          <span className="text-zinc-500">{t.via}:</span> {saved.courier}
        </p>
        <p className="text-sm text-zinc-700 break-all">
          <span className="text-zinc-500">{t.tracking}:</span> {saved.tracking}
        </p>
        <p className="mt-2 text-sm text-emerald-800">{t.savedNote}</p>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-800"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t.track}
          </a>
        )}
      </div>
    )
  }

  // Entry / edit form.
  return (
    <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <Truck className="h-4 w-4 text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-800">{t.heading}</span>
      </div>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-600">{t.courier}</label>
          <select
            value={courier}
            onChange={e => setCourier(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">{t.choose}</option>
            {COURIERS.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-600">{t.tracking}</label>
          <input
            type="text"
            value={tracking}
            onChange={e => setTracking(e.target.value)}
            maxLength={100}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="button"
          onClick={handleSave}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? t.saving : t.save}
        </button>
      </div>
    </div>
  )
}
