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
import {
  WorkerArtifactLinks,
  parseWorkerArtifacts,
  type WorkerArtifactLink,
} from '@/components/chat/worker-artifacts'
import { WorkerComposer } from '@/components/chat/worker-composer'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'
import { WorkerSettingsGear } from '@/components/chat/worker-settings-gear'
import { useWorkerAttachments, type UploadedAttachment } from '@/components/chat/use-worker-attachments'
import { ConfirmAttachments } from '@/components/inbox/confirm-attachments'
import { SignatureControls, SignaturePreview } from '@/components/inbox/signature-controls'
import { DEFAULT_SIGNATURE_VARIANT, type SignatureVariant } from '@/lib/email/signature'

interface ChatMsg {
  role: 'user' | 'worker'
  text: string
  /** agent_messages row id — present on worker replies, enables the 🧠 button. */
  id?: string
  /**
   * Files the worker PRODUCED on this turn (Antonio, 2026-08-05: "must be able to
   * produce files everywhere"). Server-attested, never parsed from the reply text.
   * Live turns only — the links are time-limited, so restoring an old one would
   * render a button that fails.
   */
  artifacts?: WorkerArtifactLink[]
}

/**
 * A frozen outbound email awaiting the staff member's Confirm — the second human
 * gate before a file leaves. Mirrors the Inbox panel's card (Antonio 2026-07-29:
 * the worker here has the same capabilities it has everywhere, attachments too).
 */
interface PreparedSend {
  id: string
  to: string
  subject: string
  /** The exact text that will be sent — confirming an address without seeing the
   *  body is how someone approves one draft while a different one goes out. */
  body: string
  attachments: Array<{ name: string; size?: number; content_type?: string; origin?: string; warning?: string }>
}

interface ThreadWorkerPanelProps {
  accountId: string | null
  contactId: string | null
  clientName: string
  /**
   * Hand a translated draft to the ORDINARY (already-unguarded) reply
   * composer on the Messages tab and switch to it — the safe alternative to
   * a "send anyway" button on the AI's own guarded send tool (dev job
   * 9c251e65, council-scoped 2026-08-22). Nothing sends automatically; a
   * human still has to look at it and press the real Send button.
   */
  onHandoffToComposer?: (text: string) => void
}

/** The exact draft + recipient the language guard just refused — surfaced by
 *  the route as `portalRefusedDraft`, never parsed from the reply text. */
interface RefusedDraft {
  message: string
  account_id?: string | null
  contact_id?: string | null
}

export function ThreadWorkerPanel({ accountId, contactId, clientName, onHandoffToComposer }: ThreadWorkerPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentContextRef = useRef(false)
  const attachments = useWorkerAttachments()
  const [preparedSend, setPreparedSend] = useState<PreparedSend | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [refusedDraft, setRefusedDraft] = useState<RefusedDraft | null>(null)
  const [translating, setTranslating] = useState<'English' | 'Italian' | null>(null)
  // WHICH OF OUR ADDRESSES IT GOES OUT FROM — the staff member chooses on the card
  // (Antonio, 2026-07-29). The server re-checks that they may send as it.
  const [sendAs, setSendAs] = useState<'support' | 'antonio'>('support')
  // WHICH SIGNATURE goes on the email — the staff member picks on the card.
  // Defaults to the full signature, i.e. exactly what this surface sent before
  // the picker existed, so an untouched card behaves as it always did.
  const [signatureVariant, setSignatureVariant] = useState<SignatureVariant>(DEFAULT_SIGNATURE_VARIANT)
  // Held in a ref so the client-switch effect can drop staged files without
  // taking the whole (re-created every render) attachments object as a dep.
  const clearAttachmentsRef = useRef(attachments.clear)
  clearAttachmentsRef.current = attachments.clear
  // 🧠 per-reply save state, keyed by the reply's row id.
  const [remembered, setRemembered] = useState<Record<string, 'saving' | 'saved'>>({})

  /**
   * Translate the refused draft into the picked language and hand it to the
   * ORDINARY reply composer (Messages tab) — never sends anything itself.
   * Reuses the exact same translation route AI Polish already ships with
   * (dev job 9c251e65): an explicit `target_language` always wins there, so
   * this never falls into Polish's own "ask which language" branch.
   */
  const translateAndHandoff = async (language: 'English' | 'Italian') => {
    if (!refusedDraft || translating) return
    setTranslating(language)
    try {
      const res = await fetch('/api/portal/chat/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: refusedDraft.message,
          account_id: refusedDraft.account_id ?? undefined,
          contact_id: refusedDraft.contact_id ?? undefined,
          target_language: language,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.polished) throw new Error(data.error || 'Could not translate — please try again.')
      onHandoffToComposer?.(data.polished)
      setRefusedDraft(null)
      toast.success(`Moved to the message box, translated to ${language} — review and send from there.`)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not translate — please try again.')
    } finally {
      setTranslating(null)
    }
  }

  /** Confirm or cancel a frozen email. Same endpoint the Inbox panel uses. */
  const resolvePreparedSend = async (action: 'confirm' | 'cancel') => {
    if (!preparedSend || confirming) return
    setConfirming(true)
    try {
      const res = await fetch('/api/inbox/worker-chat/confirm-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepared_id: preparedSend.id, action, mailbox: sendAs, signature_variant: signatureVariant }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not complete — please try again.')
      setMessages(prev => [
        ...prev,
        {
          role: 'worker',
          text: action === 'confirm'
            ? (preparedSend.attachments.length
                ? `✅ Sent to ${preparedSend.to} with ${preparedSend.attachments.map(a => a.name).join(', ')} attached.`
                : `✅ Sent to ${preparedSend.to}.`)
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
    // A frozen email belongs to the client it was drafted for. Leaving the card
    // (or a staged file) up across a client switch means "Confirm & send" would
    // dispatch the PREVIOUS client's email while the panel header shows the new
    // one — the worst kind of wrong-recipient mistake, and invisible.
    setPreparedSend(null)
    setConfirming(false)
    setRefusedDraft(null)
    clearAttachmentsRef.current()
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
    // A fresh ask supersedes any earlier refusal picker — the same discipline
    // preparedSend already follows below, so a stale "translate & send" choice
    // can't fire against a conversation that moved on.
    setRefusedDraft(null)
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
      let data: { reply?: string; error?: string; messageId?: string; preparedSend?: PreparedSend | null; artifacts?: unknown; portalRefusedDraft?: RefusedDraft | null } = {}
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
      setMessages(prev => [...prev, {
        role: 'worker',
        text: data.reply || '(empty reply)',
        id: data.messageId,
        // Shared parser: a malformed payload is dropped, never rendered as a dead button.
        artifacts: parseWorkerArtifacts(data.artifacts),
      }])
      // A frozen email waiting on a human — render the Confirm card. `?? null` is
      // load-bearing: a turn that prepares nothing must CLEAR a previous card, or a
      // stale frozen email stays on screen under a new conversation and one click
      // sends it.
      setPreparedSend(data.preparedSend ?? null)
      // Same "?? null clears the old one" discipline for the language-refusal
      // picker — already set to null above the fetch, this just confirms the
      // fresh answer (a turn that DIDN'T refuse must not leave a stale picker up).
      setRefusedDraft(data.portalRefusedDraft ?? null)
      // Fresh card → fresh choice; a sticky pick must not leak onto the next email.
      // Same for the signature: a "no signature" pick must not silently carry over.
      if (data.preparedSend) {
        setSendAs('support')
        setSignatureVariant(DEFAULT_SIGNATURE_VARIANT)
      }
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
        <WorkerSettingsGear className="ml-auto shrink-0" />
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
              {/* Produced files, from server data — present whatever the reply says. */}
              {m.role === 'worker' ? <WorkerArtifactLinks artifacts={m.artifacts} /> : null}
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

      {/* Language guard refused the draft — offer a real translate-and-hand-off
          picker instead of only prose. Nothing here sends anything: picking a
          language fills the ORDINARY Messages-tab compose box, same as it
          always worked, and a human still presses that box's own Send. */}
      {refusedDraft && (
        <div className="border-t border-indigo-200 bg-indigo-50 px-4 py-3 shrink-0">
          <p className="text-[11px] font-semibold text-indigo-800 uppercase tracking-wide mb-1">
            Which language should this go in?
          </p>
          <p className="text-xs text-zinc-500 mb-2">
            Moves the draft to the message box, translated — you still review and send it from there.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => translateAndHandoff('English')}
              disabled={translating !== null}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-h-[36px]"
            >
              {translating === 'English' ? 'Translating…' : 'English'}
            </button>
            <button
              onClick={() => translateAndHandoff('Italian')}
              disabled={translating !== null}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-h-[36px]"
            >
              {translating === 'Italian' ? 'Translating…' : 'Italian'}
            </button>
            <button
              onClick={() => setRefusedDraft(null)}
              disabled={translating !== null}
              className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50 min-h-[36px]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Frozen email awaiting a human. The worker never sends an attachment on
          its own — the staff member sees the exact recipient, subject, body and
          files here and presses Confirm. Mirrors the Inbox panel's card. */}
      {preparedSend && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 shrink-0">
          <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide mb-1">Confirm before sending</p>
          <p className="text-sm text-zinc-800">
            Email <span className="font-mono font-medium break-all">{preparedSend.to}</span>
          </p>
          {preparedSend.subject ? (
            <p className="text-xs text-zinc-600 mt-0.5">Subject: {preparedSend.subject}</p>
          ) : null}
          {preparedSend.body ? (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-white px-2.5 py-2">
              <p className="whitespace-pre-wrap break-words text-xs text-zinc-700">{preparedSend.body}</p>
            </div>
          ) : null}
          <ConfirmAttachments
            preparedId={preparedSend.id}
            attachments={preparedSend.attachments}
            className="mt-1.5 space-y-1.5"
            onChange={files => setPreparedSend(p => (p ? { ...p, attachments: files } : p))}
          />
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-zinc-500">From:</span>
            <select
              value={sendAs}
              onChange={e => {
                const next = e.target.value as 'support' | 'antonio'
                setSendAs(next)
                // Coerce the STATE, not just the display: "hat" isn't offered
                // for support, so the control would read "Full" while the POST
                // still carried "hat".
                if (next === 'support' && signatureVariant === 'hat') setSignatureVariant('gala')
              }}
              disabled={confirming}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 disabled:opacity-50"
            >
              <option value="support">support@tonydurante.us</option>
              <option value="antonio">antonio.durante@tonydurante.us</option>
            </select>
            {/* Same per-email chooser as the Inbox card and manual compose
                (Antonio, 2026-08-07 — the Inbox-only picker left this surface
                silently sending the full signature). */}
            <SignatureControls
              sender={sendAs}
              variant={signatureVariant}
              onVariantChange={setSignatureVariant}
              disabled={confirming}
            />
          </div>
          {/* The chooser is blind without a preview — the signature is attached
              server-side. Scrolls so the full variant can't swallow the card. */}
          <div className="mt-2 max-h-36 overflow-y-auto">
            <SignaturePreview sender={sendAs} variant={signatureVariant} authorWritesClosing={false} />
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={() => resolvePreparedSend('confirm')}
              disabled={confirming}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 min-h-[36px]"
            >
              {confirming ? 'Sending…' : 'Confirm & send'}
            </button>
            <button
              onClick={() => resolvePreparedSend('cancel')}
              disabled={confirming}
              className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50 min-h-[36px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

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
