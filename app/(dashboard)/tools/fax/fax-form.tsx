'use client'

import { useRef, useState } from 'react'
import { createOnceGuard } from '@/lib/crm-store/once-guard'
import { faxSendFailureText } from '@/lib/fax/client-errors'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2, Send, Upload, FileText, CheckCircle2, History } from 'lucide-react'
import { toast } from 'sonner'
import { SaveWhereDialog, type SaveWhereChoice } from '@/components/storage/save-where-dialog'
import { FAX_PURPOSES, type FaxPurpose } from '@/lib/crm-store/save-where'

import { FAX_INLINE_MAX_BYTES, FAX_UPLOAD_MAX_BYTES, FAX_UPLOAD_MAX_MB, faxSizeProblem } from '@/lib/fax/staged-upload'

// A file up to 3 MB travels inside the request (base64 + a 4.5 MB request limit); a bigger one is sent DIRECT to the private storage and
// the server reads it from there (up to 10 MB).
const MAX_FILE_MB = FAX_UPLOAD_MAX_MB

export interface RecentDocument {
  id: string
  file_name: string
  account_name: string | null
  created_at: string | null
}

interface FaxFormProps {
  recentDocuments: RecentDocument[]
  /** Configured IRS fax number, used to pre-fill when arriving via ?to=IRS. */
  irsNumber: string
}

type Source = 'upload' | 'document'

/** Read a File as a base64 string (no data: URI prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export function FaxForm({ recentDocuments, irsNumber }: FaxFormProps) {
  const params = useSearchParams()
  // Pre-fill support (e.g. the Tax Return "Send Fax to IRS" button passes
  // ?to=IRS&message=…). IRS → pre-fill the configured IRS fax number.
  const to = params.get('to') ?? ''
  const isIrs = to.toUpperCase() === 'IRS'
  const initialFaxno = params.get('faxno') ?? (isIrs ? irsNumber : '')

  const [faxno, setFaxno] = useState(initialFaxno)
  const [recipName, setRecipName] = useState(to)
  const [reason, setReason] = useState(params.get('reason') ?? '')
  const [coverMessage, setCoverMessage] = useState(params.get('message') ?? '')
  const [source, setSource] = useState<Source>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [documentId, setDocumentId] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [savedWarn, setSavedWarn] = useState(false)
  // One Send = one fax: the same id travels with every try of THIS fax, so a retry after a lost answer can never fax the IRS twice
  const [sendId, setSendId] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(16).slice(2)}`))
  const sendGuard = useRef(createOnceGuard())   // an IRS fax cannot be recalled: one request at a time, decided at once (not at the next render)
  const [asking, setAsking] = useState(false)   // the required "Where should this fax be saved?" window
  const againRef = useRef(false)   // set by "Send it again anyway": the next send carries the confirm
  const [dupWarning, setDupWarning] = useState<string | null>(null)   // the same file went to this number a few minutes ago
  const [historyError, setHistoryError] = useState<string | null>(null)

  const COMPANY_PURPOSES: FaxPurpose[] = ['irs_tax_return', 'irs_ein_request']

  const onFile = (f: File | null) => {
    if (f && f.size > FAX_UPLOAD_MAX_BYTES) {
      toast.error(faxSizeProblem(f.size) ?? `This file is too big to fax (max ${MAX_FILE_MB} MB).`)
      return
    }
    setFile(f)
  }

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault()
    if (sending || asking) return
    if (source === 'upload' && !file) { toast.error('Attach a file to fax.'); return }
    if (source === 'document' && !documentId) { toast.error('Select a document to fax.'); return }
    // An uploaded file is saved somewhere on purpose: the required window opens first, in this same Send step. A document that is
    // already stored (the picker above) is not copied again — it goes straight out.
    if (source === 'upload') { setAsking(true); return }
    void doSend(null)
  }

  /** The fax of a send that is already sent / running / the same as one a few minutes ago is NEVER sent again without the user's confirm. */
  const sendAgainAnyway = () => {
    setDupWarning(null)
    setSendId(crypto.randomUUID())   // a NEW send, on purpose
    againRef.current = true
    if (source === 'upload') { setAsking(true); return }
    void doSend(null, true)
  }

  /** Sends the fax. Returns { error } only when the window should stay open (the chosen place was refused before anything was sent). */
  const doSend = async (choice: SaveWhereChoice | null, confirmAgain = false): Promise<{ error?: string } | void> =>
    sendGuard.current.run(() => { const again = confirmAgain || againRef.current; againRef.current = false; return doSendOnce(choice, again) })

  const doSendOnce = async (choice: SaveWhereChoice | null, confirmAgain: boolean): Promise<{ error?: string } | void> => {
    setSending(true)
    setSent(null)
    setHistoryError(null)
    try {
      const payload: Record<string, unknown> = {
        faxno,
        recip_name: recipName || undefined,
        reason: reason || undefined,
        cover_message: coverMessage || undefined,
        send_id: sendId,
        confirm_resend: confirmAgain || undefined,
      }
      if (source === 'upload' && file) {
        if (file.size > FAX_INLINE_MAX_BYTES) {
          // too big for the request body: straight to the private storage; the server reads it there (up to 10 MB)
          const signRes = await fetch('/api/tools/fax/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_name: file.name, file_size: file.size }) })
          const sign = await signRes.json().catch(() => ({}))
          if (!signRes.ok) throw new Error(sign.error || 'Could not start the upload. Please try again.')
          const put = await fetch(sign.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
          if (!put.ok) throw new Error('The file did not finish uploading. Please try again.')
          payload.staged_path = sign.path
        } else {
          payload.file_base64 = await fileToBase64(file)
        }
        payload.file_name = file.name
        payload.save_choice = choice ?? { mode: 'dont_save' }
      } else {
        payload.document_id = documentId
      }

      let res: Response
      try {
        res = await fetch('/api/tools/fax/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch {
        // the request may have reached Faxage before the connection dropped: the outcome is UNKNOWN
        throw new Error(faxSendFailureText({ networkError: true }))
      }
      if (res.status === 413) throw new Error(`This file is too big to send this way. Make it smaller (the most is ${MAX_FILE_MB} MB) and try again.`)
      const parsed = await res.json().catch(() => null)
      const data = parsed ?? {}
      if (res.status === 409 && data.recent_duplicate) {
        // the same file went to this number a few minutes ago: nothing was sent; the user decides
        setDupWarning(String(data.error))
        setAsking(false)
        return
      }
      if (res.status === 409 && data.already_sent) {
        // the fax of THIS Send already went out (the answer was lost, or the copy did not finish): never send it again
        setSent(data.already_sent.job_id ? `Job ${data.already_sent.job_id}` : 'Already sent')
        setSavedNote(String(data.error))
        setSavedWarn(true)
        setAsking(false)
        return
      }
      if (!res.ok || !data.success) {
        // the chosen place was refused BEFORE the fax was sent: nothing went out, the window stays open with the reason
        if (data.destination_error && data.error) return { error: String(data.error) }
        throw new Error(faxSendFailureText({ status: res.status, json: parsed }))
      }
      setSent(data.job_id ? `Job ${data.job_id}` : (data.faxage_response || 'Fax submitted.'))
      setSavedWarn(!!data.save_failed || !!data.history_error)
      setHistoryError(data.history_error ? String(data.history_error) : null)
      setSavedNote(
        data.save_failed ? `The fax WAS sent — do not send it again. The copy could not be saved where you chose (${data.save_error}), so it is not in the storage. Save it by hand if you need it.`
          : data.saved?.path ? `Saved in: ${data.saved.path}`
            : choice && choice.mode === 'save' ? null : source === 'upload' ? "Not saved in the storage (you chose Don't save)." : null,
      )
      setAsking(false)
      toast.success('Fax submitted to Faxage.')
    } catch (err) {
      // nothing went out: close the window; the form is still filled in and Send opens it again
      setAsking(false)
      toast.error(err instanceof Error && err.message ? err.message : 'Could not send the fax.')
    } finally {
      setSending(false)
    }
  }

  if (dupWarning) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6">
        <h2 className="font-semibold text-amber-900">This fax was NOT sent</h2>
        <p className="mt-2 text-sm text-amber-900 break-words">{dupWarning}</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button type="button" onClick={sendAgainAnyway} className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700">Send it again anyway</button>
          <button type="button" onClick={() => setDupWarning(null)} className="text-sm font-medium text-blue-600 hover:text-blue-700">Do not send</button>
          <Link href="/tools/fax/history" className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"><History className="h-3.5 w-3.5" /> View Fax History</Link>
        </div>
      </div>
    )
  }

  if (sent) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-6">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          <h2 className="font-semibold text-green-800">Fax submitted</h2>
        </div>
        <p className="text-sm text-green-700">The fax was submitted to Faxage for delivery.</p>
        <p className="text-xs text-green-600 mt-2 break-words font-mono">{sent}</p>
        {savedNote && <p className={`text-sm mt-2 break-words ${savedWarn ? 'font-medium text-amber-800' : 'text-green-800'}`}>{savedNote}</p>}
        {historyError && <p role="alert" className="text-sm mt-2 break-words font-medium text-red-700">{historyError}</p>}
        <div className="mt-4 flex items-center gap-4">
          <button
            onClick={() => { setSent(null); setSavedNote(null); setSavedWarn(false); setFile(null); setDocumentId(''); setSendId(crypto.randomUUID()) }}
            className="text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            Send another fax
          </button>
          <Link
            href="/tools/fax/history"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            <History className="h-3.5 w-3.5" /> View Fax History
          </Link>
        </div>
      </div>
    )
  }

  return (
    <>
    <form onSubmit={handleSend} className="space-y-5 rounded-xl border bg-white p-6">
      <div>
        <label htmlFor="faxno" className="block text-sm font-medium text-zinc-700 mb-1">Recipient fax number</label>
        <input
          id="faxno"
          type="text"
          value={faxno}
          onChange={e => setFaxno(e.target.value)}
          required
          placeholder="e.g. 1 (800) 555-1234"
          className="w-full h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-muted-foreground mt-1">
          {isIrs ? 'Pre-filled with the configured IRS fax number — verify it before sending.' : 'Digits only are sent; formatting is ignored.'}
        </p>
      </div>

      <div>
        <label htmlFor="recip" className="block text-sm font-medium text-zinc-700 mb-1">Recipient name <span className="text-zinc-400 font-normal">(optional)</span></label>
        <input
          id="recip"
          type="text"
          value={recipName}
          onChange={e => setRecipName(e.target.value)}
          placeholder="e.g. IRS"
          className="w-full h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="reason" className="block text-sm font-medium text-zinc-700 mb-1">Reason <span className="text-zinc-400 font-normal">(optional)</span></label>
        <input
          id="reason"
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. Tax Return filing for Profit Harbor LLC"
          className="w-full h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-muted-foreground mt-1">Why this fax is being sent — shown in the Fax History.</p>
      </div>

      <div>
        <span className="block text-sm font-medium text-zinc-700 mb-2">Document to fax</span>
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => setSource('upload')}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${source === 'upload' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
          >
            <Upload className="h-3.5 w-3.5" /> Upload a file
          </button>
          <button
            type="button"
            onClick={() => setSource('document')}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${source === 'document' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
          >
            <FileText className="h-3.5 w-3.5" /> Recent document
          </button>
        </div>

        {source === 'upload' ? (
          <label className="flex items-center gap-3 rounded-md border border-dashed px-4 py-3 cursor-pointer hover:border-blue-300 hover:bg-blue-50/40 transition-colors">
            <Upload className="h-5 w-5 text-zinc-400" />
            <span className="text-sm text-zinc-600 truncate">{file ? file.name : `Choose a file (PDF, image — max ${MAX_FILE_MB} MB)`}</span>
            <input
              type="file"
              accept=".pdf,image/*,.tif,.tiff"
              onChange={e => onFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
          </label>
        ) : (
          <select
            value={documentId}
            onChange={e => setDocumentId(e.target.value)}
            className="w-full h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select a recent document…</option>
            {recentDocuments.map(d => (
              <option key={d.id} value={d.id}>
                {d.file_name}
                {d.account_name ? ` — ${d.account_name}` : ''}
                {formatDate(d.created_at) ? ` (${formatDate(d.created_at)})` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label htmlFor="cover" className="block text-sm font-medium text-zinc-700 mb-1">Cover message <span className="text-zinc-400 font-normal">(optional)</span></label>
        <textarea
          id="cover"
          value={coverMessage}
          onChange={e => setCoverMessage(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Optional note recorded with this fax."
          className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={sending || !faxno.trim() || (source === 'upload' ? !file : !documentId)}
        className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {sending ? 'Sending…' : 'Send Fax'}
      </button>
    </form>

    {/* outside the <form>: the window has its own forms and buttons */}
    {asking && file && (
      <SaveWhereDialog
        fileName={file.name}
        purposes={FAX_PURPOSES}
        companyPurposes={COMPANY_PURPOSES}
        onDecide={(c) => doSend(c)}
      />
    )}
    </>
  )
}
