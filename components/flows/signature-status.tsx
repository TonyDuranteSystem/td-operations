'use client'

import { useEffect, useState } from 'react'
import { Clock, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'

interface SignatureStatusProps {
  serviceDeliveryId: string
  label?: string
}

interface SigRequest {
  document_name: string
  status: string
  signed_at: string | null
  preview_url: string
}

/**
 * Signature status panel for the Tax Return "Sent for Signature" stage. Shows
 * whether the client has signed yet (and when), plus a staff preview link to
 * the signing page. When the client signs, the signed webhook advances the SD
 * to "Signed" server-side — this panel reflects the request's own status.
 */
export function SignatureStatus({ serviceDeliveryId, label }: SignatureStatusProps) {
  const [loading, setLoading] = useState(true)
  const [req, setReq] = useState<SigRequest | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/flows/${serviceDeliveryId}/signature`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { request?: SigRequest | null }) => {
        if (!cancelled) setReq(d.request ?? null)
      })
      .catch(() => {
        if (!cancelled) setReq(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [serviceDeliveryId])

  const isSigned = req?.status === 'signed'

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-zinc-900 mb-3">{label || 'Signature status'}</h3>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : !req ? (
        <p className="text-sm text-zinc-500">No signature request has been sent yet.</p>
      ) : isSigned ? (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">
            Signed
            {req.signed_at &&
              ` on ${new Date(req.signed_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}`}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <Clock className="h-5 w-5 text-amber-500" />
            <span className="text-sm font-medium text-amber-700">Waiting for client signature</span>
          </div>
          <a
            href={req.preview_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            Preview the signing page
          </a>
        </div>
      )}
    </div>
  )
}
