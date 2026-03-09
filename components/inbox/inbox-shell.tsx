'use client'

import { useState } from 'react'
import { ArrowLeft, MessageSquare, Mail, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InboxHeader } from './inbox-header'
import { ConversationList } from './conversation-list'
import { MessageThread } from './message-thread'
import { ComposeReply } from './compose-reply'
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

  const handleSelect = (conversation: InboxConversation) => {
    setSelected(conversation)
  }

  const handleBack = () => {
    setSelected(null)
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header with channel tabs */}
      <InboxHeader
        activeChannel={activeChannel}
        onChannelChange={setActiveChannel}
      />

      <div className="flex flex-1 min-h-0">
        {/* ─── Left Panel: Conversation List ─────────── */}
        <div
          className={cn(
            'w-full lg:w-[350px] lg:shrink-0 flex flex-col border-r',
            // On mobile, hide when a conversation is selected
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
            // On mobile, hide when no conversation is selected
            !selected ? 'hidden lg:flex' : 'flex'
          )}
        >
          {selected ? (
            <>
              {/* Thread header */}
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

                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-900 truncate">
                    {selected.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {channelLabels[selected.channel]}
                    {selected.subject && ` \u2014 ${selected.subject}`}
                  </p>
                </div>
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
    </div>
  )
}
