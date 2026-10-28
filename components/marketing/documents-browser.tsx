'use client'

import { viewKindFor } from '@/lib/crm-store/view-html'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, useLang } from '@/components/marketing/lang-provider'
import { uploadDocument } from '@/components/marketing/documents-upload'
import { formatDocSize } from '@/lib/marketing/documents-rules'

interface Listing {
  crumbs: Array<{ id: string; name: string }>
  folders: Array<{ id: string; name: string }>
  files: Array<{ id: string; name: string; size: number | null; mimeType: string | null; updatedAt: string; versions: number }>
}
const btn = 'rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-50'
const API = '/api/marketing/documents'

/** One answer of our own server: the JSON, or an Error carrying the server's own sentence (R099: never a generic "failed"). */
async function call<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const res = await fetch(url, init)
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : fallback)
  return d as T
}
const post = <T,>(url: string, body: unknown, fallback: string, method = 'POST') => call<T>(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, fallback)

/**
 * TD Marketing — Documents (dev job 9aec66fa): the team's documents, kept in the firm's Business storage in a folder called Marketing. Open a folder, upload (button or drag), download, rename, put a new
 * version of a document in place of the old one (the old one is kept), delete (to the storage's trash). A person who may only read sees no change buttons.
 */
/** What can be opened in the page: what the browser shows by itself (PDF, pictures, plain text) plus what the CRM storage's simplified view can turn into a page (Word, Excel, text-like files). Everything else downloads. */
const canView = (name: string, mime: string | null) => ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'text/plain'].includes((mime ?? '').split(';')[0].trim().toLowerCase()) || viewKindFor(name, mime) !== null

export function DocumentsBrowser({ canManage }: { canManage: boolean }) {
  const t = useT()
  const lang = useLang()
  const [folderId, setFolderId] = useState<string | null>(null)
  const [data, setData] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [confirming, setConfirming] = useState<{ kind: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const pick = useRef<HTMLInputElement>(null)
  const replaceFor = useRef<string | null>(null)
  const locale = lang === 'it' ? 'it-IT' : 'en-US'

  const load = useCallback(async (id: string | null) => {
    setError(null)
    try { setData(await call<Listing>(id ? `${API}?folder=${id}` : API, undefined, t('The documents could not be loaded. Please try again.'))) }
    catch (e) { setError(e instanceof Error ? e.message : t('The documents could not be loaded. Please try again.')) }
  }, [t])
  useEffect(() => { void load(folderId) }, [folderId, load])

  const here = data?.crumbs[data.crumbs.length - 1]?.id ?? null

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(null); setNotice(null)
    try { const m = await fn(); if (m) setNotice(m); await load(folderId) }
    catch (e) { setError(e instanceof Error && e.message ? e.message : t('Something went wrong. Please try again.')) }
    finally { setBusy(null) }
  }

  const sendOne = (file: File, folder: string, replaceFileId: string | null) => uploadDocument(file, folder, replaceFileId, t)

  function upload(files: File[], replaceFileId: string | null = null) {
    if (!here || files.length === 0) return
    void run(t('Uploading…'), async () => {
      const done: string[] = []
      for (const f of files) done.push(await sendOne(f, here, replaceFileId))
      return done.join(' ')
    })
  }

  return (
    <div className="space-y-4 p-6 pb-20" data-testid="documents">
      <div>
        <h1 className="text-2xl font-semibold">{t('Documents')}</h1>
        <p className="mt-1 text-sm text-slate-500">{t('The team documents, kept in the firm storage (Business › Marketing). Everything you upload here is also in the Storage page of the CRM.')}</p>
      </div>

      <nav aria-label={t('Folder')} className="flex flex-wrap items-center gap-1 text-sm" data-testid="doc-crumbs">
        {(data?.crumbs ?? []).map((c, i, all) => (
          <span key={c.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-400">›</span>}
            {i === all.length - 1 ? <b className="font-semibold">{c.name}</b> : <button type="button" className="underline" onClick={() => setFolderId(i === 0 ? null : c.id)}>{c.name}</button>}
          </span>
        ))}
      </nav>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${btn} bg-teal-700 text-white`} disabled={!!busy || !here} onClick={() => { replaceFor.current = null; pick.current?.click() }} data-testid="doc-upload">{t('Upload files')}</button>
          <button type="button" className={btn} disabled={!!busy || !here} onClick={() => setNewFolder('')} data-testid="doc-new-folder">{t('New folder')}</button>
          <input ref={pick} type="file" multiple className="hidden" data-testid="doc-file-input"
            onChange={e => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; const r = replaceFor.current; replaceFor.current = null; upload(r ? fs.slice(0, 1) : fs, r) }} />
          {busy && <span role="status" className="text-sm text-slate-600" data-testid="doc-busy">{busy}</span>}
        </div>
      )}

      {newFolder !== null && (
        <form className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-3" onSubmit={e => { e.preventDefault(); const name = newFolder; if (!here) return; setNewFolder(null); void run(t('Making the folder…'), async () => { await post(`${API}/folder`, { parentId: here, name }, t('The folder could not be made. Please try again.')); return t('Folder made.') }) }}>
          <input autoFocus className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm" placeholder={t('Folder name')} value={newFolder} onChange={e => setNewFolder(e.target.value)} data-testid="doc-folder-name" />
          <button type="submit" className={`${btn} bg-teal-700 text-white`} disabled={!newFolder.trim()} data-testid="doc-folder-save">{t('Make folder')}</button>
          <button type="button" className={btn} onClick={() => setNewFolder(null)}>{t('Cancel')}</button>
        </form>
      )}

      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="doc-error">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="doc-notice">{notice}</p>}

      <div
        className={`rounded-xl border bg-white ${over ? 'ring-2 ring-teal-600' : ''}`}
        onDragOver={e => { if (canManage) { e.preventDefault(); setOver(true) } }} onDragLeave={() => setOver(false)}
        onDrop={e => { if (!canManage) return; e.preventDefault(); setOver(false); upload(Array.from(e.dataTransfer.files)) }}
      >
        {!data && !error && <p className="p-5 text-sm text-slate-500">{t('Loading…')}</p>}
        {data && data.folders.length === 0 && data.files.length === 0 && (
          <p className="p-5 text-sm text-slate-500" data-testid="doc-empty">{canManage ? t('Nothing here yet. Upload files with the button or drag them here.') : t('Nothing here yet.')}</p>
        )}
        {data && (data.folders.length > 0 || data.files.length > 0) && (
          <ul className="divide-y">
            {data.folders.map(f => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5" data-testid="doc-folder">
                <button type="button" className="min-w-0 truncate text-left font-medium" onClick={() => setFolderId(f.id)}>📁 {f.name}</button>
                {canManage && (confirming?.id === f.id
                  ? <span className="flex shrink-0 items-center gap-2 text-sm"><span>{t('Delete this folder and everything in it?')}</span><button type="button" className={`${btn} bg-rose-700 text-white`} onClick={() => { const c = confirming; setConfirming(null); void run(t('Deleting…'), async () => { await post(`${API}/folder`, { folderId: c.id }, t('The folder could not be deleted. Please try again.'), 'DELETE'); return t('Folder deleted. The Storage page of the CRM can bring it back.') }) }}>{t('Delete')}</button><button type="button" className={btn} onClick={() => setConfirming(null)}>{t('Cancel')}</button></span>
                  : <button type="button" className="shrink-0 text-sm text-rose-700 underline" onClick={() => setConfirming({ kind: 'folder', id: f.id, name: f.name })}>{t('Delete')}</button>)}
              </li>
            ))}
            {data.files.map(f => (
              <li key={f.id} className="px-4 py-2.5" data-testid="doc-file" data-name={f.name}>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0">
                    {renaming?.id === f.id ? (
                      <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); const r = renaming; setRenaming(null); void run(t('Renaming…'), async () => { await post(`${API}/file/${r.id}`, { name: r.value }, t('The document could not be renamed. Please try again.'), 'PATCH'); return t('Renamed.') }) }}>
                        <input autoFocus className="min-w-0 rounded-lg border px-2 py-1 text-sm" value={renaming.value} onChange={e => setRenaming({ id: f.id, value: e.target.value })} data-testid="doc-rename-input" />
                        <button type="submit" className={btn} data-testid="doc-rename-save">{t('Save')}</button><button type="button" className={btn} onClick={() => setRenaming(null)}>{t('Cancel')}</button>
                      </form>
                    ) : <span className="block truncate font-medium">{f.name}</span>}
                    <span className="block text-xs text-slate-500">{[formatDocSize(f.size), new Date(f.updatedAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }), f.versions > 1 ? t('{n} versions', { n: f.versions }) : ''].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-3 text-sm">
                    {canView(f.name, f.mimeType) && <a className="underline" href={`${API}/file/${f.id}?view=1`} target="_blank" rel="noopener noreferrer" data-testid="doc-view">{t('Open')}</a>}
                    <a className="underline" href={`${API}/file/${f.id}`} data-testid="doc-download">{t('Download')}</a>
                    {canManage && (confirming?.id === f.id
                      ? <span className="flex items-center gap-2"><span>{t('Delete this document?')}</span><button type="button" className={`${btn} bg-rose-700 text-white`} data-testid="doc-delete-yes" onClick={() => { const c = confirming; setConfirming(null); void run(t('Deleting…'), async () => { await call(`${API}/file/${c.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }, t('The document could not be deleted. Please try again.')); return t('Document deleted. The Storage page of the CRM can bring it back.') }) }}>{t('Delete')}</button><button type="button" className={btn} onClick={() => setConfirming(null)}>{t('Cancel')}</button></span>
                      : <>
                        <button type="button" className="underline" onClick={() => setRenaming({ id: f.id, value: f.name })} data-testid="doc-rename">{t('Rename')}</button>
                        <button type="button" className="underline" disabled={!!busy} onClick={() => { replaceFor.current = f.id; pick.current?.click() }} data-testid="doc-replace">{t('Upload a new version')}</button>
                        <button type="button" className="text-rose-700 underline" onClick={() => setConfirming({ kind: 'file', id: f.id, name: f.name })} data-testid="doc-delete">{t('Delete')}</button>
                      </>)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-slate-500">{canManage ? t('To edit a document: download it, change it on your computer, then use Upload a new version. The old version is kept.') : t('You can see and download these documents. Ask your team owner if you need to change them.')}</p>
    </div>
  )
}
