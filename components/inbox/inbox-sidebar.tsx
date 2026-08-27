'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Inbox, Send, FileText, Star, Trash2, Plus, X, FolderOpen, Loader2, Tag, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { ARCHIVED_VIEW_ID } from '@/lib/inbox/view-query'

interface Label {
  id: string
  name: string
  type: 'system' | 'user'
  unread: number
  total: number
}

interface InboxSidebarProps {
  activeLabel: string | null
  onLabelChange: (labelId: string | null) => void
  /** Which Gmail mailbox is being viewed — labels and counts are per-mailbox */
  mailbox?: string
}

const systemIcons: Record<string, React.ElementType> = {
  INBOX: Inbox,
  SENT: Send,
  DRAFT: FileText,
  STARRED: Star,
  TRASH: Trash2,
}

const systemNames: Record<string, string> = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  DRAFT: 'Drafts',
  STARRED: 'Starred',
  TRASH: 'Trash',
}

export function InboxSidebar({ activeLabel, onLabelChange, mailbox }: InboxSidebarProps) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const queryClient = useQueryClient()

  const { data } = useQuery<{ labels: Label[] }>({
    queryKey: ['gmail-labels', mailbox],
    queryFn: () => fetch(`/api/inbox/labels${mailbox ? `?mailbox=${mailbox}` : ''}`).then(r => r.json()),
    refetchInterval: 60_000,
  })

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/inbox/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mailbox }),
      })
      if (!res.ok) throw new Error('Failed to create folder')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      setCreating(false)
      setNewName('')
      toast.success('Folder created')
    },
    onError: () => toast.error('Failed to create folder'),
  })

  const deleteMutation = useMutation({
    mutationFn: async (labelId: string) => {
      const res = await fetch('/api/inbox/labels', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId, mailbox }),
      })
      if (!res.ok) throw new Error('Failed to delete folder')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      toast.success('Folder deleted')
    },
  })

  const labels = data?.labels || []
  const systemLabels = labels.filter(l => l.type === 'system')
  const userLabels = labels.filter(l => l.type === 'user')

  const handleCreate = () => {
    if (!newName.trim()) return
    createMutation.mutate(newName.trim())
  }

  return (
    <div className="flex flex-col h-full py-2">
      {/* Default folders */}
      <div className="px-2 mb-1">
        <p className="px-2 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Default</p>
      </div>
      {systemLabels.map(label => {
        const Icon = systemIcons[label.id] || FolderOpen
        const name = systemNames[label.id] || label.name
        const isActive = activeLabel === label.id

        return (
          <button
            key={label.id}
            onClick={() => onLabelChange(isActive ? null : label.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-1.5 text-sm w-full text-left transition-colors',
              isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-zinc-600 hover:bg-zinc-50'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{name}</span>
            {label.unread > 0 && (
              <span className={cn(
                'text-xs font-semibold px-1.5 py-0.5 rounded-full',
                isActive ? 'bg-blue-100 text-blue-700' : 'bg-zinc-100 text-zinc-500'
              )}>
                {label.unread}
              </span>
            )}
          </button>
        )
      })}

      {/* Archived — everything filed out of the Inbox (not trash/spam/snoozed).
          A computed view over our own email index, not a Gmail label: this is
          where an archived email can always be FOUND again (dev job 21844d01 —
          archived mail previously existed in no browsable view at all). */}
      <button
        onClick={() => onLabelChange(activeLabel === ARCHIVED_VIEW_ID ? null : ARCHIVED_VIEW_ID)}
        className={cn(
          'flex items-center gap-2 px-4 py-1.5 text-sm w-full text-left transition-colors',
          activeLabel === ARCHIVED_VIEW_ID ? 'bg-blue-50 text-blue-700 font-medium' : 'text-zinc-600 hover:bg-zinc-50'
        )}
      >
        <Archive className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Archived</span>
      </button>

      {/* Custom folders */}
      <div className="px-2 mt-4 mb-1 flex items-center justify-between">
        <p className="px-2 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Folders</p>
        <FastTooltip label="Create folder">
          <button
            onClick={() => setCreating(true)}
            className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600"
            aria-label="Create folder"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </FastTooltip>
      </div>

      {/* Create new folder input */}
      {creating && (
        <div className="px-3 py-1.5 flex items-center gap-1">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
            placeholder="Folder name..."
            autoFocus
            className="flex-1 text-sm px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {createMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
          ) : (
            <>
              <FastTooltip label="Create">
                <button onClick={handleCreate} className="p-1 rounded hover:bg-emerald-50 text-emerald-500" aria-label="Create">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </FastTooltip>
              <button onClick={() => { setCreating(false); setNewName('') }} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {userLabels.length === 0 && !creating && (
        <p className="px-4 py-2 text-xs text-zinc-400">No custom folders yet</p>
      )}

      {userLabels.map(label => {
        const isActive = activeLabel === label.id

        return (
          <div key={label.id} className="group flex items-center">
            <button
              onClick={() => onLabelChange(isActive ? null : label.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-1.5 text-sm flex-1 text-left transition-colors',
                isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-zinc-600 hover:bg-zinc-50'
              )}
            >
              <Tag className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{label.name}</span>
              {label.unread > 0 && (
                <span className="text-xs font-semibold bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded-full">
                  {label.unread}
                </span>
              )}
            </button>
            <FastTooltip label="Delete folder">
              <button
                onClick={() => {
                  if (confirm(`Delete folder "${label.name}"?`)) {
                    deleteMutation.mutate(label.id)
                    if (isActive) onLabelChange(null)
                  }
                }}
                className="p-1 mr-2 rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 text-zinc-300 hover:text-red-500 transition-all"
                aria-label="Delete folder"
              >
                <X className="h-3 w-3" />
              </button>
            </FastTooltip>
          </div>
        )
      })}
    </div>
  )
}
