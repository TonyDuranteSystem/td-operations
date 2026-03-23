'use client'

import { useState, useCallback } from 'react'
import { ArrowLeft, MessageSquare, Mail, Send, PenSquare, Archive, Star, Forward, Trash2, MailOpen, ClipboardList, Cog, Receipt, X, CheckSquare, Search, FolderInput } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { InboxHeader } from './inbox-header'
import { InboxSidebar } from './inbox-sidebar'
import { ConversationList } from './conversation-list'
import { MessageThread } from './message-thread'
import { ComposeReply } from './compose-reply'
import { ComposeDialog } from './compose-dialog'
import { CreateFromEmailDialog } from './create-from-email-dialog'
import type { InboxConversation, InboxChannel } from '@/lib/types'

const channelIcons: Record<InboxChannel, React.ElementType> = {
  whatsapp: MessageSquare,
  telegram: Send,
  gmail: Mail,
}

const channelLabels: Record<InboxChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  gmail: 'Gmail',
}

interface GmailLabel {
  id: string
  name: string
  type: 'system' | 'user'
}

export function InboxShell({ isAdmin = false }: { isAdmin?: boolean }) {
  const [activeChannel, setActiveChannel] = useState<InboxChannel | null>(null)
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [activeMailbox, setActiveMailbox] = useState<'support' | 'antonio'>('support')
  const [selected, setSelected] = useState<InboxConversation | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [forwardData, setForwardData] = useState<{ subject: string } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [createDialog, setCreateDialog] = useState<{ type: 'task' | 'service' | 'invoice'; conversation: InboxConversation } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const [moveToOpen, setMoveToOpen] = useState(false)
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  const queryClient = useQueryClient()

  const handleEmailDeleted = useCallback((id: string) => {
    setDeletedIds(prev => new Set(prev).add(id))
    // If the deleted email was selected, deselect it
    setSelected(prev => prev?.id === id ? null : prev)
    // Never remove from deletedIds — Gmail can take minutes to update its index.
    // The ID stays hidden for the entire session. On page refresh, Gmail will
    // have processed the trash by then and won't return it anymore.
  }, [])

  const bulkMode = selectedIds.size > 0

  // Fetch labels for Move To dropdown
  const { data: labelsData } = useQuery<{ labels: GmailLabel[] }>({
    queryKey: ['gmail-labels'],
    queryFn: () => fetch('/api/inbox/labels').then(r => r.json()),
    refetchInterval: 60_000,
  })
  const userLabels = (labelsData?.labels || []).filter(l => l.type === 'user')

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setMoveToOpen(false)
  }, [])

  // When switching to a Gmail label view, set channel to gmail
  const handleLabelChange = (labelId: string | null) => {
    setActiveLabel(labelId)
    if (labelId) setActiveChannel('gmail')
    setSelected(null)
  }

  // Single email action
  const emailActionMutation = useMutation({
    mutationFn: async ({ action, forwardTo }: { action: string; forwardTo?: string }) => {
      if (!selected) return
      const threadId = selected.id.replace('gmail:', '')
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, action, forwardTo, mailbox: activeMailbox }),
      })
      if (!res.ok) throw new Error('Action failed')
      return res.json()
    },
    onSuccess: (_, variables) => {
      if (variables.action === 'archive' || variables.action === 'trash') {
        if (selected) {
          handleEmailDeleted(selected.id)
        }
      }
      if (variables.action === 'trash') {
        toast.success('Email deleted')
      }
      if (variables.action === 'archive') {
        toast.success('Email archived')
      }
      if (variables.action === 'mark_unread') {
        if (selected) {
          queryClient.setQueriesData(
            { queryKey: ['inbox-conversations'] },
            (old: unknown) => {
              if (!old || typeof old !== 'object') return old
              const data = old as { conversations?: InboxConversation[]; total?: number }
              if (!data.conversations) return old
              return {
                ...data,
                conversations: data.conversations.map(c =>
                  c.id === selected.id ? { ...c, unread: 1 } : c
                ),
              }
            }
          )
        }
        setSelected(null)
        toast.success('Marked as unread')
      }
      // Delay refetch for trash/archive to let Gmail process
      if (variables.action === 'trash' || variables.action === 'archive') {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
          queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
          queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
        }, 2000)
      } else {
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      }
    },
  })

  // Bulk email action
  const bulkActionMutation = useMutation({
    mutationFn: async ({ action, labelId }: { action: string; labelId?: string }) => {
      const threadIds = Array.from(selectedIds).map(id => id.replace('gmail:', ''))
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadIds, action, labelId, bulk: true, mailbox: activeMailbox }),
      })
      if (!res.ok) throw new Error('Bulk action failed')
      return res.json()
    },
    onSuccess: (_, variables) => {
      const count = selectedIds.size
      if (variables.action === 'archive' || variables.action === 'trash') {
        queryClient.setQueriesData(
          { queryKey: ['inbox-conversations'] },
          (old: unknown) => {
            if (!old || typeof old !== 'object') return old
            const data = old as { conversations?: InboxConversation[]; total?: number }
            if (!data.conversations) return old
            return {
              ...data,
              conversations: data.conversations.filter(c => !selectedIds.has(c.id)),
              total: (data.total ?? data.conversations.length) - count,
            }
          }
        )
        if (selected && selectedIds.has(selected.id)) setSelected(null)
      }
      clearSelection()
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })

      const actionLabel = variables.action === 'trash' ? 'deleted' : variables.action === 'archive' ? 'archived' : variables.action === 'mark_read' ? 'marked as read' : 'moved'
      toast.success(`${count} email${count > 1 ? 's' : ''} ${actionLabel}`)
    },
  })

  const handleSelect = (conversation: InboxConversation) => {
    setSelected(conversation)
  }

  const handleBack = () => {
    setSelected(null)
  }

  const handleForward = () => {
    if (!selected) return
    setForwardData({ subject: selected.subject || '' })
    setComposeOpen(true)
  }

  const handleSearch = () => {
    if (!searchQuery.trim()) return
    setSearchActive(true)
    setActiveChannel('gmail')
    setActiveLabel(null)
    // The ConversationList will refetch with the search query
    queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
  }

  const clearSearch = () => {
    setSearchQuery('')
    setSearchActive(false)
    queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
  }

  const isGmail = selected?.channel === 'gmail'

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header with channel tabs + compose button */}
      <div className="flex items-center justify-between border-b bg-white">
        <InboxHeader
          activeChannel={activeChannel}
          onChannelChange={(ch) => {
            setActiveChannel(ch)
            setActiveLabel(null)
            setSearchActive(false)
            setSearchQuery('')
          }}
        />
        <div className="pr-4">
          <button
            onClick={() => {
              setForwardData(null)
              setComposeOpen(true)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
          >
            <PenSquare className="h-3.5 w-3.5" />
            Compose
          </button>
        </div>
      </div>

      {/* Mailbox selector (admin only — shows both mailboxes) */}
      {isAdmin && (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b bg-zinc-50/50">
          <span className="text-xs text-zinc-400 mr-2">Mailbox:</span>
          {(['support', 'antonio'] as const).map(mb => (
            <button
              key={mb}
              onClick={() => { setActiveMailbox(mb); setSelected(null) }}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                activeMailbox === mb
                  ? 'bg-blue-100 text-blue-700'
                  : 'text-zinc-500 hover:bg-zinc-100'
              )}
            >
              {mb === 'support' ? 'support@' : 'antonio@'}
            </button>
          ))}
        </div>
      )}

      {/* Search bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-zinc-50">
        <Search className="h-4 w-4 text-zinc-400 shrink-0" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          placeholder="Search emails... (from:, subject:, has:attachment)"
          className="flex-1 text-sm bg-transparent outline-none placeholder:text-zinc-400"
        />
        {searchActive && (
          <button onClick={clearSearch} className="p-0.5 rounded hover:bg-zinc-200 text-zinc-400">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Bulk Action Bar */}
      {bulkMode && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border-b shrink-0">
          <CheckSquare className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-medium text-blue-700">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-1 ml-auto relative">
            <button
              onClick={() => bulkActionMutation.mutate({ action: 'trash' })}
              disabled={bulkActionMutation.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
            <button
              onClick={() => bulkActionMutation.mutate({ action: 'archive' })}
              disabled={bulkActionMutation.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </button>
            <button
              onClick={() => bulkActionMutation.mutate({ action: 'mark_read' })}
              disabled={bulkActionMutation.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
            >
              <MailOpen className="h-3.5 w-3.5" />
              Mark Read
            </button>
            {/* Move to folder */}
            <div className="relative">
              <button
                onClick={() => setMoveToOpen(!moveToOpen)}
                disabled={bulkActionMutation.isPending}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
              >
                <FolderInput className="h-3.5 w-3.5" />
                Move to
              </button>
              {moveToOpen && userLabels.length > 0 && (
                <div className="absolute right-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 min-w-[160px]">
                  {userLabels.map(label => (
                    <button
                      key={label.id}
                      onClick={() => {
                        bulkActionMutation.mutate({ action: 'move_to_label', labelId: label.id })
                        setMoveToOpen(false)
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 transition-colors"
                    >
                      {label.name}
                    </button>
                  ))}
                </div>
              )}
              {moveToOpen && userLabels.length === 0 && (
                <div className="absolute right-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 px-3 py-2 text-xs text-zinc-400 min-w-[160px]">
                  No folders yet. Create one in the sidebar.
                </div>
              )}
            </div>
            <button
              onClick={clearSelection}
              className="p-1 rounded hover:bg-zinc-200 text-zinc-500 ml-1"
              title="Clear selection"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* ─── Gmail Sidebar (folders) ──────────────── */}
        {(activeChannel === 'gmail' || activeChannel === null) && (
          <div className="hidden lg:flex w-[180px] shrink-0 border-r bg-zinc-50/50 overflow-y-auto">
            <InboxSidebar
              activeLabel={activeLabel}
              onLabelChange={handleLabelChange}
            />
          </div>
        )}

        {/* ─── Conversation List ─────────────── */}
        <div
          className={cn(
            'w-full lg:w-[350px] lg:shrink-0 flex flex-col border-r',
            selected ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ConversationList
            activeChannel={activeChannel}
            selectedId={selected?.id || null}
            onSelect={handleSelect}
            onDeleted={handleEmailDeleted}
            deletedIds={deletedIds}
            bulkMode={bulkMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            labelFilter={activeLabel}
            searchQuery={searchActive ? searchQuery : undefined}
            mailbox={activeMailbox}
          />
        </div>

        {/* ─── Message Thread ────────────── */}
        <div
          className={cn(
            'flex-1 flex flex-col min-w-0',
            !selected ? 'hidden lg:flex' : 'flex'
          )}
        >
          {selected ? (
            <>
              {/* Thread header with actions */}
              <div className="flex items-center gap-3 px-4 py-3 border-b bg-white shrink-0">
                <button onClick={handleBack} className="lg:hidden p-1 rounded hover:bg-zinc-100">
                  <ArrowLeft className="h-5 w-5" />
                </button>

                {(() => {
                  const Icon = channelIcons[selected.channel]
                  return <Icon className="h-4 w-4 text-zinc-400 shrink-0" />
                })()}

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-zinc-900 truncate">
                    {selected.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {channelLabels[selected.channel]}
                    {selected.subject && ` \u2014 ${selected.subject}`}
                  </p>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  {/* Create from email */}
                  <button
                    onClick={() => setCreateDialog({ type: 'task', conversation: selected })}
                    className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-orange-500 transition-colors"
                    title="Create Task"
                  >
                    <ClipboardList className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setCreateDialog({ type: 'service', conversation: selected })}
                    className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-emerald-500 transition-colors"
                    title="Create Service"
                  >
                    <Cog className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setCreateDialog({ type: 'invoice', conversation: selected })}
                    className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-500 transition-colors"
                    title="Create Invoice"
                  >
                    <Receipt className="h-4 w-4" />
                  </button>

                  <div className="w-px h-4 bg-zinc-200 mx-0.5" />

                  {/* Gmail actions */}
                  {isGmail && (
                    <>
                      <button
                        onClick={() => emailActionMutation.mutate({ action: 'archive' })}
                        disabled={emailActionMutation.isPending}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                        title="Archive"
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => emailActionMutation.mutate({ action: 'star' })}
                        disabled={emailActionMutation.isPending}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-amber-500 transition-colors"
                        title="Star"
                      >
                        <Star className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => emailActionMutation.mutate({ action: 'mark_unread' })}
                        disabled={emailActionMutation.isPending}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-500 transition-colors"
                        title="Mark Unread"
                      >
                        <MailOpen className="h-4 w-4" />
                      </button>
                      <button
                        onClick={handleForward}
                        disabled={emailActionMutation.isPending}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                        title="Forward"
                      >
                        <Forward className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => emailActionMutation.mutate({ action: 'trash' })}
                        disabled={emailActionMutation.isPending}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 hover:bg-red-100 text-red-500 hover:text-red-700 text-xs font-medium transition-colors ml-1"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>

              <MessageThread conversation={selected} mailbox={activeMailbox} />
              <ComposeReply conversation={selected} />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-400">
              <MessageSquare className="h-12 w-12 mb-3 stroke-1" />
              <p className="text-sm font-medium">Select a conversation</p>
              <p className="text-xs mt-1">Choose from WhatsApp, Telegram, or Gmail</p>
            </div>
          )}
        </div>
      </div>

      <ComposeDialog
        open={composeOpen}
        onClose={() => { setComposeOpen(false); setForwardData(null) }}
        prefillSubject={forwardData ? `Fwd: ${forwardData.subject}` : ''}
      />

      {createDialog && (
        <CreateFromEmailDialog
          type={createDialog.type}
          conversation={createDialog.conversation}
          onClose={() => setCreateDialog(null)}
        />
      )}
    </div>
  )
}
