'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, Send, Upload, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

const MAX_FILE_MB = 10

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

export function FaxForm() {
  const params = useSearchParams()
  // Pre-fill support (e.g. the Tax Return "Send Fax to IRS" button).
  const [faxno, setFaxno] = useState(params.get('faxno') ?? '')
  const [recipName, setRecipName] = useState(params.get('to') ?? '')
  const [coverMessage, setCoverMessage] = useState(params.get('message') ?? '')
  const [file, setFile] = useState<File | null>(null)
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
    if (!file) { toast.error('Attach a file to fax.'); return }
    setSending(true)
    setSent(null)
    try {
      const file_base64 = await fileToBase64(file)
      const res = await fetch('/api/tools/fax/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faxno,
          recip_name: recipName,
          cover_message: coverMessage,
          file_base64,
          file_name: file.name,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not send the fax. Please try again.')
      }
      setSent(data.faxage_response || 'Fax submitted.')
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
        {sent && <p className="text-xs text-green-600 mt-2 break-words font-mono">{sent}</p>}
        <button
          onClick={() => { setSent(null); setFile(null) }}
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
        <p className="text-xs text-muted-foreground mt-1">Digits only are sent; formatting is ignored.</p>
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
        <label className="block text-sm font-medium text-zinc-700 mb-1">Document</label>
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
      </div>

      <div>
        <label htmlFor="cover" className="block text-sm font-medium text-zinc-700 mb-1">Cover message <span className="text-zinc-400 font-normal">(optional)</span></label>
        <textarea
          id="cover"
          value={coverMessage}
          onChange={e => setCoverMessage(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Optional note included on a cover page."
          className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={sending || !file || !faxno.trim()}
        className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {sending ? 'Sending…' : 'Send Fax'}
      </button>
    </form>
  )
}
