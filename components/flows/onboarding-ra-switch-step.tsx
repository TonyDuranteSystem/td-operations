'use client'

import { useState } from 'react'
import { ShieldCheck, ExternalLink, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { HARBOR } from '@/lib/renewal-links'

/**
 * The Client Onboarding workspace's final step: switch the Registered Agent
 * to Harbor Compliance. A MANUAL switch, not an API push — Antonio,
 * 2026-09-22, verbatim: "that fucking button must open the website for us
 * to do switch. once is done, we will confirm in the workspace and the
 * system will update the crm." Two actions, in order:
 *   1. Open Harbor Compliance — staff does the actual switch there.
 *   2. Confirm — mark it done here; the server advances the SD to its
 *      final stage (POST /api/onboarding-review/[id]/confirm-ra-switch).
 */
export function OnboardingRaSwitchStep({ submissionId }: { submissionId: string }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function handleConfirm() {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`/api/onboarding-review/${submissionId}/confirm-ra-switch`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not confirm the Registered Agent switch.')
      }
      setResult({ ok: true, message: data.message || 'Registered Agent switch confirmed.' })
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error && err.message ? err.message : 'Could not confirm the Registered Agent switch.' })
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
        Switch this company&apos;s Registered Agent to Harbor Compliance, then confirm here once it&apos;s done.
      </p>

      <div className="flex flex-wrap gap-2">
        <a
          href={HARBOR.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-50"
        >
          Open Harbor Compliance
          <ExternalLink className="h-4 w-4" />
        </a>

        {!result?.ok && (
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Confirm — Registered Agent switched
          </button>
        )}
      </div>

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
