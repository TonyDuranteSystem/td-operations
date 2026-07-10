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
import { Bot, Loader2, Paperclip, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorkerMarkdown } from '@/components/chat/worker-markdown'
import { WorkerComposer } from '@/components/chat/worker-composer'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'
import { useWorkerAttachments, type UploadedAttachment } from '@/components/chat/use-worker-attachments'
import type { InboxConversation } from '@/lib/types'

interface ChatMsg {
  role: 'user' | 'worker'
  text: string
  /**
   * Server-attested off-thread address the worker tried to email and was refused.
   * When set, this worker bubble shows a "Confirm & send" button. The address
   * comes from the server (the real refused attempt), never parsed from the reply.
   */
  pendingSendTo?: string
}

interface PreparedSend {
  id: string
  to: string
  subject: string
  attachments: Array<{ name: string; size?: number }>
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
  const [preparedSend, setPreparedSend] = useState<PreparedSend | null>(null)
  const [confirming, setConfirming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentContextRef = useRef(false)
  // The staff member's most recent request text — re-sent on a "Confirm & send"
  // click so the worker re-drafts and now actually sends to the confirmed address.
  const lastUserTextRef = useRef('')
  const attachments = useWorkerAttachments()

  const resolvePreparedSend = async (action: 'confirm' | 'cancel') => {
    if (!preparedSend || confirming) return
    setConfirming(true)
    try {
      const res = await fetch('/api/inbox/worker-chat/confirm-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepared_id: preparedSend.id, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not complete — please try again.')
      setMessages(prev => [
        ...prev,
        {
          role: 'worker',
          text: action === 'confirm'
            ? `✅ Sent to ${preparedSend.to} with ${preparedSend.attachments.map(a => a.name).join(', ')} attached.`
            : 'Cancelled — nothing was sent.',
        },
      ])
      setPreparedSend(null)
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: 'worker', text: `⚠️ ${err instanceof Error && err.message ? err.message : 'Could not complete.'}` },
      ])
    } finally {
      setConfirming(false)
    }
  }

  const gmailThreadId = conversation.id.replace('gmail:', '')

  // Restore the recorded conversation on open — like opening a Slack thread.
  useEffect(() => {
    let alive = true
    const params = new URLSearchParams({ gmailThreadId })
    if (mailbox) params.set('mailbox', mailbox)
    fetch(`/api/inbox/worker-chat?${params}`)
      .then(r => r.json())
      .then((data: { turns?: Array<{ user: string; worker: string | null }> }) => {
        if (!alive || !data.turns?.length) return
        const restored: ChatMsg[] = []
        for (const t of data.turns) {
          restored.push({ role: 'user', text: t.user })
          if (t.worker) restored.push({ role: 'worker', text: t.worker })
        }
        setMessages(restored)
        sentContextRef.current = true // context already recorded on turn 1
      })
      .catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gmailThreadId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, pending])

  useEffect(() => {
    if (!pending) { setElapsed(0); return }
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [pending])

  const send = async (
    text: string,
    attachments: UploadedAttachment[],
    confirmedRecipient?: string,
  ) => {
    if (!text || pending) return
    if (confirmedRecipient) {
      // A "Confirm & send" click: record the staff's affirmative action, and drop
      // every outstanding confirm button (the address is now authorised).
      lastUserTextRef.current = text
      setMessages(prev => [
        ...prev.map(m => (m.pendingSendTo ? { ...m, pendingSendTo: undefined } : m)),
        { role: 'user', text: `✓ Confirmed — send to ${confirmedRecipient}` },
      ])
    } else {
      lastUserTextRef.current = text
      const shown = attachments.length
        ? `${text}\n\n📎 ${attachments.map(a => a.name).join(', ')}`
        : text
      setMessages(prev => [...prev, { role: 'user', text: shown }])
    }
    setPending(true)
    try {
      const res = await fetch('/api/inbox/worker-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          gmailThreadId,
          mailbox,
          ...(attachments.length ? { attachments } : {}),
          ...(confirmedRecipient ? { confirmedRecipient } : {}),
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
      let data: { reply?: string; error?: string; pendingSend?: { to?: string } | null; preparedSend?: PreparedSend | null } = {}
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
      // Off-thread recipient confirm (per-message button) — the other feature.
      setMessages(prev => [...prev, {
        role: 'worker',
        text: data.reply || '(empty reply)',
        ...(data.pendingSend?.to ? { pendingSendTo: data.pendingSend.to } : {}),
      }])
      // Attachment confirm (Confirm & send box) — this feature.
      if (data.preparedSend) setPreparedSend(data.preparedSend)
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
    <WorkerDropZone
      onFiles={files => void attachments.add(files)}
      disabled={pending}
      className="w-full sm:w-[420px] shrink-0 border-l bg-white flex flex-col min-h-0"
    >
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
            {m.role === 'worker' && m.pendingSendTo && (
              <div className="mt-1.5 max-w-[90%] rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p className="mb-1.5">
                  This address is <b>not on the email thread</b> — check every character before sending:
                </p>
                <p className="font-mono text-[13px] text-zinc-900 break-all mb-2">{m.pendingSendTo}</p>
                <button
                  onClick={() => void send(lastUserTextRef.current, [], m.pendingSendTo)}
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" /> Confirm &amp; send to this address
                </button>
              </div>
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

      {preparedSend && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 shrink-0">
          <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide mb-1">Confirm before sending</p>
          <p className="text-sm text-zinc-800">
            Email <span className="font-medium">{preparedSend.to}</span>
            {preparedSend.subject ? <> — “{preparedSend.subject}”</> : null}
          </p>
          <div className="mt-1.5 space-y-1">
            {preparedSend.attachments.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-zinc-600">
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="font-medium truncate">{a.name}</span>
                {typeof a.size === 'number' && <span className="text-zinc-400">{(a.size / 1024 / 1024).toFixed(1)} MB</span>}
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={() => resolvePreparedSend('confirm')}
              disabled={confirming}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {confirming ? 'Sending…' : 'Confirm & send'}
            </button>
            <button
              onClick={() => resolvePreparedSend('cancel')}
              disabled={confirming}
              className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <WorkerComposer
        placeholder="Ask the worker about this email…"
        pending={pending}
        value={input}
        onChange={setInput}
        onSend={send}
        attachments={attachments}
      />
    </WorkerDropZone>
  )
}
