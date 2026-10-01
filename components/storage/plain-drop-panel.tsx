'use client'

/**
 * Upload of files and whole folders into the firm's OWN areas (Business, My files) — a normal storage (Antonio 2026-10-01):
 * no document type, no "name shown", no "show to client", no file-count limit. One box: what will go in, Upload, a progress bar and a
 * Stop button, then a plain summary. Client companies and people keep their strict upload.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { PLAIN_CONCURRENCY, folderCount, formatBytes, type PlainItem, type PlainSkipped } from '@/lib/crm-store/plain-drop'

export type PlainOutcome = { outcome: 'saved' | 'unchanged' | 'failed'; message?: string }

export function PlainDropPanel({ folderName, items, skipped, run, onClose, onFinished }: {
  folderName: string
  items: PlainItem[]
  skipped: PlainSkipped[]
  run: (item: PlainItem) => Promise<PlainOutcome>
  onClose: () => void
  onFinished: () => void
}) {
  const [phase, setPhase] = useState<'ready' | 'running' | 'done'>('ready')
  const [done, setDone] = useState(0)
  const [saved, setSaved] = useState(0)
  const [same, setSame] = useState(0)
  const [failures, setFailures] = useState<Array<{ name: string; message: string }>>([])
  const stop = useRef(false)
  const total = items.length
  const bytes = items.reduce((n, i) => n + i.file.size, 0)
  const folders = folderCount(items)

  useEffect(() => {
    if (phase !== 'running') return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase])

  const start = async () => {
    stop.current = false
    setPhase('running'); setDone(0); setSaved(0); setSame(0); setFailures([])
    let next = 0
    const worker = async () => {
      for (;;) {
        if (stop.current) return
        const i = next++
        if (i >= items.length) return
        const it = items[i]
        let r: PlainOutcome
        try { r = await run(it) } catch (e) { r = { outcome: 'failed', message: e instanceof Error ? e.message : 'The file could not be saved.' } }
        if (r.outcome === 'saved') setSaved((n) => n + 1)
        else if (r.outcome === 'unchanged') setSame((n) => n + 1)
        else setFailures((f) => (f.length < 50 ? [...f, { name: [...it.path, it.file.name].join(' › '), message: r.message ?? 'The file could not be saved.' }] : f))
        setDone((n) => n + 1)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PLAIN_CONCURRENCY, Math.max(1, items.length)) }, () => worker()))
    setPhase('done')
    onFinished()
  }

  const failedCount = done - saved - same
  return (
    <div className="fixed inset-0 z-[66] flex items-center justify-center bg-black/40 p-4" onClick={() => { if (phase !== 'running') onClose() }} role="dialog" aria-modal="true" aria-label="Upload files">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 text-sm shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="plain-drop-panel">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-base font-semibold text-zinc-900">Upload {total} file{total === 1 ? '' : 's'} into “{folderName}”</h3>
          {phase !== 'running' && <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>}
        </div>
        <p className="mt-1 text-zinc-600">{total} file{total === 1 ? '' : 's'}{folders ? ` in ${folders} folder${folders === 1 ? '' : 's'}` : ''} · {formatBytes(bytes)}. The folders are kept as they are. Nothing here is ever shown to a client.</p>

        {skipped.length > 0 && (
          <details className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            <summary className="cursor-pointer font-medium">{skipped.length} item{skipped.length === 1 ? '' : 's'} left out</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {skipped.slice(0, 20).map((s, i) => <li key={i}><span className="font-medium">{s.name}</span> — {s.why}</li>)}
              {skipped.length > 20 && <li>…and {skipped.length - 20} more like these.</li>}
            </ul>
          </details>
        )}

        {phase !== 'ready' && (
          <div className="mt-3" role="status">
            <div className="h-2 overflow-hidden rounded bg-zinc-100"><div className="h-full bg-blue-600 transition-all" style={{ width: `${Math.round((done / Math.max(1, total)) * 100)}%` }} /></div>
            <p className="mt-1 text-zinc-700">
              {phase === 'running' ? 'Uploading' : 'Finished'}: {done} of {total} · {saved} saved{same ? ` · ${same} already there, unchanged` : ''}{failedCount ? ` · ${failedCount} could not be saved` : ''}
            </p>
            {phase === 'running' && <p className="text-xs text-zinc-500">You can keep working in another tab — keep this one open.</p>}
          </div>
        )}

        {failures.length > 0 && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
            <p className="font-medium">Could not be saved:</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
              {failures.slice(0, 10).map((f, i) => <li key={i}><span className="font-medium">{f.name}</span> — {f.message}</li>)}
              {failedCount > 10 && <li>…and {failedCount - 10} more.</li>}
            </ul>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {phase === 'ready' && (
            <>
              <button type="button" onClick={onClose} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50">Cancel</button>
              <button type="button" disabled={total === 0} onClick={() => void start()} className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-50" data-testid="plain-drop-start">Upload</button>
            </>
          )}
          {phase === 'running' && (
            <button type="button" onClick={() => { stop.current = true }} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50"><Loader2 className="h-3.5 w-3.5 animate-spin" />Stop</button>
          )}
          {phase === 'done' && <button type="button" onClick={onClose} className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700">Close</button>}
        </div>
      </div>
    </div>
  )
}
