'use client'

/**
 * "My Google Drive" → the open folder of My files / Business (owners only). Browse your own Drive, tick folders and files (or copy
 * the folder you are looking at), and the copy runs in the same upload box as a drop: folders kept, Google Docs / Sheets / Slides
 * become Word / Excel / PowerPoint files, nothing is changed on Drive, no file limit.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Folder, File as FileIcon, Loader2, X } from 'lucide-react'
import { allFolderPaths, formatBytes, type PlainItem, type PlainSkipped } from '@/lib/crm-store/plain-drop'
import { planDriveEntry } from '@/lib/crm-store/my-drive'

interface Entry { id: string; name: string; mimeType: string; size: number | null }
const isFolder = (e: Entry) => e.mimeType === 'application/vnd.google-apps.folder'

async function listPage(folder: string, account: string, page?: string | null): Promise<{ entries: Entry[]; nextPageToken: string | null }> {
  const r = await fetch(`/api/crm-store/mydrive/list?folder=${encodeURIComponent(folder)}&account=${encodeURIComponent(account)}${page ? `&page=${encodeURIComponent(page)}` : ''}`)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || 'Could not open your Google Drive.')
  return d
}
async function listAll(folder: string, account: string): Promise<Entry[]> {
  const out: Entry[] = []
  let page: string | null = null
  do { const r = await listPage(folder, account, page); out.push(...r.entries); page = r.nextPageToken } while (page)
  return out
}

/** every file under the chosen entries, with its folder path (folders are walked all the way down) */
export async function collectDriveItems(roots: Array<{ entry: Entry; path: string[] }>, account: string, onProgress?: (n: number) => void): Promise<{ items: PlainItem[]; skipped: PlainSkipped[]; folders: string[][] }> {
  const items: PlainItem[] = []
  const skipped: PlainSkipped[] = []
  const dirs: string[][] = []
  const queue = [...roots]
  while (queue.length) {
    const { entry, path } = queue.shift()!
    const plan = planDriveEntry(entry.mimeType, entry.name)
    if (plan.kind === 'folder') {
      dirs.push([...path, entry.name])                      // kept even if nothing inside can be copied
      const kids = await listAll(entry.id, account)
      for (const k of kids) queue.push({ entry: k, path: [...path, entry.name] })
    } else if (plan.kind === 'skip') {
      skipped.push({ name: [...path, entry.name].join(' › '), why: plan.why })
    } else {
      const f = new File([], plan.name)
      Object.defineProperty(f, 'size', { value: entry.size ?? 0 })
      items.push({ file: f, path, driveId: entry.id, driveAccount: account })
      onProgress?.(items.length)
    }
  }
  return { items, skipped, folders: allFolderPaths([], dirs) }
}

export function MyDriveDialog({ targetName, onClose, onChosen }: {
  targetName: string
  onClose: () => void
  onChosen: (items: PlainItem[], skipped: PlainSkipped[], folders: string[][]) => void
}) {
  const [account, setAccount] = useState<string>('me')
  const [emailBox, setEmailBox] = useState('')
  const [crumbs, setCrumbs] = useState<Array<{ id: string; name: string }>>([{ id: 'root', name: 'My Drive' }])
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [more, setMore] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, Entry>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const here = crumbs[crumbs.length - 1]

  const open = useCallback(async (folder: string) => {
    setEntries(null); setMore(null); setError(null)
    try { const r = await listPage(folder, account); setEntries(r.entries); setMore(r.nextPageToken) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open your Google Drive.'); setEntries([]) }
  }, [account])
  useEffect(() => { void open(here.id) }, [here.id, open])

  const loadMore = async () => {
    if (!more) return
    try { const r = await listPage(here.id, account, more); setEntries((cur) => [...(cur ?? []), ...r.entries]); setMore(r.nextPageToken) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load more.') }
  }

  const go = async (roots: Array<{ entry: Entry; path: string[] }>) => {
    setBusy('Reading the folders…'); setError(null)
    try {
      const r = await collectDriveItems(roots, account, (n) => setBusy(`Reading the folders… ${n} files found`))
      if (!r.items.length && !r.skipped.length && !r.folders.length) { setError('There is nothing to copy there.'); setBusy(null); return }
      onChosen(r.items, r.skipped, r.folders)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read your Google Drive.'); setBusy(null) }
  }

  const pickedList = Object.values(picked)
  return (
    <div className="fixed inset-0 z-[66] flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!busy) onClose() }} role="dialog" aria-modal="true" aria-label="My Google Drive">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white p-5 text-sm shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="my-drive-dialog">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-base font-semibold text-zinc-900">Copy from Google Drive into “{targetName}”</h3>
          {!busy && <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>}
        </div>
        <p className="mt-1 text-xs text-zinc-500">Pick whose Drive to look in. Nothing on Drive is changed — it is only copied. Google Docs, Sheets and Slides arrive as Word, Excel and PowerPoint files.</p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="my-drive-account">
          <span className="text-zinc-500">Whose Drive:</span>
          {[{ key: 'me', label: 'Mine' }, { key: 'support@tonydurante.us', label: 'Company (support@)' }].map((a) => (
            <button key={a.key} type="button" disabled={!!busy} onClick={() => { setAccount(a.key); setPicked({}); setCrumbs([{ id: 'root', name: 'My Drive' }]) }}
              className={`rounded-md border px-2 py-0.5 ${account === a.key ? 'border-blue-600 bg-blue-50 text-blue-800' : 'border-zinc-300 hover:bg-zinc-50'}`}>{a.label}</button>
          ))}
          <input value={emailBox} onChange={(e) => setEmailBox(e.target.value)} placeholder="a teammate’s address…" aria-label="A teammate’s Google address" disabled={!!busy}
            onKeyDown={(e) => { if (e.key === 'Enter' && emailBox.includes('@')) { setAccount(emailBox.trim().toLowerCase()); setPicked({}); setCrumbs([{ id: 'root', name: 'My Drive' }]) } }}
            className="w-44 rounded-md border border-zinc-300 px-2 py-0.5" />
          <button type="button" disabled={!!busy || !emailBox.includes('@')} onClick={() => { setAccount(emailBox.trim().toLowerCase()); setPicked({}); setCrumbs([{ id: 'root', name: 'My Drive' }]) }} className="rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 disabled:opacity-50">Open</button>
        </div>
        {account !== 'me' && <p className="mt-1 text-xs text-amber-700">You are looking at the Google Drive of <strong>{account}</strong> — it can include their personal files. Opening it and anything you copy is logged.</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-zinc-500">Look in:</span>
          {[{ id: 'root', name: 'My Drive' }, { id: 'shared', name: 'Shared with me' }, { id: 'drives', name: 'Shared drives' }].map((t) => (
            <button key={t.id} type="button" disabled={!!busy} onClick={() => { setPicked({}); setCrumbs([t]) }}
              className={`rounded-md border px-2 py-0.5 ${crumbs[0].id === t.id ? 'border-blue-600 bg-blue-50 text-blue-800' : 'border-zinc-300 hover:bg-zinc-50'}`}>{t.name}</button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-0.5 text-xs text-zinc-600">
          {crumbs.map((c, i) => (
            <span key={c.id} className="inline-flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="h-3 w-3" />}
              <button type="button" disabled={!!busy || i === crumbs.length - 1} onClick={() => setCrumbs(crumbs.slice(0, i + 1))} className="rounded px-1 hover:bg-zinc-100 disabled:font-medium disabled:text-zinc-900">{c.name}</button>
            </span>
          ))}
        </div>

        <div className="mt-2 min-h-[10rem] flex-1 overflow-y-auto rounded-md border border-zinc-200">
          {entries === null ? <p className="p-3 text-zinc-500"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />Opening…</p>
            : entries.length === 0 ? <p className="p-3 text-zinc-500">{error ? '' : 'Nothing in this folder.'}</p>
            : (
              <ul>
                {entries.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-1.5 last:border-0">
                    <input type="checkbox" aria-label={`Select ${e.name}`} disabled={!!busy} checked={!!picked[e.id]} onChange={(ev) => setPicked((p) => { const n = { ...p }; if (ev.target.checked) n[e.id] = e; else delete n[e.id]; return n })} />
                    {isFolder(e)
                      ? <button type="button" disabled={!!busy} onClick={() => setCrumbs([...crumbs, { id: e.id, name: e.name }])} className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline"><Folder className="h-4 w-4 shrink-0 text-amber-600" /><span className="truncate">{e.name}</span></button>
                      : <span className="flex min-w-0 flex-1 items-center gap-1.5"><FileIcon className="h-4 w-4 shrink-0 text-zinc-400" /><span className="truncate">{e.name}</span></span>}
                    {!isFolder(e) && e.size != null && <span className="shrink-0 text-xs text-zinc-400">{formatBytes(e.size)}</span>}
                  </li>
                ))}
              </ul>
            )}
          {more && <button type="button" onClick={() => void loadMore()} className="w-full p-2 text-xs text-blue-700 hover:bg-zinc-50">Show more</button>}
        </div>

        {error && <p className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800" role="alert">{error}</p>}
        {busy && <p className="mt-2 text-zinc-700" role="status"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />{busy}</p>}

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button type="button" disabled={!!busy || here.id === 'root' || here.id === 'shared' || here.id === 'drives'} onClick={() => void go([{ entry: { id: here.id, name: here.name, mimeType: 'application/vnd.google-apps.folder', size: null }, path: [] }])} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 disabled:opacity-50">Copy this whole folder</button>
          <button type="button" disabled={!!busy || pickedList.length === 0} onClick={() => void go(pickedList.map((entry) => ({ entry, path: [] })))} className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-50" data-testid="my-drive-copy-selected">Copy {pickedList.length || ''} selected</button>
        </div>
      </div>
    </div>
  )
}
