'use client'

/**
 * SS-4 fax panel — Company Formation "SS-4 Signed" stage.
 *
 * Lets staff review and fax the combined "signed SS-4 + Articles" IRS package
 * directly from the workspace, instead of the old hand-off to the Fax tool.
 *
 * States (driven by GET /api/flows/[id]/ss4-fax):
 *  - awaiting_signature → the SS-4 was re-sent; waiting for the client to re-sign
 *    (fax disabled — the package would be stale).
 *  - no faxable package → Articles missing or no Drive folder → warn + point to
 *    the manual Fax tool.
 *  - signed + faxable package → View the package + an editable, pre-filled send
 *    form (IRS number defaults to the domestic EIN number; Reason + Cover note
 *    are internal). Send has a confirm step; a repeat fax needs an extra
 *    confirm (server-side double-send guard). Sending leaves the stage in place
 *    (staff advance by uploading the fax confirmation).
 *
 * The send goes through the shared /api/tools/fax/send engine — the same path
 * the Fax tool uses — so there is one send/idempotency/audit implementation.
 */

import { useCallback, useEffect, useState } from 'react'
import { Printer, Loader2, Eye, CheckCircle2, AlertTriangle, RefreshCw, Send } from 'lucide-react'
import { toast } from 'sonner'

interface PackageInfo {
  document_id: string
  file_name: string
  faxable: boolean
}
interface FaxState {
  success: boolean
  ss4_status: string | null
  account_id: string | null
  package: PackageInfo | null
  already_faxed: { at: string; job_id: string | null; faxno: string | null } | null
  irs_number: string
  default_reason: string
  default_cover: string
}

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

export function Ss4FaxPanel({ serviceDeliveryId }: { serviceDeliveryId: string }) {
  const [state, setState] = useState<FaxState | null>(null)
  const [loading, setLoading] = useState(true)

  const [faxno, setFaxno] = useState('')
  const [reason, setReason] = useState('')
  const [cover, setCover] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [sentJob, setSentJob] = useState<string | null>(null)
  const [resending, setResending] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/ss4-fax`, { cache: 'no-store' })
      const data = (await res.json().catch(() => ({}))) as FaxState & { error?: string }
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not load the fax panel.')
      setState(data)
      setFaxno(data.irs_number)
      setReason(data.default_reason)
      setCover(data.default_cover)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not load the fax panel.')
    } finally {
      setLoading(false)
    }
  }, [serviceDeliveryId])

  useEffect(() => { load() }, [load])

  async function doSend(confirmResend: boolean) {
    if (!state?.package) return
    setSending(true)
    try {
      const res = await fetch('/api/tools/fax/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faxno,
          recip_name: 'IRS',
          reason: reason || undefined,
          cover_message: cover || undefined,
          document_id: state.package.document_id,
          account_id: state.account_id ?? undefined,
          service_delivery_id: serviceDeliveryId,
          dedupe_service_delivery_id: serviceDeliveryId,
          confirm_resend: confirmResend,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409 && data.already_faxed) {
        // Server double-send guard tripped — surface it and let staff confirm.
        setConfirming(false)
        setState((s) => (s ? { ...s, already_faxed: data.already_faxed } : s))
        toast.warning('This flow was already faxed. Confirm below to send it again.')
        return
      }
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not send the fax.')
      setSentJob(data.job_id ? String(data.job_id) : 'submitted')
      setConfirming(false)
      toast.success('Fax submitted to the IRS.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not send the fax.')
    } finally {
      setSending(false)
    }
  }

  async function resend() {
    setResending(true)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/resend-ss4`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not re-send the SS-4.')
      toast.success('SS-4 re-sent to the client for signature.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not re-send the SS-4.')
    } finally {
      setResending(false)
    }
  }

  const card = 'rounded-xl border border-zinc-200 bg-white p-4'

  if (loading) {
    return (
      <div className={card}>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the SS-4 fax panel…
        </div>
      </div>
    )
  }
  if (!state) {
    return (
      <div className={card}>
        <button onClick={load} className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700">
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    )
  }

  // Re-sent, waiting for the client to sign again — do not fax a stale package.
  if (state.ss4_status === 'awaiting_signature') {
    return (
      <div className={card}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
            <RefreshCw className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-zinc-900">Waiting for the client to sign again</p>
            <p className="text-xs text-zinc-500 mt-1">
              The SS-4 was re-sent for signature. Once the client re-signs, the combined IRS package is
              rebuilt automatically and this panel will show it, ready to fax.
            </p>
            <button onClick={load} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
        </div>
      </div>
    )
  }

  // No faxable package — Articles missing or no Drive folder. Never fax SS-4-only.
  if (!state.package || !state.package.faxable) {
    return (
      <div className={`${card} border-amber-200 bg-amber-50`}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">Combined IRS package not available</p>
            <p className="text-xs text-amber-800 mt-1">
              The signed SS-4 + Articles package could not be prepared automatically (the Articles may be
              missing, or the company has no Drive folder). Do <strong>not</strong> fax the SS-4 on its own —
              prepare the combined package and fax it manually via the Fax tool.
            </p>
            <div className="mt-3 flex items-center gap-4">
              <a href="/tools/fax" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 underline">
                <Printer className="h-3.5 w-3.5" /> Open the Fax tool
              </a>
              <button onClick={resend} disabled={resending} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50">
                {resending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Re-send for signature
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (sentJob) {
    return (
      <div className={`${card} border-green-200 bg-green-50`}>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          <p className="text-sm font-semibold text-green-800">Fax submitted to the IRS</p>
        </div>
        <p className="text-xs text-green-700 mt-1">
          Job <span className="font-mono">{sentJob}</span>. Upload the fax confirmation below to advance the flow.
        </p>
        <button onClick={() => { setSentJob(null); load() }} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-green-700 hover:text-green-800">
          <RefreshCw className="h-3.5 w-3.5" /> Back to the fax panel
        </button>
      </div>
    )
  }

  return (
    <div className={card}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100">
          <Printer className="h-5 w-5 text-zinc-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">Fax the SS-4 (with Articles) to the IRS</p>
          <p className="text-xs text-zinc-500 mt-1">
            This faxes the combined <strong>signed SS-4 + Articles</strong> package. Review it first, confirm the
            number, then send.
          </p>

          <a
            href={`/api/documents/${state.package.document_id}/preview`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            <Eye className="h-3.5 w-3.5" /> View the package to fax
          </a>

          {state.already_faxed && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              A fax was already sent for this flow{state.already_faxed.job_id ? ` (job ${state.already_faxed.job_id})` : ''}
              {formatWhen(state.already_faxed.at) ? ` on ${formatWhen(state.already_faxed.at)}` : ''}. Sending again will fax the IRS a second time.
            </div>
          )}

          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="ss4fax-no" className="block text-xs font-medium text-zinc-700 mb-1">IRS fax number</label>
              <input
                id="ss4fax-no"
                type="text"
                value={faxno}
                onChange={(e) => setFaxno(e.target.value)}
                className="w-full h-9 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-[11px] text-zinc-400 mt-1">Pre-filled with the domestic EIN fax number — verify before sending.</p>
            </div>
            <div>
              <label htmlFor="ss4fax-reason" className="block text-xs font-medium text-zinc-700 mb-1">Reason <span className="text-zinc-400 font-normal">(internal note)</span></label>
              <input
                id="ss4fax-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full h-9 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="ss4fax-cover" className="block text-xs font-medium text-zinc-700 mb-1">Cover note <span className="text-zinc-400 font-normal">(internal — recorded, not printed on the fax)</span></label>
              <textarea
                id="ss4fax-cover"
                value={cover}
                onChange={(e) => setCover(e.target.value)}
                rows={2}
                maxLength={2000}
                className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {!confirming ? (
            <div className="mt-3 flex items-center gap-4">
              <button
                onClick={() => setConfirming(true)}
                disabled={!faxno.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="h-4 w-4" /> {state.already_faxed ? 'Send fax again' : 'Send fax to IRS'}
              </button>
              <button onClick={resend} disabled={resending} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50">
                {resending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                SS-4 wrong? Re-send for signature
              </button>
            </div>
          ) : (
            <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3">
              <p className="text-xs font-medium text-blue-900">
                Fax the combined SS-4 + Articles to <span className="font-mono">{faxno}</span>? This sends to the IRS and can’t be undone.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => doSend(!!state.already_faxed)}
                  disabled={sending}
                  className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Confirm & send
                </button>
                <button onClick={() => setConfirming(false)} disabled={sending} className="rounded-md border px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-white disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
