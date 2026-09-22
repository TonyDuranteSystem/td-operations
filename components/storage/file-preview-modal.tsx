'use client'

/**
 * Click-to-view for a CRM Storage file — Antonio's request (2026-09-14):
 * "if I click it it should open the view and not downloading it." Mints a
 * signed URL with NO Content-Disposition: attachment (see the preview API
 * route's own comment) so the browser renders the file instead of saving
 * it, for the mime types a browser can render directly. Everything else
 * (Office docs, archives, etc.) falls back to a plain "can't preview this,
 * download it" message — there's no in-browser renderer for those here.
 */
import { useEffect, useState } from 'react'
import { AlertCircle, Download, FileQuestion, Loader2, Send, X } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'

export interface PreviewableFile {
  id: string
  file_name: string
  mime_type: string | null
  file_size: number | null
}

function previewKind(mimeType: string | null): 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none' {
  if (!mimeType) return 'none'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('text/')) return 'text'
  return 'none'
}

export function FilePreviewModal({
  file,
  onClose,
  onDownload,
  onShare,
}: {
  file: PreviewableFile
  onClose: () => void
  onDownload: () => void
  onShare: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setLoadError(false)
    fetch(`/api/crm-storage/files/${file.id}/preview`)
      .then(r => {
        if (!r.ok) throw new Error('load failed')
        return r.json()
      })
      .then(d => {
        if (!cancelled) setUrl(d.url)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => { cancelled = true }
  }, [file.id])

  const kind = previewKind(file.mime_type)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-4xl flex-col gap-2" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 text-white">
          <span className="truncate text-sm font-medium">{file.file_name}</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <FastTooltip label="Share">
              <button onClick={onShare} className="rounded-full p-2 text-white hover:bg-white/10" aria-label="Share">
                <Send className="h-4 w-4" />
              </button>
            </FastTooltip>
            <FastTooltip label="Download">
              <button onClick={onDownload} className="rounded-full p-2 text-white hover:bg-white/10" aria-label="Download">
                <Download className="h-4 w-4" />
              </button>
            </FastTooltip>
            <FastTooltip label="Close">
              <button onClick={onClose} className="rounded-full p-2 text-white hover:bg-white/10" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </FastTooltip>
          </div>
        </div>

        <div className="flex min-h-[50vh] flex-1 items-center justify-center overflow-auto rounded-md bg-zinc-900">
          {loadError ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-zinc-300">
              <AlertCircle className="h-8 w-8" />
              <p className="text-sm">Could not load this file.</p>
            </div>
          ) : !url ? (
            <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
          ) : kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element -- a private signed URL, not a Next-optimizable remote URL
            <img src={url} alt={file.file_name} className="max-h-[80vh] w-full object-contain" />
          ) : kind === 'pdf' ? (
            <iframe src={url} title={file.file_name} className="h-[80vh] w-full rounded-md bg-white" />
          ) : kind === 'video' ? (
            <video src={url} controls className="max-h-[80vh] w-full" />
          ) : kind === 'audio' ? (
            <audio src={url} controls className="w-full px-8" />
          ) : (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-zinc-300">
              <FileQuestion className="h-8 w-8" />
              <p className="text-sm">There&apos;s no preview for this file type.</p>
              <button onClick={onDownload} className="mt-1 rounded-md border border-zinc-600 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/10">
                Download instead
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
