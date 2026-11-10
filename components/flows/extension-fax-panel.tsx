'use client'

/**
 * Extension box — Tax Return "1st Installment Paid" step (plan item 7, dev job 6f555c9f).
 *
 * Staff file the client's extension straight from the job: review what will be printed on the OFFICIAL Form 7004, generate it, look at it, fax it
 * to the IRS from here. What the box shows is decided by GET /api/flows/[id]/extension-fax (pure rules in lib/fax/extension-fax.ts):
 *  - not a single-member LLC → the plain upload box this step had before (those extensions are not faxed from here yet),
 *  - nothing generated → the form to review (name, EIN, address, tax year) and "Generate Form 7004",
 *  - generated → the 7004 to view, the IRS number pre-filled (editable: the IRS can change it), a confirm window naming the file and number, then Send,
 *  - sent → "waiting for delivery" + Check now; when Faxage confirms delivery the system merges the 7004 with the receipt, saves ONE document in
 *    the company's Tax folder, moves the job to "Extension Filed" and tells the client in the chat (cron every 10 minutes),
 *  - failed → red + a confirmed re-send; never confirmed → blocked until someone has looked in Fax History.
 * The send goes through the shared fax engine (POST /api/tools/fax/send, tagged with the extension purpose — one claim row per Send, a repeat needs an
 * explicit confirm). Nothing here moves the job: the delivery check does (lib/fax/extension-fax-delivery.ts).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createOnceGuard } from '@/lib/crm-store/once-guard'
import { faxSendFailureText } from '@/lib/fax/client-errors'
import { isIrsEinFaxNumber } from '@/lib/fax/irs-ein-numbers'
import type { ExtensionFaxState } from '@/lib/fax/extension-fax'
import { Printer, Loader2, Eye, CheckCircle2, AlertTriangle, RefreshCw, Send, Clock, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { DocumentUpload } from './document-upload'

const EXTENSION_FAX_PURPOSE = 'tax_extension_7004' // the same tag as lib/fax/extension-fax.ts (that module pulls server code in; a plain string keeps this file client-safe)

interface Prefill {
  companyName: string
  ein: string
  street: string
  suite: string
  city: string
  state: string
  zip: string
  taxYear: number | null
}

interface ApiState {
  success: boolean
  state: ExtensionFaxState
  account_id: string | null
  company: string
  year: number | null
  prefill: Prefill
  fax_number: string
  default_reason: string
  default_cover: string
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

const digitsOf = (raw: string): string => {
  const d = raw.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}

/** "8558877737" → "(855) 887-7737" for the confirm sentence; anything else is shown as typed. */
function prettyNumber(raw: string): string {
  const t = digitsOf(raw)
  return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : raw
}

export function ExtensionFaxPanel({
  serviceDeliveryId,
  flowStage,
  accountId,
  uploadLabel,
  uploadFolder,
  uploadDocumentType,
  uploadAutoAdvance,
}: {
  serviceDeliveryId: string
  flowStage: string | null
  accountId: string | null
  /** the plain upload box this step had before: shown for companies that are not single-member LLCs */
  uploadLabel?: string
  uploadFolder?: string
  uploadDocumentType?: string
  uploadAutoAdvance?: boolean
}) {
  const [data, setData] = useState<ApiState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [form, setForm] = useState<Prefill | null>(null)
  const [editing, setEditing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

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
  const generateGuard = useRef(createOnceGuard())

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/extension-fax`, { cache: 'no-store' })
      const body = (await res.json().catch(() => ({}))) as ApiState & { error?: string }
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not load the extension box.')
      setData(body)
      setForm((cur) => cur ?? body.prefill)
      setFaxno((cur) => cur || body.fax_number)
      setReason((cur) => cur || body.default_reason)
      setCover((cur) => cur || body.default_cover)
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load the extension box.')
    } finally {
      setLoading(false)
    }
  }, [serviceDeliveryId])

  useEffect(() => { void load() }, [load])
  // a different job never inherits the previous job's send id
  useEffect(() => { sendId.current = crypto.randomUUID() }, [serviceDeliveryId])

  const plainUpload = (
    <DocumentUpload
      label={uploadLabel}
      serviceDeliveryId={serviceDeliveryId}
      flowStage={flowStage}
      autoAdvance={uploadAutoAdvance}
      folder={uploadFolder}
      documentType={uploadDocumentType}
      ownerKind="company"
      accountId={accountId}
    />
  )

  async function checkNow() {
    setChecking(true)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/extension-fax/check`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not check the fax.')
      const outcome = body.result?.outcome as string | undefined
      if (outcome === 'filed') toast.success('The fax was delivered. The document is saved and the job moved to Extension Filed.')
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

  async function generate() {
    if (!form) return
    await generateGuard.current.run(async () => {
      setGenerating(true)
      setGenerateError(null)
      try {
        const res = await fetch(`/api/flows/${serviceDeliveryId}/extension-fax/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, taxYear: form.taxYear ?? undefined, generate_id: crypto.randomUUID() }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body.success) throw new Error(body.error || 'Could not make the Form 7004.')
        setEditing(false)
        toast.success('Form 7004 generated. Look at it, then send it.')
        await load()
      } catch (err) {
        setGenerateError(err instanceof Error && err.message ? err.message : 'Could not make the Form 7004.')
      } finally {
        setGenerating(false)
      }
    })
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
            purpose: EXTENSION_FAX_PURPOSE,
          }),
        })
      } catch {
        // the request may have reached Faxage before the connection dropped: the outcome is UNKNOWN
        throw new Error(faxSendFailureText({ networkError: true }))
      }
      const parsed = await res.json().catch(() => null)
      const body = parsed ?? {}
      if (res.status === 409 && body.already_faxed) {
        setConfirming(false)
        if (!body.already_faxed.unconfirmed) sendId.current = crypto.randomUUID() // a confirmed re-send is a NEW send, on purpose
        toast.warning(body.already_faxed.unconfirmed ? 'A send for this job was never confirmed. Check Faxage first.' : 'The extension was already faxed. Confirm to send it again.')
        await load()
        return
      }
      if (!res.ok || !body.success) throw new Error(faxSendFailureText({ status: res.status, json: parsed }, 'Could not send the fax.'))
      sendId.current = crypto.randomUUID() // the next fax of this box is a new send
      setHistoryError(body.history_error ? String(body.history_error) : null)
      setConfirming(false)
      setShowAgain(false)
      toast.success('Form 7004 submitted to the IRS.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not send the fax.')
    } finally {
      setSending(false)
    }
  }

  const card = 'rounded-xl border border-zinc-200 bg-white p-4'

  if (loading && !data) {
    return (
      <div className={card}>
        <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading the extension box…</div>
      </div>
    )
  }
  if (loadError || !data) {
    return (
      <div className="space-y-3">
        <div className={card}>
          <p className="text-sm text-red-600">{loadError ?? 'Could not load the extension box.'}</p>
          <button onClick={load} className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"><RefreshCw className="h-3.5 w-3.5" /> Retry</button>
        </div>
        {plainUpload}
      </div>
    )
  }

  const s = data.state
  const einLine = isIrsEinFaxNumber(faxno)
  const yearText = data.year ? ` ${data.year}` : ''
  const differentNumber = digitsOf(faxno) !== digitsOf(data.fax_number)

  const header = (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100">
        <Printer className="h-5 w-5 text-zinc-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-zinc-900">File the extension{yearText} (Form 7004)</p>
        <p className="text-xs text-zinc-500 mt-1">Generate the Form 7004, look at it, fax it to the IRS. When Faxage confirms delivery, the Form 7004 and the fax receipt are merged into one document in the company’s Tax folder, the job moves to “Extension Filed” and the client is told in the chat.</p>
      </div>
    </div>
  )

  // The send form: shared by "ready", a failed fax, and "send again" on a fax already on record.
  const sendForm = (documentId: string, fileName: string, resend: boolean) => (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-4">
        <a
          href={`/api/documents/${documentId}/preview`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
        >
          <Eye className="h-3.5 w-3.5" /> View the Form 7004 to fax
        </a>
        {!resend && (
          <button onClick={() => { setEditing(true); setConfirming(false) }} className="text-xs font-medium text-zinc-500 hover:text-zinc-800 underline">Change something and generate again</button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-zinc-400">{fileName}</p>

      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="extfax-no" className="block text-xs font-medium text-zinc-700 mb-1">IRS fax number</label>
          <input
            id="extfax-no"
            type="text"
            value={faxno}
            onChange={(e) => setFaxno(e.target.value)}
            className="w-full h-9 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[11px] text-zinc-400 mt-1">Pre-filled with the number the last extension fax was delivered to (the IRS Form 5472 instructions name 855-887-7737). The IRS can change it: change it here if it did.</p>
          {einLine && <p role="alert" className="mt-1 text-xs font-medium text-red-700">That is an IRS EIN (SS-4) line. A Form 7004 does not go there.</p>}
        </div>
        <div>
          <label htmlFor="extfax-reason" className="block text-xs font-medium text-zinc-700 mb-1">Reason <span className="text-zinc-400 font-normal">(internal note)</span></label>
          <input
            id="extfax-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full h-9 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="extfax-cover" className="block text-xs font-medium text-zinc-700 mb-1">Cover note <span className="text-zinc-400 font-normal">(internal — recorded, not printed on the fax)</span></label>
          <textarea
            id="extfax-cover"
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
            <Send className="h-4 w-4" /> {resend ? 'Send fax again' : 'Send Form 7004 to the IRS'}
          </button>
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3">
          <p className="text-xs font-medium text-blue-900">
            Fax the Form 7004{yearText} of <strong>{data.company}</strong> ({fileName}) to <span className="font-mono">{prettyNumber(faxno)}</span>?
            This sends to the IRS and can’t be undone.{resend ? ' This job was faxed before: this will fax the IRS a second time.' : ''}
          </p>
          {differentNumber && <p className="mt-1 text-xs font-semibold text-amber-800">This is a different number from the last one used ({prettyNumber(data.fax_number)}). Check it is right.</p>}
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

  // The form to review before anything is made (pre-filled; every field can be corrected).
  const field = (key: keyof Prefill, label: string, opts: { wide?: boolean } = {}) => (
    <div className={opts.wide ? 'sm:col-span-2' : ''}>
      <label htmlFor={`ext-${key}`} className="block text-xs font-medium text-zinc-700 mb-1">{label}</label>
      <input
        id={`ext-${key}`}
        type="text"
        value={form ? String(form[key] ?? '') : ''}
        onChange={(e) => setForm((cur) => (cur ? { ...cur, [key]: key === 'taxYear' ? Number(e.target.value.replace(/\D/g, '')) || null : e.target.value } : cur))}
        className="w-full h-9 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
  const generateForm = (
    <div className="mt-3">
      <p className="text-xs font-medium text-zinc-700">What will be printed on the Form 7004 — check it, correct what is wrong:</p>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {field('companyName', 'Name (as on the prior-year return)', { wide: true })}
        {field('ein', 'EIN')}
        {field('taxYear', 'Calendar year of the return')}
        {field('street', 'Number and street', { wide: true })}
        {field('suite', 'Room or suite no. (optional)')}
        {field('city', 'City')}
        {field('state', 'State')}
        {field('zip', 'ZIP code')}
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">The form is the official IRS Form 7004 (Rev. December 2025): code 12 (Form 1120) on line 1, “Foreign-owned U.S. DE” across the top, lines 6, 7 and 8 printed as -0-. The address is pre-filled with the company’s mailing address.</p>
      {generateError && <p role="alert" className="mt-2 text-xs font-medium text-red-700">{generateError}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Generate Form 7004
        </button>
        {editing && <button onClick={() => { setEditing(false); setGenerateError(null) }} disabled={generating} className="text-xs font-medium text-zinc-500 hover:text-zinc-800 underline">Cancel</button>}
      </div>
    </div>
  )

  if (s.mode === 'manual') return <div className="space-y-3">{plainUpload}</div>

  if (s.mode === 'generate') {
    return (
      <div className={card}>
        {header}
        {generateForm}
      </div>
    )
  }

  if (s.mode === 'ready') {
    return (
      <div className={card}>
        {header}
        {historyError && <p role="alert" className="mt-2 text-xs font-medium text-red-700">{historyError}</p>}
        {editing ? generateForm : sendForm(s.documentId, s.fileName, false)}
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
        <div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-green-600" /><p className="text-sm font-semibold text-green-800">Form 7004 delivered to the IRS</p></div>
        <p className="text-xs text-green-700 mt-1">Faxage confirmed delivery{formatWhen(s.at) ? ` (sent ${formatWhen(s.at)})` : ''}. The document is saved in the company’s Tax folder and the job is at “Extension Filed”.</p>
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
          <p className="mt-1">
            {s.waitingTooLong
              ? `Faxage has not confirmed delivery after more than 2 hours. Check it in Fax History; the job stays at “1st Installment Paid” until it is delivered.`
              : 'Waiting for Faxage to confirm delivery. It is checked every few minutes; when the fax is delivered the document is saved, the job moves to “Extension Filed” and the client is told in the chat.'}
          </p>
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

  // failed
  return (
    <div className={`${card} border-red-200`}>
      {header}
      <div role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
        <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> The last fax was not delivered</div>
        <p className="mt-1">{s.reason ?? 'Faxage reported a failure.'} Nothing moved. Check Fax History, then send it again.</p>
      </div>
      {s.copy
        ? sendForm(s.copy.documentId, s.copy.fileName, true)
        : <p className="mt-3 text-xs text-amber-800">The Form 7004 could not be found any more. Use the <a href="/tools/fax" target="_blank" rel="noreferrer" className="underline font-medium">Fax tool</a>.</p>}
    </div>
  )
}
