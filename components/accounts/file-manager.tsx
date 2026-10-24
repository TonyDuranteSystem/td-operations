'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen,
  MoreVertical, ExternalLink, Eye, EyeOff, Search,
  RefreshCw, Loader2, X, Image as ImageIcon, FileSpreadsheet, Globe,
  ShieldCheck, ScanText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { OcrViewerModal } from '@/components/documents/ocr-viewer'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { ResolvePersonalDocument } from '@/components/documents/resolve-personal-document'
import { isUnresolvedPersonalDocument } from '@/lib/documents/visibility-guard'
import { useStoreOwnerForAccount } from '@/components/storage/new-store-browser'
import { StoreReadOnlyPanel } from './store-readonly-panel'
import { useShareMessagePrompt, suppressesAutoChat, isSilentShow, type ShareDecision } from '@/components/storage/use-share-message-prompt'

// ─── Types ────────────────────────────────────────────────

interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  webViewLink?: string
  thumbnailLink?: string
  iconLink?: string
}

interface FolderData {
  id: string
  name: string
  files: DriveFile[]
  subfolders: FolderData[]
}

interface DocInfo {
  docId: string
  portalVisible: boolean
  category: number | null
  contactId: string | null
  confidence: string | null
  updatedAt: string | null
}

function isUnresolvedPersonalDoc(doc: { category: number | null; contactId: string | null }): boolean {
  return isUnresolvedPersonalDocument({ category: doc.category, contact_id: doc.contactId })
}

interface FilesResponse {
  folders: FolderData[]
  rootFiles: DriveFile[]
  docMap?: Record<string, DocInfo>
  error?: string
}

// ─── Helpers ──────────────────────────────────────────────

function formatFileSize(bytes: string | undefined): string {
  if (!bytes) return ''
  const n = Number(bytes)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <ImageIcon className="h-4 w-4 text-pink-500" />
  if (mimeType.includes('spreadsheet') || mimeType.includes('csv') || mimeType.includes('excel')) return <FileSpreadsheet className="h-4 w-4 text-green-600" />
  if (mimeType.includes('pdf')) return <FileText className="h-4 w-4 text-red-500" />
  return <FileText className="h-4 w-4 text-zinc-400" />
}

// ─── FileRow Component ────────────────────────────────────

function FileRow({
  file,
  accountId,
  onRefresh,
  onPreview,
  onViewOcr,
  docInfo,
}: {
  file: DriveFile
  accountId: string
  onRefresh: () => void
  onPreview: (file: DriveFile) => void
  onViewOcr?: (docId: string) => void
  docInfo?: DocInfo
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [showThumb, setShowThumb] = useState(false)
  const [portalVisible, setPortalVisible] = useState(docInfo?.portalVisible ?? false)
  const [togglingVisibility, setTogglingVisibility] = useState(false)
  const [showResolver, setShowResolver] = useState(false)
  // the "tell the client?" pop-up when this eye makes a hidden file visible (shared with the other eyes)
  const { decide: decideShare, sendChat: sendShareChat, dialog: shareDialog } = useShareMessagePrompt()
  const menuRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasThumbnail = !!file.thumbnailLink

  // Sync local state when docInfo prop changes (e.g., after React Query refetch)
  useEffect(() => {
    if (!togglingVisibility) {
      setPortalVisible(docInfo?.portalVisible ?? false)
    }
  }, [docInfo?.portalVisible, togglingVisibility])

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handleMouseEnter = () => {
    if (!hasThumbnail) return
    hoverTimer.current = setTimeout(() => setShowThumb(true), 400)
  }

  const handleMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setShowThumb(false)
  }

  const handleTogglePortalVisibility = async () => {
    // Turning ON an already-indexed personal document with no resolved owner
    // needs a decision, not a request — show the inline resolver instead of
    // letting the guard just throw a dead-end error.
    if (docInfo?.docId && !portalVisible && isUnresolvedPersonalDoc(docInfo)) {
      setShowResolver(true)
      return
    }
    setTogglingVisibility(true)
    try {
      // Showing a hidden file: ask whether to tell the client in chat BEFORE anything changes (Cancel = nothing changes).
      // A file with no CRM row yet is only known by its company, so the pop-up cannot tell if it is a personal document —
      // the message is only sent after, and only if the processed document turns out not to be personal.
      let decision: ShareDecision | null = null
      if (!portalVisible) {
        decision = await decideShare([docInfo?.docId ? { id: docInfo.docId, name: file.name, source: 'document' } : { id: accountId, name: file.name, source: 'account' }])
        if (decision.kind === 'cancel') return
      }
      const suppressChat = suppressesAutoChat(decision)
      const silent = isSilentShow(decision)
      if (docInfo?.docId) {
        // Already processed — just toggle visibility
        const { toggleDocumentPortalVisibility } = await import('@/app/(dashboard)/accounts/actions')
        const newVisible = !portalVisible
        const result = await toggleDocumentPortalVisibility(docInfo.docId, newVisible, undefined, suppressChat ? { suppressChat: true, ...(silent ? { silent: true } : {}) } : undefined)
        if (result.success) {
          setPortalVisible(newVisible)
          toast.success(`Portal visibility ${newVisible ? 'enabled' : 'disabled'}`)
          // Invalidate cache so docMap reflects new state on next page visit
          onRefresh()
          if (decision?.kind === 'send') await sendShareChat(decision.pick, [file.name])
        } else {
          toast.error(result.error || 'Failed to toggle visibility')
        }
      } else {
        // Not processed yet — process + share in one call
        const res = await fetch(`/api/accounts/${accountId}/files/process-and-share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: file.id, ...(suppressChat ? { suppressChat: true } : {}), ...(silent ? { silent: true } : {}) }),
        })
        // A server-side timeout/crash can return a non-JSON body — don't let
        // that throw and fall through to the generic catch-all below (R099).
        const data = await res.json().catch(() => ({}) as { success?: boolean; error?: string })
        if (res.ok && data.success) {
          setPortalVisible(true)
          toast.success('Document processed and shared with client')
          onRefresh()
          if (decision?.kind === 'send') {
            if ((data as { personal?: boolean }).personal) toast.info('This turned out to be a personal document, so no chat message was sent — its owner got the private notification.')
            else await sendShareChat(decision.pick, [file.name])
          }
        } else {
          toast.error(data.error || `Failed to process document (server error ${res.status})`)
        }
      }
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Failed to toggle visibility')
    } finally {
      setTogglingVisibility(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 hover:bg-zinc-50 transition-colors group text-sm">
      {shareDialog}

      {/* File icon with thumbnail hover */}
      <div
        className="shrink-0 relative"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {getFileIcon(file.mimeType)}
        {/* Thumbnail preview tooltip */}
        {showThumb && file.thumbnailLink && (
          <div className="absolute left-6 top-0 z-40 bg-white border rounded-lg shadow-xl p-1 pointer-events-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.thumbnailLink}
              alt={file.name}
              className="max-w-[220px] max-h-[160px] rounded object-contain"
              loading="eager"
            />
          </div>
        )}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <FastTooltip label={file.name}>
          <button
            onClick={() => onPreview(file)}
            className="text-left truncate block w-full text-zinc-900 hover:text-blue-600 transition-colors"
            aria-label={file.name}
          >
            {file.name}
          </button>
        </FastTooltip>
      </div>

      {/* Size + Date */}
      <span className="text-xs text-zinc-400 shrink-0 hidden sm:inline">
        {formatFileSize(file.size)}
      </span>
      <span className="text-xs text-zinc-400 shrink-0 hidden md:inline w-20 text-right">
        {formatDate(file.modifiedTime)}
      </span>

      {/* Quick preview button — magnifying glass to distinguish from portal toggle */}
      <FastTooltip label="Preview document">
        <button
          onClick={() => onPreview(file)}
          className="p-1 rounded hover:bg-blue-100 text-zinc-400 hover:text-blue-600 transition-colors shrink-0"
          aria-label="Preview document"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      </FastTooltip>

      {/* View OCR text — shown when this Drive file has a CRM document record */}
      {docInfo?.docId && onViewOcr && (
        <FastTooltip label="View OCR text">
          <button
            onClick={() => onViewOcr(docInfo.docId)}
            className="p-1 rounded hover:bg-blue-100 text-zinc-400 hover:text-blue-600 transition-colors shrink-0"
            aria-label="View OCR text"
          >
            <ScanText className="h-3.5 w-3.5" />
          </button>
        </FastTooltip>
      )}

      {/* Portal visibility toggle — shown for all files, processes unprocessed ones on click */}
      <FastTooltip label={portalVisible ? 'Visible to client — click to hide' : 'Hidden from client — click to show'}>
        <button
            onClick={handleTogglePortalVisibility}
            disabled={togglingVisibility}
            aria-label={portalVisible ? 'Visible to client — click to hide' : 'Hidden from client — click to show'}
            className={cn(
              'p-1 rounded transition-colors shrink-0',
              portalVisible
                ? 'text-green-600 hover:bg-green-50'
                : 'text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500'
            )}
          >
            {togglingVisibility ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : portalVisible ? (
              <Globe className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </button>
      </FastTooltip>

      {/* Context menu */}
      <div className="relative shrink-0" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="p-1 rounded hover:bg-zinc-200 text-zinc-400 hover:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <MoreVertical className="h-4 w-4" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-8 z-30 bg-white border rounded-lg shadow-lg py-1 w-48">
            <button
              onClick={() => { onPreview(file); setMenuOpen(false) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
            >
              <Eye className="h-3.5 w-3.5" /> Preview
            </button>
            {file.webViewLink && (
              <a
                href={file.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
                onClick={() => setMenuOpen(false)}
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open in Drive
              </a>
            )}

          </div>
        )}
      </div>

      {/* Inline "who is this for" resolution — replaces the old dead-end
          error toast for a personal document with no resolved owner */}
      {showResolver && docInfo?.docId && (
        <div className="basis-full mt-1.5">
          <ResolvePersonalDocument
            documentId={docInfo.docId}
            accountId={accountId}
            confidence={docInfo.confidence}
            updatedAt={docInfo.updatedAt}
            onResolved={() => { setShowResolver(false); onRefresh() }}
            onCancel={() => setShowResolver(false)}
          />
        </div>
      )}
    </div>
  )
}

// ─── FolderSection Component ──────────────────────────────

function FolderSection({
  folder,
  accountId,
  onRefresh,
  onPreview,
  onViewOcr,
  docMap,
  defaultExpanded = true,
  depth = 0,
}: {
  folder: FolderData
  accountId: string
  onRefresh: () => void
  onPreview: (file: DriveFile) => void
  onViewOcr?: (docId: string) => void
  docMap: Record<string, DocInfo>
  defaultExpanded?: boolean
  depth?: number
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const totalFiles = folder.files.length + folder.subfolders.reduce((sum, sf) => sum + sf.files.length, 0)

  return (
    <div className={cn(depth > 0 && 'ml-4')}>
      {/* Folder header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium transition-colors rounded-md text-zinc-700 hover:bg-zinc-100"
      >
        {expanded
          ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
          : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
        }
        {expanded
          ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
          : <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        }
        <span className="flex-1 text-left">{folder.name}</span>
        <span className="text-xs text-zinc-400">{totalFiles} file{totalFiles !== 1 ? 's' : ''}</span>
      </button>

      {/* Folder contents */}
      {expanded && (
        <div className="border-l ml-5 pl-0">
          {/* Files in this folder */}
          <div>
            {folder.files.map(file => (
              <FileRow
                key={file.id}
                file={file}
                accountId={accountId}
                onRefresh={onRefresh}
                onPreview={onPreview}
                onViewOcr={onViewOcr}
                docInfo={docMap[file.id]}
              />
            ))}
          </div>

          {/* Subfolders */}
          {folder.subfolders.map(sf => (
            <FolderSection
              key={sf.id}
              folder={sf}
              accountId={accountId}
              onRefresh={onRefresh}
              onPreview={onPreview}
              onViewOcr={onViewOcr}
              docMap={docMap}
              defaultExpanded={false}
              depth={depth + 1}
            />
          ))}

          {folder.files.length === 0 && folder.subfolders.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-400 italic">Empty folder</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main FileManager Component ───────────────────────────

// Stop Drive S2: this is the READ-ONLY view of a company's old Google Drive folder (the archive). There is no upload, rename, move,
// delete or drag-and-drop here any more — Drive is never written to; new files go to the CRM storage.
export function FileManager({ accountId, driveFolderId }: {
  accountId: string; driveFolderId: string | null; isAdmin?: boolean
  /** The account lists new-store (`store:`) documents — then look for its store view even with a Drive folder. */
  hasStoreRows?: boolean
}) {
  const queryClient = useQueryClient()
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null)
  const [ocrDocId, setOcrDocId] = useState<string | null>(null)
  const [folderAction, setFolderAction] = useState<'idle' | 'validating'>('idle')
  const [validationResult, setValidationResult] = useState<{ valid: boolean; missingSubfolders: string[]; fileCount: number } | null>(null)

  // A company whose files live in the NEW store (Formation pilot, sandbox only) gets the store view
  // instead of "Create / Link Drive folder". The route answers null outside the pilot environment.
  // always asked (one light, cached request): whether a company's files live in the new storage must not depend on which of its documents the page happened to load first
  const storeOwner = useStoreOwnerForAccount(accountId, true)

  const { data, isLoading, error } = useQuery<FilesResponse>({
    queryKey: ['account-files', accountId],
    queryFn: () => fetch(`/api/accounts/${accountId}/files`).then(r => r.json()),
    enabled: !!driveFolderId,
    staleTime: 30_000,
  })

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['account-files', accountId] })
  }, [queryClient, accountId])

  if (!driveFolderId && storeOwner.isLoading) {
    return <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
  }

  if (!driveFolderId && storeOwner.data?.ownerId) {
    return (
      <StoreReadOnlyPanel ownerId={storeOwner.data.ownerId} />
    )
  }

  if (!driveFolderId) {
    return (
      <div className="text-center py-12">
        <Folder className="h-8 w-8 mx-auto text-zinc-300" />
        <p className="mt-2 text-sm text-zinc-400">No files to show here.</p>
      </div>
    )
  }

  // moved from Drive to the new storage: staff work there only — the Drive folder stays as the backup
  if (storeOwner.data?.ownerId && storeOwner.data.moved) {
    const m = storeOwner.data.moved
    return (
      <div className="space-y-2">
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {m.status === 'moving' ? 'Being moved to the new storage — files are still arriving.' : m.status === 'incomplete' ? 'Moved to the new storage WITH PROBLEMS — some files did not come over (see the report above).' : `Moved to the new storage on ${new Date(m.finishedAt ?? m.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`}{' '}
          The Drive folder stays as a backup — work in Storage.{' '}
          {driveFolderId && <a href={`https://drive.google.com/drive/folders/${driveFolderId}`} target="_blank" rel="noreferrer" className="underline">Open the old Drive folder (backup)</a>}
        </p>
        <StoreReadOnlyPanel ownerId={storeOwner.data.ownerId} />
      </div>
    )
  }

  // a company with BOTH (several open formations at company creation: Drive ran as today, then the store
  // files were handed over) — its new-storage files are shown in every state of the Drive view (loading,
  // Drive error, loaded), because the flat list above hides them
  const storeSection = storeOwner.data?.ownerId ? (
    <div className="mb-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
      <p className="text-xs text-amber-800">This company also has files in the new CRM storage:</p>
      <StoreReadOnlyPanel ownerId={storeOwner.data.ownerId} />
    </div>
  ) : null

  if (isLoading) {
    return (
      <>
      {storeSection}
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        <span className="ml-2 text-sm text-zinc-400">Loading files from Drive...</span>
      </div>
      </>
    )
  }

  if (error || data?.error) {
    return (
      <>
      {storeSection}
      <div className="text-center py-12 text-zinc-400">
        <p>Failed to load files</p>
        <button onClick={handleRefresh} className="mt-2 text-sm text-blue-600 hover:underline">
          Try again
        </button>
      </div>
      </>
    )
  }

  const folders = data?.folders || []
  const rootFiles = data?.rootFiles || []
  const docMap = data?.docMap || {}
  const totalFiles = folders.reduce((sum, f) => sum + f.files.length + f.subfolders.reduce((s, sf) => s + sf.files.length, 0), 0) + rootFiles.length

  return (
    <div className="space-y-2">
      {storeSection}
      <OcrViewerModal documentId={ocrDocId} onClose={() => setOcrDocId(null)} />
      {/* Validation result banner */}
      {validationResult && (
        <div className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
          validationResult.valid ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
        )}>
          <ShieldCheck className="h-4 w-4 shrink-0" />
          {validationResult.valid
            ? `Folder valid — ${validationResult.fileCount} files`
            : `Missing subfolders: ${validationResult.missingSubfolders.join(', ')}`}
          <button onClick={() => setValidationResult(null)} className="ml-auto p-0.5 rounded hover:bg-white/50">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{totalFiles} files</p>
        <div className="flex items-center gap-1">
          <FastTooltip label="Validate folder structure">
            <button
              onClick={async () => {
                setFolderAction('validating')
                try {
                  const { validateFolder: validateFn } = await import('@/app/(dashboard)/accounts/folder-actions')
                  const result = await validateFn(accountId)
                  if (result.success && result.data) {
                    setValidationResult(result.data)
                  } else {
                    toast.error(result.error ?? 'Validation failed')
                  }
                } catch {
                  toast.error('Validation failed')
                } finally {
                  setFolderAction('idle')
                }
              }}
              disabled={folderAction === 'validating'}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100 transition-colors"
              aria-label="Validate folder structure"
            >
              {folderAction === 'validating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Validate
            </button>
          </FastTooltip>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Folder tree (read-only) */}
      <div>
        <div className="border rounded-lg bg-white divide-y-0">
          {folders.map(folder => (
            <FolderSection
              key={folder.id}
              folder={folder}
              accountId={accountId}
              onRefresh={handleRefresh}
              onPreview={setPreviewFile}
              onViewOcr={setOcrDocId}
              docMap={docMap}
            />
          ))}

          {/* Root files (not in any folder) */}
          {rootFiles.length > 0 && (
            <div className="pt-2">
              <p className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                Root files (not in any folder)
              </p>
              <div>
                {rootFiles.map(file => (
                  <FileRow
                    key={file.id}
                    file={file}
                    accountId={accountId}
                    onRefresh={handleRefresh}
                    onPreview={setPreviewFile}
                    onViewOcr={setOcrDocId}
                    docInfo={docMap[file.id]}
                  />
                ))}
              </div>
            </div>
          )}

          {totalFiles === 0 && (
            <div className="text-center py-8 text-zinc-400">
              <Folder className="h-6 w-6 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Drive folder is empty</p>
            </div>
          )}
        </div>
      </div>

      {/* Full-screen preview modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 bg-black/70 flex flex-col" onClick={() => setPreviewFile(null)}>
          <div className="flex items-center justify-between px-6 py-3 bg-zinc-900 text-white shrink-0">
            <div className="flex items-center gap-3">
              {getFileIcon(previewFile.mimeType)}
              <span className="font-medium text-sm">{previewFile.name}</span>
              <span className="text-xs text-zinc-400">{formatFileSize(previewFile.size)}</span>
            </div>
            <div className="flex items-center gap-2">
              {previewFile.webViewLink && (
                <a
                  href={previewFile.webViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
                  onClick={e => e.stopPropagation()}
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Drive
                </a>
              )}
              <button onClick={() => setPreviewFile(null)} className="p-1 hover:bg-zinc-700 rounded">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="flex-1 p-4" onClick={e => e.stopPropagation()}>
            <iframe
              src={`/api/drive-preview/${previewFile.id}`}
              className="w-full h-full rounded-lg border-0 bg-white"
            />
          </div>
        </div>
      )}
    </div>
  )
}
