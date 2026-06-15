'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, Send, Upload, FileText, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

const MAX_FILE_MB = 10

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
  const [coverMessage, setCoverMessage] = useState(params.get('message') ?? '')
  const [source, setSource] = useState<Source>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [documentId, setDocumentId] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  const onFile = (f: File | null) => {
    if (f && f.size > MAX_FILE_MB * 1024 * 1024) {
      toast.error(`File is too large (max ${MAX_FILE_MB} MB).`)
      return
    }
    setFile(f)
  }

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (sending) return
    if (source === 'upload' && !file) { toast.error('Attach a file to fax.'); return }
    if (source === 'document' && !documentId) { toast.error('Select a document to fax.'); return }

    setSending(true)
    setSent(null)
    try {
      const payload: Record<string, unknown> = {
        faxno,
        recip_name: recipName || undefined,
        cover_message: coverMessage || undefined,
      }
      if (source === 'upload' && file) {
        payload.file_base64 = await fileToBase64(file)
        payload.file_name = file.name
      } else {
        payload.document_id = documentId
      }

      const res = await fetch('/api/tools/fax/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not send the fax. Please try again.')
      }
      setSent(data.job_id ? `Job ${data.job_id}` : (data.faxage_response || 'Fax submitted.'))
      toast.success('Fax submitted to Faxage.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not send the fax.')
    } finally {
      setSending(false)
    }
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
        <button
          onClick={() => { setSent(null); setFile(null); setDocumentId('') }}
          className="mt-4 text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          Send another fax
        </button>
      </div>
    )
  }

  return (
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
  )
}
