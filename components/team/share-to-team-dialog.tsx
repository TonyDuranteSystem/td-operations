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
import { Loader2, Send, Users, LifeBuoy, X } from 'lucide-react'
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

type Mode = 'support' | 'teammate'

export function ShareToTeamDialog({ items, onClose, label, onShared }: ShareToTeamDialogProps) {
  const [mode, setMode] = useState<Mode>('support')
  const [teammateId, setTeammateId] = useState<string>('')
  const [note, setNote] = useState('')

  const { data: dir } = useQuery<{ members: TeamMember[]; current_user_id: string }>({
    queryKey: ['team-directory'],
    queryFn: () => fetch('/api/team/threads').then(r => r.json()),
  })
  const members = (dir?.members ?? []).filter(m => m.id !== dir?.current_user_id)

  const shareMutation = useMutation({
    mutationFn: async () => {
      const target = mode === 'support' ? 'support' : { user_id: teammateId }
      const res = await fetch('/api/team/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, note: note.trim(), items }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Share failed — please try again.')
      return data as { thread_id: string; count: number }
    },
    onSuccess: (data) => {
      const where = mode === 'support'
        ? 'Support'
        : members.find(m => m.id === teammateId)?.name || 'teammate'
      toast.success(`Shared ${data.count > 1 ? `${data.count} items` : 'item'} to ${where}`, {
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
    (mode === 'support' || (mode === 'teammate' && !!teammateId)) &&
    !shareMutation.isPending

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
              onClick={() => setMode('support')}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm',
                mode === 'support'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
              )}
            >
              <LifeBuoy className="h-4 w-4 shrink-0" />
              <span>Send to Support</span>
            </button>
            <button
              onClick={() => setMode('teammate')}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm',
                mode === 'teammate'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
              )}
            >
              <Users className="h-4 w-4 shrink-0" />
              <span>Discuss with…</span>
            </button>
          </div>

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
