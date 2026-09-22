'use client'

import { useRef, useState } from 'react'
import { ShieldCheck, ExternalLink, Loader2, CheckCircle2, AlertCircle, FileText, X } from 'lucide-react'
import { HARBOR } from '@/lib/renewal-links'
import { FastTooltip } from '@/components/ui/fast-tooltip'

/**
 * The Client Onboarding workspace's final step: switch the Registered Agent
 * to Harbor Compliance. A MANUAL switch, not an API push — Antonio,
 * 2026-09-22, verbatim: "that fucking button must open the website for us
 * to do switch. once is done, we will confirm in the workspace and the
 * system will update the crm." Three steps, in order:
 *   1. Open Harbor Compliance — staff does the actual switch there.
 *   2. Attach the RA receipt — required (Antonio, same day, follow-up:
 *      "once we open HC and do the switch, we have to upload the RA
 *      receipt and confirm the switch").
 *   3. Confirm — uploads the receipt to the account's Drive folder and
 *      advances the SD to its final stage
 *      (POST /api/onboarding-review/[id]/confirm-ra-switch).
 */
export function OnboardingRaSwitchStep({ submissionId }: { submissionId: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleConfirm() {
    if (!file) return
    setLoading(true)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('receipt', file)
      const res = await fetch(`/api/onboarding-review/${submissionId}/confirm-ra-switch`, { method: 'POST', body: fd })
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
        Switch this company&apos;s Registered Agent to Harbor Compliance, attach the receipt, then confirm.
      </p>

      <div className="flex flex-wrap items-center gap-2">
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
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-3 text-sm text-zinc-700">
                <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
                {file.name}
                <button
                  type="button"
                  onClick={() => {
                    setFile(null)
                    if (inputRef.current) inputRef.current.value = ''
                  }}
                  className="text-zinc-400 hover:text-zinc-700"
                  aria-label="Remove file"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50"
              >
                <FileText className="h-4 w-4" />
                Attach the RA receipt
              </button>
            )}

            <FastTooltip label={!file ? 'Attach the RA receipt first' : ''}>
              <button
                onClick={handleConfirm}
                disabled={loading || !file}
                aria-label={!file ? 'Confirm — Registered Agent switched (attach the RA receipt first)' : 'Confirm — Registered Agent switched'}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Confirm — Registered Agent switched
              </button>
            </FastTooltip>
          </>
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
