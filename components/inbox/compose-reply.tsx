'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, Sparkles, Loader2, Paperclip } from 'lucide-react'
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
import type { InboxConversation } from '@/lib/types'
import type { ReplyTarget } from './message-thread'

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
}

export function ComposeReply({ conversation, mailbox, explicitReplyTarget, getDefaultReplyTarget }: ComposeReplyProps) {
  const [message, setMessage] = useState('')
  // The target THIS compose session actually uses — resolved once when
  // composing starts (never re-derived from a background poll afterward),
  // and re-resolved immediately on a genuine explicit pick (a real click is
  // never "silent"). Cleared after a successful send/draft-save so the next
  // reply starts fresh. lib/inbox/reply-target.ts is the server's mirror of
  // this same "skip our own messages" default.
  const [frozenTarget, setFrozenTarget] = useState<ReplyTarget | null>(null)
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
  const [aiLoading, setAiLoading] = useState(false)
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Synchronous double-click guard — isPending is render-state and two clicks
  // can land inside one render window, firing two POSTs (the route has no
  // idempotency key).
  const sendingRef = useRef(false)
  const queryClient = useQueryClient()
  const attachments = useEmailAttachments()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isEmail = conversation.channel === 'gmail'

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
          signature_variant: signatureVariant,
          ...(frozenTarget && { messageId: frozenTarget.messageId, mode: frozenTarget.mode }),
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
      // Back to reading mode: fold the signature controls away and drop any
      // per-reply variant override so the next reply starts at the default.
      setComposing(false)
      setPreviewOpen(false)
      setDraftNotice(null)
      setSignatureVariant(DEFAULT_REPLY_SIGNATURE_VARIANT)
      setFrozenTarget(null)
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
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Could not save the draft — please try again.')
      }
      return res.json()
    },
    onSuccess: () => {
      setMessage('')
      setComposing(false)
      setPreviewOpen(false)
      setFrozenTarget(null)
      setSignatureVariant(DEFAULT_REPLY_SIGNATURE_VARIANT)
      setDraftNotice('Draft saved — find it in Drafts (here and in Gmail).')
    },
    onError: (err) => {
      setDraftNotice(
        err instanceof Error && err.message ? err.message : 'Could not save the draft.'
      )
    },
  })

  const handleSend = () => {
    const text = message.trim()
    if (!text || sendMutation.isPending || sendingRef.current) return
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
    sendingRef.current = true
    sendMutation.mutate(text, { onSettled: () => { sendingRef.current = false } })
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
    // AI Suggest is reachable before the textarea's ever been focused (it
    // sits next to Attach, not gated behind `composing`), so the usual
    // freeze-on-composing effect may not have run yet. Resolve synchronously
    // here too — same target the reply will actually be sent to.
    let target = frozenTarget
    if (!target) {
      target = explicitReplyTarget ?? (() => {
        const def = getDefaultReplyTarget?.()
        return def ? { ...def, mode: 'reply' as const } : null
      })()
      if (target) setFrozenTarget(target)
      setComposing(true)
    }
    try {
      // Extract threadId from conversation.id (format: "gmail:threadId")
      const threadId = conversation.id.replace('gmail:', '')
      const res = await fetch('/api/inbox/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, ...(target && { messageId: target.messageId }) }),
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
      {/* Who this reply actually goes to — shown for EVERY reply, not just an
          explicit per-message pick, so a wrong target is visible before
          sending rather than only when staff remembers to check (the exact
          gap that let both real incidents happen: an ordinary reply whose
          untargeted default silently resolved to our own mailbox). */}
      {isEmail && frozenTarget && (
        <p className="text-xs text-zinc-500 mb-2">
          Replying{frozenTarget.mode === 'replyAll' ? ' All' : ''} to:{' '}
          <span className="font-medium text-zinc-700">{frozenTarget.sender}</span>
        </p>
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
          onChange={(e) => setMessage(e.target.value)}
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
            <FastTooltip label="AI Draft Reply">
              <button
                onClick={handleAiSuggest}
                disabled={aiLoading}
                className="shrink-0 p-2.5 rounded-xl bg-violet-100 text-violet-600 hover:bg-violet-200
                  disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="AI Draft Reply"
              >
                {aiLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
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
          onClick={handleSend}
          disabled={
            !message.trim() ||
            sendMutation.isPending ||
            attachments.files.some((f) => !f.path && !f.error)
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
