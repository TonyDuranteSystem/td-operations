'use client'

/**
 * ShareToTeamDialog — share an email (Inbox) or a client portal message
 * (Portal Chats) into the internal Team Workspace as a DM.
 *
 * Two targets, pick one (Antonio 2026-07-08):
 *  - Send to Support → the configured support person's DM. Multi-item shares post
 *    ONE message per item (a support intake queue).
 *  - Discuss with a teammate → your DM with a chosen staff member.
 * Your notes ride along as the message body; each item renders as a card that
 * links back to the source. All wiring goes through POST /api/team/share, which
 * notifies ONLY the recipient (not the whole team).
 *
 * Shared by both surfaces — do not fork it.
 */

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Loader2, Send, Users, LifeBuoy, MessagesSquare, Search, X, LayoutGrid } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export interface ShareItem {
  /** Card kind — 'client_message' for a portal message, 'link' for an email. */
  kind?: 'client_message' | 'link'
  title: string
  subtitle?: string
  /** Relative in-app href back to the source item. */
  url?: string
  color?: string
  entity_type?: string
  entity_id?: string
  /** Full source text (whole email / portal message) embedded in the message body. */
  body?: string
}

interface TeamMember {
  id: string
  name: string
  email: string | null
  role: 'admin' | 'team'
}

interface ShareToTeamDialogProps {
  items: ShareItem[]
  onClose: () => void
  /** Short label describing what's being shared, e.g. "email" / "3 messages". */
  label?: string
  /** Called after a successful share (before close) — e.g. to clear a bulk selection. */
  onShared?: () => void
}

type Mode = 'conversation' | 'support' | 'teammate' | 'dev_board'

interface ClientResult {
  value: string
  label: string
  sublabel: string
  kind: 'account' | 'contact' | 'lead'
}
interface TopicTemplate {
  slug: string
  display_name: string
}

export function ShareToTeamDialog({ items, onClose, label, onShared }: ShareToTeamDialogProps) {
  // A single client email/message → default to a client Conversation. A bulk
  // share (many items) can't sensibly become one client+topic thread, so it
  // stays on the DM targets.
  const bulk = items.length > 1
  const [mode, setMode] = useState<Mode>(bulk ? 'support' : 'conversation')
  const [teammateId, setTeammateId] = useState<string>('')
  // Dev Board target: bug (td-bug) or new-implementation request (td-dev).
  const [devChannel, setDevChannel] = useState<'td-bug' | 'td-dev'>('td-bug')
  const [note, setNote] = useState('')

  // Conversation target state.
  const [clientQuery, setClientQuery] = useState('')
  const [client, setClient] = useState<ClientResult | null>(null)
  const [topic, setTopic] = useState<string>('')

  const { data: dir } = useQuery<{ members: TeamMember[]; current_user_id: string }>({
    queryKey: ['team-directory'],
    queryFn: () => fetch('/api/team/threads').then(r => r.json()),
  })
  const members = (dir?.members ?? []).filter(m => m.id !== dir?.current_user_id)

  const { data: topicData } = useQuery<{ templates: TopicTemplate[] }>({
    queryKey: ['topic-templates'],
    queryFn: () => fetch('/api/portal/chat/topic-templates').then(r => r.json()),
    enabled: mode === 'conversation',
  })
  const topics = topicData?.templates ?? []

  const { data: clientData, isFetching: clientSearching } = useQuery<{ results: ClientResult[] }>({
    queryKey: ['team-client-search', clientQuery],
    queryFn: () => fetch(`/api/team/client-search?q=${encodeURIComponent(clientQuery)}`).then(r => r.json()),
    enabled: mode === 'conversation' && clientQuery.trim().length >= 2 && !client,
  })
  const clientResults = clientData?.results ?? []

  const shareMutation = useMutation({
    mutationFn: async () => {
      const target =
        mode === 'support'
          ? 'support'
          : mode === 'teammate'
            ? { user_id: teammateId }
            : mode === 'dev_board'
              ? { dev_board: { channel: devChannel } }
              : { conversation: { client: client!.value, topic: topic || undefined } }
      const res = await fetch('/api/team/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, note: note.trim(), items }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Share failed — please try again.')
      return data as { thread_id?: string; count?: number; dev_task_id?: string; url?: string }
    },
    onSuccess: (data) => {
      if (mode === 'dev_board') {
        toast.success(`Added to Dev Board (${devChannel === 'td-bug' ? 'Bug' : 'New implementation'})`, {
          action: {
            label: 'Open',
            onClick: () => { if (data.url) window.location.href = data.url },
          },
        })
        onShared?.()
        onClose()
        return
      }
      const where =
        mode === 'support'
          ? 'Support'
          : mode === 'teammate'
            ? members.find(m => m.id === teammateId)?.name || 'teammate'
            : `${client?.label}${topic ? ` · ${topic}` : ''}`
      toast.success(`Shared ${(data.count ?? 1) > 1 ? `${data.count} items` : 'item'} to ${where}`, {
        action: {
          label: 'Open',
          onClick: () => { window.location.href = `/team-chat?thread=${data.thread_id}` },
        },
      })
      onShared?.()
      onClose()
    },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : 'Share failed — please try again.'),
  })

  const canSubmit =
    items.length > 0 &&
    !shareMutation.isPending &&
    (
      (mode === 'support') ||
      (mode === 'teammate' && !!teammateId) ||
      (mode === 'conversation' && !!client) ||
      (mode === 'dev_board')
    )

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[92vw] bg-white rounded-xl shadow-2xl border border-zinc-200">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Send className="h-4 w-4 text-blue-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-900">Share to team chat</p>
            <p className="text-xs text-zinc-500 truncate">
              {label || `${items.length} item${items.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Target toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => !bulk && setMode('conversation')}
              disabled={bulk}
              title={bulk ? 'Share one item at a time into a client conversation' : undefined}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs',
                mode === 'conversation'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
                bulk && 'opacity-40 cursor-not-allowed',
              )}
            >
              <MessagesSquare className="h-4 w-4 shrink-0" />
              <span>Conversation</span>
            </button>
            <button
              onClick={() => setMode('support')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs',
                mode === 'support'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
              )}
            >
              <LifeBuoy className="h-4 w-4 shrink-0" />
              <span>Support</span>
            </button>
            <button
              onClick={() => setMode('teammate')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs',
                mode === 'teammate'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
              )}
            >
              <Users className="h-4 w-4 shrink-0" />
              <span>Teammate</span>
            </button>
            <button
              onClick={() => setMode('dev_board')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs',
                mode === 'dev_board'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
              )}
            >
              <LayoutGrid className="h-4 w-4 shrink-0" />
              <span>Dev Board</span>
            </button>
          </div>

          {/* Dev Board picker: bug vs new implementation */}
          {mode === 'dev_board' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setDevChannel('td-bug')}
                  className={cn(
                    'px-2.5 py-2 rounded-lg border text-xs text-left',
                    devChannel === 'td-bug' ? 'border-red-400 bg-red-50 text-red-700' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
                  )}
                >
                  🐞 Bug
                </button>
                <button
                  onClick={() => setDevChannel('td-dev')}
                  className={cn(
                    'px-2.5 py-2 rounded-lg border text-xs text-left',
                    devChannel === 'td-dev' ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
                  )}
                >
                  ✨ New implementation
                </button>
              </div>
              <p className="text-[11px] text-zinc-400">
                Creates a card on the Dev Board ({devChannel === 'td-bug' ? 'td-bug' : 'td-dev'}) with this message, the client, and your note.
              </p>
            </div>
          )}

          {/* Conversation picker: client + topic */}
          {mode === 'conversation' && (
            <div className="space-y-2">
              {client ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 text-sm">
                  <span className="flex-1 truncate text-blue-800">{client.label}</span>
                  <span className="text-[10px] uppercase text-blue-400">{client.kind}</span>
                  <button onClick={() => { setClient(null); setClientQuery('') }} className="text-blue-400 hover:text-blue-600">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
                  <input
                    value={clientQuery}
                    onChange={e => setClientQuery(e.target.value)}
                    placeholder="Find a client (company, contact, or lead)…"
                    className="w-full text-sm border rounded-lg pl-8 pr-3 py-2 outline-none placeholder:text-zinc-400 focus:border-blue-400"
                  />
                  {clientQuery.trim().length >= 2 && (
                    <div className="mt-1 max-h-36 overflow-y-auto border rounded-lg divide-y">
                      {clientSearching && <p className="text-xs text-zinc-400 px-3 py-2">Searching…</p>}
                      {!clientSearching && clientResults.length === 0 && (
                        <p className="text-xs text-zinc-400 px-3 py-2">No matches</p>
                      )}
                      {clientResults.map(r => (
                        <button
                          key={r.value}
                          onClick={() => setClient(r)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50"
                        >
                          <span className="flex-1 truncate text-zinc-800">{r.label}</span>
                          <span className="text-[10px] uppercase text-zinc-400">{r.sublabel}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <select
                value={topic}
                onChange={e => setTopic(e.target.value)}
                className="w-full text-sm border rounded-lg px-3 py-2 outline-none bg-white focus:border-blue-400"
              >
                <option value="">General (no specific topic)</option>
                {topics.map(t => (
                  <option key={t.slug} value={t.display_name}>{t.display_name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Teammate picker */}
          {mode === 'teammate' && (
            <div className="max-h-40 overflow-y-auto space-y-0.5 border rounded-lg p-1">
              {members.length === 0 && (
                <p className="text-xs text-zinc-400 px-2 py-2">No teammates found</p>
              )}
              {members.map(m => (
                <button
                  key={m.id}
                  onClick={() => setTeammateId(m.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-sm',
                    teammateId === m.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-zinc-50 text-zinc-700',
                  )}
                >
                  <span className="flex-1 truncate">{m.name}</span>
                  {m.role === 'admin' && (
                    <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                      Admin
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Notes */}
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add your notes about it… (optional)"
            rows={3}
            className="w-full text-sm border rounded-lg px-3 py-2 outline-none resize-none placeholder:text-zinc-400 focus:border-blue-400"
          />

          {/* Preview of what's shared */}
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
              Sharing {items.length === 1 ? '' : `${items.length} items`}
            </p>
            <div className="max-h-28 overflow-y-auto space-y-1">
              {items.map((it, i) => (
                <div key={i} className="px-2.5 py-1.5 rounded-lg bg-zinc-50 text-sm">
                  <p className="truncate text-zinc-800">{it.title}</p>
                  {it.subtitle && <p className="truncate text-[11px] text-zinc-400">{it.subtitle}</p>}
                </div>
              ))}
            </div>
            {mode === 'support' && items.length > 1 && (
              <p className="text-[10px] text-zinc-400">Each item is sent as its own message.</p>
            )}
          </div>

          <button
            onClick={() => shareMutation.mutate()}
            disabled={!canSubmit}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {shareMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            <span>Share</span>
          </button>
        </div>
      </div>
    </>
  )
}
