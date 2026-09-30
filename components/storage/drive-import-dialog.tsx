'use client'

/**
 * "Import from Google Drive" (Antonio 2026-09-29): browse the Shared Drive's folders, pick ONE client's folder and
 * copy it into the new storage — a STUDY copy: Google Drive is not touched and the client's records keep using Drive,
 * so nothing changes for the client. Then the copy is organised in the new storage (type, folder, name) and the rules
 * are learnt from it. Owners only; the server decides where it may run.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, Folder, Loader2, X, HardDriveDownload, CheckCircle2, AlertTriangle, Undo2, ScanText } from 'lucide-react'
import { ContentsReport, type ContentReportData } from './contents-report'

interface Row {
  id: string; name: string
  company: { accountId: string; name: string; status: string | null } | null
  copy: { runId: string; status: string; mode: 'move' | 'copy'; ownerId: string | null; files: number } | null
}
interface Listing { root: string; folderId: string; folders: Row[]; files: number; cutOff?: boolean }
interface RunView { id: string; status: string; mode: string; ownerId: string | null; counts: { total: number; done: number; merged: number; skipped: number; failed: number; pending: number; working?: number } }

async function send<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error || fallback)
  return j as T
}

export function DriveImportDialog({ onClose, onOpenStorage }: { onClose: () => void; onOpenStorage: (ownerId: string) => void }) {
  const [path, setPath] = useState<Array<{ id: string | null; name: string }>>([{ id: null, name: 'Google Drive' }])
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // the search box looks in the WHOLE Shared Drive (company names anywhere inside a word + folders at any level),
  // whichever folder is open — not just the folders on screen
  const [found, setFound] = useState<Row[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const q = filter.trim()
  const [running, setRunning] = useState<{ row: Row; run: RunView } | null>(null)
  const [confirm, setConfirm] = useState<Row | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const here = path[path.length - 1]
  const load = useCallback(async () => {
    setListing(null); setError(null)
    try {
      const r = await fetch(`/api/crm-store/drive-folders${here.id ? `?folder=${encodeURIComponent(here.id)}` : ''}`)
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j as { error?: string }).error || 'Could not open the Drive folder — please try again.')
      if (alive.current) setListing(j as Listing)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not open the Drive folder.')
    }
  }, [here.id])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (q.length < 2) { setFound(null); setSearchError(null); setSearching(false); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/crm-store/drive-folders?search=${encodeURIComponent(q)}`)
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error((j as { error?: string }).error || 'The search failed — please try again.')
        if (!cancelled) { setFound((j as { results: Row[] }).results); setSearchError(null) }
      } catch (e) {
        if (!cancelled) setSearchError(e instanceof Error && e.message ? e.message : 'The search failed — please try again.')
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q, tick])

  const copy = async (row: Row) => {
    setConfirm(null)
    if (!row.company) return
    try {
      let run = await send<RunView>('/api/crm-store/import', { accountId: row.company.accountId, mode: 'copy' }, 'The copy could not start.')
      setRunning({ row, run })
      while (alive.current && run.status === 'moving') {
        run = await send<RunView>(`/api/crm-store/import/${run.id}/continue`, {}, 'The copy stopped — press Copy again to continue.')
        if (alive.current) setRunning({ row, run })
      }
      if (!alive.current) return
      if (run.status === 'done' || run.status === 'incomplete') {
        toast.success(`${row.company.name}: ${run.counts.done} files copied${run.counts.merged ? `, ${run.counts.merged} identical copies kept once` : ''}${run.counts.skipped ? `, ${run.counts.skipped} not copied (listed)` : ''}${run.counts.failed ? `, ${run.counts.failed} failed` : ''}`)
      }
      await load(); setTick((n) => n + 1)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The copy could not run — please try again.')
      await load(); setTick((n) => n + 1)
    } finally {
      if (alive.current) setRunning(null)
    }
  }
  const [reading, setReading] = useState<string | null>(null)
  const [contents, setContents] = useState<{ title: string; data: ContentReportData } | null>(null)
  const checkContents = async (row: Row) => {
    if (!row.copy) return
    setReading(row.id)
    try {
      setContents({ title: row.company?.name ?? row.name, data: await send<ContentReportData>(`/api/crm-store/import/${row.copy.runId}/check-contents`, {}, 'The contents could not be checked.') })
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The contents could not be checked.')
    } finally {
      if (alive.current) setReading(null)
    }
  }
  const [removing, setRemoving] = useState<string | null>(null)
  const removeCopy = async (row: Row, ask = true) => {
    if (!row.copy) return
    if (ask && !window.confirm(`Remove the copy of ${row.company?.name ?? row.name} from the new storage? Google Drive is not touched.`)) return
    setRemoving(row.id)
    try {
      // a big copy is removed over several requests — keep going until it is gone
      let r = await send<{ status: string }>(`/api/crm-store/import/${row.copy.runId}/undo`, {}, 'The copy could not be removed.')
      for (let i = 0; i < 40 && alive.current && r.status === 'undoing'; i++) r = await send<{ status: string }>(`/api/crm-store/import/${row.copy.runId}/undo`, {}, 'The copy could not be removed — press Continue removing.')
      if (r.status === 'rolled_back') toast.success('Copy removed — the files are in the new storage\'s trash')
      await load(); setTick((n) => n + 1)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The copy could not be removed.')
      await load(); setTick((n) => n + 1)
    } finally {
      if (alive.current) setRemoving(null)
    }
  }

  // 2+ letters typed = search results from the whole Drive; otherwise the folders of the open level
  const rows = found !== null ? found : (listing?.folders ?? [])
  const counted = running ? running.run.counts.done + running.run.counts.merged + running.run.counts.skipped + running.run.counts.failed : 0

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!running) onClose() }} role="dialog" aria-modal="true" aria-label="Import from Google Drive">
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-xl bg-white p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-start gap-2">
          <HardDriveDownload className="mt-0.5 h-5 w-5 text-blue-600" />
          <div className="flex-1">
            <p className="font-medium text-zinc-900">Import from Google Drive</p>
            <p className="text-xs text-zinc-500">Pick a client&apos;s folder and copy it into our storage to organise it. Google Drive is not changed, and the client and the CRM keep using Drive — nothing changes for the client.</p>
          </div>
          <button type="button" aria-label="Close" disabled={!!running} onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <nav className="mb-2 flex flex-wrap items-center gap-1 text-xs text-zinc-600" aria-label="Drive path">
          {path.map((p, i) => (
            <span key={`${p.id}-${i}`} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-zinc-400" />}
              <button type="button" disabled={!!running || i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}
                className={i === path.length - 1 ? 'font-medium text-zinc-900' : 'hover:underline'}>{p.name}</button>
            </span>
          ))}
        </nav>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search all of Google Drive — a company or folder name…" aria-label="Search all of Google Drive"
          className="mb-2 w-full rounded-md border border-zinc-300 px-2 py-1 text-sm" />
        {searching && <p className="mb-1 flex items-center gap-1 text-xs text-zinc-500"><Loader2 className="h-3 w-3 animate-spin" />Searching all of Google Drive…</p>}
        {searchError && <p className="mb-1 text-xs text-red-700">{searchError}</p>}
        {found !== null && !searching && !searchError && <p className="mb-1 text-xs text-zinc-500">{found.length === 0 ? `Nothing in Google Drive matches "${q}".` : `${found.length} match${found.length === 1 ? '' : 'es'} in all of Google Drive for "${q}" — companies first.`}</p>}

        {running && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />Copying {running.row.company?.name}… {counted} of {running.run.counts.total} files — keep this window open
          </div>
        )}
        {error && <p className="text-xs text-red-700">{error}</p>}
        {!listing && !error && <p className="text-xs text-zinc-500">Loading…</p>}

        <ul className="min-h-0 flex-1 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200">
          {found === null && listing && rows.length === 0 && <li className="px-3 py-2 text-xs text-zinc-500">No folders here{listing.files ? ` (${listing.files} loose files)` : ''}.</li>}
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <button type="button" disabled={!!running} onClick={() => { setFilter(''); setPath(found !== null ? [path[0], { id: r.id, name: r.name }] : [...path, { id: r.id, name: r.name }]) }}
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline disabled:opacity-50">
                <Folder className="h-4 w-4 shrink-0 text-amber-500" /><span className="truncate">{r.name}</span>
              </button>
              {r.company ? (
                <>
                  <span className="text-xs text-zinc-500">{r.company.name}{r.company.status && r.company.status !== 'Active' ? ` · ${r.company.status}` : ''}</span>
                  {r.copy?.mode === 'move' ? (
                    <span className="text-xs text-emerald-700">{r.copy.status === 'done' || r.copy.status === 'incomplete' ? 'Moved to the new storage' : 'Being moved…'}</span>
                  ) : r.copy && (r.copy.status === 'done' || r.copy.status === 'incomplete') ? (
                    <>
                      <span className={`inline-flex items-center gap-1 text-xs ${r.copy.status === 'done' ? 'text-emerald-700' : 'text-amber-700'}`}>
                        {r.copy.status === 'done' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}Copied ({r.copy.files} files){r.copy.status === 'incomplete' ? ' — some failed' : ''}
                      </span>
                      {r.copy.ownerId && <button type="button" onClick={() => onOpenStorage(r.copy!.ownerId!)} className="rounded-md bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700">Open</button>}
                      <button type="button" disabled={!!running || !!removing || !!reading} onClick={() => void checkContents(r)} aria-label={`Check the contents of the copy of ${r.company.name}`} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50">{reading === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanText className="h-3 w-3" />}Check contents</button>
                      <button type="button" disabled={!!running || !!removing} onClick={() => void removeCopy(r)} aria-label={`Remove the copy of ${r.company.name}`} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50"><Undo2 className="h-3 w-3" />Remove copy</button>
                    </>
                  ) : r.copy && (r.copy.status === 'moving' || r.copy.status === 'scanning') ? (
                    <>
                      <button type="button" disabled={!!running || !!removing} onClick={() => void copy(r)} className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50">Continue copy</button>
                      <button type="button" disabled={!!running || !!removing} onClick={() => void removeCopy(r)} aria-label={`Remove the unfinished copy of ${r.company.name}`} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50"><Undo2 className="h-3 w-3" />Remove copy</button>
                    </>
                  ) : r.copy?.status === 'undoing' ? (
                    removing === r.id
                      ? <span className="inline-flex items-center gap-1 text-xs text-amber-700"><Loader2 className="h-3 w-3 animate-spin" />Removing…</span>
                      : <button type="button" disabled={!!running} onClick={() => void removeCopy(r, false)} className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100">Continue removing</button>
                  ) : confirm?.id === r.id ? (
                    <span className="inline-flex items-center gap-1">
                      <button type="button" onClick={() => void copy(r)} className="rounded-md bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700">Yes, copy it</button>
                      <button type="button" onClick={() => setConfirm(null)} className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50">Cancel</button>
                    </span>
                  ) : (
                    <button type="button" disabled={!!running} onClick={() => setConfirm(r)} className="rounded-md bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50">Copy into our storage</button>
                  )}
                </>
              ) : (
                <span className="text-xs text-zinc-400">not a client folder</span>
              )}
            </li>
          ))}
        </ul>
        {contents && <ContentsReport title={contents.title} data={contents.data} onClose={() => setContents(null)} onChanged={() => { const row = rows.find((x) => (x.company?.name ?? x.name) === contents.title); if (row) void checkContents(row) }} />}
        {found === null && listing && listing.files > 0 && rows.length > 0 && <p className="mt-1 text-xs text-zinc-500">{listing.files} loose files in this folder are not listed.</p>}
        {found === null && listing?.cutOff && <p className="mt-1 text-xs text-amber-700">This folder is very large — only the first 5,000 entries are listed; use the search or open a sub-folder.</p>}
      </div>
    </div>
  )
}
