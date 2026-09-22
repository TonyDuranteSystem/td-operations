'use client'

/**
 * Fax an existing CRM Storage file. There's no reusable fax-compose dialog
 * anywhere in the codebase to lift (app/(dashboard)/tools/fax/fax-form.tsx
 * is a full standalone page, not an embeddable component) — this is a new,
 * small, self-contained one that POSTs straight to the same
 * /api/tools/fax/send route that page uses, with the file's own bytes as
 * `file_base64` (a source that route already accepts, alongside its
 * Drive-`document_id` path).
 */
import { useState } from 'react'
import { Loader2, Printer } from 'lucide-react'
import { isValidFaxNo, normalizeFaxNo } from '@/lib/fax/faxage'
import { fetchStorageFileBytes } from '@/lib/crm-storage/fetch-file'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the "data:<mime>;base64," prefix — the API expects raw base64.
      resolve(result.split(',')[1] || '')
    }
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.readAsDataURL(file)
  })
}

export function ShareFaxDialog({
  fileId,
  fileName,
  mimeType,
  onSent,
  onError,
}: {
  fileId: string
  fileName: string
  mimeType: string | null
  onSent: () => void
  onError: (message: string) => void
}) {
  const [faxNo, setFaxNo] = useState('')
  const [coverMessage, setCoverMessage] = useState('')
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (sending) return
    const normalized = normalizeFaxNo(faxNo)
    if (!isValidFaxNo(normalized)) {
      onError('Enter a valid fax number.')
      return
    }
    setSending(true)
    try {
      const file = await fetchStorageFileBytes(fileId, fileName, mimeType)
      const file_base64 = await fileToBase64(file)
      const res = await fetch('/api/tools/fax/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faxno: normalized, file_base64, file_name: fileName, cover_message: coverMessage.trim() || undefined }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not send the fax. Please try again.')
      }
      onSent()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not send the fax. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
        <Printer className="h-4 w-4" />
        Fax this file
      </div>
      <div className="rounded-md border border-zinc-200 p-3 text-sm">
        <p className="text-zinc-500">Sending</p>
        <p className="truncate font-medium text-zinc-900">{fileName}</p>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Fax number
        <input
          autoFocus
          value={faxNo}
          onChange={e => setFaxNo(e.target.value)}
          placeholder="e.g. +1 555 123 4567"
          className="rounded-md border border-zinc-200 px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Cover note (optional)
        <textarea
          value={coverMessage}
          onChange={e => setCoverMessage(e.target.value)}
          rows={2}
          className="rounded-md border border-zinc-200 px-3 py-2 text-sm"
        />
      </label>
      <button
        onClick={() => void handleSend()}
        disabled={sending || !faxNo.trim()}
        className="flex items-center justify-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
      >
        {sending && <Loader2 className="h-4 w-4 animate-spin" />}
        {sending ? 'Sending...' : 'Send fax'}
      </button>
    </div>
  )
}
