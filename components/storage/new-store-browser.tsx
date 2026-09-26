'use client'

/**
 * Browser of the NEW CRM store (job 685467b5) — Storage page → "New storage", and the Files tab of a
 * company whose files live in the new store (scoped to that one owner via `ownerId`).
 * Owners (companies / people / companies being formed) → folders → files. A file opens INSIDE the CRM
 * (preview panel, no new tab); staff can show / hide it for the client (never for a staff-only file) and
 * upload into a folder (same name in the same folder = a new version). No rename / move / delete here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import { Building2, User, Hammer, Folder, FileText, ChevronRight, Eye, EyeOff, Lock, Trash2, Layers, X, Upload, Loader2 } from 'lucide-react'

interface Owner { id: string; kind: 'company' | 'person' | 'formation' | 'unfiled'; label: string; status: string | null; fileCount: number }
interface Fold { id: string; name: string; kind: string; trashed: boolean }
interface File_ {
  id: string; name: string; documentType: string | null; state: string; published: boolean; clientVisible: boolean
  staffOnly: boolean; personal: boolean; versions: number; size: number | null; mimeType: string | null; updatedAt: string
}
interface Contents { folder: Fold | null; path: Fold[]; folders: Fold[]; files: File_[] }
interface DocType { slug: string; name: string; staffOnly: boolean; personal: boolean }

/**
 * The company's owner in the NEW store (Formation pilot), or null. Shared by the company Files tab and the
 * flat documents list so both agree (same cache key). The route answers null outside the pilot environment.
 */
export function useStoreOwnerForAccount(accountId: string, enabled: boolean) {
  return useQuery<{ ownerId: string | null }>({
    queryKey: ['crm-store-owner-for-account', accountId],
    queryFn: async () => {
      const r = await fetch(`/api/crm-store/browse/owner-for-account?account=${encodeURIComponent(accountId)}`)
      if (!r.ok) return { ownerId: null }
      return r.json()
    },
    enabled,
    staleTime: 60_000,
  })
}

/** Must match STAFF_STORE_UPLOAD_PREFIX in lib/crm-store/browse.ts (server refuses anything else). */
const STAGING_PREFIX = 'crm-uploads/store-staging/'

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
  const isImage = (file.mimeType ?? '').startsWith('image/')
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
          {isImage ? (
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
  const [contents, setContents] = useState<Contents | null>(null)
  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<File_ | null>(null)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const [types, setTypes] = useState<DocType[] | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [uploadType, setUploadType] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const open = useCallback(async (oid: string, folderId: string | null) => {
    setOwnerId(oid)
    setError(null)
    setShowUpload(false)
    try {
      const q = `/api/crm-store/browse/folder?owner=${encodeURIComponent(oid)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`
      setContents(await getJson<Contents>(q))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the folder.')
    }
  }, [])

  useEffect(() => {
    if (scopedOwnerId) {
      open(scopedOwnerId, null)
      return
    }
    getJson<{ owners: Owner[] }>('/api/crm-store/browse/owners')
      .then((d) => setOwners(d.owners))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the new storage.'))
  }, [scopedOwnerId, open])

  const refresh = useCallback(() => {
    if (ownerId && contents?.folder) open(ownerId, contents.path.length > 1 ? contents.folder.id : null)
  }, [ownerId, contents, open])

  const toggleVisible = async (f: File_) => {
    setBusyFile(f.id)
    try {
      await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: !f.clientVisible }, 'Could not change who can see this file — please try again.')
      toast.success(f.clientVisible ? `"${f.name}" is now hidden from the client` : `"${f.name}" is now visible to the client`)
      refresh()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not change who can see this file.')
    } finally {
      setBusyFile(null)
    }
  }

  const startUpload = async () => {
    setShowUpload(true)
    if (types) return
    try {
      setTypes((await getJson<{ types: DocType[] }>('/api/crm-store/browse/types')).types)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not load the document types.')
    }
  }

  const doUpload = async (file: File) => {
    if (!ownerId || !contents?.folder) return
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
        ownerId, folderId: contents.folder.id, storagePath, fileName: file.name, mimeType: file.type, documentType: uploadType,
      }, 'The upload could not be saved — please try again.')
      toast.success(r.write === 'versioned' ? `"${r.name}" saved as a new version` : r.write === 'unchanged' ? `"${r.name}" is identical to the current version — nothing changed` : `"${r.name}" uploaded (hidden from the client until you show it)`)
      setShowUpload(false)
      refresh()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The upload failed — please try again.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const shown = (owners ?? []).filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()))
  const canUpload = !!contents?.folder && !contents.folder.trashed && contents.folder.kind !== 'root' && contents.folder.kind !== 'contacts'

  const right = (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!contents && !error && <p className="text-sm text-zinc-500">{scopedOwnerId ? 'Loading…' : 'Pick a company or person on the left to see its folders and files.'}</p>}
      {contents && !contents.folder && <p className="text-sm text-zinc-500">No folders yet.</p>}
      {contents?.folder && ownerId && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
            {contents.path.map((p, i) => (
              <span key={p.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-zinc-300" />}
                <button type="button" onClick={() => open(ownerId, i === 0 ? null : p.id)} className="text-blue-700 hover:underline">
                  {p.name}
                </button>
              </span>
            ))}
            <span className="flex-1" />
            {canUpload && !showUpload && (
              <button type="button" onClick={startUpload} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50">
                <Upload className="h-3.5 w-3.5" />Upload to this folder
              </button>
            )}
          </div>

          {showUpload && canUpload && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-sm">
              <select value={uploadType} onChange={(e) => setUploadType(e.target.value)} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm" disabled={uploading || !types}>
                <option value="">{types ? 'Document type…' : 'Loading types…'}</option>
                {(types ?? []).map((t) => <option key={t.slug} value={t.slug}>{t.name}{t.staffOnly ? ' (staff only)' : ''}</option>)}
              </select>
              <input ref={fileInput} type="file" className="text-sm" disabled={uploading || !uploadType}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f) }} />
              {uploading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
              <button type="button" onClick={() => setShowUpload(false)} disabled={uploading} className="text-xs text-zinc-500 hover:underline">Cancel</button>
            </div>
          )}

          <ul className="divide-y divide-zinc-100">
            {contents.folders.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => open(ownerId, f.id)} className="flex w-full items-center gap-2 py-2 text-left text-sm hover:bg-zinc-50">
                  <Folder className="h-4 w-4 text-amber-500" />
                  <span className="flex-1">{f.name}</span>
                  {f.trashed && <Badge tone="red"><Trash2 className="h-3 w-3" />in trash</Badge>}
                </button>
              </li>
            ))}
            {contents.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <FileText className="h-4 w-4 text-zinc-400" />
                <button type="button" onClick={() => setPreview(f)}
                  className={`min-w-0 flex-1 truncate text-left hover:underline ${f.state === 'trashed' ? 'text-zinc-400 line-through' : ''}`}>
                  {f.name}
                </button>
                {f.state === 'trashed' && <Badge tone="red"><Trash2 className="h-3 w-3" />in trash</Badge>}
                {f.staffOnly ? (
                  <Badge tone="gray"><Lock className="h-3 w-3" />staff only</Badge>
                ) : f.clientVisible ? (
                  <Badge tone="green"><Eye className="h-3 w-3" />client can see</Badge>
                ) : (
                  <Badge tone="gray"><EyeOff className="h-3 w-3" />hidden from client</Badge>
                )}
                {f.personal && <Badge tone="blue">personal</Badge>}
                {f.versions > 1 && <Badge tone="blue"><Layers className="h-3 w-3" />{f.versions} versions</Badge>}
                <span className="text-xs text-zinc-400">{f.size != null ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</span>
                {!f.staffOnly && f.state === 'live' && (
                  <button type="button" onClick={() => toggleVisible(f)} disabled={busyFile === f.id}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50">
                    {busyFile === f.id ? <Loader2 className="h-3 w-3 animate-spin" /> : f.clientVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {f.clientVisible ? 'Hide from client' : 'Show to client'}
                  </button>
                )}
                <button type="button" onClick={() => setPreview(f)} className="text-blue-700 hover:underline">View</button>
              </li>
            ))}
            {contents.folders.length === 0 && contents.files.length === 0 && (
              <li className="py-2 text-sm text-zinc-500">This folder is empty.</li>
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
                  onClick={() => open(o.id, null)}
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
