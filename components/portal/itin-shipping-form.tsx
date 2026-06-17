'use client'

import { useState } from 'react'
import { Truck, ExternalLink, Loader2, Pencil } from 'lucide-react'
import { COURIERS, courierTrackingUrl } from '@/lib/flows/courier'

/**
 * Client-facing ITIN shipping-tracking form, embedded in the "Client Signing"
 * card on the portal flow page. The client picks the courier + enters the
 * tracking number for the package they mailed to the TD office. Once saved it
 * collapses to a read-only summary (courier + tracking, with a tracking link
 * where available) plus an Edit button. Surfaces the server's real error (R099).
 */
export function ItinShippingForm({
  serviceDeliveryId,
  initialCourier,
  initialTracking,
  locale,
}: {
  serviceDeliveryId: string
  initialCourier: string | null
  initialTracking: string | null
  locale: 'en' | 'it'
}) {
  const t = locale === 'it'
    ? {
        heading: 'Hai spedito i documenti? Inserisci il tracking',
        courier: 'Corriere',
        choose: 'Seleziona…',
        tracking: 'Numero di tracking',
        save: 'Salva',
        saving: 'Salvataggio…',
        edit: 'Modifica',
        savedHeading: 'Spedizione registrata',
        via: 'Corriere',
        track: 'Traccia il pacco',
        errFallback: 'Impossibile salvare. Riprova.',
      }
    : {
        heading: 'Shipped your documents? Add your tracking',
        courier: 'Courier',
        choose: 'Select…',
        tracking: 'Tracking number',
        save: 'Save',
        saving: 'Saving…',
        edit: 'Edit',
        savedHeading: 'Shipping recorded',
        via: 'Courier',
        track: 'Track package',
        errFallback: 'Could not save. Please try again.',
      }

  const [courier, setCourier] = useState(initialCourier ?? '')
  const [tracking, setTracking] = useState(initialTracking ?? '')
  const [saved, setSaved] = useState<{ courier: string; tracking: string } | null>(
    initialCourier && initialTracking ? { courier: initialCourier, tracking: initialTracking } : null,
  )
  const [editing, setEditing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setError(null)
    if (!courier) { setError(t.choose); return }
    if (!tracking.trim()) { setError(t.tracking); return }
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
