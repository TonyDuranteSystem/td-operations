'use client'

import { useState, useCallback, useEffect } from 'react'
import { ArrowLeft, MessageSquare, Mail, PenSquare, Archive, Star, Forward, Trash2, MailOpen, ClipboardList, Cog, Receipt, X, CheckSquare, Search, FolderInput, Reply, Bot, MessagesSquare, Palette, Ban, Link2, Send } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { InboxHeader } from './inbox-header'
import { InboxSidebar } from './inbox-sidebar'
import { ConversationList } from './conversation-list'
import { MessageThread } from './message-thread'
import { WhatsappThread } from './whatsapp-thread'
import { ComposeReply } from './compose-reply'
import { ComposeDialog } from './compose-dialog'
import { CreateFromEmailDialog } from './create-from-email-dialog'
import { WorkerChatPanel } from './worker-chat-panel'
import { LinkClientDialog } from './link-client-dialog'
import { ShareToTeamDialog, type ShareItem } from '@/components/team/share-to-team-dialog'
import { HoverHint } from './hover-hint'
import { COLOR_MARKS, markByKey } from '@/lib/inbox/color-marks'
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client'
import type { InboxConversation, InboxChannel } from '@/lib/types'

const channelIcons: Record<InboxChannel, React.ElementType> = {
  gmail: Mail,
  portal: MessagesSquare,
  whatsapp: MessageSquare,
}

const channelLabels: Record<InboxChannel, string> = {
  gmail: 'Gmail',
  portal: 'Portal',
  whatsapp: 'WhatsApp',
}

interface GmailLabel {
  id: string
  name: string
  type: 'system' | 'user'
}

interface InboxShellProps {
  /** Admin only — shows the antonio@ personal-mailbox toggle. The API routes
   *  enforce this server-side regardless. */
  canUsePersonalMailbox?: boolean
}

export function InboxShell({ canUsePersonalMailbox = false }: InboxShellProps) {
  const [activeChannel, setActiveChannel] = useState<InboxChannel | null>('gmail')
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [activeMailbox, setActiveMailbox] = useState<'support' | 'antonio'>('support')
  const [selected, setSelected] = useState<InboxConversation | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeMenuOpen, setComposeMenuOpen] = useState(false)
  const [forwardData, setForwardData] = useState<{ subject: string; body: string; from: string } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [createDialog, setCreateDialog] = useState<{ type: 'task' | 'service' | 'invoice'; conversation: InboxConversation } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const [moveToOpen, setMoveToOpen] = useState(false)
  const [colorMenuOpen, setColorMenuOpen] = useState(false)
  const [workerOpen, setWorkerOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [shareItems, setShareItems] = useState<ShareItem[] | null>(null)
  const [shareFromBulk, setShareFromBulk] = useState(false)
  const [deepLinkDone, setDeepLinkDone] = useState(false)
  const [unreadFilter, setUnreadFilter] = useState<'all' | 'unread' | 'read'>('all')
  const [unreadOverrides, setUnreadOverrides] = useState<Map<string, number>>(new Map())
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const stored = localStorage.getItem('inbox-deleted-ids')
      if (!stored) return new Set()
      const parsed = JSON.parse(stored) as { ids: string[]; ts: number }
      if (Date.now() - parsed.ts > 5 * 60 * 1000) {
        localStorage.removeItem('inbox-deleted-ids')
        return new Set()
      }
      return new Set(parsed.ids)
    } catch { return new Set() }
  })
  const queryClient = useQueryClient()

  const isWhatsApp = activeChannel === 'whatsapp'
  const isGmail = selected?.channel === 'gmail'

  // Real-time inbox refresh: Gmail push (users.watch → Pub/Sub → webhook →
  // gmail_push_events row) — new mail appears within seconds instead of the
  // 30s poll, which remains the fallback. DEBOUNCED (trailing 2.5s): every
  // archive/delete also fires a push event, so a bulk action on N emails
  // used to trigger N back-to-back full refetches (each up to ~300 Gmail
  // calls server-side) — a storm that rate-limited Gmail and blanked the
  // list (Antonio 2026-07-08). One refetch after the burst settles.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel('inbox-gmail-push')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'gmail_push_events' },
        () => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
            queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
            queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
          }, 2500)
        }
      )
      .subscribe()
    return () => {
      if (debounce) clearTimeout(debounce)
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deep-link: /inbox?thread=gmail:<id>&mailbox=support|antonio opens a specific
  // email (used by the "Share to team chat" card link back to the source). Read
  // from window.location once on mount (no useSearchParams → no Suspense need on
  // this client component). The messages endpoint gives us subject + sender to
  // fill the thread header; MessageThread fetches the body itself.
  useEffect(() => {
    if (deepLinkDone) return
    setDeepLinkDone(true)
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const thread = params.get('thread')
    if (!thread || !thread.startsWith('gmail:')) return
    const mailbox = params.get('mailbox') === 'antonio' ? 'antonio' : 'support'
    setActiveMailbox(mailbox)
    setActiveChannel('gmail')
    ;(async () => {
      try {
        const res = await fetch(`/api/inbox/messages/${encodeURIComponent(thread)}?mailbox=${mailbox}`)
        const data = await res.json().catch(() => ({}))
        setSelected({
          id: thread,
          channel: 'gmail',
          name: data?.name || '',
          preview: '',
          unread: 0,
          lastMessageAt: '',
          subject: data?.subject || '',
        })
      } catch {
        // Fall back to a bare stub so the thread still opens by id.
        setSelected({ id: thread, channel: 'gmail', name: '', preview: '', unread: 0, lastMessageAt: '' })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkDone])

  // Build a ShareItem for an email conversation (email → 'link' card: subject as
  // title, sender + snippet as subtitle, deep-link back to /inbox).
  const buildEmailShareItem = useCallback((c: InboxConversation): ShareItem => ({
    kind: 'link',
    title: c.subject || c.name || 'Email',
    subtitle: c.name ? (c.preview ? `${c.name} · ${c.preview}` : c.name) : (c.preview || ''),
    url: `/inbox?thread=${encodeURIComponent(c.id)}&mailbox=${activeMailbox}`,
    entity_type: 'email',
    entity_id: c.id,
  }), [activeMailbox])

  // Bulk "Share to Support": resolve the selected ids to conversation objects
  // from the react-query cache (the list that populated the checkboxes), then
  // open the share dialog with one item per email.
  const handleBulkShare = useCallback(() => {
    const cached = queryClient.getQueriesData<{ conversations: InboxConversation[] }>({ queryKey: ['inbox-conversations'] })
    const map = new Map<string, InboxConversation>()
    for (const [, data] of cached) {
      (data?.conversations || []).forEach(c => map.set(c.id, c))
    }
    const items = Array.from(selectedIds).map(id => {
      const c = map.get(id)
      return c
        ? buildEmailShareItem(c)
        : { kind: 'link' as const, title: 'Email', url: `/inbox?thread=${encodeURIComponent(id)}&mailbox=${activeMailbox}`, entity_type: 'email', entity_id: id }
    })
    setShareFromBulk(true)
    setShareItems(items)
  }, [queryClient, selectedIds, buildEmailShareItem, activeMailbox])

  const handleEmailDeleted = useCallback((id: string) => {
    setDeletedIds(prev => {
      const next = new Set(prev).add(id)
      try {
        localStorage.setItem('inbox-deleted-ids', JSON.stringify({
          ids: Array.from(next),
          ts: Date.now()
        }))
      } catch { /* ignore */ }
      return next
    })
    setSelected(prev => prev?.id === id ? null : prev)
  }, [])

  const bulkMode = selectedIds.size > 0

  const { data: labelsData } = useQuery<{ labels: GmailLabel[] }>({
    queryKey: ['gmail-labels', activeMailbox],
    queryFn: () => fetch(`/api/inbox/labels?mailbox=${activeMailbox}`).then(r => r.json()),
    refetchInterval: 60_000,
    enabled: !isWhatsApp,
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

  const handleLabelChange = (labelId: string | null) => {
    setActiveLabel(labelId)
    if (labelId) setActiveChannel('gmail')
    setSelected(null)
  }

  const emailActionMutation = useMutation({
    mutationFn: async ({ action, forwardTo, color }: { action: string; forwardTo?: string; color?: string | null }) => {
      if (!selected) return
      const threadId = selected.id.replace('gmail:', '')
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, action, forwardTo, color, mailbox: activeMailbox }),
      })
      if (!res.ok) throw new Error('Action failed')
      return res.json()
    },
    onSuccess: (_, variables) => {
      if (variables.action === 'set_color') {
        // Optimistically paint the list row + the open conversation
        const colorMark = variables.color ?? null
        if (selected) {
          queryClient.setQueriesData<{ conversations: InboxConversation[]; total: number }>(
            { queryKey: ['inbox-conversations'] },
            (old) => old
              ? { ...old, conversations: old.conversations.map(c => c.id === selected.id ? { ...c, colorMark } : c) }
              : old
          )
          setSelected(prev => prev ? { ...prev, colorMark } : prev)
        }
        toast.success(colorMark ? `Marked ${markByKey(colorMark)?.label ?? colorMark}` : 'Mark removed')
        return
      }
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
          setUnreadOverrides(prev => new Map(prev).set(selected.id, 1))
        }
        setSelected(null)
        toast.success('Marked as unread')
      }
      if (variables.action === 'trash' || variables.action === 'archive') {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
          queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
          queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
        }, 2000)
      } else if (variables.action === 'mark_unread' || variables.action === 'mark_read') {
        // The optimistic unread override already updated the badge — do NOT
        // force a ~300-Gmail-call conversations refetch just to flip a read
        // dot (that heavy refetch under load is exactly what blanked the
        // list, Antonio 2026-07-08). Stats/labels are cheap; the 30s poll
        // reconciles the list. Gmail's label index lags anyway.
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      } else {
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      }
    },
  })

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
      // Optimistic unread badges — Gmail's index lags label changes
      if (variables.action === 'mark_read' || variables.action === 'mark_unread') {
        const v = variables.action === 'mark_read' ? 0 : 1
        setUnreadOverrides(prev => {
          const next = new Map(prev)
          selectedIds.forEach(id => next.set(id, v))
          return next
        })
      }
      clearSelection()
      // Read/unread already reflected by the optimistic badges above +
      // the archive/trash rows already filtered optimistically — a heavy
      // conversations refetch here is what blanked the list under Gmail load
      // (Antonio 2026-07-08). Only refetch the list for label MOVES (which
      // change membership and aren't optimistically handled).
      if (variables.action === 'move_to_label') {
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      }
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })

      const actionLabel = variables.action === 'trash' ? 'deleted' : variables.action === 'archive' ? 'archived' : variables.action === 'mark_read' ? 'marked as read' : variables.action === 'mark_unread' ? 'marked as unread' : 'moved'
      toast.success(`${count} email${count > 1 ? 's' : ''} ${actionLabel}`)
    },
  })

  const handleSelect = (conversation: InboxConversation) => {
    setSelected(conversation)
    setWorkerOpen(false) // worker chat is per email thread
    if (conversation.unread > 0) {
      setUnreadOverrides(prev => new Map(prev).set(conversation.id, 0))
    }
  }

  const handleBack = () => {
    setSelected(null)
    setWorkerOpen(false)
  }

  const handleForward = async () => {
    if (!selected) return
    try {
      const params = activeMailbox ? `?mailbox=${activeMailbox}` : ''
      const res = await fetch(`/api/inbox/messages/${encodeURIComponent(selected.id)}${params}`)
      const data = await res.json()
      const messages = data?.messages || []
      const lastMsg = messages[messages.length - 1]

      const htmlContent = lastMsg?.content || ''
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = htmlContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      const rawText = tempDiv.textContent || tempDiv.innerText || ''
      const plainText = rawText
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || selected.preview || ''

      const fwdBody = lastMsg
        ? `\n\n---------- Forwarded message ----------\nFrom: ${lastMsg.sender || selected.name}\nDate: ${lastMsg.createdAt ? new Date(lastMsg.createdAt).toLocaleString() : ''}\nSubject: ${selected.subject || ''}\n\n${plainText}`
        : ''
      setForwardData({
        subject: selected.subject || '',
        body: fwdBody,
        from: lastMsg?.sender || selected.name,
      })
      setComposeOpen(true)
    } catch {
      setForwardData({ subject: selected.subject || '', body: '', from: selected.name })
      setComposeOpen(true)
    }
  }

  const handleSearch = () => {
    if (!searchQuery.trim()) return
    setSearchActive(true)
    setActiveChannel('gmail')
    setActiveLabel(null)
    queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
  }

  const clearSearch = () => {
    setSearchQuery('')
    setSearchActive(false)
    queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
  }

  // Antonio 2026-07-08: the inbox assistant is the SLACK WORKER (read-only
  // DB/CRM/KB tools + central memory), not the generic AI Assist panel.
  const handleWorker = () => {
    if (!selected) return
    setWorkerOpen(true)
  }

  const handleReply = () => {
    const textarea = document.querySelector('.compose-reply-textarea') as HTMLTextAreaElement
    if (textarea) {
      textarea.scrollIntoView({ behavior: 'smooth', block: 'end' })
      setTimeout(() => textarea.focus(), 300)
    }
  }

  // Derive group ID from whatsapp conversation ID (format: "whatsapp:{uuid}")
  const whatsappGroupId = selected?.channel === 'whatsapp'
    ? selected.id.replace('whatsapp:', '')
    : null

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
            setSelected(null)
          }}
        />
        <div className="pr-4 relative">
          <button
            onClick={() => setComposeMenuOpen(!composeMenuOpen)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
          >
            <PenSquare className="h-3.5 w-3.5" />
            Compose
          </button>
          {composeMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setComposeMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 w-48">
                <button
                  onClick={() => {
                    setComposeMenuOpen(false)
                    setForwardData(null)
                    setComposeOpen(true)
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  <Mail className="h-4 w-4 text-blue-500" />
                  New Email
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Mailbox selector — Gmail only; antonio@ is personal (admin only) */}
      {!isWhatsApp && canUsePersonalMailbox && (
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

      {/* Search bar + Read/Unread filter — Gmail only */}
      {!isWhatsApp && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b bg-zinc-50">
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
          <div className="flex items-center gap-0.5 border-l pl-2 ml-1">
            {(['all', 'unread', 'read'] as const).map(f => (
              <button
                key={f}
                onClick={() => setUnreadFilter(f)}
                className={cn(
                  'px-2 py-1 rounded text-xs font-medium transition-colors',
                  unreadFilter === f
                    ? f === 'unread' ? 'bg-blue-100 text-blue-700' : f === 'read' ? 'bg-zinc-200 text-zinc-700' : 'bg-zinc-100 text-zinc-600'
                    : 'text-zinc-400 hover:bg-zinc-100'
                )}
              >
                {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Read'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bulk Action Bar — Gmail only */}
      {bulkMode && !isWhatsApp && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-blue-50 border-b shrink-0">
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
            <button
              onClick={() => bulkActionMutation.mutate({ action: 'mark_unread' })}
              disabled={bulkActionMutation.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
            >
              <Mail className="h-3.5 w-3.5" />
              Mark Unread
            </button>
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
              onClick={handleBulkShare}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
            >
              <Send className="h-3.5 w-3.5" />
              Share to team
            </button>
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
              mailbox={activeMailbox}
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
            unreadOverrides={unreadOverrides}
            bulkMode={bulkMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            labelFilter={activeLabel}
            searchQuery={searchActive ? searchQuery : undefined}
            mailbox={activeMailbox}
            unreadFilter={unreadFilter}
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
              {/* Thread header with actions. flex-wrap + basis on the title:
                  on narrow windows/mobile the button cluster wraps to its own
                  row instead of crushing the subject to one word per line. */}
              <div className="flex items-center gap-x-3 gap-y-1.5 px-4 py-2.5 border-b bg-white shrink-0 flex-wrap">
                <button onClick={handleBack} className="lg:hidden p-1 rounded hover:bg-zinc-100">
                  <ArrowLeft className="h-5 w-5" />
                </button>

                {(() => {
                  const Icon = channelIcons[selected.channel]
                  const iconClass = selected.channel === 'whatsapp' ? 'text-green-500' : 'text-zinc-400'
                  return <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
                })()}

                <div className="min-w-0 flex-1 basis-44">
                  <p className="text-sm font-semibold text-zinc-900 truncate">
                    {selected.name}
                  </p>
                  <p className="text-xs text-zinc-500 truncate">
                    {channelLabels[selected.channel]}
                    {selected.subject && ` — ${selected.subject}`}
                  </p>
                </div>

                {/* Action buttons — not shown for WhatsApp (read-only) */}
                {!isWhatsApp && (
                  <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end ml-auto">
                    <HoverHint label="Create Task">
                      <button
                        onClick={() => setCreateDialog({ type: 'task', conversation: selected })}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-orange-500 transition-colors"
                      >
                        <ClipboardList className="h-4 w-4" />
                      </button>
                    </HoverHint>
                    <HoverHint label="Create Service">
                      <button
                        onClick={() => setCreateDialog({ type: 'service', conversation: selected })}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-emerald-500 transition-colors"
                      >
                        <Cog className="h-4 w-4" />
                      </button>
                    </HoverHint>
                    <HoverHint label="Create Invoice">
                      <button
                        onClick={() => setCreateDialog({ type: 'invoice', conversation: selected })}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-500 transition-colors"
                      >
                        <Receipt className="h-4 w-4" />
                      </button>
                    </HoverHint>

                    <div className="w-px h-4 bg-zinc-200 mx-0.5" />

                    <HoverHint label="Write a reply">
                      <button
                        onClick={handleReply}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-50 hover:bg-blue-100 text-blue-600 hover:text-blue-700 text-xs font-medium transition-colors"
                      >
                        <Reply className="h-3.5 w-3.5" />
                        Reply
                      </button>
                    </HoverHint>
                    <HoverHint label="AI worker — reads CRM, DB & memory">
                      <button
                        onClick={handleWorker}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-violet-50 hover:bg-violet-100 text-violet-600 hover:text-violet-700 text-xs font-medium transition-colors"
                      >
                        <Bot className="h-3.5 w-3.5" />
                        Worker
                      </button>
                    </HoverHint>

                    {isGmail && (
                      <>
                        <HoverHint label="Share to team chat">
                          <button
                            onClick={() => { setShareFromBulk(false); setShareItems([buildEmailShareItem(selected)]) }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 hover:bg-emerald-100 text-emerald-600 hover:text-emerald-700 text-xs font-medium transition-colors"
                          >
                            <Send className="h-3.5 w-3.5" />
                            Share
                          </button>
                        </HoverHint>
                        <HoverHint label="Archive">
                          <button
                            onClick={() => emailActionMutation.mutate({ action: 'archive' })}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            <Archive className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Star">
                          <button
                            onClick={() => emailActionMutation.mutate({ action: 'star' })}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-amber-500 transition-colors"
                          >
                            <Star className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <div className="relative">
                          <HoverHint label="Mark with a color">
                          <button
                            onClick={() => setColorMenuOpen(!colorMenuOpen)}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            {selected.colorMark ? (
                              <span
                                className="block h-4 w-4 rounded-full border border-white shadow-sm"
                                style={{ backgroundColor: markByKey(selected.colorMark)?.hex }}
                              />
                            ) : (
                              <Palette className="h-4 w-4" />
                            )}
                          </button>
                          </HoverHint>
                          {colorMenuOpen && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => setColorMenuOpen(false)} />
                              <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-zinc-200 p-2 flex items-center gap-1.5">
                                {COLOR_MARKS.map(m => (
                                  <button
                                    key={m.key}
                                    onClick={() => {
                                      setColorMenuOpen(false)
                                      emailActionMutation.mutate({ action: 'set_color', color: m.key })
                                    }}
                                    className={cn(
                                      'h-5 w-5 rounded-full hover:scale-110 transition-transform',
                                      selected.colorMark === m.key && 'ring-2 ring-offset-1 ring-zinc-400'
                                    )}
                                    style={{ backgroundColor: m.hex }}
                                    title={m.label}
                                  />
                                ))}
                                <button
                                  onClick={() => {
                                    setColorMenuOpen(false)
                                    emailActionMutation.mutate({ action: 'set_color', color: null })
                                  }}
                                  className="h-5 w-5 rounded-full border border-zinc-300 flex items-center justify-center text-zinc-400 hover:text-zinc-600 hover:scale-110 transition-transform"
                                  title="Remove mark"
                                >
                                  <Ban className="h-3 w-3" />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        <HoverHint label="Mark as unread">
                          <button
                            onClick={() => emailActionMutation.mutate({ action: 'mark_unread' })}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-500 transition-colors"
                          >
                            <MailOpen className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Forward">
                          <button
                            onClick={handleForward}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            <Forward className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Link to client / lead / partner">
                          <button
                            onClick={() => setLinkOpen(true)}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-600 transition-colors"
                          >
                            <Link2 className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Delete (moves to Trash)">
                          <button
                            onClick={() => emailActionMutation.mutate({ action: 'trash' })}
                            disabled={emailActionMutation.isPending}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 hover:bg-red-100 text-red-500 hover:text-red-700 text-xs font-medium transition-colors ml-1"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </button>
                        </HoverHint>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Thread body */}
              {selected.channel === 'whatsapp' && whatsappGroupId ? (
                <WhatsappThread groupId={whatsappGroupId} />
              ) : (
                <div className="flex flex-1 min-h-0">
                  <div className="flex-1 flex flex-col min-w-0">
                    <MessageThread conversation={selected} mailbox={activeMailbox} />
                    <ComposeReply conversation={selected} mailbox={activeMailbox} />
                  </div>
                  {workerOpen && (
                    <WorkerChatPanel
                      conversation={selected}
                      mailbox={activeMailbox}
                      onClose={() => setWorkerOpen(false)}
                    />
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-400">
              <MessageSquare className="h-12 w-12 mb-3 stroke-1" />
              <p className="text-sm font-medium">Select a conversation</p>
              <p className="text-xs mt-1">
                {isWhatsApp ? 'Choose a WhatsApp conversation' : 'Choose an email from the inbox'}
              </p>
            </div>
          )}
        </div>
      </div>

      <ComposeDialog
        open={composeOpen}
        onClose={() => { setComposeOpen(false); setForwardData(null) }}
        prefillSubject={forwardData ? `Fwd: ${forwardData.subject}` : ''}
        prefillBody={forwardData?.body || ''}
      />

      {createDialog && (
        <CreateFromEmailDialog
          type={createDialog.type}
          conversation={createDialog.conversation}
          onClose={() => setCreateDialog(null)}
        />
      )}

      {linkOpen && selected && (
        <LinkClientDialog
          conversation={selected}
          mailbox={activeMailbox}
          onClose={() => setLinkOpen(false)}
        />
      )}

      {shareItems && (
        <ShareToTeamDialog
          items={shareItems}
          label={shareFromBulk
            ? `${shareItems.length} email${shareItems.length === 1 ? '' : 's'}`
            : `Email — ${shareItems[0]?.title || ''}`}
          onShared={shareFromBulk ? clearSelection : undefined}
          onClose={() => { setShareItems(null); setShareFromBulk(false) }}
        />
      )}
    </div>
  )
}
