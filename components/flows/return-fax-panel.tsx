'use client'

/**
 * Return fax box — Tax Return "Signed" step (plan item 6, dev job 6f555c9f).
 *
 * Staff fax the client's SIGNED return to the IRS straight from the job, instead of downloading it and typing everything into the Fax tool.
 * What the box shows is decided by GET /api/flows/[id]/return-fax (pure rules in lib/fax/return-fax.ts):
 *  - not a single-member LLC → the old "Send Fax to IRS" link (those returns are not faxed from here),
 *  - no signed copy in the company storage → a plain sentence + the Fax tool link,
 *  - ready → the signed copy to view, the IRS number pre-filled (editable), a confirm window naming the file and number, then Send,
 *  - sent → "waiting for delivery" + Check now; the job is FILED BY ITSELF once Faxage confirms delivery (cron every 10 minutes),
 *  - failed → red + a confirmed re-send; never confirmed → blocked until someone has looked in Fax History.
 * The send goes through the shared fax engine (POST /api/tools/fax/send — one claim row per Send, a repeat needs an explicit confirm), the same
 * path as the SS-4 box. Nothing here files the job: the delivery check does (lib/fax/return-fax-delivery.ts).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createOnceGuard } from '@/lib/crm-store/once-guard'
import { faxSendFailureText } from '@/lib/fax/client-errors'
import { isIrsEinFaxNumber } from '@/lib/fax/irs-ein-numbers'
import type { ReturnFaxState } from '@/lib/fax/return-fax'
import { Printer, Loader2, Eye, CheckCircle2, AlertTriangle, RefreshCw, Send, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { FaxIrs } from './fax-irs'
import type { WorkspaceAccount } from './types'

interface ApiState {
  success: boolean
  state: ReturnFaxState
  account_id: string | null
  company: string
  year: number | null
  irs_number: string
  default_reason: string
  default_cover: string
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

/** "8558877737" → "(855) 887-7737" for the confirm sentence; anything else is shown as typed. */
function prettyNumber(raw: string): string {
  const d = raw.replace(/\D/g, '')
  const t = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : raw
}

export function ReturnFaxPanel({ serviceDeliveryId, account, serviceType }: { serviceDeliveryId: string; account: WorkspaceAccount; serviceType?: string | null }) {
  const [data, setData] = useState<ApiState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [faxno, setFaxno] = useState('')
  const [reason, setReason] = useState('')
  const [cover, setCover] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [checking, setChecking] = useState(false)
  const [showAgain, setShowAgain] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const sendId = useRef(crypto.randomUUID()) // one Send = one fax (the server refuses a second try with the same id)
  const sendGuard = useRef(createOnceGuard()) // three clicks in one instant = one request

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/return-fax`, { cache: 'no-store' })
      const body = (await res.json().catch(() => ({}))) as ApiState & { error?: string }
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not load the fax box.')
      setData(body)
      setFaxno((cur) => cur || body.irs_number)
      setReason((cur) => cur || body.default_reason)
      setCover((cur) => cur || body.default_cover)
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load the fax box.')
    } finally {
      setLoading(false)
    }
  }, [serviceDeliveryId])

  useEffect(() => { void load() }, [load])
  // a different job never inherits the previous job's send id
  useEffect(() => { sendId.current = crypto.randomUUID() }, [serviceDeliveryId])

  async function checkNow() {
    setChecking(true)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/return-fax/check`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not check the fax.')
      const outcome = body.result?.outcome as string | undefined
      if (outcome === 'filed') toast.success('The fax was delivered. The receipt is saved and the job is filed.')
      else if (outcome === 'failed') toast.error('Faxage reports that the fax was not delivered.')
      else if (outcome === 'waiting_too_long') toast.warning('Still not confirmed by Faxage. Check Fax History.')
      else toast.message('Not delivered yet. It is checked again every few minutes.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not check the fax.')
    } finally {
      setChecking(false)
    }
  }

  async function doSend(documentId: string, confirmResend: boolean) {
    await sendGuard.current.run(() => doSendOnce(documentId, confirmResend))
  }

  async function doSendOnce(documentId: string, confirmResend: boolean) {
    if (!data) return
    setSending(true)
    try {
      let res: Response
      try {
        res = await fetch('/api/tools/fax/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            faxno,
            recip_name: 'IRS',
            reason: reason || undefined,
            cover_message: cover || undefined,
            document_id: documentId,
            account_id: data.account_id ?? undefined,
            service_delivery_id: serviceDeliveryId,
            dedupe_service_delivery_id: serviceDeliveryId,
            confirm_resend: confirmResend,
            send_id: sendId.current,
          }),
        })
      } catch {
        // the request may have reached Faxage before the connection dropped: the outcome is UNKNOWN
        throw new Error(faxSendFailureText({ networkError: true }))
      }
      const parsed = await res.json().catch(() => null)
      const body = parsed ?? {}
      if (res.status === 409 && body.already_faxed) {
        // the server's double-send guard: surface it. A normal "already sent" can be confirmed; an UNCONFIRMED send cannot be re-sent blindly.
        setConfirming(false)
        if (!body.already_faxed.unconfirmed) sendId.current = crypto.randomUUID() // a confirmed re-send is a NEW send, on purpose
        toast.warning(body.already_faxed.unconfirmed ? 'A send for this job was never confirmed. Check Faxage first.' : 'This job was already faxed. Confirm to send it again.')
        await load()
        return
      }
      if (!res.ok || !body.success) throw new Error(faxSendFailureText({ status: res.status, json: parsed }, 'Could not send the fax.'))
      sendId.current = crypto.randomUUID() // the next fax of this box is a new send
      setHistoryError(body.history_error ? String(body.history_error) : null)
      setConfirming(false)
      setShowAgain(false)
      toast.success('Fax submitted to the IRS.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not send the fax.')
    } finally {
      setSending(false)
    }
  }

  const card = 'rounded-xl border border-zinc-200 bg-white p-4'
  const manualCard = <FaxIrs account={account} serviceType={serviceType} />

  if (loading && !data) {
    return (
      <div className={card}>
        <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading the fax box…</div>
      </div>
    )
  }
  if (loadError || !data) {
    return (
      <div className="space-y-3">
        <div className={card}>
          <p className="text-sm text-red-600">{loadError ?? 'Could not load the fax box.'}</p>
          <button onClick={load} className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"><RefreshCw className="h-3.5 w-3.5" /> Retry</button>
        </div>
        {manualCard}
      </div>
    )
  }

  const s = data.state
  const einLine = isIrsEinFaxNumber(faxno)
  const yearText = data.year ? ` ${data.year}` : ''

  // The send form: shared by "ready", a failed fax, and "send again" on a fax already on record.
  const sendForm = (documentId: string, fileName: string, resend: boolean) => (
    <div className="mt-3">
      <a
        href={`/api/documents/${documentId}/preview`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
      >
        <Eye className="h-3.5 w-3.5" /> View the signed return to fax
      </a>
      <p className="mt-1 text-[11px] text-zinc-400">{fileName}</p>

      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="retfax-no" className="block text-xs font-medium text-zinc-700 mb-1">IRS fax number</label>
          <input
            id="retfax-no"
            type="text"
            value={faxno}
            onChange={(e) => setFaxno(e.target.value)}
            className="w-full h-9 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[11px] text-zinc-400 mt-1">Pre-filled with the IRS return line staff use for a signed return. Only a fax to this number files the job when it is delivered.</p>
          {einLine && <p role="alert" className="mt-1 text-xs font-medium text-red-700">That is an IRS EIN (SS-4) line. A signed return goes to {prettyNumber(data.irs_number)}.</p>}
        </div>
        <div>
          <label htmlFor="retfax-reason" className="block text-xs font-medium text-zinc-700 mb-1">Reason <span className="text-zinc-400 font-normal">(internal note)</span></label>
          <input
            id="retfax-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full h-9 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="retfax-cover" className="block text-xs font-medium text-zinc-700 mb-1">Cover note <span className="text-zinc-400 font-normal">(internal — recorded, not printed on the fax)</span></label>
          <textarea
            id="retfax-cover"
            value={cover}
            onChange={(e) => setCover(e.target.value)}
            rows={2}
            maxLength={2000}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {!confirming ? (
        <div className="mt-3">
          <button
            onClick={() => setConfirming(true)}
            disabled={!faxno.trim() || einLine}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" /> {resend ? 'Send fax again' : 'Send fax to IRS'}
          </button>
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3">
          <p className="text-xs font-medium text-blue-900">
            Fax the signed return{yearText} of <strong>{data.company}</strong> ({fileName}) to <span className="font-mono">{prettyNumber(faxno)}</span>?
            This sends to the IRS and can’t be undone.{resend ? ' This job was faxed before: this will fax the IRS a second time.' : ''}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => doSend(documentId, resend)}
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
  )

  const header = (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100">
        <Printer className="h-5 w-5 text-zinc-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-zinc-900">Fax the signed return{yearText} to the IRS</p>
        <p className="text-xs text-zinc-500 mt-1">Review the signed copy, confirm the number, then send. When Faxage confirms delivery, the receipt is saved in the company’s Tax folder and the job is filed by itself.</p>
      </div>
    </div>
  )

  if (s.mode === 'manual') {
    return (
      <div className="space-y-3">
        <div className={`${card} border-zinc-200 bg-zinc-50`}>
          <p className="text-xs text-zinc-600">{s.reason}</p>
        </div>
        {manualCard}
      </div>
    )
  }

  if (s.mode === 'no_copy') {
    return (
      <div className={`${card} border-amber-200 bg-amber-50`}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">The signed return is not ready to fax from here</p>
            <p className="text-xs text-amber-800 mt-1">{s.reason}</p>
            <div className="mt-3 flex items-center gap-4">
              <a href="/tools/fax" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 underline"><Printer className="h-3.5 w-3.5" /> Open the Fax tool</a>
              <button onClick={load} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (s.mode === 'unconfirmed') {
    return (
      <div className={card}>
        {header}
        <div role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          A send for this job was started{formatWhen(s.at) ? ` on ${formatWhen(s.at)}` : ''} but never confirmed, so it is not known whether the fax went out.
          Check Faxage, then say what happened in{' '}
          <a href="/tools/fax/history" target="_blank" rel="noreferrer" className="font-semibold underline">Fax History</a>. Until then it cannot be sent again from here.
        </div>
        <button onClick={load} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
      </div>
    )
  }

  if (s.mode === 'delivered') {
    return (
      <div className={`${card} border-green-200 bg-green-50`}>
        <div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-green-600" /><p className="text-sm font-semibold text-green-800">Fax delivered to the IRS</p></div>
        <p className="text-xs text-green-700 mt-1">Faxage confirmed delivery{formatWhen(s.at) ? ` (sent ${formatWhen(s.at)})` : ''}. The receipt is saved in the company’s Tax folder and the job is being filed.</p>
        <button onClick={load} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-green-700 hover:text-green-800"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
      </div>
    )
  }

  if (s.mode === 'sent') {
    return (
      <div className={card}>
        {header}
        <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${s.waitingTooLong ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900'}`}>
          <div className="flex items-center gap-1.5 font-medium"><Clock className="h-3.5 w-3.5" /> Fax sent{formatWhen(s.at) ? ` on ${formatWhen(s.at)}` : ''}{s.faxJobId ? ` (job ${s.faxJobId})` : ''}{s.faxno ? ` to ${prettyNumber(s.faxno)}` : ''}</div>
          {s.toIrsLine ? (
            <p className="mt-1">
              {s.waitingTooLong
                ? 'Faxage has not confirmed delivery after more than 2 hours. Check it in Fax History; the job stays at “Signed” until it is delivered.'
                : 'Waiting for Faxage to confirm delivery. It is checked every few minutes, and the job is filed by itself when the fax is delivered.'}
            </p>
          ) : (
            <p className="mt-1 font-medium text-amber-900">That fax did not go to the IRS return line, so it will NOT file the job by itself. Send the signed return to the IRS line, or press “File with IRS” when it has been filed.</p>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <button onClick={checkNow} disabled={checking} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check now
          </button>
          <a href="/tools/fax/history" target="_blank" rel="noreferrer" className="text-xs font-medium text-blue-600 hover:text-blue-700 underline">Fax History</a>
          {s.copy && !showAgain && (
            <button onClick={() => setShowAgain(true)} className="text-xs font-medium text-zinc-500 hover:text-zinc-800 underline">Send again…</button>
          )}
        </div>
        {historyError && <p role="alert" className="mt-2 text-xs font-medium text-red-700">{historyError}</p>}
        {s.copy && showAgain && sendForm(s.copy.documentId, s.copy.fileName, true)}
      </div>
    )
  }

  if (s.mode === 'failed') {
    return (
      <div className={`${card} border-red-200`}>
        {header}
        <div role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
          <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> The last fax was not delivered</div>
          <p className="mt-1">{s.reason ?? 'Faxage reported a failure.'} Nothing was filed. Check Fax History, then send it again.</p>
        </div>
        {s.documentId && s.fileName
          ? sendForm(s.documentId, s.fileName, true)
          : <p className="mt-3 text-xs text-amber-800">The signed copy could not be found any more. Use the <a href="/tools/fax" target="_blank" rel="noreferrer" className="underline font-medium">Fax tool</a>.</p>}
      </div>
    )
  }

  // ready
  return (
    <div className={card}>
      {header}
      {s.moreCopies && <p className="mt-2 text-[11px] text-zinc-500">This job has more than one signed copy: the newest is shown.</p>}
      {historyError && <p role="alert" className="mt-2 text-xs font-medium text-red-700">{historyError}</p>}
      {sendForm(s.documentId, s.fileName, false)}
    </div>
  )
}
