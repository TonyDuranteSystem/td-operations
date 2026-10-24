'use client'

/**
 * A large look at the MERGED PDF before it is saved (Antonio 2026-10-24: "do we have a preview before save?"). The file only
 * exists in this browser tab until "Upload merged file" is clicked — nothing is sent anywhere by looking at it. The pages show in
 * the order the person chose, so a fax receipt on the wrong page is caught here and not after the upload.
 */
import { useEffect, useState } from 'react'
import { Layers, X } from 'lucide-react'
import { trapTabKey } from '@/components/storage/focus-trap'

export function MergedPreviewModal({ file, pages, onClose }: { file: File; pages: number; onClose: () => void }) {
  // the address is made when the window opens and released when it closes, so it never leaks memory
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[64] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Preview of the merged file" onClick={onClose}>
      <div className="flex h-[min(92vh,900px)] w-full max-w-4xl flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()} onKeyDown={trapTabKey}>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Layers className="h-4 w-4 text-blue-500" />
          <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-800" title={file.name}>{file.name}</h3>
          <span className="shrink-0 text-xs text-zinc-500">{pages} {pages === 1 ? 'page' : 'pages'} · not saved yet</span>
          <button type="button" aria-label="Close the preview" onClick={onClose} className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 bg-zinc-100">
          {url && <iframe src={url} title="Merged file preview" className="h-full w-full border-0" data-testid="merged-preview-frame" />}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-xs text-zinc-500">
          <span>This is the file exactly as it will be saved. Check the order of the pages.</span>
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50" data-testid="merged-preview-close">Close</button>
        </div>
      </div>
    </div>
  )
}
