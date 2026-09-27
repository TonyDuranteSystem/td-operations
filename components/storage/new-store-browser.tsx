'use client'

/**
 * Browser of the NEW CRM store (job 685467b5) — Storage page → "New storage", and the Files tab of a
 * company whose files live in the new store (scoped to that one owner via `ownerId`).
 * Owners (companies / people / companies being formed) → a folder TREE (every folder stays on screen; each opens and
 * closes in place, like the Drive view) → files. A file opens INSIDE the CRM
 * (preview panel, no new tab); staff can show / hide it for the client (never for a staff-only file) and
 * upload into a folder (same name in the same folder = a new version). No rename / move / delete here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import { Building2, User, Hammer, Folder, FolderOpen, FileText, ChevronRight, ChevronDown, Eye, EyeOff, Lock, Trash2, Layers, X, Upload, Loader2 } from 'lucide-react'

interface Owner { id: string; kind: 'company' | 'person' | 'formation' | 'unfiled'; label: string; status: string | null; fileCount: number }
interface Fold { id: string; name: string; kind: string; trashed: boolean }
interface File_ {
  id: string; name: string; documentType: string | null; state: string; published: boolean; clientVisible: boolean
  staffOnly: boolean; personal: boolean; versions: number; size: number | null; mimeType: string | null; updatedAt: string
  listed: boolean; personName: string | null; inPersonStorage: boolean
}
interface Contents { folder: Fold | null; path: Fold[]; folders: Fold[]; files: File_[] }
interface DocType { slug: string; name: string; staffOnly: boolean; personal: boolean }

/**
 * The company's owner in the NEW store (Formation pilot), or null. Shared by the company Files tab and the
 * flat documents list so both agree (same cache key). The route answers null outside the pilot environment.
 */
export function useStoreOwnerForAccount(accountId: string, enabled: boolean) {
  return useQuery<{ ownerId: string | null; shownFileIds?: string[] }>({
    queryKey: ['crm-store-owner-for-account', accountId],
    queryFn: async () => {
      const r = await fetch(`/api/crm-store/browse/owner-for-account?account=${encodeURIComponent(accountId)}`)
      if (!r.ok) return { ownerId: null, shownFileIds: [] }
      return r.json()
    },
    enabled,
    staleTime: 60_000,
  })
}

/** Must match STAFF_STORE_UPLOAD_PREFIX in lib/crm-store/browse.ts (server refuses anything else). */
const STAGING_PREFIX = 'crm-uploads/store-staging/'

/** Mirrors INLINE_SAFE_TYPES in lib/crm-store/serve.ts — anything else downloads instead of opening. */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'text/plain'])

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not load the new storage — please try again.')
  return data as T
}

async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || fallback)
  return data as T
}

const ownerIcon = (k: Owner['kind']) => (k === 'company' ? Building2 : k === 'person' ? User : k === 'formation' ? Hammer : Folder)

function Badge({ tone, children }: { tone: 'green' | 'gray' | 'amber' | 'red' | 'blue'; children: React.ReactNode }) {
  const t = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    gray: 'bg-zinc-50 text-zinc-600 border-zinc-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
  }[tone]
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${t}`}>{children}</span>
}

function PreviewPanel({ file, onClose }: { file: File_; onClose: () => void }) {
  const src = `/api/crm-store/browse/file/${file.id}`
  const mime = (file.mimeType ?? '').split(';')[0].trim().toLowerCase()
  const inline = INLINE_TYPES.has(mime)
  const isImage = inline && mime.startsWith('image/')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
          <FileText className="h-4 w-4 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
          <button type="button" onClick={onClose} aria-label="Close preview" className="rounded p-1 text-zinc-500 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 bg-zinc-50">
          {!inline ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
              <p>This kind of file cannot be shown inside the CRM.</p>
              <a href={src} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-blue-700 hover:bg-zinc-50">Download it</a>
            </div>
          ) : isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={file.name} className="mx-auto h-full max-h-full object-contain" />
          ) : (
            <iframe src={src} title={file.name} className="h-full w-full border-0" />
          )}
        </div>
      </div>
    </div>
  )
}

export function NewStoreBrowser({ ownerId: scopedOwnerId }: { ownerId?: string } = {}) {
  const [owners, setOwners] = useState<Owner[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ownerId, setOwnerId] = useState<string | null>(scopedOwnerId ?? null)
  const [root, setRoot] = useState<Contents | null>(null)
  /** loaded contents of each opened folder (by folder id) */
  const [loaded, setLoaded] = useState<Record<string, Contents>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<File_ | null>(null)
  const [busyFiles, setBusyFiles] = useState<Set<string>>(new Set())
  const [types, setTypes] = useState<DocType[] | null>(null)
  const [uploadFolder, setUploadFolder] = useState<string | null>(null)
  const [uploadType, setUploadType] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const fetchFolder = useCallback(async (oid: string, folderId: string | null) => {
    const q = `/api/crm-store/browse/folder?owner=${encodeURIComponent(oid)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`
    return getJson<Contents>(q)
  }, [])

  const openOwner = useCallback(async (oid: string) => {
    setOwnerId(oid)
    setError(null)
    setRoot(null)
    setLoaded({})
    setExpanded(new Set())
    setUploadFolder(null)
    try {
      setRoot(await fetchFolder(oid, null))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the folder.')
    }
  }, [fetchFolder])

  useEffect(() => {
    if (scopedOwnerId) {
      openOwner(scopedOwnerId)
      return
    }
    getJson<{ owners: Owner[] }>('/api/crm-store/browse/owners')
      .then((d) => setOwners(d.owners))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the new storage.'))
  }, [scopedOwnerId, openOwner])

  const loadFolder = useCallback(async (folderId: string) => {
    if (!ownerId) return
    setLoadingFolders((l) => new Set(l).add(folderId))
    try {
      const c = await fetchFolder(ownerId, folderId)
      setLoaded((m) => ({ ...m, [folderId]: c }))
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not open the folder.')
    } finally {
      setLoadingFolders((l) => { const n = new Set(l); n.delete(folderId); return n })
    }
  }, [ownerId, fetchFolder])

  const toggleFolder = (folderId: string) => {
    const isOpen = expanded.has(folderId)
    setExpanded((x) => { const n = new Set(x); if (isOpen) n.delete(folderId); else n.add(folderId); return n })
    if (!isOpen && !loaded[folderId]) loadFolder(folderId)
    if (isOpen && uploadFolder === folderId) setUploadFolder(null)
  }

  /** reload one folder (or the root) after a change inside it */
  const refreshFolder = useCallback(async (folderId: string | null) => {
    if (!ownerId) return
    if (!folderId || folderId === root?.folder?.id) {
      try { setRoot(await fetchFolder(ownerId, null)) } catch { /* keep what is shown */ }
      return
    }
    await loadFolder(folderId)
  }, [ownerId, root, fetchFolder, loadFolder])

  const toggleVisible = async (f: File_, inFolder: string | null) => {
    if (busyFiles.has(f.id)) return
    setBusyFiles((b) => new Set(b).add(f.id))
    try {
      await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: !f.clientVisible }, 'Could not change who can see this file — please try again.')
      toast.success(f.clientVisible ? `"${f.name}" is now hidden from the client` : `"${f.name}" is now visible to the client`)
      await refreshFolder(inFolder)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not change who can see this file.')
    } finally {
      setBusyFiles((b) => { const n = new Set(b); n.delete(f.id); return n })
    }
  }

  const startUpload = async (folderId: string) => {
    setUploadFolder(folderId)
    if (types) return
    try {
      setTypes((await getJson<{ types: DocType[] }>('/api/crm-store/browse/types')).types)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not load the document types.')
    }
  }

  const doUpload = async (file: File, folderId: string) => {
    if (!ownerId) return
    if (!uploadType) { toast.error('Choose the document type first.'); return }
    setUploading(true)
    try {
      // Storage refuses spaces and odd characters in keys — sanitize the KEY, keep the readable file name.
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120)
      const storagePath = `${STAGING_PREFIX}${ownerId}/${Date.now()}_${safe}`
      const sig = await postJson<{ signedUrl?: string }>('/api/storage/upload',
        { bucket: 'onboarding-uploads', path: storagePath, contentType: file.type }, 'Could not prepare the upload — please try again.')
      if (!sig.signedUrl) throw new Error('Could not prepare the upload — please try again.')
      const put = await fetch(sig.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      if (!put.ok) throw new Error(`The file could not be sent (status ${put.status}) — please try again.`)
      const r = await postJson<{ write: string; name: string }>('/api/crm-store/browse/upload', {
        ownerId, folderId, storagePath, fileName: file.name, mimeType: file.type, documentType: uploadType,
      }, 'The upload could not be saved — please try again.')
      toast.success(r.write === 'versioned' ? `"${r.name}" saved as a new version` : r.write === 'unchanged' ? `"${r.name}" is identical to the current version — nothing changed` : `"${r.name}" uploaded (hidden from the client until you show it)`)
      setUploadFolder(null)
      await refreshFolder(folderId)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The upload failed — please try again.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const canUploadInto = (f: Fold) => !f.trashed && f.kind !== 'root' && f.kind !== 'contacts'

  const fileRow = (f: File_, inFolder: string | null, depth: number) => (
    <li key={f.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm" style={{ paddingLeft: `${depth * 20 + 22}px` }}>
      <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
      <button type="button" onClick={() => setPreview(f)}
        className={`min-w-0 flex-1 truncate text-left hover:underline ${f.state === 'trashed' ? 'text-zinc-400 line-through' : ''}`}>
        {f.personName && <span className="text-zinc-500">{f.personName} · </span>}{f.name}
      </button>
      {f.state === 'trashed' && <Badge tone="red"><Trash2 className="h-3 w-3" />in trash</Badge>}
      {f.staffOnly ? (
        <Badge tone="gray"><Lock className="h-3 w-3" />staff only</Badge>
      ) : f.clientVisible ? (
        <Badge tone="green"><Eye className="h-3 w-3" />client can see</Badge>
      ) : (
        <Badge tone="gray"><EyeOff className="h-3 w-3" />hidden from client</Badge>
      )}
      {!f.documentType ? <Badge tone="amber">no document type yet</Badge> : f.personal && <Badge tone="blue">personal</Badge>}
      {!f.listed && <Badge tone="amber">not in the CRM list</Badge>}
      {f.versions > 1 && <Badge tone="blue"><Layers className="h-3 w-3" />{f.versions} versions</Badge>}
      <span className="text-xs text-zinc-400">{f.size != null ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</span>
      {!f.staffOnly && f.state === 'live' && (f.listed || f.clientVisible)
        && (f.clientVisible || (!!f.documentType && !(f.personal && !f.inPersonStorage))) && (
        <button type="button" onClick={() => toggleVisible(f, inFolder)} disabled={busyFiles.has(f.id)}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50">
          {busyFiles.has(f.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : f.clientVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          {f.clientVisible ? 'Hide from client' : 'Show to client'}
        </button>
      )}
      <button type="button" onClick={() => setPreview(f)} className="text-blue-700 hover:underline">View</button>
    </li>
  )

  const folderNode = (f: Fold, depth: number): React.ReactNode => {
    const isOpen = expanded.has(f.id)
    const c = loaded[f.id]
    const busy = loadingFolders.has(f.id)
    return (
      <li key={f.id}>
        <div className="group flex items-center gap-1 py-1.5 text-sm hover:bg-zinc-50" style={{ paddingLeft: `${depth * 20}px` }}>
          <button type="button" onClick={() => toggleFolder(f.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={isOpen}>
            {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />}
            {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" /> : <Folder className="h-4 w-4 shrink-0 text-amber-500" />}
            <span className="truncate">{f.name}</span>
            {c && <span className="text-xs text-zinc-400">{c.files.length + c.folders.length}</span>}
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
          </button>
          {f.trashed && <Badge tone="red"><Trash2 className="h-3 w-3" />in trash</Badge>}
          {isOpen && canUploadInto(f) && uploadFolder !== f.id && (
            <button type="button" onClick={() => startUpload(f.id)} className="mr-1 inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-xs hover:bg-white">
              <Upload className="h-3.5 w-3.5" />Upload here
            </button>
          )}
        </div>
        {isOpen && (
          <div>
            {uploadFolder === f.id && (
              <div className="my-1 flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-sm" style={{ marginLeft: `${depth * 20 + 22}px` }}>
                <select value={uploadType} onChange={(e) => setUploadType(e.target.value)} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm" disabled={uploading || !types}>
                  <option value="">{types ? 'Document type…' : 'Loading types…'}</option>
                  {(types ?? []).map((t) => <option key={t.slug} value={t.slug}>{t.name}{t.staffOnly ? ' (staff only)' : ''}</option>)}
                </select>
                <input ref={fileInput} type="file" className="text-sm" disabled={uploading || !uploadType}
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) doUpload(file, f.id) }} />
                {uploading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
                <button type="button" onClick={() => setUploadFolder(null)} disabled={uploading} className="text-xs text-zinc-500 hover:underline">Cancel</button>
              </div>
            )}
            {c && (
              <ul>
                {c.folders.map((sf) => folderNode(sf, depth + 1))}
                {c.files.map((file) => fileRow(file, f.id, depth + 1))}
                {c.folders.length === 0 && c.files.length === 0 && (
                  <li className="py-1.5 text-xs text-zinc-400" style={{ paddingLeft: `${(depth + 1) * 20 + 22}px` }}>Empty</li>
                )}
              </ul>
            )}
          </div>
        )}
      </li>
    )
  }

  const shown = (owners ?? []).filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()))
  const allOpen = !!root && root.folders.length > 0 && root.folders.every((f) => expanded.has(f.id))

  const right = (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!root && !error && <p className="text-sm text-zinc-500">{scopedOwnerId || ownerId ? 'Loading…' : 'Pick a company or person on the left to see its folders and files.'}</p>}
      {root && !root.folder && <p className="text-sm text-zinc-500">No folders yet.</p>}
      {root?.folder && (
        <>
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-800">{root.folder.name}</span>
            <span className="flex-1" />
            {root.folders.length > 0 && (
              <button type="button" className="text-xs text-blue-700 hover:underline"
                onClick={() => {
                  if (allOpen) { setExpanded(new Set()); setUploadFolder(null); return }
                  setExpanded(new Set(root.folders.map((f) => f.id)))
                  for (const f of root.folders) if (!loaded[f.id]) loadFolder(f.id)
                }}>
                {allOpen ? 'Close all' : 'Open all'}
              </button>
            )}
          </div>
          <ul className="divide-y divide-zinc-50">
            {root.folders.map((f) => folderNode(f, 0))}
            {root.files.map((file) => fileRow(file, null, 0))}
            {root.folders.length === 0 && root.files.length === 0 && (
              <li className="py-2 text-sm text-zinc-500">This storage is empty.</li>
            )}
          </ul>
        </>
      )}
      {preview && <PreviewPanel file={preview} onClose={() => setPreview(null)} />}
    </div>
  )

  if (scopedOwnerId) return right

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
      <div className="rounded-xl border border-zinc-200 bg-white p-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search companies and people…"
          className="mb-2 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
        />
        {owners === null && !error && <p className="p-2 text-sm text-zinc-500">Loading…</p>}
        {owners !== null && shown.length === 0 && <p className="p-2 text-sm text-zinc-500">Nothing in the new storage yet.</p>}
        <ul className="max-h-[70vh] space-y-0.5 overflow-y-auto">
          {shown.map((o) => {
            const Icon = ownerIcon(o.kind)
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => openOwner(o.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-50 ${ownerId === o.id ? 'bg-zinc-100' : ''}`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.status && <Badge tone={o.status === 'archived' ? 'gray' : 'amber'}>{o.status}</Badge>}
                  <span className="text-xs text-zinc-400">{o.fileCount}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      {right}
    </div>
  )
}
