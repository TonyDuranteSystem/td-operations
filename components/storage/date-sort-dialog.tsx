'use client'

/**
 * "Sort by date" on a folder (dev job 1f4645b6). Pick how to group, see EXACTLY what would move (nothing is written by the preview), then Confirm.
 * The folders it makes are real folders, so the Mac's Finder shows the same. The server re-plans on every call; this screen only shows the plan.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { DEFAULT_DATE_SORT, MONTH_NAMES, groupPath, type DateSortSettings, type Grouping, type MonthLabel, type SortOrder } from '@/lib/crm-store/date-sort-rules'

interface Preview {
  folder: string; total: number; toMove: number; stay: number; clashes: number
  newGroups: string[]; reusedGroups: string[]
  groups: Array<{ label: string; count: number; example: string }>
  stayList: Array<{ name: string; reason: string }>; clashList: Array<{ name: string; reason: string }>
}
interface Applied { moved: number; failed: Array<{ name: string; reason: string }>; remaining: number; createdGroups: number }

async function call<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) { const d = await r.json().catch(() => ({})) as { error?: string }; throw new Error(d.error || fallback) }
  return r.json() as Promise<T>
}

export function DateSortDialog({ folderId, folderName, onClose, onDone }: { folderId: string; folderName: string; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [s, setS] = useState<DateSortSettings>(DEFAULT_DATE_SORT)
  const [own, setOwn] = useState(false)
  const [ownYear, setOwnYear] = useState('{year}')
  const [ownMonth, setOwnMonth] = useState('{month} {monthName}')
  const [remembered, setRemembered] = useState(false)
  const [ready, setReady] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Applied | null>(null)
  const run = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && busy !== 'apply') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // what this folder remembered from last time
  useEffect(() => {
    call<{ settings: DateSortSettings; remembered: boolean }>(`/api/crm-store/browse/folder/${folderId}/date-sort`, undefined, 'Could not read the saved choice.')
      .then((d) => {
        setS(d.settings); setRemembered(d.remembered)
        if (d.settings.custom) { setOwn(true); setOwnYear(d.settings.custom.year ?? '{year}'); setOwnMonth(d.settings.custom.month ?? '{month} {monthName}') }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read the saved choice.'))
      .finally(() => setReady(true))
  }, [folderId])

  const settings: DateSortSettings = useMemo(() => ({
    ...s, ...(own ? { custom: { ...(s.grouping !== 'month' ? { year: ownYear } : {}), ...(s.grouping !== 'year' ? { month: ownMonth } : {}) } } : { custom: undefined }),
  }), [s, own, ownYear, ownMonth])

  // the preview follows the choices (a short pause so typing a pattern doesn't ask the server on every key)
  useEffect(() => {
    if (!ready || outcome) return
    const mine = ++run.current
    const t = setTimeout(async () => {
      setBusy('preview'); setError(null)
      try {
        const p = await call<Preview>(`/api/crm-store/browse/folder/${folderId}/date-sort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'preview', settings }) }, 'Could not make the preview.')
        if (run.current === mine) setPreview(p)
      } catch (e) {
        if (run.current === mine) { setPreview(null); setError(e instanceof Error ? e.message : 'Could not make the preview.') }
      } finally { if (run.current === mine) setBusy(null) }
    }, 350)
    return () => clearTimeout(t)
  }, [ready, settings, folderId, outcome])

  const example = useMemo(() => groupPath({ year: 2026, month: 11 }, settings).join(' › '), [settings])

  const confirm = async () => {
    setBusy('apply'); setError(null)
    let moved = 0, created = 0
    const failed: Applied['failed'] = []
    let remaining = preview?.toMove ?? 0
    try {
      for (let guard = 0; guard < 400; guard++) {
        const a = await call<Applied>(`/api/crm-store/browse/folder/${folderId}/date-sort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'apply', settings }) }, 'The folder could not be sorted.')
        moved += a.moved; created += a.createdGroups; failed.push(...a.failed); remaining = a.remaining
        setProgress(`${moved} of ${preview?.toMove ?? moved} moved…`)
        if (a.remaining === 0 || a.moved === 0) break
      }
      setOutcome({ moved, failed, remaining, createdGroups: created })
      toast.success(`${moved} moved into ${created} new ${created === 1 ? 'folder' : 'folders'}${failed.length ? ` — ${failed.length} could not be moved` : ''}`)
      await onDone()
    } catch (e) {
      setError(`${e instanceof Error ? e.message : 'The folder could not be sorted.'} ${moved ? `(${moved} were already moved — press Confirm again to carry on.)` : ''}`.trim())
      await onDone()
    } finally { setBusy(null); setProgress(null) }
  }

  const sel = 'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm'
  const lab = 'text-xs font-medium text-zinc-600'
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => busy !== 'apply' && onClose()} role="dialog" aria-modal="true" aria-label="Sort by date">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start gap-2">
          <h3 className="flex-1 text-base font-semibold text-zinc-900">Sort &ldquo;{folderName}&rdquo; by date</h3>
          <button type="button" onClick={onClose} disabled={busy === 'apply'} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>
        <p className="mb-3 text-sm text-zinc-600">
          Items with a date at the start of their name (like <span className="font-mono text-xs">2026-11-02 …</span>) are put into year / month folders. These are real folders, so Finder on the Mac shows the same. Nothing moves until you press Confirm.
          {remembered && <span className="ml-1 text-zinc-500">Your last choice for this folder is filled in.</span>}
        </p>

        {!outcome && (
          <div className="mb-3 grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1"><span className={lab}>Group by</span>
              <select className={sel} value={s.grouping} disabled={busy === 'apply'} onChange={(e) => setS({ ...s, grouping: e.target.value as Grouping })}>
                <option value="year">Year only</option><option value="year_month">Year, then month</option><option value="month">Month only</option>
              </select></label>
            <label className="flex flex-col gap-1"><span className={lab}>Month is written as</span>
              <select className={sel} value={s.monthLabel} disabled={own || s.grouping === 'year' || busy === 'apply'} onChange={(e) => setS({ ...s, monthLabel: e.target.value as MonthLabel })}>
                <option value="number">11</option><option value="number_name">11 November</option><option value="name">November</option>
              </select></label>
            <label className="flex flex-col gap-1"><span className={lab}>Order</span>
              <select className={sel} value={s.order} disabled={busy === 'apply'} onChange={(e) => setS({ ...s, order: e.target.value as SortOrder })}>
                <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
              </select></label>
          </div>
        )}
        {!outcome && (
          <div className="mb-3 rounded-md border border-zinc-200 p-2.5">
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={own} disabled={busy === 'apply'} onChange={(e) => setOwn(e.target.checked)} /> Write the folder names my own way
            </label>
            {own && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {s.grouping !== 'month' && <label className="flex flex-col gap-1"><span className={lab}>Year folder</span><input className={sel} value={ownYear} maxLength={60} onChange={(e) => setOwnYear(e.target.value)} /></label>}
                {s.grouping !== 'year' && <label className="flex flex-col gap-1"><span className={lab}>{s.grouping === 'month' ? 'Month folder (include {year})' : 'Month folder'}</span><input className={sel} value={ownMonth} maxLength={60} onChange={(e) => setOwnMonth(e.target.value)} /></label>}
                <p className="text-xs text-zinc-500 sm:col-span-2">Use <span className="font-mono">{'{year}'}</span> (2026), <span className="font-mono">{'{month}'}</span> (11) and <span className="font-mono">{'{monthName}'}</span> ({MONTH_NAMES[10]}). Example: <span className="font-mono">{'{month} - {monthName}'}</span> → 11 - November.</p>
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-500">A date in November 2026 goes into: <span className="font-medium text-zinc-800">{example}</span></p>
          </div>
        )}

        {error && <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-sm text-red-700">{error}</p>}

        {!outcome && preview && (
          <div className="mb-3 text-sm text-zinc-700">
            <p className="mb-2 font-medium text-zinc-900">
              {preview.toMove === 0 ? 'Nothing to move.' : `${preview.toMove} ${preview.toMove === 1 ? 'item' : 'items'} will move into ${preview.newGroups.length} new ${preview.newGroups.length === 1 ? 'folder' : 'folders'}${preview.reusedGroups.length ? ` and ${preview.reusedGroups.length} that already exist` : ''}.`}
              {preview.stay > 0 && <span className="font-normal text-zinc-600"> {preview.stay} stay where they are.</span>}
              {preview.clashes > 0 && <span className="font-normal text-amber-700"> {preview.clashes} are skipped (same name already there).</span>}
            </p>
            {preview.groups.length > 0 && (
              <ul className="max-h-52 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-2 text-xs">
                {preview.groups.map((g) => <li key={g.label} className="flex gap-2"><span className="w-44 shrink-0 font-medium text-zinc-800">{g.label}</span><span className="w-16 shrink-0 text-zinc-500">{g.count} {g.count === 1 ? 'item' : 'items'}</span><span className="min-w-0 truncate text-zinc-400">e.g. {g.example}</span></li>)}
              </ul>
            )}
            {preview.stayList.length > 0 && (
              <details className="mt-2 text-xs text-zinc-600"><summary className="cursor-pointer">Items that stay ({preview.stay})</summary>
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">{preview.stayList.map((x, i) => <li key={i}><span className="text-zinc-800">{x.name}</span> — {x.reason}</li>)}</ul>
              </details>
            )}
            {preview.clashList.length > 0 && (
              <details className="mt-2 text-xs text-amber-700"><summary className="cursor-pointer">Skipped because the name is already there ({preview.clashes})</summary>
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">{preview.clashList.map((x, i) => <li key={i}>{x.reason}</li>)}</ul>
              </details>
            )}
          </div>
        )}

        {outcome && (
          <div className="mb-3 space-y-1 text-sm text-zinc-800">
            <p className="font-medium">{outcome.moved} moved into {outcome.createdGroups} new {outcome.createdGroups === 1 ? 'folder' : 'folders'}.</p>
            {outcome.failed.length > 0 && <ul className="list-disc pl-5 text-xs text-red-700">{outcome.failed.slice(0, 20).map((f, i) => <li key={i}>{f.name}: {f.reason}</li>)}</ul>}
            <p className="text-xs text-zinc-500">To undo, move the folders back by hand — nothing was deleted. Press the button again any time new items arrive.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!outcome ? (
            <>
              <button type="button" onClick={confirm} disabled={busy !== null || !preview || preview.toMove === 0}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
                {busy === 'apply' ? (progress ?? 'Moving…') : preview && preview.toMove > 0 ? `Confirm — move ${preview.toMove}` : 'Confirm'}
              </button>
              <button type="button" onClick={onClose} disabled={busy === 'apply'} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50">Cancel</button>
              {busy === 'preview' && <span className="text-xs text-zinc-500">Checking…</span>}
            </>
          ) : (
            <button type="button" onClick={onClose} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700">Done</button>
          )}
        </div>
      </div>
    </div>
  )
}
