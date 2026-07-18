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
import { Bot, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { WorkerMarkdown } from '@/components/chat/worker-markdown'
import { WorkerComposer } from '@/components/chat/worker-composer'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'
import { useWorkerAttachments, type UploadedAttachment } from '@/components/chat/use-worker-attachments'

interface ChatMsg {
  role: 'user' | 'worker'
  text: string
  /** agent_messages row id — present on worker replies, enables the 🧠 button. */
  id?: string
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
  const attachments = useWorkerAttachments()
  // 🧠 per-reply save state, keyed by the reply's row id.
  const [remembered, setRemembered] = useState<Record<string, 'saving' | 'saved'>>({})

  /**
   * 🧠 — turn THIS worker reply into a rule for everyone. Sends only the id; the
   * server re-reads the reply text and distills it into a general, client-free
   * rule before saving (Antonio's rule: 🧠 = make it global).
   */
  async function rememberReply(id: string) {
    if (remembered[id]) return
    setRemembered(p => ({ ...p, [id]: 'saving' }))
    const clear = () => setRemembered(p => { const n = { ...p }; delete n[id]; return n })
    try {
      const res = await fetch('/api/inbox/worker-chat/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Could not save that to memory.')
      }
      if (data.saved || data.reason === 'already_saved') {
        setRemembered(p => ({ ...p, [id]: 'saved' }))
        toast.success(data.saved ? 'Saved as a rule for everyone' : 'Already saved to memory')
        return
      }
      clear()
      toast.error(data.message || 'Could not save that to memory.')
    } catch (err) {
      clear()
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save that to memory.')
    }
  }

  const clientKey = accountId ? `acct-${accountId}` : contactId ? `contact-${contactId}` : null

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, pending])

  useEffect(() => {
    if (!pending) { setElapsed(0); return }
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [pending])

  // New client selected → restore that client's recorded conversation
  // (per-client persistent memory, like opening a Slack thread)
  useEffect(() => {
    setMessages([])
    sentContextRef.current = false
    if (!clientKey) return
    let alive = true
    fetch(`/api/inbox/worker-chat?clientKey=${encodeURIComponent(clientKey)}`)
      .then(r => r.json())
      .then((data: { turns?: Array<{ id?: string; user: string; worker: string | null }> }) => {
        if (!alive || !data.turns?.length) return
        const restored: ChatMsg[] = []
        for (const t of data.turns) {
          restored.push({ role: 'user', text: t.user })
          if (t.worker) restored.push({ role: 'worker', text: t.worker, id: t.id })
        }
        setMessages(restored)
        sentContextRef.current = true
      })
      .catch(() => {})
    return () => { alive = false }
  }, [clientKey])

  const send = async (text: string, attachments: UploadedAttachment[]) => {
    if (!text || pending || !clientKey) return
    const shown = attachments.length
      ? `${text}\n\n📎 ${attachments.map(a => a.name).join(', ')}`
      : text
    setMessages(prev => [...prev, { role: 'user', text: shown }])
    setPending(true)
    try {
      const res = await fetch('/api/inbox/worker-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          clientKey,
          // Both IDs so the server scopes the client's chat attachments the SAME
          // way the panel does — clientKey alone is one id and misses person-tagged
          // (account_id NULL) messages, which is where a screenshot often lands.
          accountId,
          contactId,
          ...(attachments.length ? { attachments } : {}),
          clientName: sentContextRef.current ? undefined : clientName,
        }),
      })
      const raw = await res.text()
      let data: { reply?: string; error?: string; messageId?: string } = {}
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
      setMessages(prev => [...prev, { role: 'worker', text: data.reply || '(empty reply)', id: data.messageId }])
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
    <WorkerDropZone
      onFiles={files => void attachments.add(files)}
      disabled={pending}
      className="flex-1 flex flex-col min-h-0"
    >
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
          <div key={i} className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
            <div
              className={cn(
                'max-w-[90%] rounded-2xl px-3.5 py-2 text-sm break-words',
                m.role === 'user'
                  ? 'bg-violet-600 text-white rounded-br-md whitespace-pre-wrap'
                  : 'bg-zinc-100 text-zinc-900 rounded-bl-md'
              )}
            >
              {m.role === 'worker' ? <WorkerMarkdown text={m.text} /> : m.text}
            </div>
            {/* 🧠 — make THIS reply a rule for everyone (global, client details
                scrubbed). Only on worker replies we have a row id for. */}
            {m.role === 'worker' && m.id && (
              <button
                type="button"
                onClick={() => void rememberReply(m.id!)}
                disabled={remembered[m.id] === 'saving' || remembered[m.id] === 'saved'}
                title={
                  remembered[m.id] === 'saved'
                    ? 'Saved to memory as a rule for everyone'
                    : 'Save as a rule for everyone (client details are removed)'
                }
                className={cn(
                  'mt-1 ml-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs min-h-[28px]',
                  'transition-colors disabled:cursor-default',
                  remembered[m.id] === 'saved'
                    ? 'text-emerald-700 bg-emerald-50'
                    : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100'
                )}
              >
                {remembered[m.id] === 'saving' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span aria-hidden>🧠</span>
                )}
                <span>
                  {remembered[m.id] === 'saved'
                    ? 'Saved'
                    : remembered[m.id] === 'saving'
                      ? 'Saving…'
                      : 'Remember'}
                </span>
              </button>
            )}
          </div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 px-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Working — checking CRM/DB/memory… {elapsed}s
          </div>
        )}
      </div>

      <WorkerComposer
        placeholder={`Ask the worker about ${clientName}…`}
        pending={pending}
        value={input}
        onChange={setInput}
        onSend={send}
        attachments={attachments}
      />
    </WorkerDropZone>
  )
}
