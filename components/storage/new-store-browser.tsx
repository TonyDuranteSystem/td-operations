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
import { Building2, User, Hammer, Folder, FolderOpen, FileText, FileImage, FileSpreadsheet, ChevronRight, ChevronDown, Eye, EyeOff, Lock, Trash2, Layers, X, Upload, Loader2, RefreshCw, Search, ScanText, MoreHorizontal, Pencil, FolderInput } from 'lucide-react'
import { OcrViewerModal } from '@/components/documents/ocr-viewer'
import { FastTooltip } from '@/components/ui/fast-tooltip'

interface Owner { id: string; kind: 'company' | 'person' | 'formation' | 'unfiled'; label: string; status: string | null; fileCount: number }
interface Fold { id: string; name: string; kind: string; trashed: boolean }
interface File_ {
  id: string; name: string; documentType: string | null; state: string; published: boolean; clientVisible: boolean
  staffOnly: boolean; personal: boolean; versions: number; size: number | null; mimeType: string | null; updatedAt: string
  listed: boolean; personName: string | null; inPersonStorage: boolean; docId: string | null
}
interface Contents { folder: Fold | null; path: Fold[]; folders: Fold[]; files: File_[]; people?: { contactId: string; name: string }[] }
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

/** A person's own storage in the NEW store (pilot), or null — for the contact page. */
export function useStoreOwnerForContact(contactId: string, enabled: boolean) {
  return useQuery<{ ownerId: string | null }>({
    queryKey: ['crm-store-owner-for-contact', contactId],
    queryFn: async () => {
      const r = await fetch(`/api/crm-store/browse/owner-for-contact?contact=${encodeURIComponent(contactId)}`)
      if (!r.ok) return { ownerId: null }
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

const fileIcon = (mime: string | null) => {
  const m = (mime ?? '').toLowerCase()
  if (m.startsWith('image/')) return FileImage
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv')) return FileSpreadsheet
  return FileText
}
const fmtSize = (n: number | null) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)
const fmtDate = (d: string) => { try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return '' } }

export function NewStoreBrowser({ ownerId: scopedOwnerId, scopedKind = 'company' }: { ownerId?: string; scopedKind?: Owner['kind'] } = {}) {
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
  const [ocrDocId, setOcrDocId] = useState<string | null>(null)
  const [busyFiles, setBusyFiles] = useState<Set<string>>(new Set())
  const [types, setTypes] = useState<DocType[] | null>(null)
  // upload panel (today's "Upload Document"): folder, whose (2. Contacts), type, display name, show to client
  const [uploadOpen, setUploadOpen] = useState(false)
  const [upFolder, setUpFolder] = useState('')
  const [upPerson, setUpPerson] = useState('')
  const [upType, setUpType] = useState('')
  const [upName, setUpName] = useState('')
  const [upVisible, setUpVisible] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  // row menu / inline rename / delete confirm / drag and drop
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [moveFor, setMoveFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [dragFile, setDragFile] = useState<{ id: string; from: string | null } | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const dragRef = useRef<{ id: string; from: string | null } | null>(null)
  const renameDone = useRef(false)
  const expandedRef = useRef<Set<string>>(new Set())

  useEffect(() => { expandedRef.current = expanded }, [expanded])

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
    setUploadOpen(false)
    try {
      const r = await fetchFolder(oid, null)
      setRoot(r)
      // today's folder view opens the top-level folders straight away
      setExpanded(new Set(r.folders.map((f) => f.id)))
      const entries = await Promise.all(r.folders.map(async (f) => [f.id, await fetchFolder(oid, f.id)] as const))
      setLoaded(Object.fromEntries(entries))
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
  }

  /** reload everything that is on screen (Refresh, and after any change) */
  const refreshAll = useCallback(async () => {
    if (!ownerId) return
    try {
      const r = await fetchFolder(ownerId, null)
      setRoot(r)
      // the folders open NOW (not when the refresh started); merged, so a folder opened meanwhile keeps its files
      const open = Array.from(expandedRef.current)
      const entries = await Promise.all(open.map(async (id) => {
        try { return [id, await fetchFolder(ownerId, id)] as const } catch { return null }
      }))
      setLoaded((m) => ({ ...m, ...Object.fromEntries(entries.filter((x): x is readonly [string, Contents] => !!x)) }))
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not refresh.')
    }
  }, [ownerId, fetchFolder])

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    if (busyFiles.has(id)) return
    setBusyFiles((b) => new Set(b).add(id))
    try { await fn() } finally { setBusyFiles((b) => { const n = new Set(b); n.delete(id); return n }) }
  }

  const toggleVisible = (f: File_) => withBusy(f.id, async () => {
    try {
      await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: !f.clientVisible }, 'Could not change who can see this file — please try again.')
      toast.success(f.clientVisible ? `"${f.name}" is now hidden from the client` : `"${f.name}" is now visible to the client`)
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not change who can see this file.')
    }
  })

  const doRename = (f: File_, value: string) => withBusy(f.id, async () => {
    if (renameDone.current) return // Enter then blur, or Escape then blur: commit at most once
    renameDone.current = true
    setRenaming(null)
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(f.name)?.[0] ?? ''
    const v = value.trim()
    if (!v || v === f.name || `${v}${ext}` === f.name) return
    try {
      const r = await postJson<{ name: string }>(`/api/crm-store/browse/file/${f.id}/rename`, { name: value }, 'The file could not be renamed.')
      toast.success(`Renamed to "${r.name}"`)
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The file could not be renamed.')
    }
  })

  const doMove = (fileId: string, name: string, folderId: string) => withBusy(fileId, async () => {
    setMenuFor(null); setMoveFor(null)
    try {
      const r = await postJson<{ folderName: string }>(`/api/crm-store/browse/file/${fileId}/move`, { folderId }, 'The file could not be moved.')
      toast.success(`Moved "${name}" to ${r.folderName}`)
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The file could not be moved.')
    }
  })

  const doDelete = (f: File_) => withBusy(f.id, async () => {
    setConfirmDelete(null); setMenuFor(null)
    try {
      await postJson(`/api/crm-store/browse/file/${f.id}/delete`, {}, 'The file could not be deleted.')
      toast.success(`"${f.name}" moved to the trash`)
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The file could not be deleted.')
    }
  })

  const openUpload = async (folderId?: string) => {
    setUploadOpen(true)
    setUpFolder(folderId ?? '')
    setUpPerson(''); setUpType(''); setUpName(''); setUpVisible(true)
    if (types) return
    try {
      setTypes((await getJson<{ types: DocType[] }>('/api/crm-store/browse/types')).types)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not load the document types.')
    }
  }

  const topFolders = root?.folders ?? []
  const upFolderObj = topFolders.find((f) => f.id === upFolder) ?? null
  const upIsContacts = upFolderObj?.kind === 'contacts'
  // the company page shows a company; on the Storage page the picked owner says what it is
  const ownerKind: Owner['kind'] = scopedOwnerId ? scopedKind : ((owners ?? []).find((o) => o.id === ownerId)?.kind ?? 'company')
  const upTypes = (types ?? []).filter((t) => (ownerKind === 'person' ? true : upIsContacts === t.personal))
  const upPeople = upFolderObj ? loaded[upFolderObj.id]?.people ?? [] : []

  const doUpload = async (file: File) => {
    if (!ownerId || !upFolder) { toast.error('Choose the folder first.'); return }
    if (!upType) { toast.error('Choose the document type first.'); return }
    if (upIsContacts && !upPerson) { toast.error('Choose whose document this is first.'); return }
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
      const r = await postJson<{ write: string; name: string; visible: boolean; identity?: string | null }>('/api/crm-store/browse/upload', {
        ownerId, folderId: upFolder, storagePath, fileName: file.name, mimeType: file.type, documentType: upType,
        displayName: upName || undefined, visible: upVisible,
        ...(upIsContacts ? { personContactId: upPerson } : {}),
      }, 'The upload could not be saved — please try again.')
      toast.success(
        r.write === 'versioned' ? `"${r.name}" saved as a new version`
          : r.write === 'unchanged' ? `"${r.name}" is identical to the current version — nothing changed`
            : `"${r.name}" uploaded${r.visible ? ' and shared with the client' : ' (hidden from the client)'}`,
      )
      if (r.identity) toast.message(r.identity)
      setUploadOpen(false)
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The upload failed — please try again.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const onDropInto = (folder: Fold) => {
    setDropOn(null)
    const d = dragRef.current
    dragRef.current = null
    setDragFile(null)
    if (!d || d.from === folder.id) return
    const f = [...(root?.files ?? []), ...Object.values(loaded).flatMap((c) => c.files)].find((x) => x.id === d.id)
    if (f) doMove(f.id, f.name, folder.id)
  }

  const fileRow = (f: File_, inFolder: Fold | null, depth: number) => {
    const Icon = fileIcon(f.mimeType)
    const busy = busyFiles.has(f.id)
    const ownFile = !f.personName // a person's file shown in the company's "2. Contacts" is moved from their own storage
    const canShare = !f.staffOnly && f.state === 'live' && (f.listed || f.clientVisible)
      && (f.clientVisible || (!!f.documentType && !(f.personal && !f.inPersonStorage)))
    const moveTargets = topFolders.filter((t) => t.id !== inFolder?.id && t.kind !== 'contacts' && !t.trashed)
    return (
      <li key={f.id}
        draggable={ownFile && !renaming}
        onDragStart={() => { const d = { id: f.id, from: inFolder?.id ?? null }; dragRef.current = d; setDragFile(d) }}
        onDragEnd={() => { setDragFile(null); setDropOn(null) }}
        className="group relative flex flex-wrap items-center gap-2 py-1.5 text-sm hover:bg-zinc-50/70" style={{ paddingLeft: `${depth * 20 + 22}px` }}>
        <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
        {renaming?.id === f.id ? (
          <input autoFocus value={renaming.value} onChange={(e) => setRenaming({ id: f.id, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') doRename(f, renaming.value); if (e.key === 'Escape') { renameDone.current = true; setRenaming(null) } }}
            onBlur={() => doRename(f, renaming.value)}
            className="min-w-0 flex-1 rounded border border-blue-300 px-1.5 py-0.5 text-sm" />
        ) : (
          <button type="button" onClick={() => setPreview(f)} className="min-w-0 flex-1 truncate text-left hover:underline">
            {f.personName && <span className="text-zinc-500">{f.personName} · </span>}{f.name}
          </button>
        )}
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
        <span className="text-xs text-zinc-400">{[fmtSize(f.size), fmtDate(f.updatedAt)].filter(Boolean).join(' · ')}</span>
        <FastTooltip label="Preview"><button type="button" aria-label="Preview" onClick={() => setPreview(f)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><Search className="h-3.5 w-3.5" /></button></FastTooltip>
        {f.docId && (
          <FastTooltip label="View OCR text"><button type="button" aria-label="View OCR text" onClick={() => setOcrDocId(f.docId)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><ScanText className="h-3.5 w-3.5" /></button></FastTooltip>
        )}
        {canShare && (
          <button type="button" onClick={() => toggleVisible(f)} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-50">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : f.clientVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {f.clientVisible ? 'Hide from client' : 'Show to client'}
          </button>
        )}
        <div className="relative">
          <FastTooltip label="More"><button type="button" aria-label="More" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === f.id ? null : f.id); setMoveFor(null); setConfirmDelete(null) }}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><MoreHorizontal className="h-4 w-4" /></button></FastTooltip>
          {menuFor === f.id && (
            <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50"
                onClick={() => { setMenuFor(null); renameDone.current = false; setRenaming({ id: f.id, value: f.name.replace(/\.[A-Za-z0-9]{1,8}$/, '') }) }}>
                <Pencil className="h-3.5 w-3.5" />Rename
              </button>
              {ownFile && moveTargets.length > 0 && (
                <>
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => setMoveFor(moveFor === f.id ? null : f.id)}>
                    <FolderInput className="h-3.5 w-3.5" />Move to…<ChevronRight className="ml-auto h-3.5 w-3.5" />
                  </button>
                  {moveFor === f.id && moveTargets.map((t) => (
                    <button key={t.id} type="button" className="flex w-full items-center gap-2 py-1.5 pl-8 pr-3 text-left text-zinc-700 hover:bg-zinc-50" onClick={() => doMove(f.id, f.name, t.id)}>
                      <Folder className="h-3.5 w-3.5 text-amber-500" />{t.name}
                    </button>
                  ))}
                </>
              )}
              <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { setMenuFor(null); setPreview(f) }}>
                <Search className="h-3.5 w-3.5" />Preview
              </button>
              {!ownFile ? (
                <p className="px-3 py-1.5 text-xs text-zinc-500">Delete this from the person&apos;s own page — it is their document, shown in each of their companies.</p>
              ) : confirmDelete === f.id ? (
                <div className="px-3 py-1.5 text-xs">
                  <p className="mb-1 text-zinc-700">Move to trash? (recoverable for 90 days)</p>
                  <div className="flex gap-2">
                    <button type="button" className="rounded bg-red-600 px-2 py-0.5 text-white" onClick={() => doDelete(f)}>Confirm</button>
                    <button type="button" className="rounded border px-2 py-0.5" onClick={() => setConfirmDelete(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50" onClick={() => setConfirmDelete(f.id)}>
                  <Trash2 className="h-3.5 w-3.5" />Delete
                </button>
              )}
            </div>
          )}
        </div>
      </li>
    )
  }

  const folderNode = (f: Fold, depth: number): React.ReactNode => {
    const isOpen = expanded.has(f.id)
    const c = loaded[f.id]
    const busy = loadingFolders.has(f.id)
    const canDrop = !!dragFile && f.kind !== 'contacts' && dragFile.from !== f.id
    // tax year folders newest first, as today
    const subs = c ? [...c.folders].sort((a, b) => (/^\d{4}$/.test(a.name) && /^\d{4}$/.test(b.name) ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name))) : []
    return (
      <li key={f.id}>
        <div
          onDragOver={(e) => { if (canDrop) { e.preventDefault(); e.stopPropagation(); setDropOn(f.id) } }}
          onDragLeave={() => setDropOn((d) => (d === f.id ? null : d))}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (canDrop) onDropInto(f) }}
          className={`group flex items-center gap-1 py-1.5 text-sm hover:bg-zinc-50 ${dropOn === f.id ? 'rounded bg-blue-50 ring-1 ring-blue-300' : ''}`} style={{ paddingLeft: `${depth * 20}px` }}>
          <button type="button" onClick={() => toggleFolder(f.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={isOpen}>
            {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />}
            {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" /> : <Folder className="h-4 w-4 shrink-0 text-amber-500" />}
            <span className="truncate font-medium text-zinc-800">{f.name}</span>
            {c && <span className="text-xs text-zinc-400">{c.files.length} {c.files.length === 1 ? 'file' : 'files'}</span>}
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
          </button>
          {depth === 0 && !f.trashed && f.kind !== 'root' && (
            <button type="button" onClick={() => openUpload(f.id)} className="mr-1 hidden items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-xs hover:bg-white group-hover:inline-flex">
              <Upload className="h-3.5 w-3.5" />Upload here
            </button>
          )}
        </div>
        {isOpen && c && (
          <ul
            onDragOver={(e) => { if (canDrop) { e.preventDefault(); e.stopPropagation(); setDropOn(f.id) } }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (canDrop) onDropInto(f) }}>
            {subs.map((sf) => folderNode(sf, depth + 1))}
            {c.files.map((file) => fileRow(file, f, depth + 1))}
            {c.folders.length === 0 && c.files.length === 0 && (
              <li className="py-1.5 text-xs italic text-zinc-400" style={{ paddingLeft: `${(depth + 1) * 20 + 22}px` }}>Empty folder</li>
            )}
          </ul>
        )}
      </li>
    )
  }

  const shown = (owners ?? []).filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()))
  const allOpen = topFolders.length > 0 && topFolders.every((f) => expanded.has(f.id))
  const totalFiles = (root?.files.length ?? 0) + topFolders.reduce((n, f) => n + (loaded[f.id]?.files.length ?? 0), 0)

  const right = (
    <div className="rounded-xl border border-zinc-200 bg-white p-4" onClick={() => { if (menuFor) setMenuFor(null) }}>
      {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!root && !error && <p className="text-sm text-zinc-500">{scopedOwnerId || ownerId ? 'Loading…' : 'Pick a company or person on the left to see its folders and files.'}</p>}
      {root && !root.folder && <p className="text-sm text-zinc-500">No folders yet.</p>}
      {root?.folder && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-zinc-800">{root.folder.name}</span>
            <span className="text-xs text-zinc-400">{totalFiles} {totalFiles === 1 ? 'file' : 'files'}</span>
            <span className="flex-1" />
            <button type="button" onClick={(e) => { e.stopPropagation(); if (uploadOpen) setUploadOpen(false); else openUpload() }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50">
              <Upload className="h-3.5 w-3.5" />Upload Document
            </button>
            <button type="button" onClick={() => refreshAll()} aria-label="Refresh" className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50">
              <RefreshCw className="h-3.5 w-3.5" />Refresh
            </button>
            {topFolders.length > 0 && (
              <button type="button" className="text-xs text-blue-700 hover:underline"
                onClick={() => {
                  if (allOpen) { setExpanded(new Set()); return }
                  setExpanded(new Set(topFolders.map((f) => f.id)))
                  for (const f of topFolders) if (!loaded[f.id]) loadFolder(f.id)
                }}>
                {allOpen ? 'Close all' : 'Open all'}
              </button>
            )}
          </div>

          {uploadOpen && (
            <div className="mb-3 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm" onClick={(e) => e.stopPropagation()}>
              <div className="flex flex-wrap items-center gap-2">
                <select value={upFolder} onChange={(e) => { setUpFolder(e.target.value); setUpType(''); setUpPerson('') }} className="rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading}>
                  <option value="">Folder…</option>
                  {topFolders.filter((t) => !t.trashed && t.kind !== 'root').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                {upIsContacts && ownerKind !== 'person' && (
                  <select value={upPerson} onChange={(e) => setUpPerson(e.target.value)} className="rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading}>
                    <option value="">Whose document?</option>
                    {upPeople.map((pp) => <option key={pp.contactId} value={pp.contactId}>{pp.name}</option>)}
                  </select>
                )}
                <select value={upType} onChange={(e) => setUpType(e.target.value)} className="rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading || !types || !upFolder}>
                  <option value="">{types ? 'Document type…' : 'Loading types…'}</option>
                  {upTypes.map((t) => <option key={t.slug} value={t.slug}>{t.name}{t.staffOnly ? ' (staff only)' : ''}</option>)}
                </select>
                <input value={upName} onChange={(e) => setUpName(e.target.value)} placeholder="Display name (optional)" className="w-52 rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading} />
                <label className="inline-flex items-center gap-1.5 text-xs text-zinc-700">
                  <input type="checkbox" checked={upVisible} onChange={(e) => setUpVisible(e.target.checked)} disabled={uploading} />
                  Show to client
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" className="text-sm"
                  disabled={uploading || !upFolder || !upType || (upIsContacts && ownerKind !== 'person' && !upPerson)}
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) doUpload(file) }} />
                {uploading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
                <button type="button" onClick={() => setUploadOpen(false)} disabled={uploading} className="text-xs text-zinc-500 hover:underline">Cancel</button>
                <span className="text-xs text-zinc-400">Same name in the same folder = a new version of that file.</span>
              </div>
            </div>
          )}

          <ul className="divide-y divide-zinc-50">
            {topFolders.map((f) => folderNode(f, 0))}
            {root.files.map((file) => fileRow(file, null, 0))}
            {topFolders.length === 0 && root.files.length === 0 && (
              <li className="py-2 text-sm text-zinc-500">This storage is empty.</li>
            )}
          </ul>
          <p className="mt-2 text-xs text-zinc-400">Drag a file onto a folder to move it.</p>
        </>
      )}
      {preview && <PreviewPanel file={preview} onClose={() => setPreview(null)} />}
      <OcrViewerModal documentId={ocrDocId} onClose={() => setOcrDocId(null)} />
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
