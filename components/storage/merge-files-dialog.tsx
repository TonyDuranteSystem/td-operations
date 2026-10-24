'use client'

/**
 * "Merge into one": the staff member ticked two or more files; this window sets the ORDER (up / down), drops any file that
 * cannot be merged, and builds the single PDF in the browser. Nothing is saved here — the merged file goes to the normal
 * Upload window, where the person chooses folder, document type, name and whether to show it to the client.
 *
 * After the Bug Hunter's review (2026-10-24): the total size is checked BEFORE anything is downloaded, every download has a
 * time limit, and Cancel / Escape / X always work — they stop a download in progress instead of being locked while it runs.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, FileText, Layers, Loader2, X } from 'lucide-react'
import { trapTabKey } from '@/components/storage/focus-trap'
import { looksMergeable, mergeParts, suggestMergedName, MERGE_MAX_PARTS, MERGE_MAX_TOTAL_BYTES, type MergePart } from '@/lib/crm-store/merge-parts'

export interface MergeFileInfo { id: string; name: string; mimeType: string | null; size: number | null }

const FETCH_TIMEOUT_MS = 90_000
const fmtSize = (n: number | null) => (n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export function MergeFilesDialog({ files, onCancel, onMerged }: {
  files: MergeFileInfo[]
  onCancel: () => void
  /** `orderedIds` = the files in the order the person chose (the first one decides which folder the Upload window starts in) */
  onMerged: (file: File, pageCounts: number[], orderedIds: string[]) => void
}) {
  const [list, setList] = useState<MergeFileInfo[]>(files)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const cancelledRef = useRef(false)

  const cancel = () => {
    cancelledRef.current = true
    abortRef.current?.abort() // a download in progress stops; its result is thrown away
    onCancel()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel])

  // leaving the window by any route (the parent unmounts it) also stops a running download
  // (the flag is reset on mount too: React's dev double-mount runs the cleanup once before the window is really used)
  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true; abortRef.current?.abort() }
  }, [])

  const blocked = useMemo(() => list.filter((f) => !looksMergeable(f.name, f.mimeType)), [list])
  const tooMany = list.length > MERGE_MAX_PARTS
  const knownTotal = useMemo(() => list.reduce((n, f) => n + (f.size ?? 0), 0), [list])
  const tooBig = knownTotal > MERGE_MAX_TOTAL_BYTES
  const canMerge = list.length >= 2 && blocked.length === 0 && !tooMany && !tooBig && !busy

  const move = (i: number, d: -1 | 1) => setList((l) => {
    const j = i + d
    if (j < 0 || j >= l.length) return l
    const c = l.slice(); [c[i], c[j]] = [c[j], c[i]]; return c
  })

  const go = async () => {
    setBusy(true); setError(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let timedOut = false
    try {
      const parts: MergePart[] = []
      for (const f of list) {
        const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, FETCH_TIMEOUT_MS)
        try {
          const res = await fetch(`/api/crm-store/browse/file/${encodeURIComponent(f.id)}`, { signal: ctrl.signal })
          if (!res.ok) {
            const d = await res.json().catch(() => ({} as { error?: string }))
            throw new Error(`"${f.name}" could not be read: ${d.error || `status ${res.status}`}`)
          }
          parts.push({ name: f.name, mimeType: f.mimeType, bytes: new Uint8Array(await res.arrayBuffer()) })
        } finally {
          clearTimeout(timer)
        }
      }
      const r = await mergeParts(parts)
      if (cancelledRef.current) return // the person closed the window meanwhile: nothing is handed on
      // a File takes the bytes as they are (a copy of up to 80 MB more would double the memory for nothing)
      onMerged(new File([r.bytes as unknown as BlobPart], suggestMergedName(list.map((f) => f.name)), { type: 'application/pdf' }), r.pageCounts, list.map((f) => f.id))
    } catch (e) {
      if (cancelledRef.current) return
      if (timedOut) setError('A file took too long to download — check the connection and try again.')
      else setError(e instanceof Error && e.message ? e.message : 'The files could not be merged — please try again.')
    } finally {
      if (!cancelledRef.current) setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[62] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Merge files into one"
      onClick={cancel}>
      <div ref={rootRef} className="flex max-h-[min(92vh,640px)] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()} onKeyDown={trapTabKey}>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Layers className="h-4 w-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-zinc-800">Merge {list.length} files into one PDF</h3>
          <button type="button" aria-label="Cancel" onClick={cancel} className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          <p className="text-zinc-600">The pages follow this order, top first. Your original files are not changed. Next you choose where the new file goes, its type and its name — the usual upload window.</p>
          <ol className="divide-y divide-zinc-100 rounded-lg border border-zinc-200" data-testid="merge-order">
            {list.map((f, i) => {
              const bad = !looksMergeable(f.name, f.mimeType)
              return (
                <li key={f.id} className={`flex items-center gap-2 px-3 py-2 ${bad ? 'bg-red-50' : ''}`}>
                  <span className="w-5 shrink-0 text-xs text-zinc-400">{i + 1}</span>
                  <FileText className={`h-4 w-4 shrink-0 ${bad ? 'text-red-500' : 'text-zinc-400'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={f.name}>{f.name}</span>
                    {bad && <span className="block text-xs text-red-600">Only PDF, PNG and JPG files can be merged — remove this one.</span>}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-400">{fmtSize(f.size)}</span>
                  <button type="button" aria-label={`Move ${f.name} up`} disabled={busy || i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Move ${f.name} down`} disabled={busy || i === list.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Leave ${f.name} out`} disabled={busy} onClick={() => setList((l) => l.filter((x) => x.id !== f.id))} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"><X className="h-3.5 w-3.5" /></button>
                </li>
              )
            })}
          </ol>
          {list.length < 2 && <p className="text-xs text-amber-700">Keep at least two files.</p>}
          {tooMany && <p className="text-xs text-amber-700">At most {MERGE_MAX_PARTS} files can be merged at a time — remove some.</p>}
          {tooBig && <p className="text-xs text-amber-700" data-testid="merge-too-big">These files are {fmtSize(knownTotal)} together — the limit for a merge is {MERGE_MAX_TOTAL_BYTES / 1048576} MB. Remove some.</p>}
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700" role="alert" data-testid="merge-error">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button type="button" onClick={cancel} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">Cancel</button>
          <button type="button" disabled={!canMerge} onClick={go} data-testid="merge-go"
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? 'Merging…' : 'Merge and continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
