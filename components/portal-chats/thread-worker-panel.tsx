'use client'

/**
 * ThreadWorkerPanel — the Slack worker as a per-CLIENT tab in Portal Chats
 * (Antonio 2026-07-08: the same worker, in every chat). Same engine and
 * tools as Slack/inbox (/api/inbox/worker-chat, client mode); conversation
 * memory persists PER CLIENT (threadId chat-acct-<id> / chat-contact-<id>).
 *
 * UI intentionally mirrors components/inbox/worker-chat-panel.tsx —
 * consolidation into one shared chat component is a flagged follow-up.
 */

import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, Send } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ChatMsg {
  role: 'user' | 'worker'
  text: string
}

interface ThreadWorkerPanelProps {
  accountId: string | null
  contactId: string | null
  clientName: string
}

export function ThreadWorkerPanel({ accountId, contactId, clientName }: ThreadWorkerPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentContextRef = useRef(false)

  const clientKey = accountId ? `acct-${accountId}` : contactId ? `contact-${contactId}` : null

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, pending])

  useEffect(() => {
    if (!pending) { setElapsed(0); return }
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [pending])

  // New client selected → fresh panel state (the worker's own per-client
  // memory persists server-side regardless)
  useEffect(() => {
    setMessages([])
    sentContextRef.current = false
  }, [clientKey])

  const send = async () => {
    const text = input.trim()
    if (!text || pending || !clientKey) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setPending(true)
    try {
      const res = await fetch('/api/inbox/worker-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          clientKey,
          clientName: sentContextRef.current ? undefined : clientName,
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

  if (!clientKey) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-zinc-400">
        Select a client to talk to the worker
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-violet-50/60 shrink-0">
        <Bot className="h-4 w-4 text-violet-600 shrink-0" />
        <p className="text-xs text-zinc-600 truncate">
          Worker — reads CRM, DB &amp; memory — about: <span className="font-medium">{clientName}</span>
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !pending && (
          <div className="text-xs text-zinc-400 px-2 py-4 text-center space-y-1">
            <p>Same worker as Slack — it checks the CRM, database and its memory before answering.</p>
            <p>Try: &quot;summarize this client&apos;s state&quot; or &quot;draft a chat message about the missing document&quot;.</p>
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
            placeholder={`Ask the worker about ${clientName}…`}
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
