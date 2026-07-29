'use client'

import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, Sparkles, Loader2, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'
import { useEmailAttachments } from './use-email-attachments'
import { EmailAttachmentChips } from './email-attachment-chips'
import type { InboxConversation } from '@/lib/types'

interface ComposeReplyProps {
  conversation: InboxConversation
  /** Which Gmail mailbox the user is viewing ('support' | 'antonio') — the
   *  reply must be fetched from and sent through the SAME mailbox. */
  mailbox?: string
}

export function ComposeReply({ conversation, mailbox }: ComposeReplyProps) {
  const [message, setMessage] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const attachments = useEmailAttachments()

  const isEmail = conversation.channel === 'gmail'

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const staged = attachments.uploaded()
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          message: text,
          channel: conversation.channel,
          mailbox,
          ...(staged.length > 0 && { attachments: staged }),
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
      attachments.clear()
      setAttachNotice(null)
      const refetch = () => {
        queryClient.invalidateQueries({
          queryKey: ['inbox-messages', conversation.id],
        })
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      }
      // Gmail indexes the sent message with a small lag, and the push watch
      // only covers INCOMING mail — without these delayed refetches the sent
      // reply never appears in the thread until a manual refresh.
      refetch()
      setTimeout(refetch, 4000)
      setTimeout(refetch, 12000)
    },
  })

  const handleSend = () => {
    const text = message.trim()
    if (!text || sendMutation.isPending) return
    // Never send while a file is mid-upload or silently drop one that failed —
    // the staff member attached it because the recipient needs it.
    if (attachments.uploading) {
      setAttachNotice('Wait for the upload to finish, then send.')
      return
    }
    if (attachments.failed().length > 0) {
      setAttachNotice('An attachment failed — remove it (×) or re-attach it before sending.')
      return
    }
    setAttachNotice(null)
    sendMutation.mutate(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    if (isEmail) {
      // Email composer works like Gmail: Enter = new line, Cmd/Ctrl+Enter
      // sends. Enter-to-send made multi-paragraph replies impossible and
      // caused accidental sends.
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        handleSend()
      }
      return
    }
    // Chat channels (WhatsApp/Telegram) keep Enter-to-send, Shift+Enter = newline
    if (!e.shiftKey) {
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

  const composer = (
    <div className="border-t bg-white px-4 py-3">
      {sendMutation.isError && (
        <p className="text-xs text-red-500 mb-2">
          Failed to send: {sendMutation.error.message}
        </p>
      )}
      {attachNotice && (
        <p className="text-xs text-amber-600 mb-2">{attachNotice}</p>
      )}
      {isEmail && (
        <div className="mb-2 empty:hidden">
          <EmailAttachmentChips attachments={attachments} />
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={isEmail ? attachments.onPaste : undefined}
          placeholder={
            isEmail
              ? 'Reply via gmail... (Enter = new line, ⌘+Enter = send, drop files to attach)'
              : `Reply via ${conversation.channel}...`
          }
          rows={isEmail ? 4 : 1}
          className={cn(
            'compose-reply-textarea flex-1 rounded-xl border border-zinc-300 px-4 py-2.5 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-400',
            isEmail ? 'resize-y min-h-[96px] max-h-80' : 'resize-none max-h-32'
          )}
          style={isEmail ? undefined : { minHeight: '42px' }}
        />

        {/* Attach + AI buttons — only for Gmail */}
        {isEmail && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? [])
                if (picked.length) void attachments.add(picked)
                e.target.value = '' // re-picking the same file must fire again
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 p-2.5 rounded-xl bg-zinc-100 text-zinc-500 hover:bg-zinc-200
                hover:text-zinc-700 transition-colors"
              title="Attach files"
            >
              <Paperclip className="h-4 w-4" />
            </button>
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
          </>
        )}

        <button
          onClick={handleSend}
          disabled={!message.trim() || sendMutation.isPending || attachments.uploading}
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

  if (!isEmail) return composer

  return (
    <WorkerDropZone onFiles={(f) => void attachments.add(f)} label="Drop files to attach to the reply">
      {composer}
    </WorkerDropZone>
  )
}
