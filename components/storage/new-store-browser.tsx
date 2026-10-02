'use client'

/**
 * Browser of the NEW CRM store (job 685467b5) — Storage page → "New storage", and the Files / Documents tabs
 * of a company or person whose files live in the new store (scoped to that one owner via `ownerId`).
 *
 * Left side (Storage page, master plan Part 14): Clients grouped automatically from the CRM (by state, People,
 * Companies being formed, Closed / Cancelled, Missing state, Unfiled) + Business (the firm's own folders) +
 * My files (the owner-only login). Right side: the path, then the folder TREE (each folder opens and closes in
 * place). Folders: + Folder, New tax year, rename / move / delete for the folders staff made (the fixed ones are
 * locked). Files open INSIDE the CRM; show / hide for the client; rename / move (tree picker or drag) / delete.
 * A company's "2. Contacts" shows one branch per person — that person's OWN storage (#28), through the company.
 * When the system can't work something out it ASKS (Part 16): one question, the evidence, real choices.
 */

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import {
  Building2, User, Hammer, Folder, FolderOpen, FolderPlus, FileText, FileImage, FileSpreadsheet, ChevronRight, ChevronDown, Eye, EyeOff,
  Lock, Trash2, Layers, X, Upload, Download, Loader2, RefreshCw, ScanText, MoreHorizontal, Pencil, FolderInput, Briefcase, CalendarPlus, AlertTriangle, Check, Search, Tag, HardDriveDownload,
} from 'lucide-react'
import { OcrViewerModal } from '@/components/documents/ocr-viewer'
import { useAiMarks, AiMarkChip, AiCheckFilesButton, AiReviewPanel } from './ai-check'
import { MyDriveDialog } from '@/components/storage/my-drive-dialog'
import { PlainDropPanel, type PlainOutcome } from './plain-drop-panel'
import { allFolderPaths, filterPlainDrop, isInternalOwnerKind, itemsFromFileList, type PlainItem, type PlainSkipped } from '@/lib/crm-store/plain-drop'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { QuestionDialog, FolderPicker, MiniPreview, sha256OfFile, type StoreQuestion, type NavGroup, type Choice } from './store-dialogs'
import { SetTypeDialog, useStoreDocTypes } from './set-type-dialog'
import { DriveImportDialog } from './drive-import-dialog'
import { folderNameProblem, suggestTaxYear as suggestYear, finalUploadName, keepBothName } from '@/lib/crm-store/names'

interface Fold { id: string; name: string; kind: string; trashed: boolean; locked?: boolean }
interface File_ {
  id: string; name: string; documentType: string | null; state: string; published: boolean; clientVisible: boolean
  /** the workspace that always shows this file to the client — it can't be hidden from here */
  shownByWorkspace?: string | null
  staffOnly: boolean; personal: boolean; versions: number; size: number | null; mimeType: string | null; updatedAt: string
  listed: boolean; personName: string | null; inPersonStorage: boolean; docId: string | null
  sha256?: string | null; needsReview?: string | null
  /** in My files › Shared with staff: who it is shared with (null = not a shareable place) */
  sharedWith?: string[] | null
  /** none / draft / filed / amended */
  filingStatus?: string | null
}
interface OwnerInfo { kind: string; label: string; accountStatus: string | null; closed: boolean }
interface Person { contactId: string; name: string; ownerId: string | null; companies: string[] }
interface Contents { folder: Fold | null; path: Fold[]; folders: Fold[]; files: File_[]; people?: Person[]; owner: OwnerInfo }
interface DocType { slug: string; name: string; staffOnly: boolean; personal: boolean; defaultFolderKind: string | null; draftNeverVisible: boolean }

/**
 * The company's owner in the NEW store (Formation pilot), or null. Shared by the company Files tab and the
 * flat documents list so both agree (same cache key). The route answers null outside the pilot environment.
 */
export function useStoreOwnerForAccount(accountId: string, enabled: boolean) {
  return useQuery<{ ownerId: string | null; shownFileIds?: string[]; moved?: { status: string; finishedAt: string | null; startedAt: string } | null }>({
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

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

const ownerIcon = (k: string) => (k === 'company' ? Building2 : k === 'person' ? User : k === 'formation' ? Hammer : k === 'business' ? Briefcase : k === 'private' ? Lock : Folder)

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

function PreviewPanel({ file, onClose, src: srcOverride, title }: { file: File_; onClose: () => void; src?: string; title?: string }) {
  const src = srcOverride ?? `/api/crm-store/browse/file/${file.id}`
  const mime = (file.mimeType ?? '').split(';')[0].trim().toLowerCase()
  const inline = INLINE_TYPES.has(mime)
  const isImage = inline && mime.startsWith('image/')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
          <FileText className="h-4 w-4 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title ?? file.name}</span>
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
const isYear = (n: string) => /^\d{4}$/.test(n)
/** year folders newest first, as today; everything else by name */
const sortFolders = (a: Fold, b: Fold) => (isYear(a.name) && isYear(b.name) ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name))

type UploadOutcome = 'saved' | 'cancelled' | 'failed'
interface TrashBatch {
  whose: string | null; ownerId: string
  batchId: string; trashedAt: string; purgeAfter: string | null; trashedBy: string | null
  topName: string | null; folders: number; files: number; held: number
  items: { kind: 'file' | 'folder'; id: string; name: string; mimeType: string | null }[]
}
interface DropItem { file: File; type: string; name: string; status: 'waiting' | 'uploading' | UploadOutcome; /** sub-folders of a dropped folder ("Taxes/2024") */ path: string[] }
interface FilteredFile { id: string; name: string; folderId: string; where: string; mimeType: string | null; size: number | null; updatedAt: string; needsReview: string | null; documentType: string | null }
interface FileDetails {
  id: string; name: string; where: string; state: string; type: string | null; typeName: string | null; year: number | null; filingStatus: string | null
  createdAt: string; createdBy: string | null; updatedAt: string
  versions: { versionNo: number; createdAt: string; size: number | null; by: string | null; current: boolean }[]
  clientCanSee: boolean; listed: boolean; sharedWithStaff: string[] | null; needsReview: string | null; links: { kind: string; taxYear: number | null }[]
}
type SortMode = 'name' | 'date'
const DROP_MAX_FILES = 500
type FsEntry = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void, bad: (e: unknown) => void) => void; createReader?: () => { readEntries: (ok: (list: FsEntry[]) => void, bad: (e: unknown) => void) => void } }
/** every file inside what was dropped (files and folders, all levels), with its sub-folder path */
async function readDropped(items: DataTransferItemList | null, files: FileList | null, max: number = DROP_MAX_FILES, unreadable?: Array<{ name: string; why: string }>, dirs?: string[][]): Promise<{ file: File; path: string[] }[]> {
  const entries = Array.from(items ?? []).map((it) => (it as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null)
  if (!entries.some((x) => x?.isDirectory)) return Array.from(files ?? []).filter((f) => !f.name.startsWith('.')).map((file) => ({ file, path: [] }))
  const out: { file: File; path: string[] }[] = []
  const walk = async (e: FsEntry, path: string[]): Promise<void> => {
    if (out.length > max) return // one past the limit is enough to say "too many"
    if (e.name.startsWith('.')) return // hidden system files and folders (.DS_Store, ._x, .git …) are never uploaded
    // with `unreadable` given (Business / My files) one locked, cloud-only or broken-alias item is reported and skipped — it never kills the whole drop
    const skipBad = (what: string): boolean => { if (!unreadable) return false; unreadable.push({ name: [...path, what].join(' › '), why: 'It could not be read — a cloud-only file that is not downloaded yet, a locked file or a broken alias.' }); return true }
    if (e.isFile && e.file) {
      try { const f = await new Promise<File>((ok, bad) => e.file!(ok, bad)); out.push({ file: f, path }) } catch (err) { if (!skipBad(e.name)) throw err }
      return
    }
    if (e.isDirectory && e.createReader) {
      dirs?.push([...path, e.name])                       // every folder is remembered, even one that turns out to hold nothing to upload
      const reader = e.createReader()
      for (;;) { // readEntries answers in batches until it returns nothing
        let batch: FsEntry[]
        try { batch = await new Promise<FsEntry[]>((ok, bad) => reader.readEntries(ok, bad)) } catch (err) { if (!skipBad(e.name)) throw err; break }
        if (!batch.length) break
        for (const c of batch) await walk(c, [...path, e.name])
      }
    }
  }
  for (const e of entries) if (e) await walk(e, [])
  return out
}
interface DropBatch { folder: Fold; items: DropItem[]; person: string }
/** a drag that carries files from the computer (not a file being moved inside the CRM) */
const isComputerDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
type PersonKey = `person:${string}`
const personKey = (contactId: string): PersonKey => `person:${contactId}`

interface Asking { slug: string; fallbackTitle: string; body: React.ReactNode; choices: Array<Omit<Choice, 'onChoose'>>; resolve: (key: string) => void }
interface Picking { props: Omit<React.ComponentProps<typeof FolderPicker>, 'onPick' | 'onClose'>; resolve: (r: { folderId: string; ownerId: string; path: string } | null) => void }
interface NewFolder { parentId: string; value: string; year?: boolean; siblings: string[]; left?: boolean }
interface TreeNode { root?: Fold | null; folders: Fold[] }

export function NewStoreBrowser({ ownerId: scopedOwnerId, scopedKind = 'company' }: { ownerId?: string; scopedKind?: string } = {}) {
  const [groups, setGroups] = useState<NavGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ownerId, setOwnerId] = useState<string | null>(scopedOwnerId ?? null)
  const [root, setRoot] = useState<Contents | null>(null)
  /** loaded contents of each opened folder (by folder id), and of each person branch (by person:<contact id>) */
  const [loaded, setLoaded] = useState<Record<string, Contents>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  /** the folder the right side shows (null = the storage's top) */
  const [focus, setFocus] = useState<string | null>(null)
  // the LEFT tree (Storage page): Clients › groups › storages › folders, Business › folders, My files › folders
  const [openTree, setOpenTree] = useState<Set<string>>(new Set())
  const [tree, setTree] = useState<Record<string, TreeNode>>({})
  const [treeLoading, setTreeLoading] = useState<Set<string>>(new Set())
  const openTreeRef = useRef<Set<string>>(new Set())
  const focusRef = useRef<string | null>(null)
  /** the storage open on the right RIGHT NOW (a slower, older load must not overwrite a newer pick) */
  const ownerIdRef = useRef<string | null>(scopedOwnerId ?? null)
  /** each folder pick gets a number; only the latest one may land */
  const pickSeq = useRef(0)
  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<File_ | null>(null)
  const [ocrDocId, setOcrDocId] = useState<string | null>(null)
  const [versionsFor, setVersionsFor] = useState<string | null>(null)
  const [versions, setVersions] = useState<{ id: string; versionNo: number; createdAt: string; size: number | null; mimeType: string | null; current: boolean; by: string | null }[] | null>(null)
  const [previewVersion, setPreviewVersion] = useState<{ file: File_; src: string; title: string } | null>(null)
  const [busyFiles, setBusyFiles] = useState<Set<string>>(new Set())
  const [types, setTypes] = useState<DocType[] | null>(null)
  const [questions, setQuestions] = useState<Record<string, StoreQuestion> | null>(null)
  // upload panel: folder, whose (2. Contacts), type, name shown, show to client
  const [uploadOpen, setUploadOpen] = useState(false)
  const [upFolder, setUpFolder] = useState('')
  const [upPerson, setUpPerson] = useState('')
  const [upType, setUpType] = useState('')
  const [upName, setUpName] = useState('')
  const [upVisible, setUpVisible] = useState(true)
  const [customName, setCustomName] = useState('')
  const [addingType, setAddingType] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  // row menus / inline rename / new folder / drag and drop
  const [menuFor, setMenuFor] = useState<string | null>(null)
  // the AI check inside the storage (job 685467b5): marks of the files on screen, and the side panel that shows the document next to what the AI found
  const visibleFileIds = useMemo(() => Object.values(loaded).flatMap((c) => c.files.filter((f) => f.state === 'live').map((f) => f.id)), [loaded])
  const ai = useAiMarks(ownerId, visibleFileIds)
  const [aiFile, setAiFile] = useState<string | null>(null)
  const [typing, setTyping] = useState<File_ | null>(null)
  // "Import from Google Drive" (owners, where copying is switched on — the server says)
  const [importOpen, setImportOpen] = useState(false)
  const { data: importProbe } = useQuery<{ allowed: boolean }>({
    queryKey: ['crm-store-drive-import-probe'],
    queryFn: async () => { const r = await fetch('/api/crm-store/drive-folders?probe=1'); return r.ok ? r.json() : { allowed: false } },
    staleTime: 300_000,
    enabled: !scopedOwnerId,
  })
  // "My Google Drive" → Business / My files (owners only — the server says)
  const [myDriveFor, setMyDriveFor] = useState<Fold | null>(null)
  const { data: myDriveProbe } = useQuery<{ allowed: boolean }>({
    queryKey: ['crm-store-mydrive-probe'],
    queryFn: async () => { const r = await fetch('/api/crm-store/mydrive/list?probe=1'); return r.ok ? r.json() : { allowed: false } },
    staleTime: 300_000,
  })
  const { data: docTypes } = useStoreDocTypes()
  const typeNameOf = (slug: string | null) => (slug ? docTypes?.find((t) => t.slug === slug)?.name ?? slug : null)
  const [renaming, setRenaming] = useState<{ id: string; value: string; folder?: boolean; left?: boolean } | null>(null)
  const [newFolder, setNewFolder] = useState<NewFolder | null>(null)
  const [dragFile, setDragFile] = useState<{ id: string; from: string | null } | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [picking, setPicking] = useState<Picking | null>(null)
  // "Shared with staff": the owners tick who may open each file; staff see "Shared with me"
  const [sharing, setSharing] = useState<File_ | null>(null)
  const [staffLogins, setStaffLogins] = useState<{ userId: string; email: string; name: string }[] | null>(null)
  const [shareTicks, setShareTicks] = useState<Set<string>>(new Set())
  const [savingShare, setSavingShare] = useState(false)
  const [sharedView, setSharedView] = useState(false)
  // the trash of the open storage, and files dragged in from the computer
  const [trashOpen, setTrashOpen] = useState(false)
  const [trash, setTrash] = useState<TrashBatch[] | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropBatch | null>(null)
  /** a plain drop / upload into the firm's own areas (Business, My files): no type, no limit */
  const [plain, setPlain] = useState<{ folder: Fold; items: PlainItem[]; skipped: PlainSkipped[]; folders: string[][] } | null>(null)
  const plainFolders = useRef(new Map<string, Fold>())
  // many files at once: selection, sort, filters, details
  const [selectedFiles, setSelectedFiles] = useState<Map<string, File_ & { folderId: string | null }>>(new Map())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>(() => { try { return (localStorage.getItem('store-sort') as SortMode) || 'name' } catch { return 'name' } })
  const [filterKind, setFilterKind] = useState<'shown' | 'review' | 'untyped' | null>(null)
  const [filtered, setFiltered] = useState<FilteredFile[] | null>(null)
  const [detailsFor, setDetailsFor] = useState<string | null>(null)
  // Escape closes the Trash window / the details panel (not while a question, picker or preview is open on top)
  useEffect(() => {
    if (!trashOpen && !detailsFor) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || asking || picking || preview) return
      if (detailsFor) setDetailsFor(null)
      else setTrashOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [trashOpen, detailsFor, asking, picking, preview])
  const [details, setDetails] = useState<FileDetails | null>(null)
  const [dropRunning, setDropRunning] = useState(false)
  const [sharedFiles, setSharedFiles] = useState<{ id: string; name: string; where: string; mimeType: string | null; size: number | null; updatedAt: string; sharedAt: string }[] | null>(null)
  const dragRef = useRef<{ id: string; from: string | null } | null>(null)
  const renameDone = useRef(false)
  const expandedRef = useRef<Set<string>>(new Set())
  /** which storage each folder on screen belongs to (a person branch's folders belong to the PERSON) */
  const folderOwner = useRef<Map<string, string>>(new Map())
  /** folders reached through a company's "2. Contacts" (opened with via=company) */
  const viaCompany = useRef<Set<string>>(new Set())

  useEffect(() => { expandedRef.current = expanded }, [expanded])
  useEffect(() => { openTreeRef.current = openTree }, [openTree])
  useEffect(() => { focusRef.current = focus }, [focus])
  // a file from the computer dropped anywhere else on the page must NOT make the browser open it (and lose the page)
  useEffect(() => {
    const stop = (e: DragEvent) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault() }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop) }
  }, [])

  useEffect(() => {
    getJson<{ questions: Record<string, StoreQuestion> }>('/api/crm-store/browse/questions')
      .then((d) => setQuestions(d.questions)).catch(() => setQuestions({}))
  }, [])

  /** ask ONE question (Part 16); resolves with the chosen key — or "__default__" when the question is switched off */
  const ask = useCallback((slug: string, fallbackTitle: string, body: React.ReactNode, choices: Asking['choices']) => new Promise<string>((resolve) => {
    const q = questions?.[slug]
    if (q && !q.enabled) { resolve('__default__'); return }
    setAsking({ slug, fallbackTitle, body, choices, resolve })
  }), [questions])
  const pick = useCallback((props: Picking['props']) => new Promise<{ folderId: string; ownerId: string; path: string } | null>((resolve) => {
    setPicking({ props, resolve })
  }), [])

  const fetchInto = useCallback(async (oid: string, folderId: string | null, via?: boolean) => {
    const q = `/api/crm-store/browse/folder?owner=${encodeURIComponent(oid)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}${via ? '&via=company' : ''}`
    const c = await getJson<Contents>(q)
    for (const f of [c.folder, ...c.folders]) {
      if (!f) continue
      folderOwner.current.set(f.id, oid)
      if (via) viaCompany.current.add(f.id)
    }
    return c
  }, [])

  const openOwner = useCallback(async (oid: string, fromPick = false) => {
    setSharedView(false)
    setSelectedFiles(new Map())
    setFilterKind(null)
    if (!fromPick) pickSeq.current++ // opening a storage by hand cancels a folder pick still loading
    ownerIdRef.current = oid
    focusRef.current = null
    setOwnerId(oid)
    setError(null)
    setRoot(null)
    setLoaded({})
    setExpanded(new Set())
    setSelected(null)
    setFocus(null)
    setUploadOpen(false)
    try {
      const r = await fetchInto(oid, null)
      if (ownerIdRef.current !== oid) return // another storage was opened meanwhile
      setRoot(r)
      // today's folder view opens the top-level folders straight away (and keeps a folder picked meanwhile)
      setExpanded((x) => new Set([...r.folders.map((f) => f.id), ...(focusRef.current ? [focusRef.current] : []), ...Array.from(x)]))
      const entries = await Promise.all(r.folders.map(async (f) => [f.id, await fetchInto(oid, f.id)] as const))
      if (ownerIdRef.current !== oid) return
      setLoaded((m) => ({ ...m, ...Object.fromEntries(entries) }))
    } catch (e) {
      setError(errMsg(e, 'Could not load the folder.'))
    }
  }, [fetchInto])

  const loadNav = useCallback(async () => {
    try { setGroups((await getJson<{ groups: NavGroup[] }>('/api/crm-store/browse/navigation')).groups) } catch (e) { setError(errMsg(e, 'Could not load the new storage.')) }
  }, [])

  useEffect(() => {
    if (scopedOwnerId) { openOwner(scopedOwnerId); return }
    loadNav()
  }, [scopedOwnerId, openOwner, loadNav])

  // ───────────────────────────────────────── the left tree

  /** load one tree node: a storage (`own:<id>` → its top folder + folders) or a folder (→ its sub-folders) */
  const loadTree = useCallback(async (key: string): Promise<Fold[] | null> => {
    const oid = key.startsWith('own:') ? key.slice(4) : folderOwner.current.get(key)
    if (!oid) return null
    setTreeLoading((l) => new Set(l).add(key))
    try {
      const c = await fetchInto(oid, key.startsWith('own:') ? null : key)
      const folders = [...c.folders].sort(sortFolders)
      setTree((t) => ({ ...t, [key]: { root: key.startsWith('own:') ? c.folder : undefined, folders } }))
      return folders
    } catch (e) {
      toast.error(errMsg(e, 'Could not open the folder.'))
      return null
    } finally {
      setTreeLoading((l) => { const n = new Set(l); n.delete(key); return n })
    }
  }, [fetchInto])

  const toggleTree = (key: string, load = true) => {
    const isOpen = openTree.has(key)
    setOpenTree((x) => { const n = new Set(x); if (isOpen) n.delete(key); else n.add(key); return n })
    if (!isOpen && load && !tree[key]) loadTree(key)
  }

  /** reload every tree node that is open (after any folder change) */
  const refreshTree = useCallback(async () => {
    const keys = Array.from(openTreeRef.current).filter((k) => k.startsWith('own:') || folderOwner.current.has(k))
    await Promise.all(keys.map((k) => loadTree(k)))
  }, [loadTree])

  /** show ONE folder on the right (from the left tree or the path) */
  const selectFolder = async (oid: string, folderId: string) => {
    const my = ++pickSeq.current
    if (oid !== ownerIdRef.current) await openOwner(oid, true)
    if (my !== pickSeq.current || ownerIdRef.current !== oid) return
    try {
      const c = await fetchInto(oid, folderId)
      // a later pick (another folder, another storage) wins
      if (my !== pickSeq.current || ownerIdRef.current !== oid) return
      focusRef.current = folderId
      setLoaded((m) => ({ ...m, [folderId]: c }))
      setFocus(folderId)
      setSelected(folderId)
      setExpanded((x) => new Set(x).add(folderId))
    } catch (e) {
      toast.error(errMsg(e, 'Could not open the folder.'))
    }
  }

  /** load a folder (or a person branch) into `loaded` */
  const loadKey = useCallback(async (key: string) => {
    if (!ownerId) return
    setLoadingFolders((l) => new Set(l).add(key))
    try {
      let c: Contents
      if (key.startsWith('person:')) {
        const person = Object.values(loaded).flatMap((x) => x.people ?? []).find((p) => personKey(p.contactId) === key)
        if (!person?.ownerId) return
        c = await fetchInto(person.ownerId, null, true)
      } else {
        c = await fetchInto(folderOwner.current.get(key) ?? ownerId, key, viaCompany.current.has(key))
      }
      setLoaded((m) => ({ ...m, [key]: c }))
    } catch (e) {
      toast.error(errMsg(e, 'Could not open the folder.'))
    } finally {
      setLoadingFolders((l) => { const n = new Set(l); n.delete(key); return n })
    }
  }, [ownerId, fetchInto, loaded])

  const toggleKey = (key: string) => {
    const isOpen = expanded.has(key)
    setExpanded((x) => { const n = new Set(x); if (isOpen) n.delete(key); else n.add(key); return n })
    if (!isOpen) { setSelected(key); if (!loaded[key]) loadKey(key) }
  }

  const refreshSeq = useRef(0)
  /** reload everything that is on screen (Refresh, and after any change) */
  const refreshAll = useCallback(async (extraKeys: string[] = []) => {
    void refreshTree()
    if (!ownerId) { if (!scopedOwnerId) loadNav(); return }
    // started for a storage that is no longer the one on screen (switched while an upload ran): leave the screen
    // alone — and do NOT count as the newest refresh (it would cancel the one running for the storage on screen)
    if (ownerIdRef.current !== ownerId) { if (!scopedOwnerId) loadNav(); return }
    // only the NEWEST refresh may write the screen: an older one finishing late would put back stale folders
    const seq = ++refreshSeq.current
    try {
      const people = Object.values(loaded).flatMap((x) => x.people ?? [])
      const fetchKey = async (key: string) => {
        try {
          if (key.startsWith('person:')) {
            const p = people.find((pp) => personKey(pp.contactId) === key)
            return p?.ownerId ? [key, await fetchInto(p.ownerId, null, true)] as const : null
          }
          return [key, await fetchInto(folderOwner.current.get(key) ?? ownerId, key, viaCompany.current.has(key))] as const
        } catch {
          // the folder shown on the right is gone (deleted / moved away): back to the storage's top
          if (key === focusRef.current) { focusRef.current = null; setFocus(null) }
          return null
        }
      }
      const apply = (entries: Array<readonly [string, Contents] | null>) => {
        const got = entries.filter((x): x is readonly [string, Contents] => !!x)
        // a folder that went to the trash (deleted, or inside a deleted folder) is no longer shown on the right
        if (focusRef.current && got.some(([k, c]) => k === focusRef.current && c.folder?.trashed)) { focusRef.current = null; setFocus(null) }
        setLoaded((m) => ({ ...m, ...Object.fromEntries(got) }))
      }
      // FIRST the folder on the right and the folder just changed (what staff are looking at), THEN the rest of
      // what is open — so the screen shows the change in about a second, not after every open folder reloads
      const first = Array.from(new Set([...(focusRef.current ? [focusRef.current] : []), ...extraKeys]))
      const [r, firstEntries] = await Promise.all([fetchInto(ownerId, null), Promise.all(first.map(fetchKey))])
      if (ownerIdRef.current !== ownerId || seq !== refreshSeq.current) return
      // what is reloaded: everything open, plus the storage's top folders (their counts show even when closed)
      const rest = Array.from(new Set([...Array.from(expandedRef.current), ...r.folders.map((x) => x.id)])).filter((k) => !first.includes(k))
      // a CLOSED folder's saved contents are not reloaded, so they may be out of date (e.g. a restored folder
      // still counting a file as shown): drop them — they are read again, fresh, when the folder is opened.
      // "2. Contacts" lists (who the people are) are kept: the upload's "Whose document?" reads them.
      const keep = new Set([...first, ...rest])
      setLoaded((m) => Object.fromEntries(Object.entries(m).filter(([k, c]) => keep.has(k) || c.folder?.kind === 'contacts')))
      setRoot(r)
      apply(firstEntries)
      // the rest of what is open reloads in the BACKGROUND (the action that asked is done once the folders it
      // changed are on screen); each folder is shown as soon as ITS reload arrives, never held back by the slowest
      void Promise.all(rest.map((k) => fetchKey(k).then((e) => {
        if (ownerIdRef.current === ownerId && seq === refreshSeq.current) apply([e])
      })))
    } catch (e) {
      toast.error(errMsg(e, 'Could not refresh.'))
    }
    if (!scopedOwnerId) loadNav()
  }, [ownerId, fetchInto, loaded, scopedOwnerId, loadNav, refreshTree])

  const openVersions = async (fileId: string) => {
    if (versionsFor === fileId) { setVersionsFor(null); return }
    setMenuFor(null)
    setVersionsFor(fileId)
    setVersions(null)
    try {
      setVersions((await getJson<{ versions: NonNullable<typeof versions> }>(`/api/crm-store/browse/file/${fileId}/versions`)).versions)
    } catch (e) {
      setVersionsFor(null)
      toast.error(errMsg(e, 'Could not load the versions.'))
    }
  }

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    if (busyFiles.has(id)) return
    setBusyFiles((b) => new Set(b).add(id))
    try { await fn() } finally { setBusyFiles((b) => { const n = new Set(b); n.delete(id); return n }) }
  }

  const ownerLabelOf = (oid: string | undefined | null) => {
    if (!oid) return ''
    if (oid === ownerId) return root?.owner.label ?? ''
    const c = Object.values(loaded).find((x) => x.folder && folderOwner.current.get(x.folder.id) === oid)
    return c?.owner.label ?? ''
  }

  const toggleVisible = (f: File_) => withBusy(f.id, async () => {
    try {
      if (!f.clientVisible && f.personal) {
        // Part 16: showing a document with personal data — who would see it
        const who = f.personName ?? (root?.owner.kind === 'person' ? root.owner.label : 'the person it belongs to')
        const a = await ask('show_personal_data', 'This document holds personal data',
          <>
            <MiniPreview src={`/api/crm-store/browse/file/${f.id}`} mimeType={f.mimeType} label={f.name} sub={f.documentType ?? undefined} />
            <p>Who would see it: <strong>{who}</strong> only, in their own portal. A personal document is never shown to anyone else in a company.</p>
            {f.docId && <button type="button" className="text-blue-700 hover:underline" onClick={() => setOcrDocId(f.docId)}>Read scanned text</button>}
          </>,
          [{ key: 'owner_only', label: `${questions?.show_personal_data?.choices.owner_only ?? 'Show it to'} ${who} only`, tone: 'primary' }, { key: 'keep_hidden' }])
        if (a !== 'owner_only' && a !== '__default__') return
      }
      await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: !f.clientVisible }, 'Could not change who can see this file — please try again.')
      toast.success(f.clientVisible ? `"${f.name}" is now hidden from the client` : `"${f.name}" is now visible to the client`)
      await refreshAll()
    } catch (e) {
      toast.error(errMsg(e, 'Could not change who can see this file.'))
    }
  })

  const doRenameFile = (f: File_, value: string) => withBusy(f.id, async () => {
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
      toast.error(errMsg(e, 'The file could not be renamed.'))
    }
  })

  /** move a file (after the "client can see it" question when it applies) */
  const moveFileTo = (f: File_, folderId: string, where: string) => withBusy(f.id, async () => {
    setMenuFor(null)
    let hide = false
    if (f.shownByWorkspace && f.clientVisible) {
      const a = await ask('move_workspace_file', 'The client can see this file',
        <p><strong>{f.name}</strong> is always shown to the client by the <strong>{f.shownByWorkspace}</strong> workspace, so it stays visible after the move to <strong>{where}</strong>.</p>,
        [{ key: 'keep', label: 'Move it (it stays visible)', tone: 'primary' }, { key: 'cancel', label: 'Cancel the move' }])
      if (a === 'cancel') return
    } else if (f.clientVisible) {
      const a = await ask('move_visible_file', 'The client can see this file',
        <p><strong>{f.name}</strong> is visible to <strong>{f.personName ?? root?.owner.label ?? 'the client'}</strong>. It is moving to <strong>{where}</strong>. Who can see a file goes with the file, not the folder.</p>,
        [{ key: 'keep', tone: 'primary' }, { key: 'hide' }, { key: 'cancel' }])
      if (a === 'cancel') return
      hide = a === 'hide'
    }
    try {
      const r = await postJson<{ folderName: string }>(`/api/crm-store/browse/file/${f.id}/move`, { folderId }, 'The file could not be moved.')
      if (hide) await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: false }, 'The file was moved, but could not be hidden — hide it from its row.')
      toast.success(`Moved "${f.name}" to ${r.folderName}${hide ? ' (now hidden from the client)' : ''}`)
      await refreshAll([folderId])
    } catch (e) {
      toast.error(errMsg(e, 'The file could not be moved.'))
      await refreshAll([folderId]) // the move itself may have happened: show where the file really is
    }
  })

  const pickAndMoveFile = async (f: File_, inFolder: Fold | null) => {
    setMenuFor(null)
    const oid = (inFolder && folderOwner.current.get(inFolder.id)) ?? ownerId
    if (!oid) return
    const r = await pick({ title: `Move "${f.name}" to…`, ownerId: oid, ownerLabel: ownerLabelOf(oid), mode: 'file', currentFolderId: inFolder?.id ?? null })
    setPicking(null)
    if (r) await moveFileTo(f, r.folderId, r.path)
  }

  const doDeleteFile = (f: File_) => withBusy(f.id, async () => {
    setMenuFor(null)
    const a = await ask('delete_file', 'Move this file to the trash?',
      <p><strong>{f.name}</strong>{f.clientVisible ? ' — the client can see it today; it disappears from their portal.' : ''} Recoverable for 90 days.</p>,
      [{ key: 'trash', label: 'Move to trash', tone: 'danger' }, { key: 'cancel', label: 'Cancel' }])
    if (a !== 'trash' && a !== '__default__') return
    try {
      await postJson(`/api/crm-store/browse/file/${f.id}/delete`, {}, 'The file could not be deleted.')
      toast.success(`"${f.name}" moved to the trash`)
      await refreshAll()
    } catch (e) {
      toast.error(errMsg(e, 'The file could not be deleted.'))
    }
  })

  const markFiled = (f: File_) => withBusy(f.id, async () => {
    setMenuFor(null)
    const a = await ask('mark_filed', 'Mark this return as filed?',
      <p><strong>{f.name}</strong> becomes the FILED return: it can then be shown to the client, and it is frozen — no new version can replace it (a correction is saved as an amended return). This can&apos;t be undone.</p>,
      [{ key: 'filed', label: 'Mark filed', tone: 'primary' }, { key: 'cancel', label: 'Cancel' }])
    if (a !== 'filed' && a !== '__default__') return
    try {
      await postJson(`/api/crm-store/browse/file/${f.id}/filed`, {}, 'It could not be marked filed.')
      toast.success(`"${f.name}" is now the filed return — show it to the client from its row when ready`)
      await refreshAll()
    } catch (e) {
      toast.error(errMsg(e, 'It could not be marked filed.'))
    }
  })

  const markReviewed = (f: File_) => withBusy(f.id, async () => {
    setMenuFor(null)
    try {
      await postJson(`/api/crm-store/browse/file/${f.id}/reviewed`, {}, 'Could not clear "Needs review".')
      toast.success(`"${f.name}" marked as reviewed`)
      await refreshAll()
    } catch (e) {
      toast.error(errMsg(e, 'Could not clear "Needs review".'))
    }
  })

  // ───────────────────────────────────────── Shared with staff

  const openSharing = async (f: File_) => {
    setMenuFor(null)
    setSharing(f)
    setShareTicks(new Set(f.sharedWith ?? []))
    if (staffLogins) return
    try {
      setStaffLogins((await getJson<{ logins: { userId: string; email: string; name: string }[] }>('/api/crm-store/browse/staff-logins')).logins)
    } catch (e) {
      toast.error(errMsg(e, 'Could not load the staff list.'))
      setSharing(null)
    }
  }

  const saveSharing = async () => {
    if (!sharing) return
    setSavingShare(true)
    try {
      const r = await postJson<{ sharedWith: string[] }>(`/api/crm-store/browse/file/${sharing.id}/shares`, { userIds: Array.from(shareTicks) }, 'The sharing could not be changed.')
      toast.success(r.sharedWith.length === 0 ? `"${sharing.name}" is not shared with anyone` : `"${sharing.name}" is shared with ${r.sharedWith.length} ${r.sharedWith.length === 1 ? 'person' : 'people'}`)
      setSharing(null)
      await refreshAll()
    } catch (e) {
      toast.error(errMsg(e, 'The sharing could not be changed.'))
    } finally {
      setSavingShare(false)
    }
  }

  const openSharedWithMe = async () => {
    setSharedView(true)
    setSharedFiles(null)
    try {
      setSharedFiles((await getJson<{ files: NonNullable<typeof sharedFiles> }>('/api/crm-store/browse/shared-with-me')).files)
    } catch (e) {
      toast.error(errMsg(e, 'Could not read the files shared with you.'))
      setSharedFiles([])
    }
  }

  // ───────────────────────────────────────── trash

  const openTrash = async () => {
    if (!ownerId) return
    setTrashOpen(true)
    setTrash(null)
    try {
      setTrash((await getJson<{ batches: TrashBatch[] }>(`/api/crm-store/browse/trash?owner=${encodeURIComponent(ownerId)}`)).batches)
    } catch (e) {
      toast.error(errMsg(e, 'Could not read the trash.'))
      setTrash([])
    }
  }

  const restoreBatch = async (b: TrashBatch, targetFolderId?: string) => {
    if (!ownerId) return
    setRestoring(b.batchId)
    try {
      const res = await fetch('/api/crm-store/browse/trash/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: b.batchId, targetFolderId }) })
      const d = await res.json().catch(() => ({})) as { needsTarget?: boolean; error?: string; files?: number; folders?: number; renamed?: string[]; skipped?: { name: string; why: string }[]; notRelisted?: string[] }
      if (res.status === 409 && d.needsTarget) {
        // the folder it came from is gone (deleted too): ask where to put it
        const onlyFiles = b.items.every((i) => i.kind === 'file')
        const r = await pick({ title: `The folder "${b.topName ?? ''}" came from is gone — restore it into…`, ownerId: b.ownerId, ownerLabel: b.whose ?? root?.owner.label, mode: onlyFiles ? 'file' : 'folder' })
        setPicking(null)
        if (r) await restoreBatch(b, r.folderId)
        return
      }
      if (!res.ok) throw new Error(d.error || 'It could not be restored — please try again.')
      const what = [d.folders ? `${d.folders} ${d.folders === 1 ? 'folder' : 'folders'}` : '', d.files ? `${d.files} ${d.files === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join(' and ')
      toast.success(`Restored ${what || 'it'} — hidden from the client${(d.renamed ?? []).length ? ` (renamed so nothing clashes: ${(d.renamed ?? []).join(', ')})` : ''}`)
      if ((d.skipped ?? []).length) toast.message(`Not restored: ${(d.skipped ?? []).map((x) => `${x.name} (${x.why})`).join('; ')}`)
      if ((d.notRelisted ?? []).length) toast.message(`Restored, but not put back in the CRM list (the client can't see them): ${(d.notRelisted ?? []).join(', ')} — tell the tech team.`)
      await openTrash()
      await refreshAll()
    } catch (e) {
      toast.error(errMsg(e, 'It could not be restored.'))
    } finally {
      setRestoring(null)
    }
  }

  // ───────────────────────────────────────── files dragged in from the computer

  /** the document types a folder takes (the same rule as the Upload panel) */
  const typesForFolder = (f: Fold | null, all: DocType[] | null = types): DocType[] => {
    const via = !!f && viaCompany.current.has(f.id)
    const isPerson = ownerKind === 'person' || via
    const contacts = f?.kind === 'contacts'
    return (all ?? []).filter((t) => (via ? t.personal : isPerson ? true : contacts ? t.personal : ownerKind === 'private' ? true : !t.personal))
  }
  /** a sensible first type for a folder: the first type whose home is this kind of folder */
  const defaultTypeFor = (f: Fold, list: DocType[]): string => {
    const k = f.kind === 'tax' ? 'tax_year' : f.kind === 'person_tax' ? 'person_tax_year' : f.kind
    return list.find((t) => t.defaultFolderKind === k)?.slug ?? ''
  }

  /** a sub-folder of the open plain upload, made once (or reused) */
  const ensurePlainFolder = async (path: string[]): Promise<Fold> => {
    if (!plain || !ownerId) throw new Error('The upload was closed.')
    if (!path.length) return plain.folder
    const key = path.join('/')
    let made = plainFolders.current.get(key)
    if (!made) {
      const r = await postJson<{ id: string; kind: string }>(`/api/crm-store/browse/folder/${plain.folder.id}/ensure-path`, { path }, 'The folders could not be created.')
      made = { id: r.id, name: path[path.length - 1], kind: r.kind, trashed: false, locked: false }
      folderOwner.current.set(r.id, ownerId)
      plainFolders.current.set(key, made)
    }
    return made
  }

  /** one file of a plain upload: its sub-folders are made (or reused) once, then the bytes go up and are registered with NO type */
  const runPlainItem = async (item: PlainItem): Promise<PlainOutcome> => {
    if (!plain || !ownerId) return { outcome: 'failed', message: 'The upload was closed.' }
    try {
      const into: Fold = await ensurePlainFolder(item.path)
      if (item.driveId) {          // copied from the owner's own Google Drive — the server fetches it, nothing comes through this browser
        const r = await postJson<{ outcome: string; message?: string }>('/api/crm-store/mydrive/copy', { driveFileId: item.driveId, ownerId, folderId: into.id }, 'The file could not be copied.')
        return r.outcome === 'saved' ? { outcome: 'saved' } : r.outcome === 'unchanged' ? { outcome: 'unchanged' } : { outcome: 'failed', message: r.message ?? 'The file could not be copied.' }
      }
      const file = item.file
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120)
      const storagePath = `${STAGING_PREFIX}${ownerId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`
      const sig = await postJson<{ signedUrl?: string }>('/api/storage/upload', { bucket: 'onboarding-uploads', path: storagePath, contentType: file.type }, 'Could not prepare the upload.')
      if (!sig.signedUrl) return { outcome: 'failed', message: 'Could not prepare the upload.' }
      const put = await fetch(sig.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      if (!put.ok) return { outcome: 'failed', message: `The file could not be sent (status ${put.status}).` }
      const r = await postJson<{ write: string }>('/api/crm-store/browse/upload', { ownerId, folderId: into.id, storagePath, fileName: file.name, mimeType: file.type }, 'The file could not be saved.')
      return { outcome: r.write === 'unchanged' ? 'unchanged' : 'saved' }
    } catch (e) {
      return { outcome: 'failed', message: errMsg(e, 'The file could not be saved.') }
    }
  }

  /** "Copy from my Google Drive into My files / Business" from the Import dialog: open that storage, then pick from the owner's own Drive */
  const openMyDriveInto = async (target: 'private' | 'business') => {
    const owner = (groups ?? []).find((g) => g.section === target)?.owners[0]
    if (!owner) { toast.error(target === 'private' ? 'Your My files storage was not found.' : 'The Business storage was not found.'); return }
    try {
      await openOwner(owner.id)
      const c = await fetchInto(owner.id, null)
      if (!c.folder) { toast.error('This storage has no top folder yet.'); return }
      folderOwner.current.set(c.folder.id, owner.id)
      setImportOpen(false)
      setMyDriveFor(c.folder)
    } catch (err) { toast.error(errMsg(err, 'Could not open that storage.')) }
  }

  /** a folder or files dropped straight on the "My files" / "Business" row of the left tree: open it, then upload into its top */
  const onDropOnOwner = async (e: React.DragEvent, oid: string) => {
    e.preventDefault(); e.stopPropagation(); setDropOn(null)
    if (uploading || dropRunning || !!drop || plain) { toast.error('Wait for the upload in progress to finish, then drop again.'); return }
    const unreadable: Array<{ name: string; why: string }> = []
    const dirs: string[][] = []
    const reading = readDropped(e.dataTransfer.items, e.dataTransfer.files, Number.POSITIVE_INFINITY, unreadable, dirs)   // started now: the dropped items are only readable during the drop
    const tid = toast.loading('Reading what you dropped…')
    try {
      await openOwner(oid)
      const c = await fetchInto(oid, null)
      if (!c.folder) { toast.error('This storage has no folder to drop into yet.'); return }
      folderOwner.current.set(c.folder.id, oid)
      const { items, skipped, folders } = filterPlainDrop(await reading)
      skipped.push(...unreadable)
      const allFolders = allFolderPaths(folders, dirs)
      if (!items.length && !skipped.length && !allFolders.length) { toast.message('Nothing to upload in what was dropped.'); return }
      plainFolders.current = new Map()
      setPlain({ folder: c.folder, items, skipped, folders: allFolders })
    } catch (err) { toast.error(errMsg(err, 'What was dropped could not be read (a file may be locked or an alias is broken) — try again or drop fewer files.')) }
    finally { toast.dismiss(tid) }
  }

  const onComputerDrop = async (e: React.DragEvent, folder: Fold) => {
    e.preventDefault(); e.stopPropagation(); setDropOn(null)
    if (uploading || dropRunning || !!drop) { toast.error('Wait for the upload in progress to finish, then drop again.'); return }
    if (folder.trashed || folder.kind === 'root') { toast.error('Drop the files on one of the folders.'); return }
    if (isInternalOwnerKind(ownerKind)) {                                  // Business / My files: a normal storage — no type, no limit
      const tid = toast.loading('Reading what you dropped…')
      try {
        const unreadable: Array<{ name: string; why: string }> = []
        const dirs: string[][] = []
        const got = await readDropped(e.dataTransfer.items, e.dataTransfer.files, Number.POSITIVE_INFINITY, unreadable, dirs)
        const { items, skipped, folders } = filterPlainDrop(got)
        skipped.push(...unreadable)
        const allFolders = allFolderPaths(folders, dirs)
        if (!items.length && !skipped.length && !allFolders.length) { toast.message('Nothing to upload in what was dropped.'); return }
        plainFolders.current = new Map()
        setPlain({ folder, items, skipped, folders: allFolders })
      } catch (err) { toast.error(errMsg(err, 'What was dropped could not be read (a file may be locked or an alias is broken) — try again or drop fewer files.')) }
      finally { toast.dismiss(tid) }
      return
    }
    let found: { file: File; path: string[] }[]
    try {
      found = await readDropped(e.dataTransfer.items, e.dataTransfer.files)
    } catch (err) {
      toast.error(errMsg(err, 'What was dropped could not be read (a file may be locked or an alias is broken) — try again or drop fewer files.'))
      return
    }
    // "2. Contacts" needs its people for "Whose documents?" even when the folder is closed in the tree
    if (folder.kind === 'contacts' && !loaded[folder.id]) {
      try {
        const c = await fetchInto(folderOwner.current.get(folder.id) ?? ownerId ?? '', folder.id)
        setLoaded((m) => ({ ...m, [folder.id]: c }))
      } catch (err) { toast.error(errMsg(err, 'Could not read the people of this company.')); return }
    }
    if (!found.length) { toast.message('Nothing to upload in what was dropped.'); return }
    if (found.length > DROP_MAX_FILES) { toast.error(`At most ${DROP_MAX_FILES} files at a time — drop a smaller folder.`); return }
    if (folder.kind === 'contacts' && found.some((x) => x.path.length)) { toast.error('A whole folder can’t go into "2. Contacts" — open the person and drop it into one of their folders.'); return }
    const typed = typesForFolder(folder, types ?? (await loadTypes()))
    const def = defaultTypeFor(folder, typed)
    setDrop({ folder, person: '', items: found.map(({ file, path }) => ({ file, path, type: def, name: '', status: 'waiting' })) })
  }

  const runDrop = async () => {
    if (!drop) return
    if (drop.folder.kind === 'contacts' && !drop.person) { toast.error('Choose whose documents these are first.'); return }
    if (drop.items.some((i) => i.status === 'waiting' && !i.type)) { toast.error('Choose a document type for every file.'); return }
    setDropRunning(true)
    setUploading(true)
    let saved = 0, skipped = 0, failed = 0
    const madePaths = new Map<string, Fold | null>() // null = that path could not be made (said once)
    const taxMemo = new Map<string, { folder: Fold; year: number | null }>()
    const oidOfDrop = folderOwner.current.get(drop.folder.id) ?? ownerId ?? ''
    const viaDrop = viaCompany.current.has(drop.folder.id)
    for (let i = 0; i < drop.items.length; i++) {
      const it = drop.items[i]
      if (it.status !== 'waiting') continue
      setDrop((d) => d && ({ ...d, items: d.items.map((x, j) => (j === i ? { ...x, status: 'uploading' } : x)) }))
      // a dropped folder: its sub-folders are made (or reused) under the target, once per path
      let into: Fold = drop.folder
      if (it.path.length) {
        const key = it.path.join('/')
        const known = madePaths.get(key)
        if (known === null) {
          failed++
          setDrop((d) => d && ({ ...d, items: d.items.map((x, j) => (j === i ? { ...x, status: 'failed' } : x)) }))
          continue
        }
        if (known) into = known
        else {
          try {
            const r = await postJson<{ id: string; kind: string }>(`/api/crm-store/browse/folder/${drop.folder.id}/ensure-path`, { path: it.path }, 'The folders could not be created.')
            into = { id: r.id, name: it.path[it.path.length - 1], kind: r.kind, trashed: false, locked: false }
            folderOwner.current.set(r.id, oidOfDrop)
            if (viaDrop) viaCompany.current.add(r.id)
            madePaths.set(key, into)
          } catch (err) {
            toast.error(`${it.path.join(' › ')}: ${errMsg(err, 'the folders could not be created.')}`)
            madePaths.set(key, null)
            failed++
            setDrop((d) => d && ({ ...d, items: d.items.map((x, j) => (j === i ? { ...x, status: 'failed' } : x)) }))
            continue
          }
        }
      }
      // dragged files always arrive HIDDEN from the client (decision #85); every question still applies
      const out = await doUploadWith(it.file, { folder: into, typeSlug: it.type, personId: drop.person, displayName: it.name, visible: false, batch: true, taxMemo })
      if (out === 'saved') saved++; else if (out === 'cancelled') skipped++; else failed++
      setDrop((d) => d && ({ ...d, items: d.items.map((x, j) => (j === i ? { ...x, status: out } : x)) }))
    }
    setDropRunning(false)
    setUploading(false)
    toast.success(`${saved} ${saved === 1 ? 'file' : 'files'} uploaded — hidden from the client${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`)
    if (saved && root?.owner.kind === 'private') toast.message('Files in Shared with staff are shared with nobody yet — use "Not shared" on each one to choose who can see it.')
    await refreshAll()
    if (!failed) setDrop(null)
  }

  // ───────────────────────────────────────── many files: sort, filters, details, group actions

  const downloadZip = async (f: Fold) => {
    try {
      const c = await getJson<{ files: number; bytes: number }>(`/api/crm-store/browse/folder/${f.id}/zip?check=1`)
      toast.message(`Preparing ${f.name}.zip — ${c.files} ${c.files === 1 ? 'file' : 'files'}, ${fmtSize(c.bytes)}`)
      // a hidden frame: the zip downloads, and if the server refuses at the last moment its message is read from
      // the frame and shown — the CRM page is never replaced by an error text
      const frame = document.createElement('iframe')
      frame.style.display = 'none'
      frame.src = `/api/crm-store/browse/folder/${f.id}/zip`
      frame.onload = () => {
        try {
          const txt = frame.contentDocument?.body?.innerText ?? ''
          const m = /"error"\s*:\s*"([^"]+)"/.exec(txt)
          if (m) toast.error(m[1])
        } catch { /* a download never loads a page into the frame */ }
        setTimeout(() => frame.remove(), 1000)
      }
      document.body.appendChild(frame)
      setTimeout(() => { if (document.body.contains(frame)) frame.remove() }, 10 * 60_000)
    } catch (e) {
      toast.error(errMsg(e, 'The zip could not be made.'))
    }
  }

  const setSort = (m: SortMode) => { setSortMode(m); try { localStorage.setItem('store-sort', m) } catch { /* a per-browser nicety */ } }
  const sortFiles = (list: File_[]) => [...list].sort((a, b) => (sortMode === 'date' ? b.updatedAt.localeCompare(a.updatedAt) : a.name.localeCompare(b.name)))

  const filterSeq = useRef(0)
  const openFilter = async (k: 'shown' | 'review' | 'untyped' | null) => {
    const my = ++filterSeq.current
    setFilterKind(k)
    setFiltered(null)
    if (!k || !ownerId) return
    try {
      const r = (await getJson<{ files: FilteredFile[] }>(`/api/crm-store/browse/filter?owner=${encodeURIComponent(ownerId)}&kind=${k}`)).files
      if (my === filterSeq.current) setFiltered(r)
    } catch (e) {
      if (my !== filterSeq.current) return
      toast.error(errMsg(e, 'Could not filter the files.'))
      setFiltered([])
    }
  }

  const openDetails = async (fileId: string) => {
    setMenuFor(null)
    setDetailsFor(fileId)
    setDetails(null)
    try {
      setDetails(await getJson<FileDetails>(`/api/crm-store/browse/file/${fileId}/details`))
    } catch (e) {
      toast.error(errMsg(e, "Could not read the file's details."))
      setDetailsFor(null)
    }
  }

  const toggleSelect = (f: File_, folderId: string | null) => setSelectedFiles((m) => {
    const n = new Map(m)
    if (n.has(f.id)) n.delete(f.id); else n.set(f.id, { ...f, folderId })
    return n
  })

  /** a file the client could be shown in a group "Show" (the same checks as its own button; personal ones one by one) */
  const bulkShowable = (f: File_) => !f.staffOnly && !f.personal && !f.needsReview && f.listed && !!f.documentType && f.sharedWith == null

  const runBulk = async (action: 'show' | 'hide' | 'delete' | 'move') => {
    const list = Array.from(selectedFiles.values())
    if (!list.length) return
    const oids = new Set(list.map((f) => (f.folderId && folderOwner.current.get(f.folderId)) || ownerId))
    if (oids.size > 1) { toast.error('Select files of ONE client (or area) at a time.'); return }
    const oid = Array.from(oids)[0] ?? ownerId
    let targets = list
    let hideAfterMove = false
    let moveTo: { folderId: string; path: string } | null = null
    if (action === 'show') {
      // the counts are from what is on screen; each file is checked again on the server when it is done
      const ok = list.filter((f) => !f.clientVisible && bulkShowable(f))
      const already = list.filter((f) => f.clientVisible).length
      const skip = list.length - ok.length - already
      const a = await ask('bulk_show', `Show ${ok.length} ${ok.length === 1 ? 'file' : 'files'} to the client?`,
        <p>{ok.length} will be shown{already ? `; ${already} already shown` : ''}{skip ? `; ${skip} can't be shown in a group and are skipped (personal documents one by one from their own button; staff-only, "Needs review", untyped or unlinked files not at all)` : ''}.</p>,
        [{ key: 'go', label: `Show ${ok.length}`, tone: 'primary', disabled: ok.length === 0 }, { key: 'cancel', label: 'Cancel' }])
      if (a !== 'go' && a !== '__default__') return
      targets = ok
    } else if (action === 'hide') {
      // a file its workspace always shows can't be hidden from here — skipped, and said so
      const byWs = list.filter((f) => f.shownByWorkspace)
      const hideable = list.filter((f) => !f.shownByWorkspace)
      const shownNow = hideable.filter((f) => f.clientVisible).length
      const a = await ask('bulk_hide', `Hide ${hideable.length} ${hideable.length === 1 ? 'file' : 'files'} from the client?`,
        <p>{hideable.length} will be hidden from the client ({shownNow === hideable.length ? `all ${shownNow === 1 ? 'is' : 'are'} shown now` : `${shownNow} ${shownNow === 1 ? 'is' : 'are'} shown now; the others are already hidden`}).{byWs.length ? ` ${byWs.length} ${byWs.length === 1 ? 'is' : 'are'} always shown by ${byWs.length === 1 ? 'its' : 'their'} workspace and can't be hidden from here — skipped.` : ''}</p>,
        [{ key: 'go', label: `Hide ${hideable.length}`, tone: 'primary', disabled: hideable.length === 0 }, { key: 'cancel', label: 'Cancel' }])
      if (a !== 'go' && a !== '__default__') return
      targets = hideable // every other ticked file is hidden — also one shown after it was ticked
    } else if (action === 'delete') {
      const shown = list.filter((f) => f.clientVisible).length
      const a = await ask('bulk_delete', `Move ${list.length} ${list.length === 1 ? 'file' : 'files'} to the trash?`,
        <p>{shown ? `${shown} ${shown === 1 ? 'is' : 'are'} shown to the client and will disappear from their portal. ` : ''}Recoverable for 90 days from the Trash.</p>,
        [{ key: 'go', label: 'Move to trash', tone: 'danger' }, { key: 'cancel', label: 'Cancel' }])
      if (a !== 'go' && a !== '__default__') return
    } else {
      const r = await pick({ title: `Move ${list.length} ${list.length === 1 ? 'file' : 'files'} to…`, ownerId: oid ?? undefined, ownerLabel: ownerLabelOf(oid), mode: 'file' })
      setPicking(null)
      if (!r) return
      moveTo = { folderId: r.folderId, path: r.path }
      // files a workspace always shows can't be hidden — they move and stay visible (said in the question)
      const byWs = list.filter((f) => f.clientVisible && f.shownByWorkspace).length
      const shown = list.filter((f) => f.clientVisible && !f.shownByWorkspace).length
      if (shown) {
        const a = await ask('move_visible_file', 'The client can see this file',
          <p>{shown} of the {list.length} files {shown === 1 ? 'is' : 'are'} visible to the client. They are moving to <strong>{r.path}</strong>. Who can see a file goes with the file, not the folder.{byWs ? ` ${byWs} more ${byWs === 1 ? 'is' : 'are'} always shown by ${byWs === 1 ? 'its' : 'their'} workspace and stay${byWs === 1 ? 's' : ''} visible.` : ''}</p>,
          [{ key: 'keep', tone: 'primary' }, { key: 'hide' }, { key: 'cancel' }])
        if (a === 'cancel') return
        hideAfterMove = a === 'hide'
      }
    }
    setBulkBusy(true)
    let ok = 0
    const failed: string[] = []
    for (const f of targets) {
      try {
        // group: true → the server refuses a personal document (shown one by one, with its question)
        if (action === 'show') await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: true, group: true }, 'Could not show it.')
        if (action === 'hide') await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: false }, 'Could not hide it.')
        if (action === 'delete') await postJson(`/api/crm-store/browse/file/${f.id}/delete`, {}, 'Could not delete it.')
        if (action === 'move' && moveTo) {
          // always sent: the server knows where the file is NOW (it may have moved since it was ticked)
          await postJson(`/api/crm-store/browse/file/${f.id}/move`, { folderId: moveTo.folderId }, 'Could not move it.')
          if (hideAfterMove && !f.shownByWorkspace) await postJson(`/api/crm-store/browse/file/${f.id}/visibility`, { visible: false }, 'Moved, but could not hide it.')
        }
        ok++
      } catch (e) {
        failed.push(`${f.name} (${errMsg(e, 'failed')})`)
      }
    }
    setBulkBusy(false)
    const verb = { show: 'shown to the client', hide: 'hidden from the client', delete: 'moved to the trash', move: `moved to ${moveTo?.path ?? ''}` }[action]
    toast.success(`${ok} ${ok === 1 ? 'file' : 'files'} ${verb}`)
    if (failed.length) toast.error(`Not done: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? ' …' : ''}`)
    setSelectedFiles(new Map())
    await refreshAll()
    if (filterKind) void openFilter(filterKind)
  }

  // ───────────────────────────────────────── folders

  /** the questions before a folder move / delete when the client can see files inside (Part 16) */
  /**
   * The question before a folder move / delete when the client sees files inside (Part 16). Nothing changes
   * here: it returns WHAT to hide; the server hides only after all its own checks pass, in the same request.
   */
  const settleVisibleInside = async (f: Fold, action: 'move' | 'delete'): Promise<{ go: boolean; files: number; stillShown: number; hide: 'none' | 'all' | { ids: string[] } }> => {
    const s = await getJson<{ files: number; shown: number; list: { id: string; name: string; shown: boolean; byWorkspace?: string | null }[] }>(`/api/crm-store/browse/folder/${f.id}/summary`)
    if (s.shown === 0) return { go: true, files: s.files, stillShown: 0, hide: 'none' }
    // files a workspace always shows can't be hidden: listed as such, never offered in "hide"
    const locked = s.list.filter((x) => x.shown && x.byWorkspace)
    const visible = s.list.filter((x) => x.shown && !x.byWorkspace)
    const a = await ask('folder_with_visible_files', 'The client can see files in this folder',
      <>
        <p>{action === 'delete' ? 'Deleting' : 'Moving'} <strong>{f.name}</strong> touches {s.files} {s.files === 1 ? 'file' : 'files'}; <strong>{s.shown}</strong> {s.shown === 1 ? 'is' : 'are'} shown to the client:</p>
        <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-xs">{visible.slice(0, 40).map((x) => <li key={x.id}>{x.name}</li>)}{visible.length > 40 && <li>… and {visible.length - 40} more</li>}
          {locked.slice(0, 20).map((x) => <li key={x.id}>{x.name} <span className="text-zinc-500">— always shown by the {x.byWorkspace} workspace (it can&apos;t be hidden here{action === 'delete' ? '; deleting takes it off the portal' : ''})</span></li>)}</ul>
      </>,
      visible.length ? [{ key: 'all' }, { key: 'hide_first', tone: 'primary' }, { key: 'pick' }, { key: 'cancel' }] : [{ key: 'all', tone: 'primary' }, { key: 'cancel' }])
    if (a === 'cancel') return { go: false, files: s.files, stillShown: s.shown, hide: 'none' }
    if (a === 'hide_first') return { go: true, files: s.files, stillShown: locked.length, hide: 'all' }
    if (a === 'pick') {
      const chosen = new Set(visible.map((x) => x.id))
      const b = await ask('folder_with_visible_files_pick', 'Which ones should the client stop seeing?',
        <PickList items={visible} chosen={chosen} />,
        [{ key: 'go', label: 'Hide the ticked ones, then continue', tone: 'primary' }, { key: 'cancel', label: 'Cancel' }])
      if (b !== 'go' && b !== '__default__') return { go: false, files: s.files, stillShown: s.shown, hide: 'none' }
      return { go: true, files: s.files, stillShown: s.shown - chosen.size, hide: { ids: Array.from(chosen) } }
    }
    return { go: true, files: s.files, stillShown: s.shown, hide: 'none' }
  }

  const pickAndMoveFolder = async (f: Fold, parentId: string | null) => {
    setMenuFor(null)
    const oid = folderOwner.current.get(f.id) ?? ownerId
    if (!oid) return
    const r = await pick({ title: `Move the folder "${f.name}" into…`, ownerId: oid, ownerLabel: ownerLabelOf(oid), mode: 'folder', excludeFolderId: f.id, currentFolderId: parentId })
    setPicking(null)
    if (!r) return
    let tid: string | number | undefined
    try {
      const v = await settleVisibleInside(f, 'move')
      if (!v.go) return
      // a folder move can take several seconds (every file's CRM category follows) — say so while it runs
      tid = toast.loading(`Moving "${f.name}"…`)
      const m = await postJson<{ parentName: string }>(`/api/crm-store/browse/folder/${f.id}/move`, { toFolderId: r.folderId, hide: v.hide }, 'The folder could not be moved.')
      await refreshAll([r.folderId])
      toast.success(`Moved "${f.name}" into ${m.parentName}${v.hide !== 'none' ? ' (the files you chose are now hidden from the client)' : ''}`, { id: tid })
    } catch (e) {
      toast.error(errMsg(e, 'The folder could not be moved.'), tid ? { id: tid } : undefined)
    }
  }

  const deleteFolder = async (f: Fold) => {
    setMenuFor(null)
    let tid: string | number | undefined
    try {
      const v = await settleVisibleInside(f, 'delete')
      if (!v.go) return
      const a = await ask('delete_folder', 'Move this folder to the trash?',
        <p>Move <strong>{f.name}</strong> and its {v.files} {v.files === 1 ? 'file' : 'files'} to the trash?{v.stillShown > 0 ? ` ${v.stillShown} ${v.stillShown === 1 ? 'is' : 'are'} shown to the client and will disappear from their portal.` : ''} Recoverable for 90 days.</p>,
        [{ key: 'trash', label: 'Move to trash', tone: 'danger' }, { key: 'cancel', label: 'Cancel' }])
      if (a !== 'trash' && a !== '__default__') return
      tid = toast.loading(`Moving "${f.name}" to the trash…`)
      const r = await postJson<{ files: number }>(`/api/crm-store/browse/folder/${f.id}/delete`, { hide: v.hide }, 'The folder could not be deleted.')
      await refreshAll()
      toast.success(`"${f.name}" and ${r.files} ${r.files === 1 ? 'file' : 'files'} moved to the trash`, { id: tid })
    } catch (e) {
      toast.error(errMsg(e, 'The folder could not be deleted.'), tid ? { id: tid } : undefined)
    }
  }

  const doRenameFolder = async (f: Fold, value: string) => {
    if (renameDone.current) return
    renameDone.current = true
    setRenaming(null)
    if (!value.trim() || value.trim() === f.name) return
    const tid = toast.loading('Renaming…')
    try {
      const r = await postJson<{ name: string }>(`/api/crm-store/browse/folder/${f.id}/rename`, { name: value }, 'The folder could not be renamed.')
      await refreshAll()
      toast.success(`Folder renamed to "${r.name}"`, { id: tid })
    } catch (e) {
      toast.error(errMsg(e, 'The folder could not be renamed.'), { id: tid })
    }
  }

  /** open the inline "new folder" box under a folder — on the right tree, or in the LEFT tree (`left`) */
  const startNewFolder = (parentId: string, year?: boolean, left?: boolean, knownSiblings?: Fold[]) => {
    setMenuFor(null)
    if (left) {
      const node = tree[parentId] ?? Object.values(tree).find((t) => t.root?.id === parentId)
      const siblings = (knownSiblings ?? node?.folders ?? []).map((x) => x.name)
      setNewFolder({ parentId, siblings, year, left: true, value: year ? suggestYear(siblings) : '' })
      return
    }
    const siblings = (loaded[parentId]?.folders ?? (root?.folder?.id === parentId ? root.folders : [])).map((x) => x.name)
    setNewFolder({ parentId, siblings, year, value: year ? suggestYear(siblings) : '' })
    setExpanded((x) => new Set(x).add(parentId))
    if (!loaded[parentId] && root?.folder?.id !== parentId) loadKey(parentId)
  }

  /** the person whose storage a folder on screen (reached through "2. Contacts") belongs to */
  const personOfFolder = (folderId: string): Person | null => {
    const oid = folderOwner.current.get(folderId)
    if (!oid || oid === ownerId) return null
    return Object.values(loaded).flatMap((x) => x.people ?? []).find((p) => p.ownerId === oid) ?? null
  }

  const saveNewFolder = async () => {
    if (!newFolder) return
    const nf = newFolder
    const problem = folderNameProblem(nf.value, nf.siblings)
    if (problem) { toast.error(problem); return }
    let parentId = nf.parentId
    // Part 16: a folder made in a PERSON's storage from a company page shows in every company of theirs
    // (not from the left tree: there the folder is in the person's OWN storage, opened as such)
    const person = !nf.left && viaCompany.current.has(nf.parentId) ? personOfFolder(nf.parentId) : null
    if (person && !nf.year) {
      const others = person.companies.filter((c) => c !== root?.owner.label)
      const a = await ask('person_folder_from_company', "This folder goes into the person's own storage",
        <p><strong>{person.name}</strong> is in {person.companies.length > 0 ? person.companies.join(' and ') : 'this company'}; a folder in their storage {others.length > 0 ? `shows in ${person.companies.length === 2 ? 'both' : 'each of them'}` : 'shows on this company and on their own page'}.</p>,
        [{ key: 'person', label: `Create it in ${person.name}'s storage`, tone: 'primary' }, { key: 'company' }, { key: 'cancel' }])
      if (a === 'cancel') return
      if (a === 'company') {
        if (!ownerId) return
        const r = await pick({ title: `Where in ${root?.owner.label ?? 'this company'}?`, ownerId, ownerLabel: root?.owner.label, mode: 'folder' })
        setPicking(null)
        if (!r) return
        parentId = r.folderId
      }
    }
    setNewFolder(null)
    try {
      const r = nf.year
        ? await postJson<{ name: string }>(`/api/crm-store/browse/folder/${parentId}/tax-year`, { year: nf.value.trim() }, 'The tax-year folder could not be created.')
        : await postJson<{ name: string }>('/api/crm-store/browse/folder/create', { parentId, name: nf.value }, 'The folder could not be created.')
      toast.success(`Folder "${r.name}" created`)
      if (nf.left) {
        // open the parent in the left tree so the new folder is visible there
        const ownKey = Object.entries(tree).find(([, t]) => t.root?.id === parentId)?.[0]
        const key = ownKey ?? parentId
        setOpenTree((x) => new Set(x).add(key))
        openTreeRef.current = new Set(openTreeRef.current).add(key)
      } else {
        setExpanded((x) => new Set(x).add(parentId))
        if (!loaded[parentId]) await loadKey(parentId)
      }
      await refreshAll([parentId])
    } catch (e) {
      toast.error(errMsg(e, 'The folder could not be created.'))
    }
  }

  // ───────────────────────────────────────── upload

  const loadTypes = async () => {
    if (types) return types
    try {
      const t = (await getJson<{ types: DocType[] }>('/api/crm-store/browse/types')).types
      setTypes(t)
      return t
    } catch (e) {
      toast.error(errMsg(e, 'Could not load the document types.'))
      return null
    }
  }

  const openUpload = async (folderId?: string) => {
    setUploadOpen(true)
    setUpFolder(folderId ?? '')
    setUpPerson(''); setUpType(''); setUpName(''); setUpVisible(true)
    await loadTypes()
  }

  /** every folder on screen that can take a file, in tree order, with its depth (the upload's Folder list) */
  const folderOptions = (): Array<{ f: Fold; depth: number; owner: string; label: string }> => {
    const out: Array<{ f: Fold; depth: number; owner: string; label: string }> = []
    const walk = (list: Fold[], depth: number, prefix = '') => {
      for (const f of list) {
        if (f.trashed) continue
        out.push({ f, depth, owner: folderOwner.current.get(f.id) ?? ownerId ?? '', label: `${prefix}${f.name}` })
        const c = loaded[f.id]
        if (f.kind === 'contacts') {
          // each person's own folders opened through the company (the ones the company page may show)
          for (const p of c?.people ?? []) {
            const pc = loaded[personKey(p.contactId)]
            if (pc) walk([...pc.folders].sort(sortFolders), depth + 1, `${p.name} › `)
          }
          continue
        }
        if (c) walk([...c.folders].sort(sortFolders), depth + 1, prefix)
      }
    }
    if (root?.folder && root.folder.kind !== 'root') out.push({ f: root.folder, depth: 0, owner: ownerId ?? '', label: root.folder.name })
    walk(root?.folders ?? [], root?.folder && root.folder.kind !== 'root' ? 1 : 0)
    return out
  }
  const upOptions = folderOptions()
  const upFolderObj = upOptions.find((o) => o.f.id === upFolder)?.f ?? null
  const upIsContacts = upFolderObj?.kind === 'contacts'
  const ownerKind = root?.owner.kind ?? scopedKind
  const upTargetIsPerson = ownerKind === 'person' || (!!upFolderObj && viaCompany.current.has(upFolderObj.id))
  const upViaCompany = !!upFolderObj && viaCompany.current.has(upFolderObj.id)
  // a person's folder opened from a company page takes only the person's own documents (the server refuses the rest)
  const upTypes = (types ?? []).filter((t) => (upViaCompany ? t.personal : upTargetIsPerson ? true : upIsContacts ? t.personal : ownerKind === 'private' ? true : !t.personal))
  const upPeople = upFolderObj ? loaded[upFolderObj.id]?.people ?? [] : []
  // "Whose document?" needs the people of "2. Contacts": read them when the panel points there and they aren't on screen
  const peopleTried = useRef(new Set<string>())
  useEffect(() => {
    if (!upIsContacts || !upFolderObj || loaded[upFolderObj.id] || loadingFolders.has(upFolderObj.id)) return
    if (peopleTried.current.has(upFolderObj.id)) return // once per folder: a failed read is not retried in a loop
    peopleTried.current.add(upFolderObj.id)
    void loadKey(upFolderObj.id)
  }, [upIsContacts, upFolderObj, loaded, loadingFolders, loadKey])

  /** today's "Custom…" type: added once, then listed for everyone (catalog, with who added it) */
  const addCustomType = async () => {
    if (!upFolderObj) return
    setAddingType(true)
    try {
      const folderKind = upTargetIsPerson ? (upFolderObj.kind === 'person_tax' ? 'person_tax' : 'personal') : upFolderObj.kind
      const r = await postJson<{ slug: string; name: string; created: boolean }>('/api/crm-store/browse/types', { name: customName, folderKind }, 'The type could not be added.')
      const fresh = await getJson<{ types: DocType[] }>('/api/crm-store/browse/types')
      setTypes(fresh.types)
      setUpType(r.slug)
      setCustomName('')
      toast.success(r.created ? `New document type "${r.name}" added` : `"${r.name}" already exists — selected`)
    } catch (e) {
      toast.error(errMsg(e, 'The type could not be added.'))
    } finally {
      setAddingType(false)
    }
  }

  /**
   * The upload, with the questions the system can't answer itself (Part 16), in this order: a closed
   * company · which tax year · a prepared return filed or draft · the same name already here · the exact same
   * file stored elsewhere. Every question has a way out; nothing is saved until the answers are in.
   */
  /**
   * ONE upload through every question — used by the Upload panel and by files dragged in from the computer
   * (`batch`: several in a row — no panel close / refresh per file). Returns what happened to this file.
   */
  const doUploadWith = async (file: File, o: { folder: Fold | null; typeSlug: string; personId: string; displayName: string; visible: boolean; batch?: boolean; taxMemo?: Map<string, { folder: Fold; year: number | null }> }): Promise<UploadOutcome> => {
    const upFolderObj = o.folder, upType = o.typeSlug, upPerson = o.personId, upName = o.displayName, upVisible = o.visible
    const upIsContacts = upFolderObj?.kind === 'contacts'
    if (!ownerId || !upFolderObj) { toast.error('Choose the folder first.'); return 'failed' }
    if (!upType) { toast.error('Choose the document type first.'); return 'failed' }
    if (upIsContacts && !upPerson) { toast.error('Choose whose document this is first.'); return 'failed' }
    const type = (types ?? []).find((t) => t.slug === upType)
    let target = { ownerId: folderOwner.current.get(upFolderObj.id) ?? ownerId, folder: upFolderObj, via: viaCompany.current.has(upFolderObj.id) }
    let periodYear: number | null = null
    let filingAnswer: 'filed' | 'draft' | null = null
    let needsReview: string | null = null
    let displayName = upName
    const localUrl = URL.createObjectURL(file)
    if (!o.batch) setUploading(true)
    try {
      // 1. a closed or cancelled company
      if (root?.owner.closed && target.ownerId === ownerId) {
        const a = await ask('closed_company_upload', 'This company is closed or cancelled',
          <>
            <p><strong>{root.owner.label}</strong> is <strong>{root.owner.accountStatus ?? 'archived'}</strong>. Is this document really for it?</p>
            <MiniPreview src={localUrl} mimeType={file.type} label={file.name} sub="the file you are uploading" />
          </>,
          [{ key: 'store_here', tone: 'primary' }, { key: 'other_place' }, { key: 'business' }, { key: 'later' }])
        if (a === 'cancel') return 'cancelled' // closed the question: nothing is saved
        if (a === 'other_place' || a === 'business') {
          const nav = groups ?? (await getJson<{ groups: NavGroup[] }>('/api/crm-store/browse/navigation')).groups
          const businessId = nav.find((g) => g.key === 'business')?.owners[0]?.id
          if (a === 'business' && !businessId) throw new Error('The Business folders could not be found — please try again.')
          const r = await pick({ title: a === 'business' ? 'Where in the Business folders?' : 'Where does it belong?', mode: 'file', chooseOwner: a !== 'business', ownerId: a === 'business' ? businessId : undefined, ownerLabel: a === 'business' ? 'Business' : undefined })
          setPicking(null)
          if (!r) return 'cancelled'
          const info = await getJson<Contents>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(r.ownerId)}&folder=${encodeURIComponent(r.folderId)}`)
          if (!info.folder) return 'cancelled'
          target = { ownerId: r.ownerId, folder: info.folder, via: false }
        } else if (a === 'later') {
          needsReview = `Uploaded into ${root.owner.label} (${root.owner.accountStatus ?? 'closed'}) — check it belongs here`
        }
      }
      // 2. a tax form put in "Tax" itself, not in a year folder
      const memoKey = `tax:${target.folder.id}`
      const memo = o.taxMemo?.get(memoKey)
      if (memo && type && /_year$/.test(type.defaultFolderKind ?? '') && (target.folder.kind === 'tax' || target.folder.kind === 'person_tax')) {
        // a drag-in of several: the year answered for the first file of this folder is used for the rest
        target = { ...target, folder: memo.folder }
        periodYear = memo.year
      } else if (type && /_year$/.test(type.defaultFolderKind ?? '') && (target.folder.kind === 'tax' || target.folder.kind === 'person_tax')) {
        const askedFor = target.folder.id
        // read the year folders fresh (the target may not be open on screen)
        const taxNow = await getJson<Contents>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(target.ownerId)}&folder=${encodeURIComponent(target.folder.id)}${target.via ? '&via=company' : ''}`)
        const years = taxNow.folders.filter((f) => isYear(f.name) && !f.trashed).sort((x, y) => y.name.localeCompare(x.name))
        const suggestion = suggestYear(years.map((y) => y.name))
        const choiceLabel = questions?.tax_year_missing?.choices.year ?? 'Put it in'
        const a = await ask('tax_year_missing', 'Which tax year is this for?',
          <p>A <strong>{type.name}</strong> belongs in a year folder inside <strong>{target.folder.name}</strong>. {years.length ? `Year folders here: ${years.map((y) => y.name).join(', ')}.` : 'There is no year folder yet.'}</p>,
          [
            ...years.slice(0, 4).map((y, i) => ({ key: `y:${y.id}`, label: `${choiceLabel} ${y.name}`, tone: i === 0 ? 'primary' as const : 'plain' as const })),
            { key: 'new_year', label: `${questions?.tax_year_missing?.choices.new_year ?? 'New year folder'} ${suggestion}`, tone: years.length ? 'plain' : 'primary' },
            { key: 'other_place' }, { key: 'cancel' },
          ])
        if (a === 'cancel') return 'cancelled'
        if (a.startsWith('y:')) {
          const y = years.find((x) => `y:${x.id}` === a)!
          target = { ...target, folder: y }
          periodYear = Number(y.name)
        } else if (a === 'new_year') {
          const r = await postJson<{ id: string; name: string }>(`/api/crm-store/browse/folder/${target.folder.id}/tax-year`, { year: suggestion }, 'The year folder could not be created.')
          folderOwner.current.set(r.id, target.ownerId)
          if (target.via) viaCompany.current.add(r.id)
          target = { ...target, folder: { id: r.id, name: r.name, kind: target.folder.kind === 'tax' ? 'tax_year' : 'person_tax_year', trashed: false } }
          periodYear = Number(r.name)
        } else if (a === 'other_place') {
          const r = await pick({ title: 'Which folder?', ownerId: target.ownerId, ownerLabel: ownerLabelOf(target.ownerId), mode: 'file', currentFolderId: target.folder.id })
          setPicking(null)
          if (!r) return 'cancelled'
          const info = await getJson<Contents>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(r.ownerId)}&folder=${encodeURIComponent(r.folderId)}`)
          if (!info.folder) return 'cancelled'
          target = { ...target, folder: info.folder }
        }
        o.taxMemo?.set(`tax:${askedFor}`, { folder: target.folder, year: periodYear })
      } else if (target.folder.kind === 'tax_year' || target.folder.kind === 'person_tax_year' || isYear(target.folder.name)) {
        periodYear = isYear(target.folder.name) ? Number(target.folder.name) : null
      }
      // 3. a prepared tax return — filed or draft
      if (type?.draftNeverVisible && !needsReview) {
        const a = await ask('prepared_tax_return', 'Is this the filed return or a draft?',
          <>
            <MiniPreview src={localUrl} mimeType={file.type} label={file.name} sub="the first pages — check the signature / filing marks" />
            <p>A draft is never shown to the client until it is marked filed.</p>
          </>,
          [{ key: 'filed' }, { key: 'draft', tone: 'primary' }, { key: 'later' }])
        if (a === 'cancel') return 'cancelled' // closed the question: nothing is saved
        if (a === 'filed') filingAnswer = 'filed'
        else if (a === 'later') needsReview = 'Prepared return — filed or draft not decided yet'
        else filingAnswer = 'draft'
      }
      // 4. the same name already in that folder, different content
      const name = finalUploadName(file.name, displayName)
      // where the file will really land: through "2. Contacts" it goes into that person's "Personal documents"
      let landsIn = { ownerId: target.ownerId, folderId: target.folder.id, via: target.via }
      if (target.folder.kind === 'contacts') {
        // the people list is read fresh when it isn't on screen — never skip the same-name check for want of it
        const peopleHere = loaded[target.folder.id]?.people
          ?? (await getJson<Contents>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(target.ownerId)}&folder=${encodeURIComponent(target.folder.id)}`)).people ?? []
        const person = peopleHere.find((pp) => pp.contactId === upPerson)
        if (!person) throw new Error("That person is not listed in this company any more — refresh and choose whose document it is again.")
        // a person with no storage yet has no files to clash with: the server makes their storage on this first upload
        const top = person?.ownerId ? await getJson<Contents>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(person.ownerId)}&via=company`) : null
        const personal = top?.folders.find((x) => x.kind === 'personal')
        landsIn = person?.ownerId && personal ? { ownerId: person.ownerId, folderId: personal.id, via: true } : { ownerId: '', folderId: '', via: false }
      }
      const here = landsIn.folderId
        ? await getJson<Contents>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(landsIn.ownerId)}&folder=${encodeURIComponent(landsIn.folderId)}${landsIn.via ? '&via=company' : ''}`)
        : null
      const sha = await sha256OfFile(file)
      const same = here?.files.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (same && !(sha && same.sha256 === sha)) {
        const suggestion = keepBothName(name, (here?.files ?? []).map((x) => x.name))
        const a = await ask('same_name_different_content', 'A file with this name is already here',
          <div className="flex flex-col gap-2 sm:flex-row">
            <MiniPreview src={`/api/crm-store/browse/file/${same.id}`} mimeType={same.mimeType} label={`Already here: ${same.name}`} sub={`${fmtDate(same.updatedAt)} · ${fmtSize(same.size)}`} />
            <MiniPreview src={localUrl} mimeType={file.type} label={`New: ${name}`} sub={`${fmtSize(file.size)} · from your computer`} />
          </div>,
          [{ key: 'replace' }, { key: 'keep_both', label: `${questions?.same_name_different_content?.choices.keep_both ?? 'Keep both — save the new one as'} "${suggestion}"`, tone: 'primary' }, { key: 'cancel' }])
        if (a === 'cancel') return 'cancelled'
        if (a === 'keep_both') displayName = suggestion
      } else if (!same && sha) {
        // 5. the exact same file already stored under another name / somewhere else
        const hits = (await getJson<{ files: { fileId: string; name: string; ownerId: string; where: string; mimeType: string | null }[] }>(`/api/crm-store/browse/identical?sha=${sha}`)).files
        if (hits.length > 0) {
          // the copy in THIS storage first; a copy in another client's storage can never be renamed from here
          const h = hits.find((x) => x.ownerId === (landsIn.ownerId || target.ownerId)) ?? hits[0]
          const sameStorage = h.ownerId === (landsIn.ownerId || target.ownerId)
          const a = await ask('identical_elsewhere', 'This exact file is already stored',
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <MiniPreview src={`/api/crm-store/browse/file/${h.fileId}`} mimeType={h.mimeType} label={`Already stored: ${h.name}`} sub={h.where} />
                <MiniPreview src={localUrl} mimeType={file.type} label={`New: ${name}`} sub={`into ${target.folder.name}`} />
              </div>
              {!sameStorage && <p>The copy already stored belongs to <strong>another storage</strong> ({h.where.split(' › ')[0]}). If this document is also for {target.folder.name}, add it here.</p>}
              {hits.length > 1 && <p className="text-xs text-zinc-500">Also stored at: {hits.filter((x) => x !== h).slice(0, 4).map((x) => x.where).join(' · ')}{hits.length > 5 ? ' …' : ''}</p>}
            </>,
            [
              { key: 'dont_add', tone: sameStorage ? 'primary' : 'plain' },
              ...(sameStorage ? [{ key: 'rename_existing', disabled: h.name.toLowerCase() === name.toLowerCase() }] : []),
              { key: 'second_copy', tone: sameStorage ? 'plain' as const : 'primary' as const },
              { key: 'cancel' },
            ])
          if (a === 'dont_add' || a === 'cancel') { if (a === 'dont_add') toast.message(`Kept the existing copy: ${h.where}`); return 'cancelled' }
          if (a === 'rename_existing' && sameStorage) {
            const r = await postJson<{ name: string }>(`/api/crm-store/browse/file/${h.fileId}/rename`, { name }, 'The existing file could not be renamed.')
            toast.success(`The existing file is now called "${r.name}" — nothing new was added`)
            if (!o.batch) { setUploadOpen(false); await refreshAll() }
            return 'saved'
          }
        }
      }
      // the save
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120)
      const storagePath = `${STAGING_PREFIX}${target.ownerId}/${Date.now()}_${safe}`
      const sig = await postJson<{ signedUrl?: string }>('/api/storage/upload',
        { bucket: 'onboarding-uploads', path: storagePath, contentType: file.type }, 'Could not prepare the upload — please try again.')
      if (!sig.signedUrl) throw new Error('Could not prepare the upload — please try again.')
      const put = await fetch(sig.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      if (!put.ok) throw new Error(`The file could not be sent (status ${put.status}) — please try again.`)
      const r = await postJson<{ write: string; name: string; visible: boolean; identity?: string | null }>('/api/crm-store/browse/upload', {
        ownerId: target.ownerId, folderId: target.folder.id, storagePath, fileName: file.name, mimeType: file.type, documentType: upType,
        displayName: displayName || undefined, visible: upVisible && !needsReview, periodYear, filingAnswer, needsReview,
        ...(target.folder.kind === 'contacts' ? { personContactId: upPerson } : {}),
        ...(target.via && ownerId ? { viaCompanyOwnerId: ownerId } : {}),
      }, 'The upload could not be saved — please try again.')
      toast.success(
        r.write === 'versioned' ? `"${r.name}" saved as a new version (the old copy is under Versions) — ${r.visible ? 'the client can see it' : 'hidden from the client'}`
          : r.write === 'unchanged' ? `"${r.name}" is identical to the current copy — nothing changed`
            : `"${r.name}" uploaded${needsReview ? ' — marked "Needs review", hidden from the client' : r.visible ? ' and shared with the client' : ' (hidden from the client)'}`,
      )
      if (r.identity) toast.message(r.identity)
      // saved into My files › Shared with staff: ask straight away who may open it (nobody until ticked) —
      // one file at a time only; after a drag-in of several the panel says so once
      if (!o.batch && root?.owner.kind === 'private' && r.write === 'created') {
        const after = await getJson<Contents>(`/api/crm-store/browse/folder?owner=${encodeURIComponent(target.ownerId)}&folder=${encodeURIComponent(target.folder.id)}`).catch(() => null)
        const saved = after?.files.find((x) => x.name === r.name)
        if (saved && saved.sharedWith != null) void openSharing(saved)
      }
      if (!o.batch) { setUploadOpen(false); await refreshAll([target.folder.id]) }
      return 'saved'
    } catch (e) {
      toast.error(errMsg(e, 'The upload failed — please try again.'))
      return 'failed'
    } finally {
      URL.revokeObjectURL(localUrl)
      setAsking(null)
      if (!o.batch) setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const doUpload = (file: File) => doUploadWith(file, { folder: upFolderObj, typeSlug: upType, personId: upPerson, displayName: upName, visible: upVisible })

  const onDropInto = (folder: Fold, where: string) => {
    setDropOn(null)
    const d = dragRef.current
    dragRef.current = null
    setDragFile(null)
    if (!d || d.from === folder.id) return
    const f = [...(root?.files ?? []), ...Object.values(loaded).flatMap((c) => c.files)].find((x) => x.id === d.id)
    if (!f) return
    const fromOwner = d.from ? folderOwner.current.get(d.from) ?? ownerId : ownerId
    if ((folderOwner.current.get(folder.id) ?? ownerId) !== fromOwner) { toast.error("A file can only be moved within the same company's or person's storage."); return }
    moveFileTo(f, folder.id, where)
  }

  // ───────────────────────────────────────── rows

  const fileRow = (f: File_, inFolder: Fold | null, depth: number) => {
    const Icon = fileIcon(f.mimeType)
    const busy = busyFiles.has(f.id)
    const canShare = !f.staffOnly && f.state === 'live' && (f.listed || f.clientVisible) && f.filingStatus !== 'draft'
      && (f.clientVisible || (!!f.documentType && !(f.personal && !f.inPersonStorage)))
    const internal = ownerKind === 'business' || ownerKind === 'private'
    const cantShowWhy = f.filingStatus === 'draft' ? 'A draft return — never shown to the client until it is marked filed (menu → Mark filed)'
      : f.staffOnly ? 'Staff only — it holds other people\'s personal data and is never shown to a client'
      : internal ? 'Internal folders — never shown to a client'
        : !f.listed ? 'Not linked to the CRM list — the client cannot see it'
          : !f.documentType ? 'It needs a document type before it can be shown'
            : "A person's document can only be shown from their own storage"
    return (
      <li key={f.id}
        draggable={!renaming}
        onDragStart={() => { const d = { id: f.id, from: inFolder?.id ?? null }; dragRef.current = d; setDragFile(d) }}
        onDragEnd={() => { setDragFile(null); setDropOn(null) }}
        className="group relative flex flex-wrap items-center gap-2 py-1.5 text-sm hover:bg-zinc-50/70" style={{ paddingLeft: `${depth * 20 + 22}px` }}>
        <input type="checkbox" aria-label={`Select ${f.name}`} checked={selectedFiles.has(f.id)} onChange={() => toggleSelect(f, inFolder?.id ?? null)}
          className={`h-3.5 w-3.5 shrink-0 ${selectedFiles.size ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`} />
        <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
        {renaming?.id === f.id && !renaming.folder ? (
          <input autoFocus value={renaming.value} onChange={(e) => setRenaming({ id: f.id, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') doRenameFile(f, renaming.value); if (e.key === 'Escape') { renameDone.current = true; setRenaming(null) } }}
            onBlur={() => doRenameFile(f, renaming.value)}
            className="min-w-0 flex-1 rounded border border-blue-300 px-1.5 py-0.5 text-sm" />
        ) : (
          <button type="button" onClick={() => setPreview(f)} className="min-w-[12rem] flex-1 truncate text-left hover:underline">{f.name}</button>
        )}
        {f.needsReview && (
          <FastTooltip label={f.needsReview}><span><Badge tone="red"><AlertTriangle className="h-3 w-3" />Needs review</Badge></span></FastTooltip>
        )}
        {/* ONE control: it shows whether the client can see the file, and a click on it switches it */}
        {f.shownByWorkspace && f.clientVisible ? (
          <FastTooltip label={`Always shown to the client by the ${f.shownByWorkspace} workspace — it can't be hidden from here`}>
            <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
              <Lock className="h-3 w-3" />Client can see
            </span>
          </FastTooltip>
        ) : canShare && !internal ? (
          <FastTooltip label={f.clientVisible ? 'Click to hide it from the client' : 'Click to show it to the client'}>
            <button type="button" onClick={() => toggleVisible(f)} disabled={busy}
              aria-label={f.clientVisible ? 'Client can see — click to hide' : 'Hidden from client — click to show'}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-50 ${f.clientVisible
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100'}`}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : f.clientVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {f.clientVisible ? 'Client can see' : 'Hidden from client'}
            </button>
          </FastTooltip>
        ) : (
          <FastTooltip label={cantShowWhy}>
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500"><Lock className="h-3 w-3" />Can&apos;t be shown</span>
          </FastTooltip>
        )}
        {f.sharedWith != null && (
          <FastTooltip label="Choose which staff can open and download it">
            <button type="button" onClick={() => openSharing(f)}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${f.sharedWith.length ? 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100' : 'border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100'}`}>
              <User className="h-3 w-3" />{f.sharedWith.length ? `Shared with ${f.sharedWith.length}` : 'Not shared'}
            </button>
          </FastTooltip>
        )}
        {f.filingStatus === 'draft' && <Badge tone="gray">Draft</Badge>}
        {(
          <FastTooltip label={f.documentType ? 'The document type — click to change it' : 'Give this file its document type'}>
            <button type="button" onClick={(e) => { e.stopPropagation(); setTyping(f) }}
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] ${f.documentType ? 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50' : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'}`}>
              {f.documentType ? typeNameOf(f.documentType) : 'Needs a type'}
            </button>
          </FastTooltip>
        )}
        {ai.available && <AiMarkChip m={ai.marks[f.id]} onClick={() => setAiFile(f.id)} />}
        {!f.listed && !internal && <Badge tone="amber">Not linked — client can&apos;t see it</Badge>}
        {f.versions > 1 && (
          <div className="relative">
            <FastTooltip label="See and open every saved copy">
              <button type="button" onClick={(e) => { e.stopPropagation(); openVersions(f.id) }}
                className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700 hover:bg-blue-100">
                <Layers className="h-3 w-3" />Versions ({f.versions})
              </button>
            </FastTooltip>
            {versionsFor === f.id && (
              <div className="absolute left-0 z-20 mt-1 w-80 rounded-md border border-zinc-200 bg-white py-1 text-xs shadow-lg" onClick={(e) => e.stopPropagation()}>
                <p className="px-3 py-1 text-[11px] text-zinc-500">Each time a file with this name was uploaded again (newest first):</p>
                {versions === null && <p className="px-3 py-1.5 text-zinc-500">Loading…</p>}
                {(versions ?? []).map((v) => (
                  <div key={v.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50">
                    <span className="font-medium">v{v.versionNo}</span>
                    <span className="text-zinc-500">{fmtDate(v.createdAt)} · {fmtSize(v.size)}{v.by ? ` · ${v.by}` : ''}</span>
                    {v.current && <Badge tone="green">current</Badge>}
                    <span className="flex-1" />
                    <button type="button" className="text-blue-700 hover:underline"
                      onClick={() => { setVersionsFor(null); setPreviewVersion({ file: { ...f, mimeType: v.mimeType ?? f.mimeType }, src: `/api/crm-store/browse/file/${f.id}/versions?open=${v.id}`, title: `${f.name} — version ${v.versionNo}${v.current ? ' (current)' : ''}` }) }}>
                      View
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="text-xs text-zinc-400">{[fmtSize(f.size), fmtDate(f.updatedAt)].filter(Boolean).join(' · ')}</span>
        {f.docId && (
          <FastTooltip label="Read scanned text"><button type="button" aria-label="Read scanned text" onClick={() => setOcrDocId(f.docId)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><ScanText className="h-3.5 w-3.5" /></button></FastTooltip>
        )}
        <div className="relative">
          <FastTooltip label="More"><button type="button" aria-label="More" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === f.id ? null : f.id) }}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><MoreHorizontal className="h-4 w-4" /></button></FastTooltip>
          {menuFor === f.id && (
            <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
              <MenuItem icon={Search} label="Preview" onClick={() => { setMenuFor(null); setPreview(f) }} />
              {ai.available && f.state === 'live' && <MenuItem icon={ScanText} label="Check this file" onClick={() => { setMenuFor(null); setAiFile(f.id) }} />}
              <MenuItem icon={Layers} label="Details" onClick={() => { void openDetails(f.id) }} />
              <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenuFor(null); renameDone.current = false; setRenaming({ id: f.id, value: f.name.replace(/\.[A-Za-z0-9]{1,8}$/, '') }) }} />
              <MenuItem icon={FolderInput} label="Move to…" onClick={() => pickAndMoveFile(f, inFolder)} />
              <MenuItem icon={Tag} label={f.documentType ? 'Change type…' : 'Set type…'} onClick={() => { setMenuFor(null); setTyping(f) }} />
              {f.needsReview && <MenuItem icon={Check} label="Mark reviewed" onClick={() => markReviewed(f)} />}
              {f.filingStatus === 'draft' && !f.needsReview && <MenuItem icon={Check} label="Mark filed" onClick={() => markFiled(f)} />}
              <MenuItem icon={Trash2} label="Delete" danger onClick={() => doDeleteFile(f)} />
            </div>
          )}
        </div>
      </li>
    )
  }

  const newFolderBox = (parentId: string, depth: number, left = false) => {
    if (newFolder?.parentId !== parentId || !!newFolder.left !== left) return null
    const problem = newFolder.value ? folderNameProblem(newFolder.value, newFolder.siblings) : null
    const badYear = newFolder.year && !/^(19|20)\d{2}$/.test(newFolder.value.trim())
    return (
      <li className="py-1.5" style={{ paddingLeft: `${depth * 20 + 22}px` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2">
          <FolderPlus className="h-4 w-4 text-amber-500" />
          <input autoFocus value={newFolder.value} onChange={(e) => setNewFolder({ ...newFolder, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !problem && !badYear) saveNewFolder(); if (e.key === 'Escape') setNewFolder(null) }}
            placeholder={newFolder.year ? 'Year, e.g. 2025' : 'Folder name'} className="w-56 rounded border border-blue-300 px-1.5 py-0.5 text-sm" />
          <button type="button" disabled={!!problem || !newFolder.value.trim() || !!badYear} onClick={saveNewFolder}
            className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white disabled:opacity-50">{newFolder.year ? 'Create year folder' : 'Create folder'}</button>
          <button type="button" onClick={() => setNewFolder(null)} className="text-xs text-zinc-500 hover:underline">Cancel</button>
        </div>
        <p className={`mt-1 text-[11px] ${problem || badYear ? 'text-red-600' : 'text-zinc-400'}`}>
          {badYear ? 'Four digits, e.g. 2025.' : problem ?? '1–255 characters · no / or \\ · no two folders with the same name here'}
        </p>
      </li>
    )
  }

  const folderNode = (f: Fold, depth: number, parentId: string | null, trail: string[]): React.ReactNode => {
    const isOpen = expanded.has(f.id)
    const c = loaded[f.id]
    const busy = loadingFolders.has(f.id)
    const canDrop = !!dragFile && f.kind !== 'contacts' && f.kind !== 'root' && dragFile.from !== f.id
    const subs = c ? [...c.folders].sort(sortFolders) : []
    const shown = c ? c.files.filter((x) => x.clientVisible).length : 0
    const isTax = f.kind === 'tax' || f.kind === 'person_tax'
    const where = [...trail, f.name].join(' › ')
    return (
      <li key={f.id}>
        <div
          onDragOver={(e) => { if (canDrop || (isComputerDrag(e) && f.kind !== 'root' && !f.trashed)) { e.preventDefault(); e.stopPropagation(); setDropOn(f.id) } }}
          onDragLeave={() => setDropOn((d) => (d === f.id ? null : d))}
          onDrop={(e) => { if (isComputerDrag(e)) { void onComputerDrop(e, f); return } e.preventDefault(); e.stopPropagation(); if (canDrop) onDropInto(f, where) }}
          className={`group relative flex items-center gap-1 py-1.5 text-sm hover:bg-zinc-50 ${dropOn === f.id ? 'rounded bg-blue-50 ring-1 ring-blue-300' : ''} ${selected === f.id ? 'bg-zinc-50' : ''}`} style={{ paddingLeft: `${depth * 20}px` }}>
          {renaming?.id === f.id && renaming.folder && !renaming.left ? (
            <input autoFocus value={renaming.value} onChange={(e) => setRenaming({ id: f.id, value: e.target.value, folder: true })}
              onKeyDown={(e) => { if (e.key === 'Enter') doRenameFolder(f, renaming.value); if (e.key === 'Escape') { renameDone.current = true; setRenaming(null) } }}
              onBlur={() => doRenameFolder(f, renaming.value)}
              className="ml-6 min-w-0 flex-1 rounded border border-blue-300 px-1.5 py-0.5 text-sm" />
          ) : (
            <button type="button" onClick={() => toggleKey(f.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={isOpen}>
              {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />}
              {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" /> : <Folder className="h-4 w-4 shrink-0 text-amber-500" />}
              <span className="truncate font-medium text-zinc-800">{f.name}</span>
              {c && f.kind !== 'contacts' && (
                <span className="text-xs text-zinc-400">{c.files.length} {c.files.length === 1 ? 'file' : 'files'}{shown > 0 ? ` · ${shown} shown to client` : ''}</span>
              )}
              {c && f.kind === 'contacts' && <span className="text-xs text-zinc-400">{(c.people ?? []).length} {(c.people ?? []).length === 1 ? 'person' : 'people'}</span>}
              {/* open but not read yet: say so, never look like an empty folder */}
              {isOpen && !c && !busy && <span className="inline-flex items-center gap-1 text-xs text-zinc-400"><Loader2 className="h-3 w-3 animate-spin" />Loading…</span>}
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
            </button>
          )}
          {!f.trashed && (
            <div className="mr-1 hidden items-center gap-1 group-hover:flex">
              {f.kind !== 'root' && (
                <button type="button" onClick={() => openUpload(f.id)} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50">
                  <Upload className="h-3.5 w-3.5" />Upload here
                </button>
              )}
              {f.kind !== 'contacts' && (
                <button type="button" onClick={() => startNewFolder(f.id)} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50">
                  <FolderPlus className="h-3.5 w-3.5" />Folder
                </button>
              )}
              {f.kind !== 'contacts' && (
                <FastTooltip label="Download this folder as a zip (the download is recorded)">
                  <button type="button" onClick={(e) => { e.stopPropagation(); void downloadZip(f) }}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50">
                    <Download className="h-3.5 w-3.5" />Zip
                  </button>
                </FastTooltip>
              )}
              {isTax && (
                <button type="button" onClick={() => startNewFolder(f.id, true)} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50">
                  <CalendarPlus className="h-3.5 w-3.5" />New tax year
                </button>
              )}
            </div>
          )}
          {!f.locked && !f.trashed && (
            <div className="relative">
              <FastTooltip label="Folder actions"><button type="button" aria-label="Folder actions" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === `folder:${f.id}` ? null : `folder:${f.id}`) }}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><MoreHorizontal className="h-4 w-4" /></button></FastTooltip>
              {menuFor === `folder:${f.id}` && (
                <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
                  <MenuItem icon={FolderPlus} label="New folder inside" onClick={() => startNewFolder(f.id)} />
                  <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenuFor(null); renameDone.current = false; setRenaming({ id: f.id, value: f.name, folder: true }) }} />
                  <MenuItem icon={FolderInput} label="Move to…" onClick={() => pickAndMoveFolder(f, parentId)} />
                  <MenuItem icon={Trash2} label="Delete" danger onClick={() => deleteFolder(f)} />
                </div>
              )}
            </div>
          )}
          {f.locked && <FastTooltip label="A fixed folder — it can't be renamed, moved or deleted"><Lock className="mr-1 h-3.5 w-3.5 text-zinc-300" /></FastTooltip>}
        </div>
        {isOpen && c && (
          <ul
            onDragOver={(e) => { if (canDrop || (isComputerDrag(e) && f.kind !== 'root' && !f.trashed)) { e.preventDefault(); e.stopPropagation(); setDropOn(f.id) } }}
            onDrop={(e) => { if (isComputerDrag(e)) { void onComputerDrop(e, f); return } e.preventDefault(); e.stopPropagation(); if (canDrop) onDropInto(f, where) }}>
            {newFolderBox(f.id, depth + 1)}
            {f.kind === 'contacts'
              ? (c.people ?? []).map((p) => personNode(p, depth + 1, [...trail, f.name]))
              : subs.map((sf) => folderNode(sf, depth + 1, f.id, [...trail, f.name]))}
            {sortFiles(c.files).map((file) => fileRow(file, f, depth + 1))}
            {f.kind === 'contacts' && (c.people ?? []).length === 0 && (
              <li className="py-1.5 text-xs italic text-zinc-400" style={{ paddingLeft: `${(depth + 1) * 20 + 22}px` }}>No people are linked to this company.</li>
            )}
            {f.kind !== 'contacts' && c.folders.length === 0 && c.files.length === 0 && newFolder?.parentId !== f.id && (
              <li className="py-1.5 text-xs italic text-zinc-400" style={{ paddingLeft: `${(depth + 1) * 20 + 22}px` }}>Empty folder</li>
            )}
          </ul>
        )}
      </li>
    )
  }

  /** one person inside a company's "2. Contacts": their own storage, opened through the company */
  const personNode = (p: Person, depth: number, trail: string[]): React.ReactNode => {
    const key = personKey(p.contactId)
    const isOpen = expanded.has(key)
    const c = loaded[key]
    const others = p.companies.filter((x) => x !== root?.owner.label)
    return (
      <li key={key}>
        <div className="group flex items-center gap-1 py-1.5 text-sm hover:bg-zinc-50" style={{ paddingLeft: `${depth * 20}px` }}>
          <button type="button" onClick={() => p.ownerId && toggleKey(key)} disabled={!p.ownerId} className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default" aria-expanded={isOpen}>
            {p.ownerId ? (isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />) : <span className="w-4" />}
            <User className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="truncate font-medium text-zinc-800">{p.name}</span>
            {others.length > 0 && <span className="truncate text-xs text-zinc-400">also in {others.join(', ')}</span>}
            {!p.ownerId && <span className="text-xs italic text-zinc-400">no documents yet</span>}
            {loadingFolders.has(key) && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
          </button>
          {c?.folder && (
            <button type="button" onClick={() => startNewFolder(c.folder!.id)} className="mr-1 hidden items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs hover:bg-zinc-50 group-hover:inline-flex">
              <FolderPlus className="h-3.5 w-3.5" />Folder
            </button>
          )}
        </div>
        {isOpen && c && (
          <ul>
            {c.folder && newFolderBox(c.folder.id, depth + 1)}
            {[...c.folders].sort(sortFolders).map((sf) => folderNode(sf, depth + 1, c.folder?.id ?? null, [...trail, p.name]))}
            {sortFiles(c.files).map((file) => fileRow(file, c.folder, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  // ───────────────────────────────────────── page

  // the right side shows the storage's top, or the ONE folder picked on the left / in the path
  const view: Contents | null = focus && loaded[focus] && !loaded[focus].folder?.trashed ? loaded[focus] : root
  const viewFolder = view?.folder ?? null
  const topFolders = view && viewFolder?.kind !== 'contacts' ? [...view.folders].sort(sortFolders) : []
  const allOpen = topFolders.length > 0 && topFolders.every((f) => expanded.has(f.id))
  const totalFiles = (view?.files.length ?? 0) + topFolders.reduce((n, f) => n + (loaded[f.id]?.files.length ?? 0), 0)
  const groupOf = (groups ?? []).find((g) => g.owners.some((o) => o.id === ownerId))
  const pathKey = focus ?? selected
  const selPath = pathKey && loaded[pathKey] ? loaded[pathKey].path.filter((x) => x.kind !== 'root' && x.kind !== 'business_root' && x.kind !== 'private_root') : []
  const selPerson = selected?.startsWith('person:') ? Object.values(loaded).flatMap((x) => x.people ?? []).find((p) => personKey(p.contactId) === selected) : null
  // each step of the path: its label and, when it is a place you can go to, what a click opens
  const crumbs: Array<{ label: string; go?: () => void }> = [
    ...(scopedOwnerId ? [] : [{ label: 'Storage' }, ...(groupOf && groupOf.section === 'clients' ? [{ label: groupOf.label }] : [])]),
    ...(root?.owner.label ? [{ label: root.owner.label, go: () => { setFocus(null); setSelected(null) } }] : []),
    ...(selPerson ? [{ label: '2. Contacts' }, { label: selPerson.name }]
      : pathKey && personOfFolder(pathKey)
        // a person's folder reached through "2. Contacts": say whose it is; never jump into their own storage from here
        ? [{ label: '2. Contacts' }, { label: personOfFolder(pathKey)!.name }, ...selPath.map((x) => ({ label: x.name }))]
        : selPath.map((x) => ({ label: x.name, go: ownerId && (folderOwner.current.get(x.id) ?? ownerId) === ownerId ? () => { void selectFolder(ownerId, x.id) } : undefined }))),
  ]

  const right = (
    <div className={`rounded-xl border border-zinc-200 bg-white p-4 ${scopedOwnerId ? '' : 'min-h-[70vh] self-start'}`} onClick={() => { if (menuFor) setMenuFor(null); if (versionsFor) setVersionsFor(null) }}>
      {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {sharedView && (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-800">Shared with me</span>
            <span className="text-xs text-zinc-400">files the owners shared with you — open or download</span>
          </div>
          {sharedFiles === null && <p className="text-sm text-zinc-500">Loading…</p>}
          {sharedFiles && sharedFiles.length === 0 && <p className="text-sm text-zinc-500">Nothing has been shared with you yet.</p>}
          <ul className="divide-y divide-zinc-50">
            {(sharedFiles ?? []).map((sf) => {
              const Icon = fileIcon(sf.mimeType)
              const asFile: File_ = { id: sf.id, name: sf.name, documentType: null, state: 'live', published: false, clientVisible: false, staffOnly: false, personal: false, versions: 1, size: sf.size, mimeType: sf.mimeType, updatedAt: sf.updatedAt, listed: false, personName: null, inPersonStorage: false, docId: null }
              return (
                <li key={sf.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                  <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
                  <button type="button" onClick={() => setPreview(asFile)} className="min-w-0 flex-1 truncate text-left hover:underline">{sf.name}</button>
                  <span className="text-xs text-zinc-400">{sf.where}</span>
                  <span className="text-xs text-zinc-400">{[fmtSize(sf.size), `shared ${fmtDate(sf.sharedAt)}`].filter(Boolean).join(' · ')}</span>
                  <a href={`/api/crm-store/browse/file/${sf.id}`} download className="text-xs text-blue-700 hover:underline">Download</a>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {!sharedView && !root && !error && <p className="text-sm text-zinc-500">{scopedOwnerId || ownerId ? 'Loading…' : 'Pick a client, Business or My files on the left.'}</p>}
      {!sharedView && root && !root.folder && <p className="text-sm text-zinc-500">No folders yet.</p>}
      {!sharedView && root?.folder && (
        <div className="min-h-[60vh]"
          onDragOver={(e) => { if (viewFolder && isComputerDrag(e) && viewFolder.kind !== 'root' && viewFolder.kind !== 'contacts') { e.preventDefault(); setDropOn(`view:${viewFolder.id}`) } }}
          onDragLeave={() => setDropOn((d) => (d?.startsWith('view:') ? null : d))}
          onDrop={(e) => { if (viewFolder && isComputerDrag(e) && viewFolder.kind !== 'root' && viewFolder.kind !== 'contacts') void onComputerDrop(e, viewFolder) }}>
          <nav aria-label="Path" className="mb-2 flex flex-wrap items-center gap-1 text-xs text-zinc-500">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="inline-flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3" />}
                {c.go && i < crumbs.length - 1
                  ? <button type="button" onClick={c.go} className="hover:text-zinc-800 hover:underline">{c.label}</button>
                  : <span className={i === crumbs.length - 1 ? 'font-medium text-zinc-800' : ''}>{c.label}</span>}
              </span>
            ))}
            {root.owner.closed && <Badge tone="gray">{root.owner.accountStatus ?? 'archived'}</Badge>}
          </nav>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-zinc-800">{viewFolder?.name ?? root.folder.name}</span>
            {viewFolder?.kind !== 'contacts' && <span className="text-xs text-zinc-400">{topFolders.some((f) => expanded.has(f.id) && !loaded[f.id]) ? 'Loading…' : `${totalFiles} ${totalFiles === 1 ? 'file' : 'files'}`}</span>}
            <span className="flex-1" />
            {viewFolder && viewFolder.kind !== 'contacts' && <button type="button" onClick={(e) => { e.stopPropagation(); startNewFolder(viewFolder.id) }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50">
              <FolderPlus className="h-3.5 w-3.5" />New folder
            </button>}
            <button type="button" onClick={(e) => { e.stopPropagation(); if (uploadOpen) setUploadOpen(false); else openUpload(viewFolder && viewFolder.kind !== 'root' ? viewFolder.id : undefined) }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50">
              <Upload className="h-3.5 w-3.5" />Upload
            </button>
            <FastTooltip label="Refresh">
              <button type="button" onClick={() => refreshAll()} aria-label="Refresh" className="rounded-md border border-zinc-200 p-1 hover:bg-zinc-50">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </FastTooltip>
            {ai.available && ownerId && <AiCheckFilesButton ownerId={ownerId} folderId={viewFolder && viewFolder.kind !== 'root' && viewFolder.kind !== 'contacts' ? viewFolder.id : null} scopeLabel={viewFolder && viewFolder.kind !== 'root' ? viewFolder.name : (root.owner.label || 'this storage')} onMark={ai.setOne} onFinished={() => { void ai.reload(visibleFileIds) }} />}
            <button type="button" onClick={(e) => { e.stopPropagation(); void openTrash() }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50">
              <Trash2 className="h-3.5 w-3.5" />Trash
            </button>
            <select aria-label="Sort" value={sortMode} onChange={(e) => setSort(e.target.value as SortMode)} className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs">
              <option value="name">Sort: name</option>
              <option value="date">Sort: newest first</option>
            </select>
            <select aria-label="Filter" value={filterKind ?? ''} onChange={(e) => { void openFilter((e.target.value || null) as typeof filterKind) }} className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs">
              <option value="">Filter: none</option>
              {root.owner.kind !== 'business' && root.owner.kind !== 'private' && <option value="shown">Shown to client</option>}
              <option value="review">Needs review</option>
              <option value="untyped">Needs a type</option>
            </select>
            {topFolders.length > 0 && (
              <button type="button" className="text-xs text-blue-700 hover:underline"
                onClick={() => {
                  if (allOpen) { setExpanded(new Set()); return }
                  setExpanded(new Set(topFolders.map((f) => f.id)))
                  for (const f of topFolders) if (!loaded[f.id]) loadKey(f.id)
                }}>
                {allOpen ? 'Close all' : 'Open all'}
              </button>
            )}
          </div>

          {selectedFiles.size > 0 && (
            <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm" onClick={(e) => e.stopPropagation()}>
              <span className="font-medium text-blue-900">{selectedFiles.size} selected</span>
              <span className="flex-1" />
              <button type="button" disabled={bulkBusy} onClick={() => runBulk('move')} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"><FolderInput className="mr-1 inline h-3.5 w-3.5" />Move to…</button>
              {ownerKind !== 'business' && ownerKind !== 'private' && <>
                <button type="button" disabled={bulkBusy} onClick={() => runBulk('show')} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"><Eye className="mr-1 inline h-3.5 w-3.5" />Show to client</button>
                <button type="button" disabled={bulkBusy} onClick={() => runBulk('hide')} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"><EyeOff className="mr-1 inline h-3.5 w-3.5" />Hide from client</button>
              </>}
              <button type="button" disabled={bulkBusy} onClick={() => runBulk('delete')} className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="mr-1 inline h-3.5 w-3.5" />Delete</button>
              <button type="button" disabled={bulkBusy} onClick={() => setSelectedFiles(new Map())} className="text-xs text-zinc-600 hover:underline">Clear</button>
              {bulkBusy && <Loader2 className="h-4 w-4 animate-spin text-blue-700" />}
            </div>
          )}

          {filterKind && (
            <div className="mb-3 rounded-lg border border-zinc-200 p-2">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-medium">{filterKind === 'shown' ? 'Shown to client' : filterKind === 'review' ? 'Needs review' : 'Needs a type'}</span>
                <span className="text-xs text-zinc-400">in all of {root.owner.label}&apos;s own folders{root.owner.kind === 'company' ? ' (its people’s own documents are in each person’s storage)' : ''}</span>
                <span className="flex-1" />
                <button type="button" onClick={() => { void openFilter(null) }} className="text-xs text-blue-700 hover:underline">Close filter</button>
              </div>
              {filtered === null && <p className="text-sm text-zinc-500">Loading…</p>}
              {filtered && filtered.length === 0 && <p className="text-sm text-zinc-500">No files.</p>}
              <ul className="divide-y divide-zinc-50">
                {(filtered ?? []).map((ff) => {
                  const Icon = fileIcon(ff.mimeType)
                  return (
                    <li key={ff.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                      <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
                      <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setPreview({ id: ff.id, name: ff.name, documentType: ff.documentType, state: 'live', published: false, clientVisible: false, staffOnly: false, personal: false, versions: 1, size: ff.size, mimeType: ff.mimeType, updatedAt: ff.updatedAt, listed: true, personName: null, inPersonStorage: false, docId: null })}>{ff.name}</button>
                      {ff.needsReview && <Badge tone="red"><AlertTriangle className="h-3 w-3" />Needs review</Badge>}
                      <button type="button" className="text-xs text-zinc-500 hover:underline" onClick={() => { void selectFolder(folderOwner.current.get(ff.folderId) ?? ownerId ?? '', ff.folderId); void openFilter(null) }}>{ff.where || 'top'}</button>
                      <button type="button" className="text-xs text-blue-700 hover:underline" onClick={() => { void openDetails(ff.id) }}>Details</button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {uploadOpen && isInternalOwnerKind(ownerKind) && viewFolder && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm" onClick={(e) => e.stopPropagation()} data-testid="plain-upload-box">
              <span className="text-zinc-700">Into <strong>{viewFolder.name}</strong>:</span>
              <label className="cursor-pointer rounded-md border border-zinc-300 bg-white px-3 py-1 hover:bg-zinc-50">Choose files
                <input type="file" multiple className="hidden" onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; if (!list.length) return; const { items, skipped, folders } = filterPlainDrop(itemsFromFileList(list.map((file) => ({ file })))); plainFolders.current = new Map(); setPlain({ folder: viewFolder, items, skipped, folders }); setUploadOpen(false) }} />
              </label>
              <label className="cursor-pointer rounded-md border border-zinc-300 bg-white px-3 py-1 hover:bg-zinc-50">Choose a folder
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- webkitdirectory is not in React's input typings */}
                <input type="file" multiple className="hidden" {...({ webkitdirectory: '', directory: '' } as any)} onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; if (!list.length) return; const { items, skipped, folders } = filterPlainDrop(itemsFromFileList(list.map((file) => ({ file, relative: (file as File & { webkitRelativePath?: string }).webkitRelativePath })))); plainFolders.current = new Map(); setPlain({ folder: viewFolder, items, skipped, folders }); setUploadOpen(false) }} />
              </label>
              {myDriveProbe?.allowed && <button type="button" onClick={() => { setMyDriveFor(viewFolder); setUploadOpen(false) }} className="rounded-md border border-zinc-300 bg-white px-3 py-1 hover:bg-zinc-50" data-testid="my-drive-open">From my Google Drive</button>}
              <button type="button" onClick={() => setUploadOpen(false)} className="text-xs text-zinc-500 hover:underline">Cancel</button>
              <span className="text-xs text-zinc-400">Any kind of file. The same name replaces the file; the old copy is kept under Versions.</span>
            </div>
          )}
          {uploadOpen && !isInternalOwnerKind(ownerKind) && (
            <div className="mb-3 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm" onClick={(e) => e.stopPropagation()}>
              <div className="flex flex-wrap items-center gap-2">
                <select value={upFolder} onChange={(e) => { setUpFolder(e.target.value); setUpType(''); setUpPerson('') }} className="max-w-xs rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading}>
                  <option value="">Folder…</option>
                  {upOptions.map(({ f, depth }) => <option key={f.id} value={f.id}>{`${'  '.repeat(depth)}${f.name}`}</option>)}
                </select>
                {upIsContacts && (
                  <select value={upPerson} onChange={(e) => setUpPerson(e.target.value)} className="rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading}>
                    <option value="">Whose document?</option>
                    {upPeople.map((pp) => <option key={pp.contactId} value={pp.contactId}>{pp.name}</option>)}
                  </select>
                )}
                <select value={upType} onChange={(e) => setUpType(e.target.value)} className="rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading || !types || !upFolder}>
                  <option value="">{types ? 'Document type…' : 'Loading types…'}</option>
                  {upTypes.map((t) => <option key={t.slug} value={t.slug}>{t.name}{t.staffOnly ? ' (staff only)' : ''}</option>)}
                  <option value="__custom__">Custom…</option>
                </select>
                {upType === '__custom__' && (
                  <>
                    <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="New type name" className="w-44 rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={addingType} />
                    <button type="button" disabled={addingType || customName.trim().length < 2} onClick={addCustomType}
                      className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50">
                      {addingType ? 'Adding…' : 'Add'}
                    </button>
                  </>
                )}
                <input value={upName} onChange={(e) => setUpName(e.target.value)} placeholder="Name shown (optional)" className="w-52 rounded-md border border-zinc-200 bg-white px-2 py-1" disabled={uploading} />
                {ownerKind !== 'business' && ownerKind !== 'private' && (() => {
                  // a staff-only type is never shown: the box says so instead of looking ticked
                  const neverShown = (types ?? []).find((t) => t.slug === upType)?.staffOnly === true
                  return (
                    <FastTooltip label={neverShown ? 'Staff only — this type is never shown to a client' : 'Show the file to the client straight away'}>
                      <label className={`inline-flex items-center gap-1.5 text-xs ${neverShown ? 'text-zinc-400' : 'text-zinc-700'}`}>
                        <input type="checkbox" checked={upVisible && !neverShown} onChange={(e) => setUpVisible(e.target.checked)} disabled={uploading || neverShown} />
                        Show to client
                      </label>
                    </FastTooltip>
                  )
                })()}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" className="text-sm"
                  disabled={uploading || !upFolder || !upType || upType === '__custom__' || (upIsContacts && !upPerson)}
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) doUpload(file) }} />
                {uploading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
                <button type="button" onClick={() => setUploadOpen(false)} disabled={uploading} className="text-xs text-zinc-500 hover:underline">Cancel</button>
                <span className="text-xs text-zinc-400">Uploading a file with the same name replaces it; the old copy is kept under Versions.</span>
              </div>
            </div>
          )}

          <ul className={`divide-y divide-zinc-50 ${viewFolder && dropOn === `view:${viewFolder.id}` ? 'rounded ring-1 ring-blue-300' : ''}`}
            onDragOver={(e) => { if (viewFolder && isComputerDrag(e) && viewFolder.kind !== 'root' && viewFolder.kind !== 'contacts') { e.preventDefault(); setDropOn(`view:${viewFolder.id}`) } }}
            onDragLeave={() => setDropOn((d) => (d?.startsWith('view:') ? null : d))}
            onDrop={(e) => { if (viewFolder && isComputerDrag(e) && viewFolder.kind !== 'root' && viewFolder.kind !== 'contacts') void onComputerDrop(e, viewFolder) }}>
            {viewFolder && newFolderBox(viewFolder.id, 0)}
            {viewFolder?.kind === 'contacts'
              ? (view?.people ?? []).map((p) => personNode(p, 0, [viewFolder.name]))
              : topFolders.map((f) => folderNode(f, 0, viewFolder?.id ?? null, []))}
            {sortFiles(view?.files ?? []).map((file) => fileRow(file, viewFolder, 0))}
            {viewFolder?.kind !== 'contacts' && topFolders.length === 0 && (view?.files.length ?? 0) === 0 && newFolder?.parentId !== viewFolder?.id && (
              <li className="py-2 text-sm text-zinc-500">{focus ? 'This folder is empty — use New folder or Upload.' : 'This storage is empty — use New folder or Upload.'}</li>
            )}
          </ul>
          <p className="mt-2 text-xs text-zinc-400">Drag a file onto a folder to move it. Drag files from your computer onto a folder to upload them — they arrive hidden from the client.</p>
        </div>
      )}
      {preview && <PreviewPanel file={preview} onClose={() => setPreview(null)} />}
      {myDriveFor && (
        <MyDriveDialog targetName={myDriveFor.name} onClose={() => setMyDriveFor(null)}
          onChosen={(items, skipped, folders) => { plainFolders.current = new Map(); setPlain({ folder: myDriveFor, items, skipped, folders }); setMyDriveFor(null) }} />
      )}
      {plain && (
        <PlainDropPanel folderName={plain.folder.name} items={plain.items} skipped={plain.skipped} folders={plain.folders} makeFolder={async (path) => { await ensurePlainFolder(path) }} run={runPlainItem}
          onClose={() => setPlain(null)} onFinished={() => { void refreshAll([plain.folder.id]) }} />
      )}
      {aiFile && ownerId && (
        <AiReviewPanel fileId={aiFile} onClose={() => setAiFile(null)}
          queue={Array.from(new Set([aiFile, ...visibleFileIds.filter((id) => ai.marks[id] && (ai.marks[id].mark === 'look' || ai.marks[id].mark === 'conflict'))]))}
          onChanged={() => { void refreshAll(); void ai.reload(visibleFileIds) }} onOpenFile={setAiFile} />
      )}
      {previewVersion && <PreviewPanel file={previewVersion.file} src={previewVersion.src} title={previewVersion.title} onClose={() => setPreviewVersion(null)} />}
      <OcrViewerModal documentId={ocrDocId} onClose={() => setOcrDocId(null)} />
      {asking && (
        <QuestionDialog q={questions?.[asking.slug]} fallbackTitle={asking.fallbackTitle}
          onClose={() => { const r = asking.resolve; setAsking(null); r('cancel') }}
          choices={asking.choices.map((c) => ({ ...c, onChoose: () => { const r = asking.resolve; setAsking(null); r(c.key) } }))}>
          {asking.body}
        </QuestionDialog>
      )}
      {detailsFor && (
        <div className="fixed inset-y-0 right-0 z-[58] flex w-full max-w-md flex-col border-l border-zinc-200 bg-white p-4 shadow-xl" role="dialog" aria-label="File details" onClick={(e) => e.stopPropagation()}>
          <div className="mb-3 flex items-center gap-2">
            <Layers className="h-4 w-4 text-zinc-500" />
            <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{details?.name ?? 'Details'}</h3>
            <button type="button" onClick={() => { setDetailsFor(null); setDetails(null) }} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
          </div>
          {!details ? <p className="text-sm text-zinc-500">Loading…</p> : (
            <dl className="min-h-0 flex-1 space-y-2 overflow-y-auto text-sm">
              {([
                ['Where', details.where || 'top of the storage'],
                ['Type', details.typeName ?? 'Needs a type'],
                ['Year', details.year ? String(details.year) : '—'],
                ['Filed or draft', details.filingStatus && details.filingStatus !== 'none' ? details.filingStatus : '—'],
                ['Client can see it', ownerKind === 'business' || ownerKind === 'private' ? 'Never (internal)' : details.clientCanSee ? 'Yes' : details.listed ? 'No' : 'No — not linked to the CRM list'],
                ...(details.sharedWithStaff ? [['Shared with staff', details.sharedWithStaff.length ? details.sharedWithStaff.join(', ') : 'Nobody']] : []),
                ...(details.needsReview ? [['Needs review', details.needsReview]] : []),
                ['Uploaded', `${fmtDate(details.createdAt)}${details.createdBy ? ` by ${details.createdBy}` : ''}`],
                ['Last changed', fmtDate(details.updatedAt)],
                ...(details.links.length ? [['Linked to', details.links.map((l) => `${l.kind.replace(/_/g, ' ')}${l.taxYear ? ` ${l.taxYear}` : ''}`).join(', ')]] : []),
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[9rem_1fr] gap-2"><dt className="text-zinc-500">{k}</dt><dd className="text-zinc-800">{v}</dd></div>
              ))}
              <div>
                <dt className="mb-1 text-zinc-500">Versions ({details.versions.length})</dt>
                <dd>
                  <ul className="space-y-1">
                    {details.versions.map((v) => (
                      <li key={v.versionNo} className="flex items-center gap-2 text-xs">
                        <span className="font-medium">v{v.versionNo}</span>
                        <span className="text-zinc-500">{fmtDate(v.createdAt)} · {fmtSize(v.size)}{v.by ? ` · ${v.by}` : ''}</span>
                        {v.current && <Badge tone="green">current</Badge>}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
      {importOpen && (
        <DriveImportDialog onClose={() => setImportOpen(false)}
          onOpenStorage={(oid) => { setImportOpen(false); void loadNav(); void openOwner(oid) }}
          onMyDrive={myDriveProbe?.allowed ? (target) => { void openMyDriveInto(target) } : undefined} />
      )}
      {typing && (
        <SetTypeDialog file={typing} viewingOwnerId={ownerId} onClose={() => setTyping(null)}
          onDone={() => { setTyping(null); void refreshAll() }} />
      )}
      {trashOpen && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4" onClick={() => setTrashOpen(false)} role="dialog" aria-modal="true">
          <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-zinc-500" />
              <h3 className="flex-1 text-base font-semibold">Trash — {root?.owner.label}</h3>
              <button type="button" onClick={() => setTrashOpen(false)} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
            </div>
            <p className="mb-3 text-xs text-zinc-500">Deleted files and folders stay here for 90 days, then they are deleted for good. Anything restored comes back hidden from the client{root?.owner.kind === 'private' ? ' and shared with nobody' : ''}.{root?.owner.kind === 'company' ? " A person's own document (passport, ID…) deleted from 2. Contacts is listed here too, marked with whose storage it is, and goes back to that person's storage." : ''}</p>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {trash === null && <li className="text-sm text-zinc-500">Loading…</li>}
              {trash && trash.length === 0 && <li className="text-sm text-zinc-500">The trash is empty.</li>}
              {(trash ?? []).map((b) => (
                <li key={b.batchId} className="rounded-lg border border-zinc-200 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {b.items.slice(0, 5).map((it) => {
                        const Icon = it.kind === 'folder' ? Folder : fileIcon(it.mimeType)
                        return (
                          <div key={it.id} className="flex items-center gap-1.5">
                            <Icon className={`h-4 w-4 shrink-0 ${it.kind === 'folder' ? 'text-amber-500' : 'text-zinc-400'}`} />
                            {it.kind === 'file'
                              ? <button type="button" className="truncate hover:underline" onClick={() => setPreview({ id: it.id, name: it.name, documentType: null, state: 'trashed', published: false, clientVisible: false, staffOnly: false, personal: false, versions: 1, size: null, mimeType: it.mimeType, updatedAt: b.trashedAt, listed: false, personName: null, inPersonStorage: false, docId: null })}>{it.name}</button>
                              : <span className="truncate">{it.name}</span>}
                          </div>
                        )
                      })}
                      {b.items.length > 5 && <p className="text-xs text-zinc-500">… and {b.items.length - 5} more</p>}
                      {b.whose && <p className="mt-1 text-xs font-medium text-violet-700">In {b.whose}</p>}
                      <p className="mt-1 text-xs text-zinc-500">
                        {b.folders > 0 && `${b.folders} ${b.folders === 1 ? 'folder' : 'folders'} · `}{b.files} {b.files === 1 ? 'file' : 'files'} · deleted {fmtDate(b.trashedAt)}{b.trashedBy ? ` by ${b.trashedBy}` : ''}
                        {b.purgeAfter ? ` · deleted for good on ${fmtDate(b.purgeAfter)}` : ''}
                        {b.held > 0 ? ` · ${b.held} kept by a legal hold` : ''}
                      </p>
                    </div>
                    <button type="button" disabled={!!restoring} onClick={() => restoreBatch(b)}
                      className="rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50">
                      {restoring === b.batchId ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {drop && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!dropRunning) setDrop(null) }} role="dialog" aria-modal="true">
          <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2">
              <Upload className="h-4 w-4 text-zinc-500" />
              <h3 className="flex-1 text-base font-semibold">Upload {drop.items.length} {drop.items.length === 1 ? 'file' : 'files'} into “{drop.folder.name}”</h3>
              <button type="button" disabled={dropRunning} onClick={() => setDrop(null)} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40"><X className="h-4 w-4" /></button>
            </div>
            <p className="mb-2 text-xs text-zinc-500">Files dragged in arrive <strong>hidden from the client</strong>; show them afterwards from their row. If something needs a decision (same name, tax year, filed or draft…) you are asked one file at a time.</p>
            {drop.items.some((x) => x.path.length) && (
              <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                These folders will be created inside “{drop.folder.name}” (or reused if they already exist): {Array.from(new Set(drop.items.filter((x) => x.path.length).map((x) => x.path.join(' › ')))).join(' · ')}
              </p>
            )}
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              {drop.folder.kind === 'contacts' && (
                <select value={drop.person} disabled={dropRunning} onChange={(e) => setDrop({ ...drop, person: e.target.value })} className="rounded-md border border-zinc-200 bg-white px-2 py-1">
                  <option value="">Whose documents?</option>
                  {(loaded[drop.folder.id]?.people ?? []).map((pp) => <option key={pp.contactId} value={pp.contactId}>{pp.name}</option>)}
                </select>
              )}
              <select value="" disabled={dropRunning} onChange={(e) => { const v = e.target.value; if (v) setDrop({ ...drop, items: drop.items.map((x) => (x.status === 'waiting' ? { ...x, type: v } : x)) }) }}
                className="rounded-md border border-zinc-200 bg-white px-2 py-1">
                <option value="">Same type for all…</option>
                {typesForFolder(drop.folder).map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
              </select>
            </div>
            <ul className="min-h-0 flex-1 divide-y divide-zinc-100 overflow-y-auto">
              {drop.items.map((it, i) => (
                <li key={`${it.file.name}-${i}`} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                  <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate" title={[...it.path, it.file.name].join(' › ')}>
                    {it.path.length > 0 && <span className="text-zinc-400">{it.path.join(' › ')} › </span>}{it.file.name}
                  </span>
                  <span className="text-xs text-zinc-400">{fmtSize(it.file.size)}</span>
                  <select value={it.type} disabled={dropRunning || it.status !== 'waiting'} onChange={(e) => setDrop({ ...drop, items: drop.items.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })}
                    className="max-w-[12rem] rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs">
                    <option value="">Document type…</option>
                    {typesForFolder(drop.folder).map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
                  </select>
                  <input value={it.name} disabled={dropRunning || it.status !== 'waiting'} onChange={(e) => setDrop({ ...drop, items: drop.items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                    placeholder="Name shown (optional)" className="w-40 rounded-md border border-zinc-200 px-2 py-1 text-xs" />
                  <span className={`w-20 text-right text-xs ${it.status === 'saved' ? 'text-emerald-700' : it.status === 'failed' ? 'text-red-600' : it.status === 'cancelled' ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {it.status === 'uploading' ? <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" /> : it.status === 'saved' ? 'uploaded' : it.status === 'failed' ? 'failed' : it.status === 'cancelled' ? 'skipped' : 'waiting'}
                  </span>
                  {!dropRunning && it.status === 'waiting' && (
                    <button type="button" aria-label="Remove" onClick={() => setDrop({ ...drop, items: drop.items.filter((_, j) => j !== i) })} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100"><X className="h-3.5 w-3.5" /></button>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2 border-t border-zinc-100 pt-3">
              <span className="flex-1 text-xs text-zinc-500">{drop.items.filter((x) => x.status === 'saved').length} of {drop.items.length} uploaded</span>
              <button type="button" disabled={dropRunning} onClick={() => setDrop(null)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50">{drop.items.some((x) => x.status === 'saved') ? 'Close' : 'Cancel'}</button>
              <button type="button" disabled={dropRunning || !drop.items.some((x) => x.status === 'waiting')} onClick={() => { void runDrop() }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">{dropRunning ? 'Uploading…' : 'Upload'}</button>
            </div>
          </div>
        </div>
      )}
      {sharing && (
        <QuestionDialog q={undefined} fallbackTitle={`Who can see "${sharing.name}"?`} onClose={() => setSharing(null)}
          choices={[
            { key: 'save', label: savingShare ? 'Saving…' : 'Save', tone: 'primary', disabled: savingShare || !staffLogins, onChoose: () => { void saveSharing() } },
            { key: 'cancel', label: 'Cancel', onChoose: () => setSharing(null) },
          ]}>
          <p>Ticked people can open and download this file from their <strong>Shared with me</strong>. They can&apos;t change, move or delete it. The owners always see it.</p>
          {!staffLogins ? <p className="text-zinc-500">Loading…</p> : staffLogins.length === 0 ? <p className="text-zinc-500">No staff logins yet — add them in Team Management.</p> : (
            <ul className="space-y-1">
              {staffLogins.map((l) => (
                <li key={l.userId}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={shareTicks.has(l.userId)} disabled={savingShare}
                      onChange={(e) => setShareTicks((t) => { const n = new Set(t); if (e.target.checked) n.add(l.userId); else n.delete(l.userId); return n })} />
                    <span className="font-medium">{l.name}</span><span className="text-xs text-zinc-500">{l.email}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </QuestionDialog>
      )}
      {picking && (
        <FolderPicker {...picking.props}
          onClose={() => { const r = picking.resolve; setPicking(null); r(null) }}
          onPick={(folderId, oid, path) => { const r = picking.resolve; setPicking(null); r({ folderId, ownerId: oid, path }) }} />
      )}
    </div>
  )

  if (scopedOwnerId) return right

  const q = filter.trim().toLowerCase()

  /** "+" on a storage in the left tree: a new folder at its top (loads the storage first if needed) */
  const newFolderAtOwner = async (oid: string) => {
    setMenuFor(null)
    const key = `own:${oid}`
    try {
      const c = await fetchInto(oid, null)
      if (!c.folder) return
      const folders = [...c.folders].sort(sortFolders)
      setTree((t) => ({ ...t, [key]: { root: c.folder, folders } }))
      setOpenTree((x) => new Set(x).add(key))
      setNewFolder({ parentId: c.folder.id, siblings: folders.map((x) => x.name), left: true, value: '' })
    } catch (e) {
      toast.error(errMsg(e, 'Could not open the storage.'))
    }
  }

  const treeArrow = (key: string, open: boolean, load = true) => (
    <button type="button" aria-label={open ? 'Close' : 'Open'} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setMenuFor(null); toggleTree(key, load) }}
      className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600">
      {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
    </button>
  )

  /** one folder in the LEFT tree: arrow opens / closes it here; the name shows it on the right */
  const treeFolderRow = (oid: string, f: Fold, depth: number, parentId: string | null): React.ReactNode => {
    if (f.trashed) return null
    const open = openTree.has(f.id)
    const kids = tree[f.id]?.folders
    const menuKey = `lfolder:${f.id}`
    return (
      <li key={f.id}>
        <div className={`group relative flex items-center gap-1 rounded-md py-1 pr-1 text-sm hover:bg-zinc-50 ${focus === f.id ? 'bg-blue-50' : ''}`} style={{ paddingLeft: `${depth * 14}px` }}>
          {f.kind === 'contacts' ? <span className="w-5" /> : treeArrow(f.id, open)}
          {renaming?.id === f.id && renaming.left ? (
            <input autoFocus value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') doRenameFolder(f, renaming.value); if (e.key === 'Escape') { renameDone.current = true; setRenaming(null) } }}
              onBlur={() => doRenameFolder(f, renaming.value)}
              className="min-w-0 flex-1 rounded border border-blue-300 px-1.5 py-0.5 text-sm" />
          ) : (
            <button type="button" onClick={() => selectFolder(oid, f.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              {open ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" /> : <Folder className="h-4 w-4 shrink-0 text-amber-500" />}
              <span className="truncate">{f.name}</span>
            </button>
          )}
          {treeLoading.has(f.id) && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
          {f.kind !== 'contacts' && (
            <FastTooltip label="New folder inside">
              <button type="button" aria-label="New folder inside" onClick={async (e) => {
                e.stopPropagation()
                if (!open) setOpenTree((x) => new Set(x).add(f.id))
                // the name check needs the folders already inside — read them first
                const kidsNow = tree[f.id]?.folders ?? await loadTree(f.id)
                if (kidsNow) startNewFolder(f.id, false, true, kidsNow)
              }} className="hidden rounded p-0.5 text-zinc-500 hover:bg-zinc-100 group-hover:inline-flex"><FolderPlus className="h-3.5 w-3.5" /></button>
            </FastTooltip>
          )}
          {!f.locked ? (
            <div className="relative">
              <button type="button" aria-label="Folder actions" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === menuKey ? null : menuKey) }}
                className="hidden rounded p-0.5 text-zinc-500 hover:bg-zinc-100 group-hover:inline-flex"><MoreHorizontal className="h-3.5 w-3.5" /></button>
              {menuFor === menuKey && (
                <div className="absolute right-0 z-30 mt-1 w-48 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
                  <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenuFor(null); renameDone.current = false; setRenaming({ id: f.id, value: f.name, folder: true, left: true }) }} />
                  <MenuItem icon={FolderInput} label="Move to…" onClick={() => pickAndMoveFolder(f, parentId)} />
                  <MenuItem icon={Trash2} label="Delete" danger onClick={() => deleteFolder(f)} />
                </div>
              )}
            </div>
          ) : (
            <FastTooltip label="A fixed folder — it can't be renamed, moved or deleted"><Lock className="hidden h-3 w-3 text-zinc-300 group-hover:inline" /></FastTooltip>
          )}
        </div>
        {open && (
          <ul>
            {newFolderBox(f.id, depth + 1, true)}
            {(kids ?? []).map((k) => treeFolderRow(oid, k, depth + 1, f.id))}
            {kids && kids.length === 0 && newFolder?.parentId !== f.id && f.kind !== 'contacts' && (
              <li className="py-0.5 text-xs italic text-zinc-400" style={{ paddingLeft: `${(depth + 1) * 14 + 22}px` }}>no sub-folders</li>
            )}
          </ul>
        )}
      </li>
    )
  }

  /** one storage in the LEFT tree (a company, a person, Business, My files) */
  const treeOwnerRow = (o: NavGroup['owners'][number], depth: number, label?: string, note?: string): React.ReactNode => {
    const key = `own:${o.id}`
    const open = openTree.has(key)
    const node = tree[key]
    const Icon = ownerIcon(o.kind)
    return (
      <li key={o.id}>
        <div className={`group flex items-center gap-1 rounded-md py-1 pr-1 text-sm hover:bg-zinc-50 ${ownerId === o.id && !focus ? 'bg-blue-50' : ''} ${dropOn === key ? 'ring-1 ring-blue-300 bg-blue-50' : ''}`} style={{ paddingLeft: `${depth * 14}px` }}
          onDragOver={(e) => { if (isInternalOwnerKind(o.kind) && isComputerDrag(e)) { e.preventDefault(); e.stopPropagation(); setDropOn(key) } }}
          onDragLeave={() => setDropOn((d) => (d === key ? null : d))}
          onDrop={(e) => { if (isInternalOwnerKind(o.kind) && isComputerDrag(e)) void onDropOnOwner(e, o.id) }}>
          {treeArrow(key, open)}
          <button type="button" onClick={() => openOwner(o.id)} className={`flex min-w-0 flex-1 items-center gap-2 text-left ${label ? 'font-medium' : ''}`}>
            <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1 truncate">{label ?? o.label}</span>
          </button>
          {o.status && <Badge tone={o.status === 'archived' ? 'gray' : 'amber'}>{o.status}</Badge>}
          {note && <span className="text-[11px] text-zinc-400">{note}</span>}
          {treeLoading.has(key) && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
          <FastTooltip label="New folder">
            <button type="button" aria-label="New folder" onClick={(e) => { e.stopPropagation(); void newFolderAtOwner(o.id) }}
              className="hidden rounded p-0.5 text-zinc-500 hover:bg-zinc-100 group-hover:inline-flex"><FolderPlus className="h-3.5 w-3.5" /></button>
          </FastTooltip>
          <span className="w-6 text-right text-xs text-zinc-400">{o.fileCount}</span>
        </div>
        {open && node && (
          <ul>
            {node.root && newFolderBox(node.root.id, depth + 1, true)}
            {node.folders.map((f) => treeFolderRow(o.id, f, depth + 1, node.root?.id ?? null))}
            {node.folders.length === 0 && newFolder?.parentId !== node.root?.id && (
              <li className="py-0.5 text-xs italic text-zinc-400" style={{ paddingLeft: `${(depth + 1) * 14 + 22}px` }}>no folders yet — hover and click the folder + to add one</li>
            )}
          </ul>
        )}
      </li>
    )
  }

  const clientGroups = (groups ?? []).filter((g) => g.section === 'clients')
  const businessOwner = (groups ?? []).find((g) => g.section === 'business')?.owners[0]
  const privateOwner = (groups ?? []).find((g) => g.section === 'private')?.owners[0]
  const clientsOpen = !!q || openTree.has('sec:clients')
  const clientCount = clientGroups.reduce((n, g) => n + g.owners.filter((o) => !q || o.label.toLowerCase().includes(q)).length, 0)

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[340px_1fr]">
      <div className="min-h-[70vh] self-start rounded-xl border border-zinc-200 bg-white p-3" onClick={() => { if (menuFor) setMenuFor(null); if (versionsFor) setVersionsFor(null) }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search clients, people, Business…"
          className="mb-2 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
        />
        {groups === null && !error && <p className="p-2 text-sm text-zinc-500">Loading…</p>}
        <ul className="space-y-0.5">
          {clientGroups.length > 0 && (
            <li>
              <div className="flex items-center gap-1 rounded-md py-1 pr-1 text-sm font-medium hover:bg-zinc-50">
                {treeArrow('sec:clients', clientsOpen, false)}
                <button type="button" onClick={() => toggleTree('sec:clients', false)} className="flex flex-1 items-center gap-2 text-left">
                  <Building2 className="h-4 w-4 text-zinc-500" /><span className="flex-1">Clients</span>
                </button>
                <span className="w-6 text-right text-xs font-normal text-zinc-400">{clientCount}</span>
              </div>
              {clientsOpen && (
                <ul>
                  {clientGroups.map((g) => {
                    const owners = g.owners.filter((o) => !q || o.label.toLowerCase().includes(q))
                    if (q && owners.length === 0) return null
                    const gKey = `grp:${g.key}`
                    const gOpen = !!q || openTree.has(gKey)
                    return (
                      <li key={g.key}>
                        <div className="flex items-center gap-1 rounded-md py-1 pr-1 text-sm hover:bg-zinc-50" style={{ paddingLeft: '14px' }}>
                          {treeArrow(gKey, gOpen, false)}
                          <button type="button" onClick={() => toggleTree(gKey, false)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                            <Folder className="h-4 w-4 shrink-0 text-amber-500" /><span className="truncate">{g.label}</span>
                          </button>
                          <span className="w-6 text-right text-xs text-zinc-400">{owners.length}</span>
                        </div>
                        {gOpen && <ul>{owners.map((o) => treeOwnerRow(o, 2))}</ul>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )}
          {businessOwner && (!q || 'business'.includes(q)) && <li className="pt-2"><ul>{treeOwnerRow(businessOwner, 0, 'Business')}</ul></li>}
          {privateOwner && (!q || 'my files'.includes(q)) && <li><ul>{treeOwnerRow(privateOwner, 0, 'My files', 'owners only')}</ul></li>}
          {groups && !privateOwner && (!q || 'shared with me'.includes(q)) && (
            <li>
              <button type="button" onClick={() => { void openSharedWithMe() }}
                className={`flex w-full items-center gap-2 rounded-md py-1 pl-6 pr-1 text-left text-sm font-medium hover:bg-zinc-50 ${sharedView ? 'bg-blue-50' : ''}`}>
                <User className="h-4 w-4 text-zinc-400" /><span className="flex-1">Shared with me</span>
              </button>
            </li>
          )}
          {!scopedOwnerId && (importProbe?.allowed || myDriveProbe?.allowed) && (
            <li className="pt-2">
              <button type="button" onClick={() => setImportOpen(true)}
                className="flex w-full items-center gap-2 rounded-md border border-blue-200 bg-blue-50 py-1 pl-2 pr-1 text-left text-sm font-medium text-blue-800 hover:bg-blue-100">
                <HardDriveDownload className="h-4 w-4" /><span className="flex-1">Import from Google Drive</span>
              </button>
            </li>
          )}
        </ul>
      </div>
      {right}
    </div>
  )
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${danger ? 'text-red-600 hover:bg-red-50' : 'hover:bg-zinc-50'}`}>
      <Icon className="h-3.5 w-3.5" />{label}
    </button>
  )
}

/** "Pick which ones to hide": ticked = the client stops seeing it (the Set is read when the question is answered). */
function PickList({ items, chosen }: { items: { id: string; name: string }[]; chosen: Set<string> }) {
  const [, force] = useState(0)
  return (
    <ul className="max-h-60 space-y-1 overflow-y-auto">
      {items.map((x) => (
        <li key={x.id}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={chosen.has(x.id)} onChange={(e) => { if (e.target.checked) chosen.add(x.id); else chosen.delete(x.id); force((n) => n + 1) }} />
            {x.name}
          </label>
        </li>
      ))}
    </ul>
  )
}
