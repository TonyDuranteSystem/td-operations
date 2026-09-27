'use client'

/**
 * The storage screens' questions and pickers (master plan Part 16 "the system asks you", Part 14 Move picker).
 * - QuestionDialog: ONE clear question with its evidence (previews side by side, facts) and REAL choices —
 *   every button does something specific; the words come from the catalog (storage_questions).
 * - FolderPicker: the tree of one storage (or, with `chooseOwner`, any client / Business / My files first),
 *   lazy-loaded, for Move and for "Choose another place…".
 */

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2, X, Building2, User, Hammer, Briefcase, Lock } from 'lucide-react'

export interface StoreQuestion { enabled: boolean; title: string; choices: Record<string, string> }
export interface PickFolder { id: string; name: string; kind: string; trashed: boolean; locked?: boolean }
export interface NavOwner { id: string; kind: string; label: string; status: string | null; fileCount: number }
export interface NavGroup { key: string; label: string; section: 'clients' | 'business' | 'private'; owners: NavOwner[] }

const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'text/plain'])

/** A small preview of a file (a stored one by URL, or a file just picked on the computer by object URL). */
export function MiniPreview({ src, mimeType, label, sub }: { src: string; mimeType: string | null; label: string; sub?: string }) {
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase()
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-zinc-200">
      <div className="border-b border-zinc-100 px-2 py-1 text-xs">
        <p className="truncate font-medium text-zinc-800">{label}</p>
        {sub && <p className="truncate text-zinc-500">{sub}</p>}
      </div>
      <div className="h-64 bg-zinc-50">
        {!INLINE.has(mime) ? (
          <p className="flex h-full items-center justify-center p-3 text-center text-xs text-zinc-500">No preview for this kind of file.</p>
        ) : mime.startsWith('image/') ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={label} className="mx-auto h-full object-contain" />
        ) : (
          <iframe src={src} title={label} className="h-full w-full border-0" />
        )}
      </div>
    </div>
  )
}

export interface Choice { key: string; label?: string; tone?: 'primary' | 'danger' | 'plain'; disabled?: boolean; onChoose: () => void }

/** One question: title, evidence, and the choices (labels from the catalog, falling back to the given label). */
export function QuestionDialog({ q, fallbackTitle, children, choices, onClose }: {
  q: StoreQuestion | undefined; fallbackTitle: string; children: React.ReactNode; choices: Choice[]; onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start gap-2">
          <h3 className="flex-1 text-base font-semibold text-zinc-900">{q?.title ?? fallbackTitle}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-4 space-y-3 text-sm text-zinc-700">{children}</div>
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <button key={c.key} type="button" disabled={c.disabled} onClick={c.onChoose}
              className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${c.tone === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-700'
                : c.tone === 'danger' ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50'}`}>
              {c.label ?? q?.choices[c.key] ?? c.key}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not load — please try again.')
  return data as T
}

const ownerIcon = (k: string) => (k === 'company' ? Building2 : k === 'person' ? User : k === 'formation' ? Hammer : k === 'business' ? Briefcase : k === 'private' ? Lock : Folder)

/**
 * The folder tree picker. `mode` 'file' = where a FILE may go (not a client's top folder, not "2. Contacts");
 * 'folder' = where a FOLDER may go (a top folder is fine; never inside itself). With `chooseOwner` the
 * picker first lists every storage (search), most likely first (`preferOwnerIds`).
 */
export function FolderPicker({ title, ownerId: fixedOwner, ownerLabel, mode, excludeFolderId, currentFolderId, chooseOwner, preferOwnerIds, onPick, onClose }: {
  title: string; ownerId?: string; ownerLabel?: string; mode: 'file' | 'folder'; excludeFolderId?: string | null; currentFolderId?: string | null
  chooseOwner?: boolean; preferOwnerIds?: string[]; onPick: (folderId: string, ownerId: string, path: string) => void; onClose: () => void
}) {
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(fixedOwner ? { id: fixedOwner, label: ownerLabel ?? '' } : null)
  const [groups, setGroups] = useState<NavGroup[] | null>(null)
  const [search, setSearch] = useState('')
  const [nodes, setNodes] = useState<Record<string, PickFolder[]>>({})
  const [rootId, setRootId] = useState<string | null>(null)
  const [rootFolder, setRootFolder] = useState<PickFolder | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<{ id: string; path: string } | null>(null)

  useEffect(() => {
    if (!chooseOwner || owner) return
    getJson<{ groups: NavGroup[] }>('/api/crm-store/browse/navigation').then((d) => setGroups(d.groups)).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the list.'))
  }, [chooseOwner, owner])

  const load = useCallback(async (oid: string, folderId: string | null) => {
    const key = folderId ?? 'root'
    setLoading((l) => new Set(l).add(key))
    try {
      const r = await getJson<{ folder: PickFolder | null; folders: PickFolder[] }>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(oid)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`)
      if (!folderId) { setRootId(r.folder?.id ?? null); setRootFolder(r.folder); if (r.folder) setOpen(new Set([r.folder.id])) }
      if (r.folder) setNodes((n) => ({ ...n, [r.folder!.id]: r.folders }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the folder.')
    } finally {
      setLoading((l) => { const n = new Set(l); n.delete(key); return n })
    }
  }, [])

  useEffect(() => { if (owner) { setNodes({}); setOpen(new Set()); setChosen(null); load(owner.id, null) } }, [owner, load])

  const selectable = (f: PickFolder) => {
    if (f.trashed || f.kind === 'contacts' || f.id === excludeFolderId || f.id === currentFolderId) return false
    if (mode === 'file' && f.kind === 'root') return false
    return true
  }
  const toggle = (f: PickFolder) => {
    const isOpen = open.has(f.id)
    setOpen((o) => { const n = new Set(o); if (isOpen) n.delete(f.id); else n.add(f.id); return n })
    if (!isOpen && !nodes[f.id] && owner) load(owner.id, f.id)
  }
  const node = (f: PickFolder, depth: number, trail: string[]): React.ReactNode => {
    if (f.id === excludeFolderId) return null // a folder can't go inside itself (nor its sub-folders)
    const isOpen = open.has(f.id)
    const kids = nodes[f.id]
    const path = [...trail, f.name]
    const ok = selectable(f)
    return (
      <li key={f.id}>
        <div className={`flex items-center gap-1 rounded py-1 text-sm ${chosen?.id === f.id ? 'bg-blue-50 ring-1 ring-blue-300' : 'hover:bg-zinc-50'}`} style={{ paddingLeft: `${depth * 18 + 4}px` }}>
          {f.kind === 'contacts' ? <span className="w-4" /> : (
            <button type="button" aria-label={isOpen ? 'Close' : 'Open'} onClick={() => toggle(f)} className="text-zinc-400">
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          )}
          <button type="button" disabled={!ok} onClick={() => setChosen({ id: f.id, path: path.join(' › ') })}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-not-allowed disabled:text-zinc-400">
            {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" /> : <Folder className="h-4 w-4 shrink-0 text-amber-500" />}
            <span className="truncate">{f.name}</span>
            {f.id === currentFolderId && <span className="text-xs text-zinc-400">(where it is now)</span>}
            {f.kind === 'contacts' && <span className="text-xs text-zinc-400">(each person&apos;s own storage)</span>}
          </button>
          {loading.has(f.id) && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
        </div>
        {isOpen && kids && <ul>{kids.filter((k) => !k.trashed).map((k) => node(k, depth + 1, path))}</ul>}
      </li>
    )
  }

  const q = search.trim().toLowerCase()
  const prefer = new Set(preferOwnerIds ?? [])
  const allOwners = (groups ?? []).flatMap((g) => g.owners.map((o) => ({ ...o, group: g.label })))
  const shownOwners = allOwners.filter((o) => !q || o.label.toLowerCase().includes(q))
    .sort((a, b) => Number(prefer.has(b.id)) - Number(prefer.has(a.id)))

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="flex-1 text-base font-semibold">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        {error && <p className="mb-2 rounded bg-red-50 px-2 py-1 text-sm text-red-700">{error}</p>}
        {!owner ? (
          <>
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a client, a person, Business…" className="mb-2 rounded-md border border-zinc-200 px-2 py-1.5 text-sm" />
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {groups === null && !error && <li className="p-2 text-sm text-zinc-500">Loading…</li>}
              {shownOwners.slice(0, 200).map((o) => {
                const Icon = ownerIcon(o.kind)
                return (
                  <li key={o.id}>
                    <button type="button" onClick={() => setOwner({ id: o.id, label: o.label })} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-50">
                      <Icon className="h-4 w-4 text-zinc-400" /><span className="min-w-0 flex-1 truncate">{o.label}</span>
                      <span className="text-xs text-zinc-400">{prefer.has(o.id) ? 'suggested · ' : ''}{o.group}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <>
            <p className="mb-2 text-xs text-zinc-500">
              {chooseOwner && <button type="button" className="mr-2 text-blue-700 hover:underline" onClick={() => { setOwner(null); setRootId(null) }}>← all storages</button>}
              {owner.label}
            </p>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {loading.has('root') && <li className="p-2 text-sm text-zinc-500">Loading…</li>}
              {rootFolder && rootId && (mode === 'folder' || rootFolder.kind !== 'root'
                // a folder can go at the top; a FILE can go at the top of Business / My files (their top takes files)
                ? node(rootFolder, 0, [owner.label].filter(Boolean))
                : (nodes[rootId] ?? []).filter((k) => !k.trashed).map((k) => node(k, 0, [owner.label].filter(Boolean))))}
            </ul>
          </>
        )}
        <div className="mt-3 flex items-center gap-2 border-t border-zinc-100 pt-3">
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{chosen ? chosen.path : 'Choose a folder'}</span>
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm">Cancel</button>
          <button type="button" disabled={!chosen || !owner} onClick={() => chosen && owner && onPick(chosen.id, owner.id, chosen.path)}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">Choose this folder</button>
        </div>
      </div>
    </div>
  )
}

/** SHA-256 of a file picked on the computer (hex), or null when too big to fingerprint in the browser. */
export async function sha256OfFile(file: File, maxBytes = 200 * 1024 * 1024): Promise<string | null> {
  if (file.size > maxBytes || !globalThis.crypto?.subtle) return null
  const buf = await file.arrayBuffer()
  const d = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export { finalUploadName, keepBothName } from '@/lib/crm-store/names'
