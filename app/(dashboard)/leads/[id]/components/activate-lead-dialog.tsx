'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Rocket, Loader2, X, CheckCircle2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'

interface ActivateLeadDialogProps {
  open: boolean
  onClose: () => void
  leadId: string
  leadName: string
  leadEmail: string
  offerToken: string | null
}

export function ActivateLeadDialog({
  open,
  onClose,
  leadId,
  leadName,
  leadEmail,
  offerToken,
}: ActivateLeadDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<{
    success: boolean
    message: string
    already_had_login?: boolean
    email_sent?: boolean
  } | null>(null)

  const handleActivate = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/activate-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: leadId }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to activate lead')
          return
        }

        setResult({
          success: true,
          message: data.message,
          already_had_login: data.already_had_login,
          email_sent: data.email_sent,
        })
        toast.success(`${leadName} activated`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  const handleClose = () => {
    setResult(null)
    onClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-indigo-600" />
            <h2 className="text-lg font-semibold">Activate Lead</h2>
          </div>
          <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5">
          {!result ? (
            <>
              {/* Pre-activation summary */}
              <div className="space-y-3">
                <div className="bg-indigo-50 rounded-lg p-4 text-sm">
                  <p className="font-medium text-indigo-900 mb-2">This will:</p>
                  <ul className="space-y-1.5 text-indigo-800">
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>Create portal login for <strong>{leadEmail}</strong></span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>Send email with login credentials</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>Lead will see the offer inside the portal</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>Set lead status to &quot;Offer Sent&quot;</span>
                    </li>
                  </ul>
                </div>

                <div className="flex items-center gap-2 text-sm text-zinc-600">
                  <span className="font-medium">Offer:</span>
                  <span className="text-blue-600">{offerToken || 'unknown'}</span>
                </div>

                <div className="flex items-center gap-2 text-sm text-zinc-600">
                  <span className="font-medium">Portal:</span>
                  <span>portal.tonydurante.us</span>
                </div>
              </div>
            </>
          ) : (
            // Post-activation result
            <div className="space-y-3">
              <div className={`rounded-lg p-4 text-sm ${result.success ? 'bg-emerald-50' : 'bg-red-50'}`}>
                <div className="flex items-start gap-2">
                  {result.success ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
                  )}
                  <div>
                    <p className={`font-medium ${result.success ? 'text-emerald-900' : 'text-red-900'}`}>
                      {result.success ? 'Lead Activated' : 'Activation Failed'}
                    </p>
                    <p className={`mt-1 ${result.success ? 'text-emerald-700' : 'text-red-700'}`}>
                      {result.message}
                    </p>
                  </div>
                </div>
              </div>

              {result.success && !result.email_sent && (
                <div className="bg-amber-50 rounded-lg p-3 text-sm flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                  <p className="text-amber-800">
                    Email was not sent. You may need to send credentials manually.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-5 border-t">
          {!result ? (
            <>
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                onClick={handleActivate}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                Activate
              </button>
            </>
          ) : (
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-md hover:bg-zinc-800"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
