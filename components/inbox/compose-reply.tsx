'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import type { InboxConversation } from '@/lib/types'

interface ComposeReplyProps {
  conversation: InboxConversation
}

export function ComposeReply({ conversation }: ComposeReplyProps) {
  const [message, setMessage] = useState('')
  const queryClient = useQueryClient()

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          message: text,
          channel: conversation.channel,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setMessage('')
      // Refetch messages to show the sent message
      queryClient.invalidateQueries({
        queryKey: ['inbox-messages', conversation.id],
      })
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
    },
  })

  const handleSend = () => {
    const text = message.trim()
    if (!text || sendMutation.isPending) return
    sendMutation.mutate(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="border-t bg-white px-4 py-3">
      {sendMutation.isError && (
        <p className="text-xs text-red-500 mb-2">
          Failed to send: {sendMutation.error.message}
        </p>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Reply via ${conversation.channel}...`}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-zinc-300 px-4 py-2.5 text-sm
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
            placeholder:text-zinc-400 max-h-32"
          style={{ minHeight: '42px' }}
        />

        <button
          onClick={handleSend}
          disabled={!message.trim() || sendMutation.isPending}
          className="shrink-0 p-2.5 rounded-xl bg-blue-500 text-white hover:bg-blue-600
            disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {sendMutation.isPending ? (
            <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  )
}
