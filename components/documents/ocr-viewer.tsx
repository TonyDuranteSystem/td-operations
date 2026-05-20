'use client'

import { useEffect, useState } from 'react'
import { Loader2, X, ScanText } from 'lucide-react'
import { toast } from 'sonner'

interface OcrData {
  file_name: string | null
  document_type_name: string | null
  ocr_text: string | null
  ocr_page_count: number | null
  status: string | null
  has_ocr: boolean
}

/**
 * Shared OCR text viewer modal. Render it once per surface and drive it with a
 * documentId state: pass the id to open, null to close. Fetches the OCR text
 * on demand from /api/documents/[id]/ocr. Read-only.
 */
export function OcrViewerModal({
  documentId,
  onClose,
}: {
  documentId: string | null
  onClose: () => void
}) {
  const [data, setData] = useState<OcrData | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRun = async () => {
    if (!documentId) return
    setRunning(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/ocr`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'OCR failed')
      setData(d as OcrData)
      toast.success((d as OcrData).has_ocr ? 'OCR complete' : 'Processed — no text found')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'OCR failed')
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    if (!documentId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    fetch(`/api/documents/${documentId}/ocr`)
      .then(async res => {
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d.error || 'Failed to load OCR text')
        return d as OcrData
      })
      .then(d => { if (!cancelled) setData(d) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load OCR text') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [documentId])

  if (!documentId) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2 min-w-0">
            <ScanText className="h-4 w-4 text-blue-600 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{data?.file_name || 'Document'} — OCR text</p>
              {data?.document_type_name && (
                <p className="text-xs text-muted-foreground truncate">
                  {data.document_type_name}
                  {data.ocr_page_count ? ` · ${data.ocr_page_count} page(s)` : ''}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 shrink-0" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading OCR text…
            </div>
          ) : error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : data && data.has_ocr ? (
            <pre className="text-xs whitespace-pre-wrap break-words font-mono text-zinc-800 leading-relaxed">{data.ocr_text}</pre>
          ) : (
            <div className="text-sm text-muted-foreground space-y-3">
              <p>This document hasn&apos;t been OCR&apos;d yet.</p>
              <button
                onClick={handleRun}
                disabled={running}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanText className="h-4 w-4" />}
                {running ? 'Running OCR…' : 'Run OCR'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
