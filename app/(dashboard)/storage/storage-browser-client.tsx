'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { FastTooltip } from '@/components/ui/fast-tooltip'

interface FolderNode {
  id: string
  parent_id: string | null
  name: string
}

interface FileRow {
  id: string
  folder_id?: string | null
  file_name: string
  mime_type: string | null
  file_size: number | null
  created_at?: string
}

interface FolderRow {
  id: string
  name: string
  created_at?: string
}

interface ContentsResponse {
  parent_id: string | null
  subfolders: FolderRow[]
  files: FileRow[]
}

type SelectedKey = string // `folder:<id>` or `file:<id>`

interface ContextMenuState {
  x: number
  y: number
  kind: 'folder' | 'file'
  id: string
  name: string
}

function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function jsonOrThrow(resOrPromise: Response | Promise<Response>) {
  const res = await resOrPromise
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Request failed')
  }
  return res.json()
}

export function StorageBrowserClient() {
  const [tree, setTree] = useState<FolderNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [contents, setContents] = useState<ContentsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOverContent, setDragOverContent] = useState(false)
  const [dragOverTreeId, setDragOverTreeId] = useState<string | null>(null)
  const [selectedItems, setSelectedItems] = useState<Set<SelectedKey>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renaming, setRenaming] = useState<{ kind: 'folder' | 'file'; id: string; value: string } | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [favFolders, setFavFolders] = useState<Set<string>>(new Set())
  const [togglingFavorites, setTogglingFavorites] = useState<Set<string>>(new Set())
  const [favFiles, setFavFiles] = useState<Set<string>>(new Set())
  const [favoritesList, setFavoritesList] = useState<{ folders: (FolderRow & { path: string })[]; files: (FileRow & { path: string })[] } | null>(null)
  const [showingFavorites, setShowingFavorites] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ folders: (FolderRow & { path: string })[]; files: (FileRow & { path: string })[] } | null>(null)
  const [movePicker, setMovePicker] = useState<{ folderIds: string[]; fileIds: string[] } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadTree = useCallback(async () => {
    try {
      const body = await jsonOrThrow(await fetch('/api/crm-storage/tree'))
      setTree(body.folders)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the folder tree')
    }
  }, [])

  const loadContents = useCallback(async (folderId: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const url = folderId ? `/api/crm-storage/folders?parent_id=${encodeURIComponent(folderId)}` : '/api/crm-storage/folders'
      const body = await jsonOrThrow(await fetch(url))
      setContents(body)
      setSelectedItems(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load folder contents')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadFavorites = useCallback(async () => {
    try {
      const body = await jsonOrThrow(await fetch('/api/crm-storage/favorites'))
      const folders = new Set<string>()
      const files = new Set<string>()
      for (const f of body.favorites as { folder_id: string | null; file_id: string | null }[]) {
        if (f.folder_id) folders.add(f.folder_id)
        if (f.file_id) files.add(f.file_id)
      }
      setFavFolders(folders)
      setFavFiles(files)
      setFavoritesList({ folders: body.folders ?? [], files: body.files ?? [] })
    } catch {
      // Favorites are a convenience layer — a failed load shouldn't block browsing.
    }
  }, [])

  useEffect(() => { loadTree(); loadFavorites() }, [loadTree, loadFavorites])
  useEffect(() => { loadContents(selectedFolderId) }, [selectedFolderId, loadContents])
  useEffect(() => { setShowingFavorites(false) }, [selectedFolderId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setContextMenu(null)
      setMovePicker(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const childrenByParent = useMemo(() => {
    const map = new Map<string, FolderNode[]>()
    for (const node of tree) {
      const key = node.parent_id ?? '__root__'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(node)
    }
    for (const list of Array.from(map.values())) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [tree])

  const nodeById = useMemo(() => new Map(tree.map(n => [n.id, n])), [tree])

  const breadcrumbs = useMemo(() => {
    const trail: FolderNode[] = []
    let current = selectedFolderId ? nodeById.get(selectedFolderId) : undefined
    while (current) {
      trail.unshift(current)
      current = current.parent_id ? nodeById.get(current.parent_id) : undefined
    }
    return trail
  }, [selectedFolderId, nodeById])

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Navigating to a folder always leaves the Favorites overlay, even when
  // the target folder is already the current selection (e.g. it was open
  // before Favorites was opened on top of it) — relying only on the
  // selectedFolderId-changed effect misses that case, since the id never
  // actually changes.
  function goToFolder(id: string | null) {
    setShowingFavorites(false)
    setSelectedFolderId(id)
  }

  async function refreshAfterChange() {
    // Favorites must be refetched here too — a starred item that gets
    // renamed, moved, or deleted elsewhere would otherwise keep showing
    // its old name/location, or keep showing at all, in the Favorites
    // view until something else happened to trigger a refetch.
    await Promise.all([loadTree(), loadContents(selectedFolderId), loadFavorites()])
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    // Each file is uploaded independently — one bad file (e.g. a name that
    // already exists) must not silently abandon the rest of the batch, and
    // the person needs to know exactly which ones failed and why.
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        const form = new FormData()
        form.append('file', file)
        if (selectedFolderId) form.append('folder_id', selectedFolderId)
        await jsonOrThrow(await fetch('/api/crm-storage/files', { method: 'POST', body: form }))
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`)
      }
    }
    // loadContents clears any error as part of its own refresh, so the
    // failure summary must be set AFTER it, not before — setting it first
    // would have it wiped out before the person ever saw it.
    await loadContents(selectedFolderId)
    if (failures.length > 0) {
      const succeeded = files.length - failures.length
      const prefix = succeeded > 0 ? `${succeeded} of ${files.length} uploaded. ` : ''
      setError(`${prefix}${failures.join('; ')}`)
    }
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function createFolder() {
    const trimmed = newFolderName.trim()
    if (!trimmed || creatingFolder) return
    setCreatingFolder(true)
    setError(null)
    try {
      await jsonOrThrow(await fetch('/api/crm-storage/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, parent_id: selectedFolderId }),
      }))
      setNewFolderName('')
      setNewFolderOpen(false)
      await refreshAfterChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder')
    } finally {
      setCreatingFolder(false)
    }
  }

  async function handleDownload(id: string, fileName: string) {
    try {
      const body = await jsonOrThrow(await fetch(`/api/crm-storage/files/${id}/download`))
      // The link now forces a real download itself (the server sets
      // Content-Disposition), so this doesn't need to open a new tab —
      // and shouldn't: a new tab left the person with a blank/empty tab
      // behind after the file saved, and it's what made downloading
      // several files in a row silently drop everything after the first
      // (a browser only allows one script-opened tab per click; each
      // later one in a loop gets blocked with no error).
      const a = document.createElement('a')
      a.href = body.url
      a.download = fileName
      a.click()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    }
  }

  async function submitRename() {
    if (!renaming) return
    const trimmed = renaming.value.trim()
    if (!trimmed) { setRenaming(null); return }
    try {
      if (renaming.kind === 'folder') {
        await jsonOrThrow(await fetch(`/api/crm-storage/folders/${renaming.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmed }),
        }))
      } else {
        await jsonOrThrow(await fetch(`/api/crm-storage/files/${renaming.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_name: trimmed }),
        }))
      }
      setRenaming(null)
      await refreshAfterChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed')
    }
  }

  async function deleteFolder(id: string, name: string) {
    if (!confirm(`Delete "${name}" and everything inside it? This can't be undone.`)) return
    try {
      await jsonOrThrow(await fetch(`/api/crm-storage/folders/${id}`, { method: 'DELETE' }))
      if (selectedFolderId === id) setSelectedFolderId(null)
      await refreshAfterChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  async function deleteFile(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return
    try {
      await jsonOrThrow(await fetch(`/api/crm-storage/files/${id}`, { method: 'DELETE' }))
      await refreshAfterChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  async function toggleFavorite(kind: 'folder' | 'file', id: string) {
    // A second rapid click before the first request finishes was racing
    // the same star against itself — both requests would read "not
    // starred yet" from the same stale state, the second would hit the
    // database's own duplicate guard, and the person would see a false
    // "failed to star" error for a star that actually succeeded.
    if (togglingFavorites.has(id)) return
    setTogglingFavorites(prev => new Set(prev).add(id))
    const isFav = kind === 'folder' ? favFolders.has(id) : favFiles.has(id)
    try {
      await jsonOrThrow(await fetch('/api/crm-storage/favorites', {
        method: isFav ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'folder' ? { folder_id: id } : { file_id: id }),
      }))
      await loadFavorites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update favorite')
    } finally {
      setTogglingFavorites(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  async function moveItemsTo(targetFolderId: string | null, folderIds: string[], fileIds: string[]) {
    // Each item is moved independently — Promise.all would reject on the
    // FIRST failure (e.g. one name collision at the destination) while the
    // other requests it already fired keep running to completion in the
    // background. That left people told "move failed" when most of what
    // they selected had, in fact, already moved.
    const failures: string[] = []
    for (const id of folderIds) {
      try {
        await jsonOrThrow(fetch(`/api/crm-storage/folders/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: targetFolderId }),
        }))
      } catch (err) {
        const name = tree.find(n => n.id === id)?.name ?? id
        failures.push(`${name}: ${err instanceof Error ? err.message : 'move failed'}`)
      }
    }
    for (const id of fileIds) {
      try {
        await jsonOrThrow(fetch(`/api/crm-storage/files/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_id: targetFolderId }),
        }))
      } catch (err) {
        const name = contents?.files.find(f => f.id === id)?.file_name ?? id
        failures.push(`${name}: ${err instanceof Error ? err.message : 'move failed'}`)
      }
    }
    await refreshAfterChange()
    if (failures.length > 0) {
      const total = folderIds.length + fileIds.length
      const succeeded = total - failures.length
      const prefix = succeeded > 0 ? `${succeeded} of ${total} moved. ` : ''
      setError(`${prefix}${failures.join('; ')}`)
    }
  }

  async function runSearch(q: string) {
    setSearchQuery(q)
    if (!q.trim()) { setSearchResults(null); return }
    setSelectedItems(new Set())
    try {
      const body = await jsonOrThrow(await fetch(`/api/crm-storage/search?q=${encodeURIComponent(q)}`))
      setSearchResults(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    }
  }

  function toggleSelect(key: SelectedKey) {
    setSelectedItems(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectedIds() {
    const folderIds: string[] = []
    const fileIds: string[] = []
    for (const key of Array.from(selectedItems)) {
      const [kind, id] = key.split(':')
      if (kind === 'folder') folderIds.push(id)
      else fileIds.push(id)
    }
    return { folderIds, fileIds }
  }

  async function bulkDelete() {
    const { folderIds, fileIds } = selectedIds()
    if (folderIds.length === 0 && fileIds.length === 0) return
    if (!confirm(`Delete ${folderIds.length + fileIds.length} selected item(s)? This can't be undone.`)) return

    // Same reasoning as moveItemsTo: report exactly what happened, not an
    // all-or-nothing verdict that can be wrong the moment two people (or
    // two tabs) touch the same item — e.g. someone else already deleted
    // one of the selected items a moment earlier.
    const failures: string[] = []
    for (const id of folderIds) {
      try {
        await jsonOrThrow(fetch(`/api/crm-storage/folders/${id}`, { method: 'DELETE' }))
      } catch (err) {
        const name = tree.find(n => n.id === id)?.name ?? id
        failures.push(`${name}: ${err instanceof Error ? err.message : 'delete failed'}`)
      }
    }
    for (const id of fileIds) {
      try {
        await jsonOrThrow(fetch(`/api/crm-storage/files/${id}`, { method: 'DELETE' }))
      } catch (err) {
        const name = contents?.files.find(f => f.id === id)?.file_name ?? id
        failures.push(`${name}: ${err instanceof Error ? err.message : 'delete failed'}`)
      }
    }
    await refreshAfterChange()
    if (failures.length > 0) {
      const total = folderIds.length + fileIds.length
      const succeeded = total - failures.length
      const prefix = succeeded > 0 ? `${succeeded} of ${total} deleted. ` : ''
      setError(`${prefix}${failures.join('; ')}`)
    }
  }

  async function bulkDownload() {
    const { fileIds } = selectedIds()
    for (const id of fileIds) {
      const file = contents?.files.find(f => f.id === id)
      if (file) await handleDownload(id, file.file_name)
    }
  }

  function renderTreeNode(node: FolderNode, depth: number) {
    const children = childrenByParent.get(node.id) ?? []
    const isExpanded = expanded.has(node.id)
    const isSelected = selectedFolderId === node.id
    const isDragOver = dragOverTreeId === node.id
    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-1 px-2 py-1.5 text-sm rounded cursor-pointer select-none ${isSelected ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100'} ${isDragOver ? 'ring-2 ring-blue-400' : ''}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => goToFolder(node.id)}
          onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, kind: 'folder', id: node.id, name: node.name }) }}
          draggable
          onDragStart={e => e.dataTransfer.setData('application/x-crm-storage', JSON.stringify({ kind: 'folder', id: node.id }))}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverTreeId(node.id) }}
          onDragLeave={() => setDragOverTreeId(prev => (prev === node.id ? null : prev))}
          onDrop={e => {
            e.preventDefault()
            e.stopPropagation()
            setDragOverTreeId(null)
            const raw = e.dataTransfer.getData('application/x-crm-storage')
            if (!raw) return
            const dropped = JSON.parse(raw) as { kind: 'folder' | 'file'; id: string }
            if (dropped.kind === 'folder' && dropped.id === node.id) return
            moveItemsTo(node.id, dropped.kind === 'folder' ? [dropped.id] : [], dropped.kind === 'file' ? [dropped.id] : [])
          }}
        >
          <button type="button" className="w-4 shrink-0 text-gray-400" onClick={e => { e.stopPropagation(); toggleExpand(node.id) }}>
            {children.length > 0 ? (isExpanded ? '▾' : '▸') : ''}
          </button>
          <span aria-hidden>📁</span>
          <span className="flex-1 truncate">{node.name}</span>
          {favFolders.has(node.id) && <span aria-hidden title="Starred">★</span>}
        </div>
        {isExpanded && children.map(child => renderTreeNode(child, depth + 1))}
      </div>
    )
  }

  const rootChildren = childrenByParent.get('__root__') ?? []

  return (
    <div className="flex h-[75vh] min-h-[500px] border border-gray-200 rounded-lg overflow-hidden bg-white" onClick={() => setContextMenu(null)}>
      {/* Left pane — persistent folder tree */}
      <div
        className={`w-64 shrink-0 border-r border-gray-200 overflow-y-auto py-2 ${dragOverTreeId === '__root__' ? 'ring-2 ring-inset ring-blue-400' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOverTreeId('__root__') }}
        onDrop={e => {
          e.preventDefault()
          setDragOverTreeId(null)
          const raw = e.dataTransfer.getData('application/x-crm-storage')
          if (!raw) return
          const dropped = JSON.parse(raw) as { kind: 'folder' | 'file'; id: string }
          moveItemsTo(null, dropped.kind === 'folder' ? [dropped.id] : [], dropped.kind === 'file' ? [dropped.id] : [])
        }}
      >
        <div
          className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded cursor-pointer ${showingFavorites ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100'}`}
          onClick={() => { setShowingFavorites(true); setSearchResults(null); setSearchQuery(''); setSelectedItems(new Set()) }}
        >
          <span aria-hidden>★</span>
          <span>Favorites</span>
        </div>
        <div
          className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded cursor-pointer ${selectedFolderId === null && !showingFavorites ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100'}`}
          onClick={() => goToFolder(null)}
        >
          <span aria-hidden>🗄️</span>
          <span>Storage</span>
        </div>
        {rootChildren.map(node => renderTreeNode(node, 0))}
      </div>

      {/* Right pane — current folder's contents */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-1 text-sm text-gray-600 min-w-0">
            {showingFavorites ? (
              <span className="font-medium text-gray-900 flex items-center gap-1"><span aria-hidden>★</span> Favorites</span>
            ) : (
              <>
                <button type="button" className="hover:text-blue-600 hover:underline shrink-0" onClick={() => goToFolder(null)}>Storage</button>
                {breadcrumbs.map(node => (
                  <span key={node.id} className="flex items-center gap-1 min-w-0">
                    <span className="text-gray-300">/</span>
                    <button type="button" className="hover:text-blue-600 hover:underline truncate" onClick={() => goToFolder(node.id)}>{node.name}</button>
                  </span>
                ))}
              </>
            )}
          </div>
          <div className="flex-1" />
          <input
            type="text"
            className="w-56 px-3 py-1.5 text-sm border border-gray-300 rounded-md"
            placeholder="Search all files and folders"
            value={searchQuery}
            onChange={e => runSearch(e.target.value)}
          />
          {!showingFavorites && (
            <>
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50"
                onClick={() => { setNewFolderOpen(s => !s); setNewFolderName(''); setError(null) }}
              >
                New folder
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? 'Uploading…' : 'Upload file'}
              </button>
            </>
          )}
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => handleUpload(e.target.files)} />
        </div>

        {newFolderOpen && (
          <div className="flex gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50">
            <input
              type="text"
              className="flex-1 max-w-sm px-3 py-1.5 text-sm border border-gray-300 rounded-md"
              placeholder="Folder name"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createFolder() }}
              autoFocus
            />
            <button type="button" className="px-3 py-1.5 text-sm rounded-md bg-gray-900 text-white disabled:opacity-50" disabled={creatingFolder} onClick={createFolder}>
              {creatingFolder ? 'Creating…' : 'Create'}
            </button>
          </div>
        )}

        {selectedItems.size > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-blue-50 text-sm">
            <span>{selectedItems.size} selected</span>
            <button type="button" className="px-2 py-1 rounded hover:bg-blue-100" onClick={bulkDownload}>Download</button>
            <button type="button" className="px-2 py-1 rounded hover:bg-blue-100" onClick={() => { const { folderIds, fileIds } = selectedIds(); setMovePicker({ folderIds, fileIds }) }}>Move to…</button>
            <button type="button" className="px-2 py-1 rounded text-red-600 hover:bg-red-100" onClick={bulkDelete}>Delete</button>
          </div>
        )}

        {error && (
          <div className="mx-4 mt-2 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">{error}</div>
        )}

        <div
          className={`flex-1 overflow-y-auto ${dragOverContent ? 'ring-2 ring-inset ring-blue-400' : ''}`}
          onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragOverContent(true) }}
          onDragLeave={() => setDragOverContent(false)}
          onDrop={e => {
            e.preventDefault()
            setDragOverContent(false)
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files)
          }}
        >
          {showingFavorites ? (
            <div className="divide-y divide-gray-100">
              {(!favoritesList || (favoritesList.folders.length === 0 && favoritesList.files.length === 0)) && (
                <div className="text-sm text-gray-400 py-12 text-center">
                  Nothing starred yet. Click the ☆ next to a folder or file to pin it here.
                </div>
              )}
              {favoritesList?.folders.map(f => (
                <button key={f.id} type="button" className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-gray-50" onClick={() => goToFolder(f.id)}>
                  <span aria-hidden>★</span>
                  <span aria-hidden>📁</span>
                  <span className="flex-1 min-w-0 truncate text-sm">{f.name}</span>
                  <span className="text-xs text-gray-400 truncate max-w-[40%]">{f.path}</span>
                </button>
              ))}
              {favoritesList?.files.map(f => (
                <button key={f.id} type="button" className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-gray-50" onClick={() => handleDownload(f.id, f.file_name)}>
                  <span aria-hidden>★</span>
                  <span aria-hidden>📄</span>
                  <span className="flex-1 min-w-0 truncate text-sm">{f.file_name}</span>
                  <span className="text-xs text-gray-400 truncate max-w-[40%]">{f.path}</span>
                </button>
              ))}
            </div>
          ) : searchResults ? (
            <div className="divide-y divide-gray-100">
              <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50">Search results for &quot;{searchQuery}&quot;</div>
              {searchResults.folders.length === 0 && searchResults.files.length === 0 && (
                <div className="text-sm text-gray-400 py-8 text-center">No matches</div>
              )}
              {searchResults.folders.map(f => (
                <button key={f.id} type="button" className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-gray-50" onClick={() => { setSearchQuery(''); setSearchResults(null); goToFolder(f.id) }}>
                  <span aria-hidden>📁</span>
                  <span className="flex-1 min-w-0 truncate text-sm">{f.name}</span>
                  <span className="text-xs text-gray-400 truncate max-w-[40%]">{f.path}</span>
                </button>
              ))}
              {searchResults.files.map(f => (
                <button key={f.id} type="button" className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-gray-50" onClick={() => handleDownload(f.id, f.file_name)}>
                  <span aria-hidden>📄</span>
                  <span className="flex-1 min-w-0 truncate text-sm">{f.file_name}</span>
                  <span className="text-xs text-gray-400 truncate max-w-[40%]">{f.path}</span>
                </button>
              ))}
            </div>
          ) : loading ? (
            <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {(!contents || (contents.subfolders.length === 0 && contents.files.length === 0)) && (
                <div className="text-sm text-gray-400 py-12 text-center">
                  This folder is empty. Drag files here, or use Upload file.
                </div>
              )}
              {contents && (contents.subfolders.length > 0 || contents.files.length > 0) && (
                <div className="flex items-center gap-2 px-4 py-1.5 bg-gray-50 text-xs text-gray-500">
                  <input
                    type="checkbox"
                    checked={selectedItems.size > 0 && selectedItems.size === contents.subfolders.length + contents.files.length}
                    onChange={e => {
                      if (e.target.checked) {
                        const all = new Set<SelectedKey>([
                          ...contents.subfolders.map(f => `folder:${f.id}` as SelectedKey),
                          ...contents.files.map(f => `file:${f.id}` as SelectedKey),
                        ])
                        setSelectedItems(all)
                      } else {
                        setSelectedItems(new Set())
                      }
                    }}
                  />
                  <span>Select all</span>
                </div>
              )}
              {contents?.subfolders.map(folder => {
                const key: SelectedKey = `folder:${folder.id}`
                const isDragOver = dragOverTreeId === folder.id
                return (
                  <div
                    key={folder.id}
                    className={`flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 ${isDragOver ? 'ring-2 ring-inset ring-blue-400' : ''}`}
                    onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, kind: 'folder', id: folder.id, name: folder.name }) }}
                    draggable
                    onDragStart={e => e.dataTransfer.setData('application/x-crm-storage', JSON.stringify({ kind: 'folder', id: folder.id }))}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverTreeId(folder.id) }}
                    onDragLeave={() => setDragOverTreeId(prev => (prev === folder.id ? null : prev))}
                    onDrop={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      setDragOverTreeId(null)
                      const raw = e.dataTransfer.getData('application/x-crm-storage')
                      if (!raw) return
                      const dropped = JSON.parse(raw) as { kind: 'folder' | 'file'; id: string }
                      if (dropped.kind === 'folder' && dropped.id === folder.id) return
                      moveItemsTo(folder.id, dropped.kind === 'folder' ? [dropped.id] : [], dropped.kind === 'file' ? [dropped.id] : [])
                    }}
                  >
                    <input type="checkbox" checked={selectedItems.has(key)} onChange={() => toggleSelect(key)} onClick={e => e.stopPropagation()} />
                    <span aria-hidden>📁</span>
                    {renaming?.kind === 'folder' && renaming.id === folder.id ? (
                      <input
                        className="flex-1 min-w-0 px-2 py-0.5 text-sm border border-gray-300 rounded"
                        value={renaming.value}
                        onChange={e => setRenaming({ ...renaming, value: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(null) }}
                        onBlur={submitRename}
                        autoFocus
                      />
                    ) : (
                      <button type="button" className="flex-1 min-w-0 text-left text-sm truncate hover:text-blue-600" onDoubleClick={() => goToFolder(folder.id)}>{folder.name}</button>
                    )}
                    <FastTooltip label={favFolders.has(folder.id) ? 'Unstar' : 'Star'}>
                      <button type="button" className="text-xs" onClick={() => toggleFavorite('folder', folder.id)} aria-label={favFolders.has(folder.id) ? 'Unstar' : 'Star'}>
                        {favFolders.has(folder.id) ? '★' : '☆'}
                      </button>
                    </FastTooltip>
                    <button type="button" className="px-2 py-1 text-xs text-gray-500 hover:text-gray-900" onClick={() => goToFolder(folder.id)}>Open</button>
                    <button type="button" className="px-2 py-1 text-xs text-gray-500 hover:text-gray-900" onClick={() => setRenaming({ kind: 'folder', id: folder.id, value: folder.name })}>Rename</button>
                    <button type="button" className="px-2 py-1 text-xs text-red-500 hover:text-red-700" onClick={() => deleteFolder(folder.id, folder.name)}>Delete</button>
                  </div>
                )
              })}
              {contents?.files.map(file => {
                const key: SelectedKey = `file:${file.id}`
                return (
                  <div
                    key={file.id}
                    className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50"
                    onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, kind: 'file', id: file.id, name: file.file_name }) }}
                    draggable
                    onDragStart={e => e.dataTransfer.setData('application/x-crm-storage', JSON.stringify({ kind: 'file', id: file.id }))}
                  >
                    <input type="checkbox" checked={selectedItems.has(key)} onChange={() => toggleSelect(key)} />
                    <span aria-hidden>📄</span>
                    {renaming?.kind === 'file' && renaming.id === file.id ? (
                      <input
                        className="flex-1 min-w-0 px-2 py-0.5 text-sm border border-gray-300 rounded"
                        value={renaming.value}
                        onChange={e => setRenaming({ ...renaming, value: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(null) }}
                        onBlur={submitRename}
                        autoFocus
                      />
                    ) : (
                      <button type="button" className="flex-1 min-w-0 text-left text-sm truncate hover:text-blue-600" onClick={() => handleDownload(file.id, file.file_name)}>{file.file_name}</button>
                    )}
                    <span className="text-xs text-gray-400 shrink-0">{formatSize(file.file_size)}</span>
                    <FastTooltip label={favFiles.has(file.id) ? 'Unstar' : 'Star'}>
                      <button type="button" className="text-xs" onClick={() => toggleFavorite('file', file.id)} aria-label={favFiles.has(file.id) ? 'Unstar' : 'Star'}>
                        {favFiles.has(file.id) ? '★' : '☆'}
                      </button>
                    </FastTooltip>
                    <button type="button" className="px-2 py-1 text-xs text-gray-500 hover:text-gray-900" onClick={() => setRenaming({ kind: 'file', id: file.id, value: file.file_name })}>Rename</button>
                    <button type="button" className="px-2 py-1 text-xs text-red-500 hover:text-red-700" onClick={() => deleteFile(file.id, file.file_name)}>Delete</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 bg-white border border-gray-200 rounded-md shadow-lg py-1 text-sm min-w-[140px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.kind === 'folder' && (
            <button type="button" className="w-full text-left px-3 py-1.5 hover:bg-gray-100" onClick={() => { goToFolder(contextMenu.id); setContextMenu(null) }}>Open</button>
          )}
          <button type="button" className="w-full text-left px-3 py-1.5 hover:bg-gray-100" onClick={() => { setRenaming({ kind: contextMenu.kind, id: contextMenu.id, value: contextMenu.name }); setContextMenu(null) }}>Rename</button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100"
            onClick={() => { toggleFavorite(contextMenu.kind, contextMenu.id); setContextMenu(null) }}
          >
            {(contextMenu.kind === 'folder' ? favFolders : favFiles).has(contextMenu.id) ? 'Unstar' : 'Star'}
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50"
            onClick={() => { contextMenu.kind === 'folder' ? deleteFolder(contextMenu.id, contextMenu.name) : deleteFile(contextMenu.id, contextMenu.name); setContextMenu(null) }}
          >
            Delete
          </button>
        </div>
      )}

      {movePicker && (() => {
        // Disable the folder(s) being moved AND all of their own descendants
        // — moving a folder into one of its own subfolders is invalid, and
        // the picker should never offer a destination the server would
        // reject, rather than let someone pick it and then explain why not.
        const disabled = new Set(movePicker.folderIds)
        const queue = [...movePicker.folderIds]
        while (queue.length > 0) {
          const current = queue.shift()!
          for (const child of childrenByParent.get(current) ?? []) {
            disabled.add(child.id)
            queue.push(child.id)
          }
        }

        function renderPickerNode(node: FolderNode, depth: number) {
          const children = childrenByParent.get(node.id) ?? []
          return (
            <div key={node.id}>
              <button
                type="button"
                className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-gray-100 truncate disabled:opacity-40 disabled:hover:bg-transparent"
                style={{ paddingLeft: `${8 + depth * 16}px` }}
                disabled={disabled.has(node.id)}
                onClick={() => { moveItemsTo(node.id, movePicker.folderIds, movePicker.fileIds); setMovePicker(null) }}
              >
                📁 {node.name}
              </button>
              {children.map(child => renderPickerNode(child, depth + 1))}
            </div>
          )
        }

        return (
          <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setMovePicker(null)}>
            <div className="bg-white rounded-lg shadow-xl w-80 max-h-[70vh] overflow-y-auto p-3" onClick={e => e.stopPropagation()}>
              <div className="text-sm font-medium mb-2 px-1">Move to…</div>
              <button
                type="button"
                className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-gray-100"
                onClick={() => { moveItemsTo(null, movePicker.folderIds, movePicker.fileIds); setMovePicker(null) }}
              >
                🗄️ Storage (root)
              </button>
              {rootChildren.map(node => renderPickerNode(node, 0))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
