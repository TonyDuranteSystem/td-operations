'use client'

/**
 * WhatsAppWorkerPanel — the CRM Worker beside ONE open WhatsApp chat.
 *
 * Read-only: it looks things up and drafts. Nothing is sent from here — "Use as draft" drops
 * the text into the ordinary WhatsApp message box, and the staff member presses Send there.
 * Talks to /api/inbox/whatsapp-worker; conversation memory is permanent per chat.
 */

import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { WorkerMarkdown } from '@/components/chat/worker-markdown'
import { extractDrafts } from '@/lib/inbox/whatsapp-worker-context'

interface ChatMsg {
  role: 'user' | 'worker' | 'error'
  text: string
}

interface ChatSummary {
  name: string | null
  isGroup: boolean
  leadName: string | null
  contactName: string | null
  accountName: string | null
}

interface WhatsAppWorkerPanelProps {
  groupId: string
  onClose: () => void
  /** Puts text in the message box. Returns false when it could not (e.g. a send is in flight). */
  onUseDraft: (text: string) => boolean
}

function linkLabel(chat: ChatSummary | null, failed: boolean): string {
  if (failed) return 'Could not load who this chat is — the Worker still works'
  if (!chat) return 'Checking who this chat is…'
  const parts: string[] = []
  if (chat.leadName) parts.push(`lead ${chat.leadName}`)
  if (chat.contactName) parts.push(`contact ${chat.contactName}`)
  if (chat.accountName) parts.push(`company ${chat.accountName}`)
  return parts.length ? `Linked to ${parts.join(', ')}` : 'Not linked to any lead, contact or company'
}

export function WhatsAppWorkerPanel({ groupId, onClose, onUseDraft }: WhatsAppWorkerPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [chat, setChat] = useState<ChatSummary | null>(null)
  const [chatFailed, setChatFailed] = useState(false)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetch(`/api/inbox/whatsapp-worker?groupId=${encodeURIComponent(groupId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
      .then((data: { turns?: Array<{ user: string; worker: string | null }>; chat?: ChatSummary }) => {
        if (!alive) return
        if (data.chat) setChat(data.chat)
        if (!data.turns?.length) return
        const restored: ChatMsg[] = []
        for (const t of data.turns) {
          restored.push({ role: 'user', text: t.user })
          if (t.worker) restored.push({ role: 'worker', text: t.worker })
        }
        setMessages(restored)
      })
      .catch(() => {
        if (alive) setChatFailed(true)
      })
    return () => {
      alive = false
    }
  }, [groupId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, pending])

  useEffect(() => {
    if (!pending) {
      setElapsed(0)
      return
    }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [pending])

  const send = async () => {
    const text = input.trim()
    if (!text || pending) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setInput('')
    setPending(true)
    try {
      const res = await fetch('/api/inbox/whatsapp-worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, message: text }),
      })
      const raw = await res.text()
      let data: { reply?: string; error?: string } = {}
      try {
        data = JSON.parse(raw)
      } catch {
        /* non-JSON = gateway error */
      }
      if (!res.ok) {
        throw new Error(
          data.error ||
            (res.status === 504
              ? 'The worker ran out of time (over 5 minutes) — ask a narrower question or try again.'
              : `Worker error ${res.status} — please try again.`),
        )
      }
      if (!data.reply?.trim()) throw new Error('The worker sent back an empty answer — please try again.')
      if (aliveRef.current) setMessages((prev) => [...prev, { role: 'worker', text: data.reply as string }])
    } catch (err) {
      if (!aliveRef.current) return
      setMessages((prev) => [
        ...prev,
        { role: 'error', text: err instanceof Error && err.message ? err.message : 'Worker failed — please try again.' },
      ])
      setInput((prev) => prev || text)
    } finally {
      if (aliveRef.current) setPending(false)
    }
  }

  const useDraft = (text: string) => {
    if (onUseDraft(text)) toast.success('Added to the message box — read it, then press Send there.')
    else toast.error('Could not add it to the message box right now — try again in a moment.')
  }

  return (
    <div className="w-full sm:w-[420px] shrink-0 border-l bg-white flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-violet-50/60 shrink-0">
        <Bot className="h-4 w-4 text-violet-600 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900">Worker</p>
          <p className="text-[11px] text-zinc-500 truncate">{linkLabel(chat, chatFailed)}</p>
        </div>
        <FastTooltip label="Close">
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 text-zinc-400" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </FastTooltip>
      </div>

      {chat?.isGroup && (
        <div className="px-4 py-1.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800 shrink-0">
          Group chat — anything sent here goes to everyone in the group.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !pending && (
          <div className="text-xs text-zinc-400 px-2 py-4 text-center space-y-1">
            <p>It reads this chat and looks in the CRM, KB and call notes. It cannot send anything.</p>
            <p>Try: &quot;who is this and where are we with them?&quot; or &quot;draft a reply saying we&apos;ll follow up tomorrow&quot;.</p>
            <p>Photos, voice notes and documents in the chat are not read.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
            {m.role === 'user' && (
              <div className="max-w-[90%] rounded-2xl rounded-br-md bg-violet-600 text-white px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                {m.text}
              </div>
            )}
            {m.role === 'error' && (
              <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-red-50 text-red-700 px-3.5 py-2 text-sm break-words">
                ⚠️ {m.text}
              </div>
            )}
            {m.role === 'worker' && <WorkerReply text={m.text} onUseDraft={useDraft} />}
          </div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 px-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Working — checking the chat and the CRM… {elapsed}s
          </div>
        )}
      </div>

      <div className="border-t px-3 py-2.5 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Ask the worker about this chat…"
            rows={3}
            disabled={pending}
            className="flex-1 resize-y rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent placeholder:text-zinc-400 min-h-[72px] max-h-48 disabled:bg-zinc-50"
          />
          <FastTooltip label="Send to the worker">
            <button
              onClick={() => void send()}
              disabled={pending || !input.trim()}
              className="shrink-0 p-2 rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"
              aria-label="Send to the worker"
            >
              <Send className="h-4 w-4" />
            </button>
          </FastTooltip>
        </div>
      </div>
    </div>
  )
}

function WorkerReply({ text, onUseDraft }: { text: string; onUseDraft: (text: string) => void }) {
  const segments = extractDrafts(text)
  return (
    <div className="max-w-[90%] space-y-2">
      {segments.map((s, i) =>
        s.type === 'draft' ? (
          <div key={i} className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">Draft message</p>
            <p className="text-sm text-zinc-900 whitespace-pre-wrap break-words">{s.text}</p>
            <button
              onClick={() => onUseDraft(s.text)}
              className="mt-2 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
            >
              Use as draft
            </button>
          </div>
        ) : (
          <div key={i} className="rounded-2xl rounded-bl-md bg-zinc-100 text-zinc-900 px-3.5 py-2 text-sm break-words">
            <WorkerMarkdown text={s.text} />
          </div>
        ),
      )}
    </div>
  )
}
