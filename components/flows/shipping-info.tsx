import { Truck, ExternalLink } from 'lucide-react'
import type { WorkspaceServiceDelivery } from './types'
import { courierTrackingUrl } from '@/lib/flows/courier'

/**
 * Staff workspace component: shows the courier + tracking number the client
 * entered for their signed ITIN package (Client Signing stage). Before the
 * client submits, shows an "awaiting" state. When a known courier has a public
 * tracking URL, the number links to it.
 *
 * Reads straight from the serviceDelivery row (shipping_courier /
 * shipping_tracking_number) — no client-side fetch.
 */
export function ShippingInfo({ serviceDelivery }: { serviceDelivery: WorkspaceServiceDelivery }) {
  const courier = serviceDelivery.shipping_courier ?? null
  const tracking = serviceDelivery.shipping_tracking_number ?? null
  const submittedAt = serviceDelivery.shipping_submitted_at ?? null

  if (!courier || !tracking) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-center gap-2 mb-1">
          <Truck className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-900">Shipping</h3>
        </div>
        <p className="text-sm text-zinc-500">Awaiting shipping info from client</p>
      </div>
    )
  }

  const url = courierTrackingUrl(courier, tracking)
  const submitted = submittedAt ? new Date(submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Truck className="h-4 w-4 text-emerald-700" />
        <h3 className="text-sm font-semibold text-emerald-900">Shipping</h3>
        {submitted && <span className="text-xs text-emerald-700/70">submitted {submitted}</span>}
      </div>
      <p className="text-sm text-zinc-700">
        <span className="text-zinc-500">Courier:</span> {courier}
      </p>
      <p className="text-sm text-zinc-700 break-all">
        <span className="text-zinc-500">Tracking:</span>{' '}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-blue-700 hover:text-blue-800"
          >
            {tracking}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : (
          <span className="font-medium text-zinc-800">{tracking}</span>
        )}
      </p>
    </div>
  )
}
