'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, Sparkles, Loader2, Paperclip, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'
import { useEmailAttachments } from './use-email-attachments'
import { EmailAttachmentChips } from './email-attachment-chips'
import { SignatureControls, SignaturePreview } from './signature-controls'
import {
  DEFAULT_REPLY_SIGNATURE_VARIANT,
  type SignatureVariant,
} from '@/lib/email/signature'
import { findUnresolvedPlaceholders, type AiMode } from '@/lib/inbox/ai-email'
import type { InboxConversation } from '@/lib/types'
import type { ReplyTarget } from './message-thread'

/**
 * Pull every bare email address out of a display string like
 * `"Dragos Popescu" <dragos@payset.io>, "Jane Smith" <jane@x.com>` — used to
 * seed the editable To chips from a resolved target's display sender. A
 * small client-safe duplicate of lib/gmail.ts's extractAllEmailAddresses
 * (same regex, comma-inside-a-display-name safe) rather than importing that
 * file client-side, which also pulls in its server-only Google-auth code.
 */
function parseAddressesFromDisplay(value: string): string[] {
  const matches = value.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g)
  if (!matches) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of matches) {
    const addr = m.toLowerCase()
    if (!seen.has(addr)) {
      seen.add(addr)
      out.push(addr)
    }
  }
  return out
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type QuoteMode = 'message' | 'thread' | 'none'

interface ComposeReplyProps {
  conversation: InboxConversation
  /** Which Gmail mailbox the user is viewing ('support' | 'antonio') — the
   *  reply must be fetched from and sent through the SAME mailbox. */
  mailbox?: string
  /** Staff explicitly clicked "Reply"/"Reply All" on a message card — wins
   *  over the default immediately, even mid-draft. Null = no explicit pick. */
  explicitReplyTarget?: ReplyTarget | null
  /** Reads a FRESH snapshot of "who would an untargeted reply go to right
   *  now" (skips our own messages) — called only at the moment a target is
   *  frozen, never on every render, so the parent's 15s poll can't silently
   *  retarget an in-progress reply out from under the person composing it. */
  getDefaultReplyTarget?: () => Omit<ReplyTarget, 'mode'> | null
  /** Tells the parent an explicit pick was just used (sent or saved as a
   *  draft) so it can clear `explicitReplyTarget`. Without this, the picked
   *  target outlives the send: the default-resolution effect below stays
   *  permanently blocked for the rest of the conversation, AND a later
   *  AI-Suggest click falls back to this same stale target and re-freezes
   *  onto it — an old message's sender, not the current one, could then be
   *  what a follow-up reply actually goes out to (bug-hunter pass 3,
   *  dev job ec61a2ae — verified against a real explicitReplyTarget that
   *  only ever reset on a conversation switch, never after a send). */
  onTargetConsumed?: () => void
}

export function ComposeReply({ conversation, mailbox, explicitReplyTarget, getDefaultReplyTarget, onTargetConsumed }: ComposeReplyProps) {
  const [message, setMessage] = useState('')
  // The target THIS compose session actually uses — resolved once when
  // composing starts (never re-derived from a background poll afterward),
  // and re-resolved immediately on a genuine explicit pick (a real click is
  // never "silent"). Cleared after a successful send/draft-save so the next
  // reply starts fresh. lib/inbox/reply-target.ts is the server's mirror of
  // this same "skip our own messages" default.
  const [frozenTarget, setFrozenTarget] = useState<ReplyTarget | null>(null)
  // Editable recipient chips, seeded from frozenTarget the moment it
  // resolves — visible and editable BEFORE send (Antonio, 2026-09-03: "I
  // want to see the from and to addresses... option to see them and delete
  // one or add if needed"). Sending with an edited list overrides the
  // server's own resolution outright (lib/inbox/reply-target.ts's
  // toOverride) — the server still validates every address looks real.
  const [toAddresses, setToAddresses] = useState<string[]>([])
  const [toInput, setToInput] = useState('')
  // 'message' (default) quotes just the message being answered, matching
  // Gmail's own ordinary reply. 'thread' quotes the whole conversation.
  // 'none' quotes nothing. Antonio, 2026-09-03.
  const [quoteMode, setQuoteMode] = useState<QuoteMode>('message')
  const [signatureVariant, setSignatureVariant] = useState<SignatureVariant>(
    DEFAULT_REPLY_SIGNATURE_VARIANT
  )
  // The signature picker + preview appear only once the reader starts
  // replying — while READING a thread they were eating the reading space
  // (Antonio's production QA, 2026-08-05). Focus-latched rather than
  // focus-bound: touching the picker blurs the textarea, so a naive
  // "visible while focused" would snap the controls away mid-choice.
  // Resets on send (below) and on thread switch (key= remount).
  const [composing, setComposing] = useState(false)
  // Preview closed by default — its content is one click away and the space
  // matters more while a thread is open above (Antonio's QA, 2026-08-05).
  const [previewOpen, setPreviewOpen] = useState(false)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  // The ONE AI button has two honest modes (dev job bbc70ff8, 2026-10-06): box has text → 'polish' (fix his own
  // wording, nothing added); box is empty → 'draft' (first draft from the thread). Which one is running, or null.
  const [aiRunning, setAiRunning] = useState<AiMode | null>(null)
  const aiLoading = aiRunning !== null
  // After the AI replaces text we keep the ORIGINAL until he presses Keep or sends — a programmatic setMessage
  // wipes the browser's own Cmd+Z, so this bar is the only way back.
  const [aiUndo, setAiUndo] = useState<{ original: string; output: string; mode: AiMode } | null>(null)
  // Plain-language AI errors/info shown right under the box instead of failing silently (R099).
  const [aiNotice, setAiNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null)
  // Set when Send finds an unresolved [placeholder]; cleared on the next edit.
  const [placeholderWarn, setPlaceholderWarn] = useState<string[] | null>(null)
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Synchronous double-click guard — isPending is render-state and two clicks
  // can land inside one render window, firing two POSTs (the route has no
  // idempotency key).
  const sendingRef = useRef(false)
  // Same guard for the AI button (render-state `aiRunning` can be stale inside one click window), plus a request
  // counter: a send (or a newer click) bumps it so a late AI answer is dropped instead of landing in a composer
  // that has already moved on.
  const aiBusyRef = useRef(false)
  const aiRequestRef = useRef(0)
  // Latest typed text, readable inside async callbacks without a stale closure.
  const messageRef = useRef('')
  const queryClient = useQueryClient()
  const attachments = useEmailAttachments()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isEmail = conversation.channel === 'gmail'
  messageRef.current = message
  // What the AI button will do right now — shown on the button itself (a hover label does not exist on a phone).
  const aiMode: AiMode = message.trim() ? 'polish' : 'draft'

  // Everything AI-related that must not outlive a send or a saved draft: an in-flight answer is invalidated, and
  // Undo is dropped so it can never re-insert text that has already left.
  const resetAiAfterSend = () => {
    aiRequestRef.current++
    aiBusyRef.current = false
    setAiRunning(null)
    setAiUndo(null)
    setAiNotice(null)
    setPlaceholderWarn(null)
  }

  // An explicit pick (a real click on a message card) always wins
  // immediately, mid-draft or not — typed text is preserved, but the
  // indicator below re-renders so the change is impossible to miss before
  // sending. Also opens the composer and focuses it, since picking a target
  // is itself the intent to reply.
  useEffect(() => {
    if (!explicitReplyTarget) return
    setFrozenTarget(explicitReplyTarget)
    setComposing(true)
    textareaRef.current?.focus()
  }, [explicitReplyTarget])

  // The untargeted default is resolved exactly ONCE per compose session, at
  // the moment real composing starts — not live-recomputed on every
  // background poll (message-thread.tsx's 15s refetch), which would let a
  // client's follow-up message silently swap the target out from under
  // typed text about an entirely different message (bug-hunter finding,
  // dev job ec61a2ae pass 3).
  useEffect(() => {
    if (!composing || frozenTarget || explicitReplyTarget) return
    const def = getDefaultReplyTarget?.()
    if (def) setFrozenTarget({ ...def, mode: 'reply' })
  }, [composing, frozenTarget, explicitReplyTarget, getDefaultReplyTarget])

  // Seed the editable To chips the moment a target freezes — every time it
  // (re)freezes, never live-recomputed afterward (same "frozen, not
  // re-derived" discipline as the target itself, so typed edits here can't
  // be silently overwritten by anything else re-rendering).
  useEffect(() => {
    if (!frozenTarget) {
      setToAddresses([])
      return
    }
    setToAddresses(parseAddressesFromDisplay(frozenTarget.sender))
  }, [frozenTarget])

  // Belt-and-braces to the key={conversation.id} at both mount sites: staged
  // attachments must NEVER survive a thread switch (council blocker
  // 2026-07-29 — a passport staged on thread A must not ride a reply to B).
  const clearAttachments = attachments.clear
  useEffect(() => {
    clearAttachments()
    setAttachNotice(null)
  }, [conversation.id, clearAttachments])

  // While the email composer is on screen, a drop that MISSES the drop zone
  // must not make the browser navigate to the file and destroy the draft.
  useEffect(() => {
    if (!isEmail) return
    const swallow = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [isEmail])

  const sendMutation = useMutation({
    mutationFn: async ({ text, allowPlaceholders }: { text: string; allowPlaceholders?: boolean }) => {
      const staged = attachments.uploaded()
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          message: text,
          channel: conversation.channel,
          mailbox,
          signature_variant: signatureVariant,
          ...(frozenTarget && { messageId: frozenTarget.messageId, mode: frozenTarget.mode }),
          ...(isEmail && toAddresses.length > 0 && { to: toAddresses }),
          ...(isEmail && { quoteMode }),
          ...(staged.length > 0 && { attachments: staged }),
          ...(allowPlaceholders && { allowPlaceholders: true }),
        }),
      })
      if (!res.ok) {
        // R099: surface the server's own words; a gateway timeout returns HTML, not JSON.
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `Send failed (error ${res.status}) — please try again.`)
      }
      return res.json()
    },
    onSuccess: () => {
      resetAiAfterSend()
      setMessage('')
      attachments.clear()
      setAttachNotice(null)
      // Back to reading mode: fold the signature controls away and drop any
      // per-reply variant override so the next reply starts at the default.
      setComposing(false)
      setPreviewOpen(false)
      setDraftNotice(null)
      setSignatureVariant(DEFAULT_REPLY_SIGNATURE_VARIANT)
      setFrozenTarget(null)
      setToInput('')
      setQuoteMode('message')
      onTargetConsumed?.()
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

  // Save the typed reply as a REAL Gmail draft, threaded, signature baked in
  // (it may be finished in Gmail's own UI where our send path never runs).
  const draftMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch('/api/inbox/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          message: text,
          mailbox,
          signature_variant: signatureVariant,
          ...(frozenTarget && { messageId: frozenTarget.messageId, mode: frozenTarget.mode }),
          ...(toAddresses.length > 0 && { to: toAddresses }),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Could not save the draft — please try again.')
      }
      return res.json()
    },
    onSuccess: () => {
      resetAiAfterSend()
      setMessage('')
      setComposing(false)
      setPreviewOpen(false)
      setFrozenTarget(null)
      setToInput('')
      setQuoteMode('message')
      onTargetConsumed?.()
      setSignatureVariant(DEFAULT_REPLY_SIGNATURE_VARIANT)
      setDraftNotice('Draft saved — find it in Drafts (here and in Gmail).')
    },
    onError: (err) => {
      setDraftNotice(
        err instanceof Error && err.message ? err.message : 'Could not save the draft.'
      )
    },
  })

  const handleSend = (allowPlaceholders = false) => {
    const text = message.trim()
    // Never send while the AI is still working: its late answer used to land AFTER the send and refill the box
    // with text nobody had read (Cmd+Enter reaches this function too, so the guard lives here).
    if (!text || sendMutation.isPending || sendingRef.current || aiBusyRef.current) return
    // The empty-To warning is already visible above the textarea — no
    // recipient means nothing safe to send.
    if (isEmail && frozenTarget && toAddresses.length === 0) return
    // Never send while a file is mid-upload or silently drop one that failed —
    // the staff member attached it because the recipient needs it. Per-file
    // pending check, NOT the uploading boolean (which races across batches).
    if (attachments.pending().length > 0) {
      setAttachNotice('Wait for the upload to finish, then send.')
      return
    }
    if (attachments.failed().length > 0) {
      setAttachNotice('An attachment failed — remove it (×) or re-attach it before sending.')
      return
    }
    setAttachNotice(null)
    // An unresolved [blank] (the AI writes these on purpose when it lacks a fact) must be filled in, or sent
    // knowingly. The server enforces the same rule; this just asks first instead of failing after the click.
    if (isEmail && !allowPlaceholders) {
      const blanks = findUnresolvedPlaceholders(text)
      if (blanks.length > 0) {
        setPlaceholderWarn(blanks)
        return
      }
    }
    setPlaceholderWarn(null)
    sendingRef.current = true
    sendMutation.mutate({ text, allowPlaceholders }, { onSettled: () => { sendingRef.current = false } })
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

  // The one AI button. Box has text → POLISH exactly that text (the server sends nothing else to the model).
  // Box is empty → DRAFT a first reply from the thread. See app/api/inbox/ai-suggest/route.ts.
  const handleAi = async () => {
    if (aiBusyRef.current || sendingRef.current || sendMutation.isPending) return
    const mode: AiMode = messageRef.current.trim() ? 'polish' : 'draft'
    const sentDraft = messageRef.current
    aiBusyRef.current = true
    const reqId = ++aiRequestRef.current
    setAiRunning(mode)
    setAiNotice(null)
    setPlaceholderWarn(null)

    // A draft needs the message it answers. The button is reachable before the textarea's ever been focused (it
    // sits next to Attach, not gated behind `composing`), so the usual freeze-on-composing effect may not have
    // run yet. Resolve synchronously here too — same target the reply will actually be sent to.
    let target = frozenTarget
    if (mode === 'draft' && !target) {
      target = explicitReplyTarget ?? (() => {
        const def = getDefaultReplyTarget?.()
        return def ? { ...def, mode: 'reply' as const } : null
      })()
      if (target) setFrozenTarget(target)
      setComposing(true)
    }

    try {
      const res = await fetch('/api/inbox/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          mailbox: mailbox === 'antonio' ? 'antonio' : 'support',
          ...(mode === 'polish'
            ? { draft: sentDraft }
            : {
                // Extract threadId from conversation.id (format: "gmail:threadId")
                threadId: conversation.id.replace('gmail:', ''),
                ...(target && { messageId: target.messageId }),
              }),
        }),
      })
      // R099: show the server's own words; a gateway timeout returns HTML, not JSON.
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `The AI request failed (error ${res.status}) — please try again.`)
      }
      // A send (or a newer click) moved on while we waited — this answer is stale, drop it.
      if (aiRequestRef.current !== reqId) return

      const result: string = typeof data.result === 'string' ? data.result : ''
      if (!result.trim()) throw new Error('The AI returned nothing — your text was left as it is.')

      // Typing during the wait must never be overwritten: apply only if the box is exactly what we sent.
      const unchanged = mode === 'polish'
        ? messageRef.current === sentDraft
        : messageRef.current.trim() === ''
      if (!unchanged) {
        setAiNotice({ tone: 'info', text: 'You changed the text while the AI was working, so its version was not applied.' })
        return
      }
      if (mode === 'polish' && data.changed === false) {
        setAiNotice({ tone: 'info', text: 'Your text already reads well — the AI changed nothing.' })
        return
      }
      setMessage(result)
      // Keep the FIRST original until Keep/send, even across several AI runs.
      setAiUndo((prev) => ({ original: prev?.original ?? sentDraft, output: result, mode }))
      textareaRef.current?.focus()
    } catch (err) {
      if (aiRequestRef.current === reqId) {
        setAiNotice({
          tone: 'error',
          text: err instanceof Error && err.message ? err.message : 'The AI could not do that right now — please try again.',
        })
      }
    } finally {
      // Only the request that is still current may release the lock (a send already reset it).
      if (aiRequestRef.current === reqId) {
        aiBusyRef.current = false
        setAiRunning(null)
      }
    }
  }

  // Put his original text back. If he has edited the AI's version since, replacing it loses those edits — ask first.
  const handleUndoAi = () => {
    if (!aiUndo) return
    if (message !== aiUndo.output && message.trim() && !window.confirm('Replace what is in the box now with your original text?')) return
    setMessage(aiUndo.original)
    setAiUndo(null)
    setAiNotice(null)
    textareaRef.current?.focus()
  }

  const composer = (
    <div
      className="border-t bg-white px-4 py-3"
      // The way BACK to reading (Antonio's QA, 2026-08-05): clicking anywhere
      // outside the composer with an EMPTY draft folds the signature area
      // away again. Checked against the whole container, not the textarea —
      // a blur caused by touching the picker or a button inside stays open.
      // A draft with text never auto-folds: typed words must not vanish.
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget as Node | null) &&
          !message.trim()
        ) {
          setComposing(false)
        }
      }}
    >
      {/* Who this reply actually goes to — shown and now EDITABLE for every
          reply, not just an explicit per-message pick, so a wrong target is
          visible (and fixable) before sending rather than only when staff
          remembers to check (the exact gap that let both real incidents
          happen: an ordinary reply whose untargeted default silently
          resolved to our own mailbox). Antonio, 2026-09-03: "I want to see
          the from and to addresses... option to see them and delete one or
          add if needed." An edited list overrides the server's own
          resolution outright — the server re-validates every address. */}
      {isEmail && frozenTarget && (
        <div className="mb-2 space-y-1">
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            <span className="text-zinc-500 shrink-0">
              {frozenTarget.mode === 'replyAll' ? 'Reply All to' : 'To'}:
            </span>
            {toAddresses.map((addr) => (
              <span
                key={addr}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 pl-2 pr-1 py-0.5 text-zinc-700"
              >
                {addr}
                <button
                  type="button"
                  onClick={() => setToAddresses((prev) => prev.filter((a) => a !== addr))}
                  aria-label={`Remove ${addr}`}
                  className="rounded-full p-0.5 hover:bg-zinc-300/60 text-zinc-500 hover:text-zinc-700"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ',') return
                e.preventDefault()
                const candidate = toInput.trim().replace(/,$/, '')
                if (candidate && EMAIL_RE.test(candidate) && !toAddresses.includes(candidate.toLowerCase())) {
                  setToAddresses((prev) => [...prev, candidate.toLowerCase()])
                }
                setToInput('')
              }}
              placeholder={toAddresses.length ? 'add another…' : 'add a recipient…'}
              className="min-w-[100px] flex-1 bg-transparent outline-none text-zinc-700 placeholder:text-zinc-400 py-0.5"
            />
          </div>
          {toAddresses.length === 0 && (
            <p className="text-xs text-amber-600">At least one recipient is required.</p>
          )}
          <p className="text-xs text-zinc-400">
            {/* frozenTarget.sender is the RECIPIENT for one of our own
                messages (the message card shows "To: X"), not always an
                author — "replying to the message from X" read backwards on
                that card, so this stays direction-agnostic. */}
            From: {mailbox === 'antonio' ? 'antonio.durante@tonydurante.us' : 'support@tonydurante.us'} · replying to the message shown above
          </p>
        </div>
      )}
      {isEmail && composing && (
        <div className="mb-2 flex items-center gap-1.5 text-xs">
          <span className="text-zinc-500 shrink-0">Quote:</span>
          {([
            ['message', 'This message'],
            ['thread', 'Whole conversation'],
            ['none', 'None'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setQuoteMode(value)}
              className={cn(
                'rounded-full px-2.5 py-1 transition-colors',
                quoteMode === value
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {sendMutation.isError && (
        <p className="text-xs text-red-500 mb-2">
          Failed to send: {sendMutation.error.message}
        </p>
      )}
      {attachNotice && (
        <p className="text-xs text-amber-600 mb-2">{attachNotice}</p>
      )}
      {draftNotice && (
        <p className="text-xs text-emerald-700 mb-2">{draftNotice}</p>
      )}
      {/* After the AI replaces text, the original stays one click away until Keep or send. */}
      {isEmail && aiUndo && (
        <div role="status" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            {aiUndo.mode === 'draft'
              ? 'AI wrote a first draft from this thread. Read every line and check each fact before sending.'
              : 'AI polished your text. Your original is one click away.'}
          </span>
          <span className="flex items-center gap-3 font-medium">
            <button type="button" onClick={handleUndoAi} className="underline decoration-dotted hover:text-violet-950">
              {message === aiUndo.output ? 'Undo' : 'Restore my original'}
            </button>
            <button type="button" onClick={() => setAiUndo(null)} className="underline decoration-dotted hover:text-violet-950">
              Keep
            </button>
          </span>
        </div>
      )}
      {isEmail && aiNotice && (
        <p
          role={aiNotice.tone === 'error' ? 'alert' : 'status'}
          className={cn('text-xs mb-2', aiNotice.tone === 'error' ? 'text-red-600' : 'text-zinc-500')}
        >
          {aiNotice.text}
        </p>
      )}
      {/* Send found a [blank to fill in] — fix it, or send knowingly. */}
      {isEmail && placeholderWarn && (
        <div role="alert" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>
            This email still has a blank to fill in: <strong>{placeholderWarn.slice(0, 4).join(', ')}</strong>
            {placeholderWarn.length > 4 ? '…' : ''}. Replace it before sending.
          </span>
          <span className="flex items-center gap-3 font-medium">
            <button
              type="button"
              onClick={() => { setPlaceholderWarn(null); textareaRef.current?.focus() }}
              className="underline decoration-dotted hover:text-amber-950"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => handleSend(true)}
              className="underline decoration-dotted hover:text-amber-950"
            >
              Send anyway
            </button>
          </span>
        </div>
      )}
      {isEmail && (
        <div className="mb-2 empty:hidden">
          <EmailAttachmentChips attachments={attachments} />
        </div>
      )}
      {/* Replies default to compact so a portrait does not stack down a
          twenty-message thread; overridable per reply. The mailbox is NOT
          selectable here — a reply must go through the same mailbox the
          thread lives in, which is the one being viewed. The preview shows
          exactly what will be appended under the typed reply — but only
          once the reader starts replying, never while just reading. */}
      {isEmail && composing && (
        <div className="mb-2 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <SignatureControls
              sender={mailbox === 'antonio' ? 'antonio' : 'support'}
              variant={signatureVariant}
              onVariantChange={setSignatureVariant}
              disabled={sendMutation.isPending}
            />
            {/* The full preview is one click away, not always open — even
                mid-draft the signature area costs one small row, so reading
                the thread above stays comfortable. */}
            <button
              type="button"
              onClick={() => setPreviewOpen((v) => !v)}
              className="text-xs text-zinc-500 hover:text-zinc-700 underline decoration-dotted"
            >
              {previewOpen ? 'Hide preview' : 'Preview'}
            </button>
          </div>
          {previewOpen && (
            <SignaturePreview
              sender={mailbox === 'antonio' ? 'antonio' : 'support'}
              variant={signatureVariant}
            />
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value)
            if (placeholderWarn) setPlaceholderWarn(null)
            if (aiNotice) setAiNotice(null)
          }}
          onFocus={() => {
            setComposing(true)
            setDraftNotice(null)
          }}
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
            <FastTooltip label="Attach files">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 p-2.5 rounded-xl bg-zinc-100 text-zinc-500 hover:bg-zinc-200
                  hover:text-zinc-700 transition-colors"
                aria-label="Attach files"
              >
                <Paperclip className="h-4 w-4" />
              </button>
            </FastTooltip>
            {/* ONE button, named for what it will do RIGHT NOW (a hover label does not exist on a phone):
                text in the box → it polishes that text; empty box → it drafts from the thread. */}
            <FastTooltip
              label={
                aiMode === 'polish'
                  ? 'Polish what you typed — fixes wording only and never adds facts or prices'
                  : 'Write a first draft from this email thread — check every fact before sending'
              }
            >
              <button
                onClick={handleAi}
                disabled={aiLoading || sendMutation.isPending}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-violet-100 text-violet-700
                  text-xs font-medium hover:bg-violet-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label={aiMode === 'polish' ? 'AI Polish — improve my text' : 'AI Draft — write a first draft from the thread'}
              >
                {aiLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {/* The mode word is always visible; the "AI " prefix drops on a phone so the writing box keeps its width. */}
                <span>
                  {aiRunning === 'polish' ? 'Polishing…' : aiRunning === 'draft' ? 'Drafting…' : (
                    <>
                      <span className="hidden sm:inline">AI </span>
                      {aiMode === 'polish' ? 'Polish' : 'Draft'}
                    </>
                  )}
                </span>
              </button>
            </FastTooltip>
          </>
        )}

        {/* Save draft — email only, needs text, refuses while files are
            staged: drafts are text-only for now and silently dropping a
            staged passport would be worse than a disabled button. */}
        {isEmail && composing && message.trim() && (
          <FastTooltip
            label={
              attachments.files.length > 0
                ? 'Drafts cannot carry attachments yet — send directly, or remove the files first.'
                : 'Save as a Gmail draft (threaded to this conversation)'
            }
          >
            <button
              onClick={() => draftMutation.mutate(message)}
              disabled={
                draftMutation.isPending ||
                sendMutation.isPending ||
                aiLoading ||
                attachments.files.length > 0
              }
              aria-label={
                attachments.files.length > 0
                  ? 'Drafts cannot carry attachments yet — send directly, or remove the files first.'
                  : 'Save as a Gmail draft (threaded to this conversation)'
              }
              className="shrink-0 px-3 py-2.5 rounded-xl bg-zinc-100 text-zinc-600 text-xs font-medium
                hover:bg-zinc-200 hover:text-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed
                transition-colors"
            >
              {draftMutation.isPending ? 'Saving…' : 'Save draft'}
            </button>
          </FastTooltip>
        )}

        <button
          onClick={() => handleSend()}
          aria-label="Send reply"
          disabled={
            !message.trim() ||
            sendMutation.isPending ||
            aiLoading ||
            attachments.files.some((f) => !f.path && !f.error) ||
            (isEmail && !!frozenTarget && toAddresses.length === 0)
          }
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
