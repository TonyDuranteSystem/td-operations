'use client'

/**
 * WorkerChatPanel — the Slack worker embedded in the Inbox (Antonio,
 * 2026-07-08: "the same worker I have in Slack with the same power").
 *
 * Slide-over chat next to the open email thread. Calls
 * /api/inbox/worker-chat, which runs the shared read-only worker
 * (DB/CRM/KB/Gmail reads + central memory recall + propose_action) with the
 * Slack persona. Conversation memory is persistent PER EMAIL THREAD
 * (threadId inbox-<mailbox>-<gmailThreadId>) — closing and reopening the
 * panel on the same email continues the same conversation.
 */

import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { InboxConversation } from '@/lib/types'

interface ChatMsg {
  role: 'user' | 'worker'
  text: string
}

interface WorkerChatPanelProps {
  conversation: InboxConversation
  mailbox?: string
  onClose: () => void
}

export function WorkerChatPanel({ conversation, mailbox, onClose }: WorkerChatPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentContextRef = useRef(false)

  const gmailThreadId = conversation.id.replace('gmail:', '')

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, pending])

  useEffect(() => {
    if (!pending) { setElapsed(0); return }
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [pending])

  const send = async () => {
    const text = input.trim()
    if (!text || pending) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setPending(true)
    try {
      const res = await fetch('/api/inbox/worker-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          gmailThreadId,
          mailbox,
          // Email context only on the panel's first message — the worker's
          // persistent thread memory carries it afterwards.
          context: sentContextRef.current
            ? null
            : {
                subject: conversation.subject,
                sender: conversation.name,
                mailbox: mailbox === 'antonio' ? 'antonio' : 'support',
                latestMessage: conversation.preview,
              },
        }),
      })
      const raw = await res.text()
      let data: { reply?: string; error?: string } = {}
      try { data = JSON.parse(raw) } catch { /* non-JSON = gateway error */ }
      if (!res.ok) {
        throw new Error(
          data.error ||
          (res.status === 504
            ? 'The worker ran out of time (over 5 minutes) — ask a narrower question or try again.'
            : `Worker error ${res.status} — please try again.`)
        )
      }
      sentContextRef.current = true
      setMessages(prev => [...prev, { role: 'worker', text: data.reply || '(empty reply)' }])
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: 'worker', text: `⚠️ ${err instanceof Error && err.message ? err.message : 'Worker failed — please try again.'}` },
      ])
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="w-full sm:w-[420px] shrink-0 border-l bg-white flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-violet-50/60 shrink-0">
        <Bot className="h-4 w-4 text-violet-600 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900">Worker</p>
          <p className="text-[11px] text-zinc-500 truncate">
            Reads CRM, DB &amp; memory — about: {conversation.subject || conversation.name}
          </p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 text-zinc-400" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !pending && (
          <div className="text-xs text-zinc-400 px-2 py-4 text-center space-y-1">
            <p>Same worker as Slack — it checks the CRM, database and its memory before answering.</p>
            <p>Try: &quot;who is this client and what&apos;s open with them?&quot; or &quot;draft a reply&quot;.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[90%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words',
                m.role === 'user'
                  ? 'bg-violet-600 text-white rounded-br-md'
                  : 'bg-zinc-100 text-zinc-900 rounded-bl-md'
              )}
            >
              {m.text}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 px-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Working — checking CRM/DB/memory… {elapsed}s
          </div>
        )}
      </div>

      <div className="border-t px-3 py-2.5 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            placeholder="Ask the worker about this email…"
            rows={1}
            className="flex-1 resize-none rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent placeholder:text-zinc-400 max-h-28"
          />
          <button
            onClick={send}
            disabled={!input.trim() || pending}
            className="shrink-0 p-2 rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 transition-colors"
            title="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
