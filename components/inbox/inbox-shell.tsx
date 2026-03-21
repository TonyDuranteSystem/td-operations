'use client'

import { useState } from 'react'
import { ArrowLeft, MessageSquare, Mail, Send, PenSquare, Archive, Star, Forward, Trash2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { InboxHeader } from './inbox-header'
import { ConversationList } from './conversation-list'
import { MessageThread } from './message-thread'
import { ComposeReply } from './compose-reply'
import { ComposeDialog } from './compose-dialog'
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

export function InboxShell() {
  const [activeChannel, setActiveChannel] = useState<InboxChannel | null>(null)
  const [selected, setSelected] = useState<InboxConversation | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [forwardData, setForwardData] = useState<{ subject: string } | null>(null)
  const queryClient = useQueryClient()

  const emailActionMutation = useMutation({
    mutationFn: async ({ action, forwardTo }: { action: string; forwardTo?: string }) => {
      if (!selected) return
      const threadId = selected.id.replace('gmail:', '')
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, action, forwardTo }),
      })
      if (!res.ok) throw new Error('Action failed')
      return res.json()
    },
    onSuccess: (_, variables) => {
      // After archive or trash, immediately remove from list + deselect
      if (variables.action === 'archive' || variables.action === 'trash') {
        if (selected) {
          // Optimistically remove the conversation from the cache
          queryClient.setQueriesData(
            { queryKey: ['inbox-conversations'] },
            (old: unknown) => {
              if (!old || typeof old !== 'object') return old
              const data = old as { conversations?: InboxConversation[]; total?: number }
              if (!data.conversations) return old
              return {
                ...data,
                conversations: data.conversations.filter(c => c.id !== selected.id),
                total: (data.total ?? data.conversations.length) - 1,
              }
            }
          )
        }
        setSelected(null)
      }
      // Refetch to get fresh data from server
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
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

  const isGmail = selected?.channel === 'gmail'

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header with channel tabs + compose button */}
      <div className="flex items-center justify-between border-b bg-white">
        <InboxHeader
          activeChannel={activeChannel}
          onChannelChange={setActiveChannel}
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

      <div className="flex flex-1 min-h-0">
        {/* ─── Left Panel: Conversation List ─────────── */}
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
          />
        </div>

        {/* ─── Right Panel: Message Thread ────────────── */}
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
                {/* Back button (mobile only) */}
                <button
                  onClick={handleBack}
                  className="lg:hidden p-1 rounded hover:bg-zinc-100"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>

                {/* Channel icon + name */}
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

                {/* Gmail action buttons */}
                {isGmail && (
                  <div className="flex items-center gap-1 shrink-0">
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
                      className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-red-500 transition-colors"
                      title="Trash"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* Messages */}
              <MessageThread conversation={selected} />

              {/* Reply composer */}
              <ComposeReply conversation={selected} />
            </>
          ) : (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-400">
              <MessageSquare className="h-12 w-12 mb-3 stroke-1" />
              <p className="text-sm font-medium">Select a conversation</p>
              <p className="text-xs mt-1">
                Choose from WhatsApp, Telegram, or Gmail
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Compose email dialog */}
      <ComposeDialog
        open={composeOpen}
        onClose={() => {
          setComposeOpen(false)
          setForwardData(null)
        }}
        prefillSubject={forwardData ? `Fwd: ${forwardData.subject}` : ''}
      />
    </div>
  )
}
