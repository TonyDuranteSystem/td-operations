'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen,
  MoreVertical, Pencil, ArrowRight, ExternalLink, Eye,
  RefreshCw, Loader2, X, GripVertical, Image as ImageIcon, FileSpreadsheet,
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
}

interface FolderData {
  id: string
  name: string
  files: DriveFile[]
  subfolders: FolderData[]
}

interface FilesResponse {
  folders: FolderData[]
  rootFiles: DriveFile[]
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
}: {
  file: DriveFile
  accountId: string
  folders: FolderData[]
  index: number
  onRefresh: () => void
  onPreview: (file: DriveFile) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(file.name)
  const [saving, setSaving] = useState(false)
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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

          {/* File icon */}
          <div className="shrink-0">{getFileIcon(file.mimeType)}</div>

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
  defaultExpanded = true,
  depth = 0,
}: {
  folder: FolderData
  accountId: string
  allFolders: FolderData[]
  onRefresh: () => void
  onPreview: (file: DriveFile) => void
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

export function FileManager({ accountId, driveFolderId }: { accountId: string; driveFolderId: string | null }) {
  const queryClient = useQueryClient()
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null)

  const { data, isLoading, error } = useQuery<FilesResponse>({
    queryKey: ['account-files', accountId],
    queryFn: () => fetch(`/api/accounts/${accountId}/files`).then(r => r.json()),
    enabled: !!driveFolderId,
    staleTime: 30_000,
  })

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['account-files', accountId] })
  }, [queryClient, accountId])

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
    return (
      <div className="text-center py-12 text-zinc-400">
        <Folder className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No Google Drive folder linked to this account</p>
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
  const totalFiles = folders.reduce((sum, f) => sum + f.files.length + f.subfolders.reduce((s, sf) => s + sf.files.length, 0), 0) + rootFiles.length

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{totalFiles} files</p>
        <button
          onClick={handleRefresh}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

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
