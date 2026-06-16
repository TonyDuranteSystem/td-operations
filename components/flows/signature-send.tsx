'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileSignature, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

interface SignatureSendProps {
  serviceDeliveryId: string
  /** Label from stage_layout, e.g. "Send for Signature". */
  label?: string
}

interface FlowDoc {
  id: string
  file_name: string | null
}

/**
 * "Send for Signature" action on the Tax Return "Tax Return Prepared" stage.
 *
 * Enabled only once a document has been uploaded against this SD. On click it
 * POSTs to /api/flows/[id]/send-for-signature, which creates a signature
 * request from the latest uploaded document, notifies the client, and advances
 * the SD to "Sent for Signature". Surfaces the server's real error (R099).
 */
export function SignatureSend({ serviceDeliveryId, label }: SignatureSendProps) {
  const router = useRouter()
  const [docCount, setDocCount] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendLabel = label || 'Send for Signature'

  // Check whether a document has been uploaded yet (gates the button).
  useEffect(() => {
    let cancelled = false
    fetch(`/api/flows/${serviceDeliveryId}/documents`)
      .then((r) => r.json())
      .then((d: { documents?: FlowDoc[] }) => {
        if (!cancelled) setDocCount(Array.isArray(d.documents) ? d.documents.length : 0)
      })
      .catch(() => {
        if (!cancelled) setDocCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [serviceDeliveryId])

  const handleSend = useCallback(async () => {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/send-for-signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not send for signature. Please try again.')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send for signature.')
      setSending(false)
    }
  }, [serviceDeliveryId, sending, router])

  const hasDoc = (docCount ?? 0) > 0

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <FileSignature className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">Send to client for signature</h3>
      </div>
      <p className="text-sm text-zinc-500 mb-3">
        Sends the uploaded tax return to the client&rsquo;s portal for e-signature and notifies them.
      </p>

      {!hasDoc && docCount !== null && (
        <p className="mb-3 flex items-center gap-1.5 text-sm text-amber-600">
          <AlertCircle className="h-4 w-4" />
          Upload the prepared tax return first.
        </p>
      )}

      <button
        type="button"
        onClick={handleSend}
        disabled={!hasDoc || sending}
        className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
          !hasDoc || sending
            ? 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
            : 'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer'
        }`}
      >
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
        {sending ? 'Sending…' : sendLabel}
      </button>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}
