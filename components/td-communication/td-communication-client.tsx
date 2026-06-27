'use client'

import { useState } from 'react'
import { Plus, Loader2, MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { ConversationChat } from './conversation-chat'
import type { CommConversationListItem, CommParticipant } from '@/lib/td-communication/types'

interface PartnerOption {
  id: string
  partner_name: string | null
}

/**
 * CRM staff shell for TD Communication: a list of conversations on the left
 * (with a "new conversation" composer) and the realtime chat on the right.
 */
export function TdCommunicationClient({
  viewer,
  initialConversations,
  partners,
}: {
  viewer: CommParticipant
  initialConversations: CommConversationListItem[]
  partners: PartnerOption[]
}) {
  const [conversations, setConversations] = useState(initialConversations)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversations[0]?.id ?? null,
  )
  const [creating, setCreating] = useState(false)
  const [showForm, setShowForm] = useState(initialConversations.length === 0)
  const [subject, setSubject] = useState('')
  const [partnerId, setPartnerId] = useState('')

  const partnerName = (id: string | null) =>
    partners.find((p) => p.id === id)?.partner_name ?? null

  async function handleCreate() {
    if (creating) return
    setCreating(true)
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subject.trim() || undefined,
          partner_id: partnerId || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to create conversation.')
      const conv = data.conversation
      const item: CommConversationListItem = {
        ...conv,
        partner_name: partnerName(conv.partner_id),
        last_message_preview: null,
      }
      setConversations((prev) => [item, ...prev])
      setSelectedId(conv.id)
      setSubject('')
      setPartnerId('')
      setShowForm(false)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to create conversation.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-4 sm:p-6 h-[calc(100vh-3.5rem)] flex flex-col">
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <MessagesSquare className="h-5 w-5 text-blue-600" />
        <h1 className="text-xl font-bold">TD Communication</h1>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        {/* Conversation list */}
        <div className="flex flex-col min-h-0 bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="p-3 border-b flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-700">Conversations</span>
            <button
              onClick={() => setShowForm((v) => !v)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          </div>

          {showForm && (
            <div className="p-3 border-b bg-zinc-50 space-y-2">
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject (optional)"
                className="w-full px-2.5 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
              <select
                value={partnerId}
                onChange={(e) => setPartnerId(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-zinc-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
              >
                <option value="">No partner</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.partner_name || 'Unnamed partner'}
                  </option>
                ))}
              </select>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create conversation
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto">
            {conversations.length === 0 ? (
              <p className="p-4 text-sm text-zinc-400">No conversations yet.</p>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 border-b hover:bg-zinc-50 transition-colors',
                    selectedId === c.id && 'bg-blue-50 hover:bg-blue-50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-zinc-900 truncate">
                      {c.subject || c.partner_name || 'Conversation'}
                    </span>
                    {c.status !== 'open' && (
                      <span className="text-[9px] uppercase tracking-wide text-zinc-400">{c.status}</span>
                    )}
                  </div>
                  {c.partner_name && c.subject && (
                    <p className="text-[11px] text-zinc-500 truncate">{c.partner_name}</p>
                  )}
                  <p className="text-xs text-zinc-400 truncate">
                    {c.last_message_preview || 'No messages yet'}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Chat */}
        {selectedId ? (
          <ConversationChat key={selectedId} conversationId={selectedId} viewer={viewer} />
        ) : (
          <div className="flex items-center justify-center bg-white rounded-xl border shadow-sm text-zinc-400">
            <p className="text-sm">Select or create a conversation</p>
          </div>
        )}
      </div>
    </div>
  )
}
