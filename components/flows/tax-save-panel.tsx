'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FolderOpen, Info, Loader2, RotateCw } from 'lucide-react'

/**
 * The saved copy of an APPROVED tax questionnaire (dev job 7df278cd, Shipment 2). Shown at the top of the answers once staff approved:
 *   - saved: where the file is, which version, who approved it — and, when earlier copies exist, a card asking what to do with them;
 *   - saving: working on it (it starts by itself if the copy is not in Storage yet);
 *   - failed: why, what to do, Retry saving. The approval itself is never undone;
 *   - not needed: the company is closed.
 * The words follow the approved mockup. All the rules live on the server (lib/tax/tax-save.ts); this only shows them.
 */

interface SaveView {
  state:
    | { state: 'not_released' }
    | { state: 'not_needed'; reason: string }
    | { state: 'saved' }
    | { state: 'saving' }
    | { state: 'not_saved' }
    | { state: 'failed'; reason: string; fix: string; attempts: number; retrying: boolean }
  file: { name: string; path: string[]; version: number; savedAt: string; storageHref: string } | null
  approved: { at: string; by: string } | null
  earlierToDecide: Array<{ versionNo: number; createdAt: string }>
}

const POLL_MS = 4000
const MAX_POLLS = 60

function day(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

async function call(serviceDeliveryId: string, body?: Record<string, unknown>): Promise<SaveView> {
  const res = await fetch(`/api/flows/${serviceDeliveryId}/tax-save`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.success) throw new Error(data.error || 'Could not read the saved copy. Please try again.')
  return data.view as SaveView
}

export function TaxSavePanel({ serviceDeliveryId }: { serviceDeliveryId: string }) {
  const [view, setView] = useState<SaveView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'hidden' | 'visible' | null>(null)
  const autoStarted = useRef(false)
  const polls = useRef(0)

  const run = useCallback(
    async (body: Record<string, unknown>, what: 'save' | 'hidden' | 'visible') => {
      setBusy(what)
      setError(null)
      try {
        setView(await call(serviceDeliveryId, body))
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.')
      } finally {
        setBusy(null)
      }
    },
    [serviceDeliveryId],
  )

  // first read
  useEffect(() => {
    let cancelled = false
    call(serviceDeliveryId)
      .then((v) => { if (!cancelled) setView(v) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error && e.message ? e.message : 'Could not read the saved copy.') })
    return () => { cancelled = true }
  }, [serviceDeliveryId])

  // the approved copy is not in Storage yet and nothing is running: start the save (once per open; a failed save waits for Retry)
  useEffect(() => {
    if (view?.state.state === 'not_saved' && !autoStarted.current) {
      autoStarted.current = true
      void run({ action: 'save' }, 'save')
    }
  }, [view, run])

  // a save is running somewhere (the background job): check again until it ends
  useEffect(() => {
    if (view?.state.state !== 'saving' || busy) return
    if (polls.current >= MAX_POLLS) return
    const t = setTimeout(() => {
      polls.current += 1
      call(serviceDeliveryId).then(setView).catch(() => { /* keep showing "saving"; the next check may work */ })
    }, POLL_MS)
    return () => clearTimeout(t)
  }, [view, busy, serviceDeliveryId])

  if (!view) {
    return error ? <p className="mb-3 text-xs text-red-600" data-testid="tax-save-error">{error}</p> : null
  }
  const st = view.state
  if (st.state === 'not_released') return null

  const approvedLine = view.approved ? `approved ${day(view.approved.at)}${view.approved.by ? ` by ${view.approved.by}` : ''}` : 'approved'

  return (
    <div className="mb-4 space-y-3" data-testid="tax-save-panel" data-state={st.state}>
      {st.state === 'saved' && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Approved and saved in Storage</p>
            {view.file ? (
              <p className="mt-0.5 break-words text-xs text-emerald-800">
                {[...view.file.path, view.file.name].join(' › ')}
                <br />
                Version {view.file.version}, {approvedLine}. The answers are locked.
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-emerald-800">The answers are locked, {approvedLine}.</p>
            )}
          </div>
          {view.file && (
            <a href={view.file.storageHref} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100">
              <FolderOpen className="h-3.5 w-3.5" /> Open in Storage
            </a>
          )}
        </div>
      )}

      {st.state === 'saved' && view.earlierToDecide.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-3 text-sm" data-testid="tax-earlier-copies">
          <p className="font-semibold text-zinc-900">What should we do with the earlier {view.earlierToDecide.length === 1 ? 'copy' : 'copies'}?</p>
          <p className="mt-1 text-xs text-zinc-600">
            This file was saved more than once, so {view.earlierToDecide.length === 1 ? '1 earlier copy needs' : `${view.earlierToDecide.length} earlier copies need`} a decision:{' '}
            {view.earlierToDecide.slice(0, 4).map((v) => `Version ${v.versionNo}, saved ${day(v.createdAt)}`).join('; ')}
            {view.earlierToDecide.length > 4 ? ` and ${view.earlierToDecide.length - 4} more` : ''}. This stays on the job until you choose. Nothing is ever deleted.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run({ action: 'earlier_copies', choice: 'hidden' }, 'hidden')}
              className="rounded-lg border border-zinc-300 p-2 text-left hover:bg-zinc-50 disabled:opacity-60"
              data-testid="tax-earlier-hidden"
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-900">{busy === 'hidden' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Keep hidden, as history</span>
              <span className="mt-0.5 block text-xs text-zinc-600">Not listed in the folder. You can open it from the file&apos;s History, so the story is never lost.</span>
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run({ action: 'earlier_copies', choice: 'visible' }, 'visible')}
              className="rounded-lg border border-zinc-300 p-2 text-left hover:bg-zinc-50 disabled:opacity-60"
              data-testid="tax-earlier-visible"
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-900">{busy === 'visible' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Keep visible</span>
              <span className="mt-0.5 block text-xs text-zinc-600">Stays in the folder, as its own file next to the approved one.</span>
            </button>
          </div>
        </div>
      )}

      {(st.state === 'saving' || st.state === 'not_saved') && (
        <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" />
          <div>
            <p className="font-semibold">Approved. Saving the answers in Storage…</p>
            <p className="mt-0.5 text-xs text-blue-800">The answers are locked. This takes a few seconds; you can keep working.</p>
          </div>
        </div>
      )}

      {st.state === 'failed' && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="tax-save-failed">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Approved, but the file is not in Storage yet</p>
              <p className="mt-1 text-xs"><b>Why:</b> {st.reason}</p>
              <p className="mt-0.5 text-xs"><b>What to do:</b> {st.fix}</p>
              <p className="mt-1 text-xs text-amber-800">
                Tried {st.attempts} {st.attempts === 1 ? 'time' : 'times'}.{' '}
                {st.retrying ? 'The system keeps trying by itself.' : 'The system stopped trying by itself; the team was alerted.'} The approval is not undone.
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 pl-7">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run({ action: 'save' }, 'save')}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
              data-testid="tax-save-retry"
            >
              {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
              Retry saving
            </button>
            <a href="/storage" className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100">
              <FolderOpen className="h-3.5 w-3.5" /> Open in Storage
            </a>
          </div>
        </div>
      )}

      {st.state === 'not_needed' && (
        <div className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
          <p className="text-xs">{st.reason}</p>
        </div>
      )}

      {error && <p className="text-xs text-red-600" data-testid="tax-save-error">{error}</p>}
    </div>
  )
}
