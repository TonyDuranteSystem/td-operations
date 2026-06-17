'use client'

import { useState } from 'react'
import { ShieldCheck, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

interface ActivateRaProps {
  serviceDeliveryId: string
  /** SD's account_id — empty until the company is materialized at Articles Received. */
  accountId?: string | null
}

/**
 * "Activate Registered Agent on Harbor Compliance" — pushes the (now real)
 * company to Harbor Compliance via POST /api/flows/[id]/activate-ra, which calls
 * the HC sync. Only meaningful once the company exists (Articles received), so
 * it's disabled until the SD has an account_id. Surfaces the server's real
 * message (R099) rather than a generic toast.
 */
export function ActivateRa({ serviceDeliveryId, accountId }: ActivateRaProps) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const hasAccount = !!accountId

  async function handleActivate() {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/activate-ra`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not activate the Registered Agent on Harbor Compliance.')
      }
      setResult({ ok: true, message: data.message || 'Registered Agent activated on Harbor Compliance.' })
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error && err.message ? err.message : 'Could not activate the Registered Agent.',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">Registered Agent</h3>
      </div>
      <p className="mb-3 text-sm text-zinc-500">
        Activate the Registered Agent on Harbor Compliance now that the company exists.
      </p>

      {!hasAccount ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The CRM account isn&apos;t created yet — upload the Articles of Organization to materialize the company first,
          then activate the Registered Agent.
        </p>
      ) : (
        <button
          onClick={handleActivate}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Activate RA on Harbor Compliance
        </button>
      )}

      {result && (
        <div
          className={`mt-3 flex items-start gap-1.5 rounded-lg px-3 py-2 text-sm ${
            result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  )
}
