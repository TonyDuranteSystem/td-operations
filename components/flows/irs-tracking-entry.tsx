'use client'

import { useState, useEffect, useCallback } from 'react'
import { Truck, Loader2, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react'
import { COURIERS, courierTrackingUrl } from '@/lib/flows/courier'

interface IrsTrackingEntryProps {
  serviceDeliveryId: string
}

interface TrackingState {
  courier: string | null
  tracking_number: string
  status: string | null
  delivered_at: string | null
  matched_ship_date: string | null
  duplicate_of?: { service_delivery_id: string; company_name: string | null } | null
}

const STATUS_LABEL: Record<string, string> = {
  not_found: 'ShipStation has no label matching this number yet',
  unknown: 'Status unknown',
  in_transit: 'In transit',
  error: 'Carrier reported an error',
  delivered: 'Delivered',
}

/**
 * Staff entry for the tracking number of the ITIN package mailed to the IRS. Shown on
 * both "Submitted to IRS" (the natural moment, right after the mailing receipt is
 * uploaded) and "IRS Processing" (so the 3 real cases already sitting there when this
 * shipped can be backfilled from their existing receipt scan). A daily check then
 * confirms delivery automatically and tells the client — staff never re-check by hand.
 */
export function IrsTrackingEntry({ serviceDeliveryId }: IrsTrackingEntryProps) {
  const [courier, setCourier] = useState<string>('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [saved, setSaved] = useState<TrackingState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/irs-tracking`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success && data.tracking) {
        setSaved(data.tracking)
        setCourier(data.tracking.courier || '')
        setTrackingNumber(data.tracking.tracking_number || '')
      }
    } finally {
      setLoaded(true)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/irs-tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courier, tracking_number: trackingNumber }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not save the tracking number.')
      }
      setSaved(data.tracking)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save the tracking number.')
    } finally {
      setBusy(false)
    }
  }

  const trackingUrl = saved ? courierTrackingUrl(saved.courier, saved.tracking_number) : null

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <Truck className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">IRS mailing tracking number</h3>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          {saved && !editing ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {saved.courier ? `${saved.courier} — ` : ''}
                {trackingUrl ? (
                  <a href={trackingUrl} target="_blank" rel="noreferrer" className="underline">
                    {saved.tracking_number}
                  </a>
                ) : (
                  saved.tracking_number
                )}
              </div>
              <div className="text-xs text-zinc-500">
                {saved.delivered_at
                  ? `Confirmed delivered ${new Date(saved.delivered_at).toLocaleDateString()}`
                  : saved.status
                    ? `Last check: ${STATUS_LABEL[saved.status] ?? saved.status}${saved.matched_ship_date ? ` · label shipped ${new Date(saved.matched_ship_date).toLocaleDateString()}` : ''}`
                    : 'Not checked yet'}
              </div>
              <button
                onClick={() => setEditing(true)}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Correct this
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-zinc-500">
                Required before this case can move to the next stage. The system checks daily and tells the client once it&apos;s confirmed delivered.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={courier}
                  onChange={(e) => setCourier(e.target.value)}
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="">Courier…</option>
                  {COURIERS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                  placeholder="Tracking number"
                  className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
                <button
                  onClick={save}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
                  Save
                </button>
                {editing && (
                  <button
                    onClick={() => { setEditing(false); setCourier(saved?.courier || ''); setTrackingNumber(saved?.tracking_number || ''); setError(null) }}
                    className="text-sm text-zinc-500 hover:underline"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {saved?.duplicate_of && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>This tracking number is already on file for {saved.duplicate_of.company_name || 'another case'} — double-check it&apos;s correct.</span>
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
