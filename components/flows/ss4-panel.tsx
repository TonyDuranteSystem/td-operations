'use client'

import { useState, useEffect, useCallback } from 'react'
import { FileText, Loader2, CheckCircle2, AlertCircle, Clock, ExternalLink } from 'lucide-react'

interface Ss4PanelProps {
  serviceDeliveryId: string
  /** SD's account_id — empty until the company is materialized at Articles Received. */
  accountId?: string | null
}

interface Ss4Record {
  id: string
  status: string
  company_name: string
  signed_at?: string | null
  previewUrl?: string
}

/**
 * SS-4 panel for the Company Formation "SS-4 Prepared" workspace stage. Reads the
 * SD's account's SS-4 (GET /api/flows/[id]/generate-ss4) and offers the next
 * action by status:
 *   none  → "Generate SS-4" (POST generate-ss4; surfaces the real blocker, e.g.
 *           "Registered Agent not set", per R099)
 *   draft → preview link + "Send to Client for Signature" (POST send-ss4)
 *   awaiting_signature → waiting notice
 *   signed → signed confirmation
 */
export function Ss4Panel({ serviceDeliveryId, accountId }: Ss4PanelProps) {
  const [ss4, setSs4] = useState<Ss4Record | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasAccount = !!accountId

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/generate-ss4`)
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) setSs4(data.ss4 ?? null)
    } finally {
      setLoaded(true)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/generate-ss4`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not generate the SS-4.')
      }
      setSs4(data.ss4 ?? null)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not generate the SS-4.')
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/send-ss4`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not send the SS-4 to the client.')
      }
      setSs4((prev) => (prev ? { ...prev, status: data.status || 'awaiting_signature' } : prev))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send the SS-4.')
    } finally {
      setBusy(false)
    }
  }

  function formatDate(d?: string | null): string {
    if (!d) return ''
    try {
      return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    } catch {
      return d
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <FileText className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">SS-4 (EIN Application)</h3>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !ss4 ? (
        // ── No SS-4 yet ──
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">No SS-4 generated yet.</p>
          {!hasAccount ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              The CRM account isn&apos;t created yet — reach &quot;Articles Received&quot; to materialize the company first.
            </p>
          ) : (
            <button
              onClick={generate}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Generate SS-4
            </button>
          )}
        </div>
      ) : ss4.status === 'signed' || ss4.status === 'submitted' ? (
        // ── Signed ──
        <div className="flex items-start gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Signed by client{ss4.signed_at ? ` on ${formatDate(ss4.signed_at)}` : ''}.</span>
        </div>
      ) : ss4.status === 'awaiting_signature' ? (
        // ── Awaiting signature ──
        <div className="space-y-3">
          <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Waiting for the client to sign in the portal.</span>
          </div>
          {ss4.previewUrl && (
            <a
              href={ss4.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-100"
            >
              <ExternalLink className="h-4 w-4" /> Preview SS-4
            </a>
          )}
        </div>
      ) : (
        // ── Draft ──
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">Draft</span>
            {ss4.previewUrl && (
              <a
                href={ss4.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Preview SS-4
              </a>
            )}
          </div>
          <button
            onClick={send}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Send to Client for Signature
          </button>
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
