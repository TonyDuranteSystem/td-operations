'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen,
  MoreVertical, Pencil, ArrowRight, ExternalLink, Eye, EyeOff, Trash2, Search,
  RefreshCw, Loader2, X, GripVertical, Image as ImageIcon, FileSpreadsheet, Globe,
  FolderPlus, Link2, ShieldCheck, Upload,
} from 'lucide-react'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

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
  folders,
  index,
  onRefresh,
  onPreview,
  docInfo,
}: {
  file: DriveFile
  accountId: string
  folders: FolderData[]
  index: number
  onRefresh: () => void
  onPreview: (file: DriveFile) => void
  docInfo?: DocInfo
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(file.name)
  const [saving, setSaving] = useState(false)
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showThumb, setShowThumb] = useState(false)
  const [portalVisible, setPortalVisible] = useState(docInfo?.portalVisible ?? false)
  const [togglingVisibility, setTogglingVisibility] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasThumbnail = !!file.thumbnailLink

  // Sync local state when docInfo prop changes (e.g., after React Query refetch)
  useEffect(() => {
    if (!togglingVisibility) {
      setPortalVisible(docInfo?.portalVisible ?? false)
    }
  }, [docInfo?.portalVisible, togglingVisibility])

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      // Select name without extension
      const dotIdx = file.name.lastIndexOf('.')
      inputRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : file.name.length)
    }
  }, [renaming, file.name])

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setMoveMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handleRename = async () => {
    if (!newName.trim() || newName === file.name) {
      setRenaming(false)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/accounts/${accountId}/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.id, newName: newName.trim() }),
      })
      if (!res.ok) throw new Error('Rename failed')
      toast.success(`Renamed to "${newName.trim()}"`)
      onRefresh()
    } catch {
      toast.error('Failed to rename file')
    } finally {
      setSaving(false)
      setRenaming(false)
    }
  }

  const handleMove = async (targetFolder: FolderData) => {
    setMenuOpen(false)
    setMoveMenuOpen(false)
    try {
      const res = await fetch(`/api/accounts/${accountId}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: file.id,
          targetFolderId: targetFolder.id,
          targetFolderName: targetFolder.name,
        }),
      })
      if (!res.ok) throw new Error('Move failed')
      toast.success(`Moved "${file.name}" to ${targetFolder.name}`)
      onRefresh()
    } catch {
      toast.error('Failed to move file')
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/accounts/${accountId}/files/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.id }),
      })
      if (!res.ok) throw new Error('Delete failed')
      toast.success(`"${file.name}" moved to trash`)
      onRefresh()
    } catch {
      toast.error('Failed to delete file')
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
      setMenuOpen(false)
    }
  }

  const handleMouseEnter = () => {
    if (!hasThumbnail) return
    hoverTimer.current = setTimeout(() => setShowThumb(true), 400)
  }

  const handleMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setShowThumb(false)
  }

  const handleTogglePortalVisibility = async () => {
    setTogglingVisibility(true)
    try {
      if (docInfo?.docId) {
        // Already processed — just toggle visibility
        const { toggleDocumentPortalVisibility } = await import('@/app/(dashboard)/accounts/actions')
        const newVisible = !portalVisible
        const result = await toggleDocumentPortalVisibility(docInfo.docId, newVisible)
        if (result.success) {
          setPortalVisible(newVisible)
          toast.success(`Portal visibility ${newVisible ? 'enabled' : 'disabled'}`)
          // Invalidate cache so docMap reflects new state on next page visit
          onRefresh()
        } else {
          toast.error('Failed to toggle visibility')
        }
      } else {
        // Not processed yet — process + share in one call
        const res = await fetch(`/api/accounts/${accountId}/files/process-and-share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: file.id }),
        })
        const data = await res.json()
        if (res.ok && data.success) {
          setPortalVisible(true)
          toast.success('Document processed and shared with client')
          onRefresh()
        } else {
          toast.error(data.error || 'Failed to process document')
        }
      }
    } catch {
      toast.error('Failed to toggle visibility')
    } finally {
      setTogglingVisibility(false)
    }
  }

  return (
    <Draggable draggableId={file.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className={cn(
            'flex items-center gap-2 px-3 py-2 hover:bg-zinc-50 transition-colors group text-sm',
            snapshot.isDragging && 'bg-blue-50 shadow-lg rounded-lg border border-blue-200'
          )}
        >
          {/* Drag handle */}
          <div {...provided.dragHandleProps} className="opacity-0 group-hover:opacity-40 hover:!opacity-100 cursor-grab active:cursor-grabbing shrink-0">
            <GripVertical className="h-3.5 w-3.5 text-zinc-400" />
          </div>

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

          {/* Name (or rename input) */}
          <div className="flex-1 min-w-0">
            {renaming ? (
              <div className="flex items-center gap-1">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRename()
                    if (e.key === 'Escape') { setRenaming(false); setNewName(file.name) }
                  }}
                  onBlur={handleRename}
                  disabled={saving}
                  className="flex-1 text-sm px-1.5 py-0.5 border rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none min-w-0"
                />
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400 shrink-0" />}
              </div>
            ) : (
              <button
                onClick={() => onPreview(file)}
                className="text-left truncate block w-full text-zinc-900 hover:text-blue-600 transition-colors"
                title={file.name}
              >
                {file.name}
              </button>
            )}
          </div>

          {/* Size + Date */}
          <span className="text-xs text-zinc-400 shrink-0 hidden sm:inline">
            {formatFileSize(file.size)}
          </span>
          <span className="text-xs text-zinc-400 shrink-0 hidden md:inline w-20 text-right">
            {formatDate(file.modifiedTime)}
          </span>

          {/* Quick preview button — magnifying glass to distinguish from portal toggle */}
          <button
            onClick={() => onPreview(file)}
            className="p-1 rounded hover:bg-blue-100 text-zinc-400 hover:text-blue-600 transition-colors shrink-0"
            title="Preview document"
          >
            <Search className="h-3.5 w-3.5" />
          </button>

          {/* Portal visibility toggle — shown for all files, processes unprocessed ones on click */}
          <button
              onClick={handleTogglePortalVisibility}
              disabled={togglingVisibility}
              title={portalVisible ? 'Visible to client — click to hide' : 'Hidden from client — click to show'}
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

          {/* Context menu */}
          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={() => { setMenuOpen(!menuOpen); setMoveMenuOpen(false) }}
              className="p-1 rounded hover:bg-zinc-200 text-zinc-400 hover:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <MoreVertical className="h-4 w-4" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-8 z-30 bg-white border rounded-lg shadow-lg py-1 w-48">
                <button
                  onClick={() => { setMenuOpen(false); setRenaming(true); setNewName(file.name) }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </button>
                <button
                  onClick={() => setMoveMenuOpen(!moveMenuOpen)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  <ArrowRight className="h-3.5 w-3.5" /> Move to...
                </button>
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

                {/* Delete */}
                <div className="border-t mt-1 pt-1">
                  {!confirmDelete ? (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  ) : (
                    <div className="px-3 py-1.5">
                      <p className="text-xs text-red-600 mb-1.5">Move to trash? (recoverable 30 days)</p>
                      <div className="flex gap-1.5">
                        <button
                          onClick={handleDelete}
                          disabled={deleting}
                          className="flex-1 text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          {deleting ? 'Deleting...' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="flex-1 text-xs px-2 py-1 bg-zinc-100 text-zinc-600 rounded hover:bg-zinc-200"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Move submenu */}
                {moveMenuOpen && (
                  <div className="border-t mt-1 pt-1">
                    <p className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Move to folder</p>
                    {folders.map(f => (
                      <button
                        key={f.id}
                        onClick={() => handleMove(f)}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-blue-50 hover:text-blue-600"
                      >
                        <Folder className="h-3.5 w-3.5" /> {f.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Draggable>
  )
}

// ─── FolderSection Component ──────────────────────────────

function FolderSection({
  folder,
  accountId,
  allFolders,
  onRefresh,
  onPreview,
  docMap,
  defaultExpanded = true,
  depth = 0,
}: {
  folder: FolderData
  accountId: string
  allFolders: FolderData[]
  onRefresh: () => void
  onPreview: (file: DriveFile) => void
  docMap: Record<string, DocInfo>
  defaultExpanded?: boolean
  depth?: number
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const totalFiles = folder.files.length + folder.subfolders.reduce((sum, sf) => sum + sf.files.length, 0)

  return (
    <div className={cn(depth > 0 && 'ml-4')}>
      {/* Folder header — droppable target */}
      <Droppable droppableId={`folder:${folder.id}:${folder.name}`} isDropDisabled={false}>
        {(provided, snapshot) => (
          <div ref={provided.innerRef} {...provided.droppableProps}>
            <button
              onClick={() => setExpanded(!expanded)}
              className={cn(
                'flex items-center gap-2 w-full px-3 py-2 text-sm font-medium transition-colors rounded-md',
                snapshot.isDraggingOver
                  ? 'bg-blue-100 text-blue-700 ring-2 ring-blue-300'
                  : 'text-zinc-700 hover:bg-zinc-100'
              )}
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
            {/* Hidden placeholder — we don't render draggables inside droppable header */}
            <div className="hidden">{provided.placeholder}</div>
          </div>
        )}
      </Droppable>

      {/* Folder contents */}
      {expanded && (
        <div className="border-l ml-5 pl-0">
          {/* Files in this folder */}
          <Droppable droppableId={`files:${folder.id}:${folder.name}`}>
            {(provided) => (
              <div ref={provided.innerRef} {...provided.droppableProps}>
                {folder.files.map((file, idx) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    accountId={accountId}
                    folders={allFolders}
                    index={idx}
                    onRefresh={onRefresh}
                    onPreview={onPreview}
                    docInfo={docMap[file.id]}
                  />
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>

          {/* Subfolders */}
          {folder.subfolders.map(sf => (
            <FolderSection
              key={sf.id}
              folder={sf}
              accountId={accountId}
              allFolders={allFolders}
              onRefresh={onRefresh}
              onPreview={onPreview}
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

// Hard-coded base types for the account-side upload. These always appear in
// the dropdown; any additional custom types ever uploaded (anywhere) are
// merged in at runtime from /api/crm/admin-actions/document-types so that a
// user typing a new name via the "Custom" option sees it permanently the
// next time they upload.
const ACCOUNT_UPLOAD_BASE_TYPES = [
  'Articles of Organization',
  'Operating Agreement',
  'EIN Letter',
  'Bank Statement',
  'Tax Return',
  'IRS Notice',
  'Invoice',
  'Contract',
] as const

const ACCOUNT_UPLOAD_CATEGORIES = ['Company', 'Tax', 'Banking', 'Correspondence'] as const

export function FileManager({ accountId, driveFolderId }: { accountId: string; driveFolderId: string | null; isAdmin?: boolean }) {
  const queryClient = useQueryClient()
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null)
  const [folderAction, setFolderAction] = useState<'idle' | 'creating' | 'linking' | 'validating'>('idle')
  const [linkFolderId, setLinkFolderId] = useState('')
  const [validationResult, setValidationResult] = useState<{ valid: boolean; missingSubfolders: string[]; fileCount: number } | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadType, setUploadType] = useState<string>(ACCOUNT_UPLOAD_BASE_TYPES[0])
  const [customType, setCustomType] = useState('')
  const [uploadCategory, setUploadCategory] = useState<string>(ACCOUNT_UPLOAD_CATEGORIES[0])
  const [displayName, setDisplayName] = useState('')
  const uploadInputRef = useRef<HTMLInputElement | null>(null)

  const { data: typesData } = useQuery<{ types: string[] }>({
    queryKey: ['document-types'],
    queryFn: () => fetch('/api/crm/admin-actions/document-types').then(r => r.json()),
    staleTime: 60_000,
    enabled: showUpload,
  })

  const availableTypes = (() => {
    const base = new Set<string>(ACCOUNT_UPLOAD_BASE_TYPES)
    for (const t of typesData?.types ?? []) base.add(t)
    return Array.from(base).sort((a, b) => a.localeCompare(b))
  })()

  const { data, isLoading, error } = useQuery<FilesResponse>({
    queryKey: ['account-files', accountId],
    queryFn: () => fetch(`/api/accounts/${accountId}/files`).then(r => r.json()),
    enabled: !!driveFolderId,
    staleTime: 30_000,
  })

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['account-files', accountId] })
  }, [queryClient, accountId])

  const resetUploadForm = useCallback(() => {
    setShowUpload(false)
    setCustomType('')
    setDisplayName('')
    if (uploadInputRef.current) uploadInputRef.current.value = ''
  }, [])

  const handleFileUpload = useCallback(async (file: File) => {
    const isCustom = uploadType === 'Custom'
    const resolvedType = isCustom ? customType.trim() : uploadType
    if (!resolvedType) {
      toast.error('Enter a name for the custom document type')
      return
    }

    setUploading(true)
    try {
      // 1. Signed URL for Supabase Storage (bypass Vercel 4.5MB body limit)
      const storagePath = `crm-account-uploads/${accountId}/${Date.now()}_${file.name}`
      const sigRes = await fetch('/api/storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'onboarding-uploads',
          path: storagePath,
          contentType: file.type,
        }),
      })
      const { signedUrl } = await sigRes.json()
      if (!signedUrl) {
        toast.error('Failed to get upload URL')
        return
      }

      // 2. PUT file to Storage via signed URL
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!putRes.ok) {
        toast.error('File upload failed')
        return
      }

      // 3. Register in CRM (Drive upload + documents row)
      const apiRes = await fetch('/api/crm/admin-actions/upload-account-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type,
          document_type: resolvedType,
          category: uploadCategory,
          display_name: displayName.trim() || undefined,
        }),
      })
      const data = await apiRes.json()
      if (data.success) {
        toast.success(data.detail)
        if (data.side_effects?.length) toast.info(data.side_effects.join(' | '))
        resetUploadForm()
        queryClient.invalidateQueries({ queryKey: ['document-types'] })
        handleRefresh()
      } else {
        toast.error(data.detail || 'Upload failed')
      }
    } catch {
      toast.error('Upload error — check file size (max 50MB)')
    } finally {
      setUploading(false)
    }
  }, [accountId, uploadType, customType, uploadCategory, displayName, resetUploadForm, queryClient, handleRefresh])

  const handleDragEnd = useCallback(async (result: DropResult) => {
    const { draggableId, destination } = result
    if (!destination) return

    // Parse destination droppable ID: "folder:{folderId}:{folderName}" or "files:{folderId}:{folderName}"
    const parts = destination.droppableId.split(':')
    if (parts.length < 3) return

    const targetFolderId = parts[1]
    const targetFolderName = parts.slice(2).join(':') // folder name might contain colons

    // Find the file being dragged
    const allFiles = [
      ...(data?.rootFiles || []),
      ...(data?.folders || []).flatMap(f => [...f.files, ...f.subfolders.flatMap(sf => sf.files)]),
    ]
    const file = allFiles.find(f => f.id === draggableId)
    if (!file) return

    try {
      const res = await fetch(`/api/accounts/${accountId}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: draggableId, targetFolderId, targetFolderName }),
      })
      if (!res.ok) throw new Error('Move failed')
      toast.success(`Moved "${file.name}" to ${targetFolderName}`)
      handleRefresh()
    } catch {
      toast.error('Failed to move file')
    }
  }, [data, accountId, handleRefresh])

  if (!driveFolderId) {
    const handleCreate = async () => {
      setFolderAction('creating')
      try {
        const { createCompanyFolder } = await import('@/app/(dashboard)/accounts/folder-actions')
        const result = await createCompanyFolder(accountId)
        if (result.success) {
          toast.success('Company folder created')
          window.location.reload()
        } else {
          toast.error(result.error ?? 'Failed to create folder')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create folder')
      } finally {
        setFolderAction('idle')
      }
    }

    const handleLink = async () => {
      if (!linkFolderId.trim()) return
      setFolderAction('linking')
      try {
        const { linkDriveFolder } = await import('@/app/(dashboard)/accounts/folder-actions')
        const result = await linkDriveFolder(accountId, linkFolderId.trim())
        if (result.success) {
          toast.success('Drive folder linked')
          window.location.reload()
        } else {
          toast.error(result.error ?? 'Failed to link folder')
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to link folder')
      } finally {
        setFolderAction('idle')
      }
    }

    return (
      <div className="text-center py-12 space-y-4">
        <Folder className="h-8 w-8 mx-auto text-zinc-300" />
        <p className="text-sm text-zinc-400">No Google Drive folder linked to this account</p>
        <div className="flex justify-center gap-3">
          <button
            onClick={handleCreate}
            disabled={folderAction !== 'idle'}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {folderAction === 'creating' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
            Create Company Folder
          </button>
        </div>
        <div className="max-w-sm mx-auto">
          <p className="text-xs text-zinc-400 mb-2">Or link an existing Drive folder by ID:</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={linkFolderId}
              onChange={e => setLinkFolderId(e.target.value)}
              placeholder="Drive folder ID"
              className="flex-1 px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleLink}
              disabled={folderAction !== 'idle' || !linkFolderId.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
            >
              {folderAction === 'linking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              Link
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        <span className="ml-2 text-sm text-zinc-400">Loading files from Drive...</span>
      </div>
    )
  }

  if (error || data?.error) {
    return (
      <div className="text-center py-12 text-zinc-400">
        <p>Failed to load files</p>
        <button onClick={handleRefresh} className="mt-2 text-sm text-blue-600 hover:underline">
          Try again
        </button>
      </div>
    )
  }

  const folders = data?.folders || []
  const rootFiles = data?.rootFiles || []
  const docMap = data?.docMap || {}
  const totalFiles = folders.reduce((sum, f) => sum + f.files.length + f.subfolders.reduce((s, sf) => s + sf.files.length, 0), 0) + rootFiles.length

  return (
    <div className="space-y-2">
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
          <button
            onClick={() => setShowUpload(v => !v)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 transition-colors"
          >
            <Upload className="h-3.5 w-3.5" /> Upload Document
          </button>
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
            title="Validate folder structure"
          >
            {folderAction === 'validating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            Validate
          </button>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Upload panel */}
      {showUpload && (
        <div className="rounded-lg border bg-white p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
              Type
              <select
                value={uploadType}
                onChange={e => setUploadType(e.target.value)}
                className="min-w-[180px] text-sm border rounded-lg px-3 py-1.5 bg-white"
                disabled={uploading}
              >
                {availableTypes.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
                <option value="Custom">Custom…</option>
              </select>
            </label>
            {uploadType === 'Custom' && (
              <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
                Custom type name
                <input
                  type="text"
                  value={customType}
                  onChange={e => setCustomType(e.target.value)}
                  placeholder="e.g. DBA, Certificate of Incumbency"
                  className="min-w-[220px] text-sm border rounded-lg px-3 py-1.5 bg-white"
                  disabled={uploading}
                />
              </label>
            )}
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
              Category
              <select
                value={uploadCategory}
                onChange={e => setUploadCategory(e.target.value)}
                className="min-w-[160px] text-sm border rounded-lg px-3 py-1.5 bg-white"
                disabled={uploading}
              >
                {ACCOUNT_UPLOAD_CATEGORIES.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 flex-1 min-w-[220px]">
              Display name <span className="text-zinc-400 font-normal">(optional)</span>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Leave blank to use the original filename"
                className="text-sm border rounded-lg px-3 py-1.5 bg-white"
                disabled={uploading}
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={uploadInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) handleFileUpload(f)
              }}
              disabled={uploading}
              className="flex-1 text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium file:cursor-pointer hover:file:bg-blue-100 disabled:opacity-50"
            />
            {uploading && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
            <button
              onClick={resetUploadForm}
              disabled={uploading}
              className="text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Folder tree with drag-drop */}
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="border rounded-lg bg-white divide-y-0">
          {folders.map(folder => (
            <FolderSection
              key={folder.id}
              folder={folder}
              accountId={accountId}
              allFolders={folders}
              onRefresh={handleRefresh}
              onPreview={setPreviewFile}
              docMap={docMap}
            />
          ))}

          {/* Root files (not in any folder) */}
          {rootFiles.length > 0 && (
            <div className="pt-2">
              <p className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                Root files (not in any folder)
              </p>
              <Droppable droppableId={`files:${driveFolderId}:root`}>
                {(provided) => (
                  <div ref={provided.innerRef} {...provided.droppableProps}>
                    {rootFiles.map((file, idx) => (
                      <FileRow
                        key={file.id}
                        file={file}
                        accountId={accountId}
                        folders={folders}
                        index={idx}
                        onRefresh={handleRefresh}
                        onPreview={setPreviewFile}
                        docInfo={docMap[file.id]}
                      />
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </div>
          )}

          {totalFiles === 0 && (
            <div className="text-center py-8 text-zinc-400">
              <Folder className="h-6 w-6 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Drive folder is empty</p>
            </div>
          )}
        </div>
      </DragDropContext>

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
