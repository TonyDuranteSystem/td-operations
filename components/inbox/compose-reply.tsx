'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, Sparkles, Loader2 } from 'lucide-react'
import type { InboxConversation } from '@/lib/types'

interface ComposeReplyProps {
  conversation: InboxConversation
}

export function ComposeReply({ conversation }: ComposeReplyProps) {
  const [message, setMessage] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
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

  const handleAiSuggest = async () => {
    if (aiLoading) return
    setAiLoading(true)
    try {
      // Extract threadId from conversation.id (format: "gmail:threadId")
      const threadId = conversation.id.replace('gmail:', '')
      const res = await fetch('/api/inbox/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'AI suggestion failed')
      }
      const data = await res.json()
      if (data.suggestion) {
        setMessage(data.suggestion)
      }
    } catch {
      // Silently fail — AI is optional
    } finally {
      setAiLoading(false)
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
          className="compose-reply-textarea flex-1 resize-none rounded-xl border border-zinc-300 px-4 py-2.5 text-sm
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
            placeholder:text-zinc-400 max-h-32"
          style={{ minHeight: '42px' }}
        />

        {/* AI Suggest button — only for Gmail */}
        {conversation.channel === 'gmail' && (
          <button
            onClick={handleAiSuggest}
            disabled={aiLoading}
            className="shrink-0 p-2.5 rounded-xl bg-violet-100 text-violet-600 hover:bg-violet-200
              disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="AI Draft Reply"
          >
            {aiLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </button>
        )}

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
