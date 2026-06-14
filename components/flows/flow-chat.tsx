'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Send } from 'lucide-react'

interface FlowChatProps {
  serviceDeliveryId: string
  label?: string
}

interface ChatMessage {
  id: string
  created_at: string | null
  sender_type: string
  sender_name: string | null
  message: string
  topic: string | null
}

/**
 * Flow Workspace chat panel — a per-service-delivery message stream backed by
 * portal_messages (filtered by service_delivery_id). Staff send messages to the
 * client about THIS flow; the POST auto-stamps service_delivery_id + topic (the
 * flow name) + account/contact, so the message appears in the client's portal
 * chat and notifies them. Client replies that reply to a flow message thread back
 * here. Messages render oldest-first (chronological).
 */
export function FlowChat({ serviceDeliveryId, label }: FlowChatProps) {
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/chat`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Could not load messages.')
      }
      setMessages(data.messages ?? [])
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load messages.')
    } finally {
      setLoading(false)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  // Keep the latest message in view as the thread grows.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Could not send the message.')
      }
      setMessages((prev) => [...prev, data.message])
      setDraft('')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send the message.')
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-zinc-900 mb-3">{label || 'Chat'}</h3>

      <div
        ref={scrollRef}
        className="max-h-80 overflow-y-auto space-y-3 mb-3"
      >
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-zinc-500">No messages yet for this flow.</p>
        ) : (
          messages.map((m) => {
            const isAdmin = m.sender_type === 'admin'
            return (
              <div key={m.id} className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 ${
                    isAdmin ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-900'
                  }`}
                >
                  <div className={`text-[11px] mb-0.5 ${isAdmin ? 'text-blue-100' : 'text-zinc-500'}`}>
                    {m.sender_name || (isAdmin ? 'Tony Durante Team' : 'Client')}
                    {m.topic && <span className="ml-1 opacity-80">· {m.topic}</span>}
                    {m.created_at && (
                      <span className="ml-1 opacity-80">
                        {new Date(m.created_at).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  <div className="text-sm whitespace-pre-wrap break-words">{m.message}</div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Write a message…"
            rows={2}
            maxLength={5000}
            className="flex-1 resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || !draft.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
