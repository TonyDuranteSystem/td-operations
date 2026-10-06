'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, Sparkles, Loader2, Paperclip, X, ChevronDown, ChevronUp, Maximize2 } from 'lucide-react'
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
import {
  DEFAULT_RICH_STYLE,
  hasInlineFormatting,
  richHtmlToText,
  shouldSendRich,
  textToHtml,
  type RichStyle,
} from '@/lib/inbox/rich-text'
import {
  clearReplyDraft,
  describeStoredDraft,
  getDraftStorage,
  loadReplyDraft,
  replyDraftKey,
  saveReplyDraft,
  type StoredReplyDraft,
} from '@/lib/inbox/reply-draft-store'
import { RichEditor, type RichEditorHandle } from './rich-editor'
import { readReplyPopupDefault, writeReplyPopupDefault } from '@/lib/inbox/reply-popup-pref'
import { ReplyPopup } from './reply-popup'
import type { InboxConversation } from '@/lib/types'
import { MessageThread, type ReplyTarget } from './message-thread'

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

const QUOTE_LABELS: Record<QuoteMode, string> = {
  message: 'This message',
  thread: 'Whole conversation',
  none: 'None',
}

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
  // The reply's PLAIN TEXT. For email it mirrors the editor (richHtmlToText of its HTML) so every guard — empty,
  // [blank], what the AI polishes — reads exactly the words the server will derive from the same HTML; for chat
  // channels it is the textarea's own value.
  const [message, setMessage] = useState('')
  // Email only: the editor's HTML (state, so the Undo label re-renders; the ref is for synchronous reads) and the
  // four message-level style choices (font, size, line, gap) the server applies to the whole email.
  const [bodyHtml, setBodyHtml] = useState('')
  const htmlRef = useRef('')
  const [richStyle, setRichStyle] = useState<RichStyle>({ ...DEFAULT_RICH_STYLE })
  const editorRef = useRef<RichEditorHandle>(null)
  // The draft safety net (lib/inbox/reply-draft-store.ts): an unsent reply is copied into THIS TAB's sessionStorage and
  // offered back after a refresh / crash / accidental Back. `restorable` is only what the bar renders; the ref is what
  // the logic reads (it must be right inside timers and page-leave handlers).
  const [restorable, setRestorable] = useState<StoredReplyDraft | null>(null)
  const restorableRef = useRef<StoredReplyDraft | null>(null)
  // Recipients to put back once the restored target has re-seeded the To chips.
  const pendingRestoreTo = useRef<string[] | null>(null)
  // When a send began (cleared if it fails): a draft still carrying it after a reload "may have been sent".
  const sendStartedRef = useRef<number | null>(null)
  // Set after a successful send / saved draft until the next real edit, so a late flush can never bring a sent reply back.
  const suppressPersistRef = useRef(false)
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
  // Which frozen target the chips above were seeded from — until they are, the recipient line shows the target's own
  // address instead of a false "no recipient" for one render.
  const [seededFor, setSeededFor] = useState<ReplyTarget | null>(null)
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
  // The recipient / From / Quote details fold behind one line (see the header block below).
  const [detailsOpen, setDetailsOpen] = useState(false)
  // The reply pop-up (a large window with the email beside the editor). The text, recipients, attachments and AI
  // state all stay HERE; the pop-up only changes where the writing column is drawn, so a draft can never fork.
  const [expanded, setExpanded] = useState(false)
  // "Open replies in the pop-up by default" — per device, read after mount (localStorage does not exist on the server).
  const [popupDefault, setPopupDefault] = useState(false)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  // The ONE AI button has two honest modes (dev job bbc70ff8, 2026-10-06): box has text → 'polish' (fix his own
  // wording, nothing added); box is empty → 'draft' (first draft from the thread). Which one is running, or null.
  const [aiRunning, setAiRunning] = useState<AiMode | null>(null)
  const aiLoading = aiRunning !== null
  // After the AI replaces text we keep the ORIGINAL until he presses Keep or sends — a programmatic setMessage
  // wipes the browser's own Cmd+Z, so this bar is the only way back.
  const [aiUndo, setAiUndo] = useState<{ originalHtml: string; outputHtml: string; mode: AiMode } | null>(null)
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
  // Safari / iOS do not focus a <button> on press, so pressing Attach / AI / Send blurs the textarea with no related
  // target; with an empty box the composer used to fold and shrink under the finger and the tap missed. A press that
  // starts inside the composer is remembered for a moment so that blur never folds it.
  const pointerInsideRef = useRef(false)
  // Closing the pop-up must not immediately re-open it: with the default switched on, focusing the inline box opens
  // the pop-up, and giving focus back to the page can look like exactly that.
  const suppressAutoOpenRef = useRef(false)
  // Once a reply has been closed out of the pop-up on purpose, it stays inline until it is sent or abandoned — with
  // "open by default" on, the next click into the small box must not throw it straight back (the Expand button is
  // always there to go back).
  const keepInlineRef = useRef(false)
  const expandBtnRef = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()
  const attachments = useEmailAttachments()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isEmail = conversation.channel === 'gmail'
  messageRef.current = message
  // What the AI button will do right now — shown on the button itself (a hover label does not exist on a phone).
  const aiMode: AiMode = message.trim() ? 'polish' : 'draft'
  // What the recipient line shows. Before the chips are seeded it reads the target's own address, so there is never a
  // flash of "no recipient"; after, it is the editable list.
  const recipientsKnown = !!frozenTarget && seededFor === frozenTarget
  const shownAddresses = frozenTarget
    ? recipientsKnown ? toAddresses : parseAddressesFromDisplay(frozenTarget.sender)
    : []
  // No recipient is the one state that must never hide behind a click, so Details opens itself then.
  const noRecipient = !!frozenTarget && recipientsKnown && toAddresses.length === 0
  const showDetails = detailsOpen || noRecipient
  // Commit an address typed into the To box (Enter / comma / leaving the box) so it is never silently dropped.
  const commitToInput = () => {
    const candidate = toInput.trim().replace(/,$/, '')
    if (candidate && EMAIL_RE.test(candidate)) {
      const addr = candidate.toLowerCase()
      setToAddresses((prev) => (prev.includes(addr) ? prev : [...prev, addr]))
      setToInput('')
    }
  }

  // Everything AI-related that must not outlive a send or a saved draft: an in-flight answer is invalidated, and
  // Undo is dropped so it can never re-insert text that has already left.
  const resetAiAfterSend = () => {
    keepInlineRef.current = false
    setExpanded(false)
    aiRequestRef.current++
    aiBusyRef.current = false
    setAiRunning(null)
    setAiUndo(null)
    setAiNotice(null)
    setPlaceholderWarn(null)
  }

  useEffect(() => {
    setPopupDefault(readReplyPopupDefault())
  }, [])

  const openPopup = () => {
    setExpanded(true)
    setComposing(true)
    setDraftNotice(null)
  }
  // Close = the writing column goes back to the inline box with EVERYTHING kept. Nothing is discarded here.
  const closePopup = useCallback(() => {
    keepInlineRef.current = true
    suppressAutoOpenRef.current = true
    window.setTimeout(() => { suppressAutoOpenRef.current = false }, 700)
    setExpanded(false)
    if (!messageRef.current.trim()) setComposing(false)
    window.requestAnimationFrame(() => expandBtnRef.current?.focus())
  }, [])
  const togglePopupDefault = (on: boolean) => {
    setPopupDefault(on)
    writeReplyPopupDefault(on)
  }
  // Put the cursor back in the box WITHOUT letting that focus count as "start a reply" (which, with the pop-up on by
  // default, would open it): used after an AI answer, Undo, or the blank warning's Edit.
  const focusEditor = () => {
    if (isEmail) editorRef.current?.focus()
    else textareaRef.current?.focus()
  }
  const focusBoxQuietly = () => {
    suppressAutoOpenRef.current = true
    focusEditor()
    window.setTimeout(() => { suppressAutoOpenRef.current = false }, 700)
  }
  // The editor reports every change here: keep the plain-text mirror and the HTML current. `user` is false when WE
  // changed the box (AI answer, Undo, reset) — only a real edit clears the AI / blank notices.
  const handleEditorChange = (html: string, user: boolean) => {
    const text = richHtmlToText(html)
    htmlRef.current = html
    messageRef.current = text
    setBodyHtml(html)
    setMessage(text)
    // Writing anything means the person has moved on from the offer to restore the earlier reply.
    if (user && restorableRef.current && text.trim()) {
      restorableRef.current = null
      setRestorable(null)
    }
    // New words after a send / saved draft are a new reply: the safety net is live again.
    if (text.trim()) suppressPersistRef.current = false
    if (user) {
      if (placeholderWarn) setPlaceholderWarn(null)
      if (aiNotice) setAiNotice(null)
    }
  }
  // Empty the box after a send / saved draft and give the next reply the default style.
  const resetBody = () => {
    setMessage('')
    messageRef.current = ''
    htmlRef.current = ''
    setBodyHtml('')
    setRichStyle({ ...DEFAULT_RICH_STYLE })
    editorRef.current?.applyHtml('')
  }
  // What a send / draft will carry, read at the moment of the click (never from possibly-stale state). Email: the
  // text is derived from the editor's HTML, and the formatted payload is used only when something is actually
  // formatted or the style was changed — plain paragraphs go out on today's exact path.
  const readBody = () => {
    if (!isEmail) return { text: message.trim(), html: '', rich: false }
    const html = editorRef.current?.getHTML() ?? htmlRef.current
    return { text: richHtmlToText(html).trim(), html, rich: shouldSendRich(html, richStyle) }
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
    if (isEmail) editorRef.current?.focus()
    else textareaRef.current?.focus()
  }, [explicitReplyTarget, isEmail])

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
      setSeededFor(null)
      return
    }
    setToAddresses(pendingRestoreTo.current ?? parseAddressesFromDisplay(frozenTarget.sender))
    pendingRestoreTo.current = null
    setSeededFor(frozenTarget)
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

  // ── Draft safety net ───────────────────────────────────────────────────────────────────────────────────────
  const draftKey = isEmail ? replyDraftKey(mailbox, conversation.id) : null
  const forgetStoredDraft = () => {
    if (draftKey) clearReplyDraft(getDraftStorage(), draftKey)
    restorableRef.current = null
    setRestorable(null)
  }
  // Always the LATEST render's values (reassigned every render), so a timer or a page-leave handler never saves stale state.
  const persistRef = useRef<() => void>(() => {})
  persistRef.current = () => {
    if (!draftKey || suppressPersistRef.current) return
    // While an earlier reply is on offer nothing is saved over it: an empty box (or an AI answer that is then undone)
    // must never erase a draft the person has not discarded. It ends when they type, restore, or discard.
    if (restorableRef.current) return
    saveReplyDraft(
      getDraftStorage(),
      draftKey,
      {
        html: editorRef.current?.getHTML() ?? htmlRef.current,
        style: richStyle,
        target: frozenTarget ? { messageId: frozenTarget.messageId, sender: frozenTarget.sender, mode: frozenTarget.mode } : null,
        to: toAddresses,
        quoteMode,
        signatureVariant,
        attachmentCount: attachments.files.length,
        ...(sendStartedRef.current !== null && { sendStartedAt: sendStartedRef.current }),
      },
      Date.now(),
    )
  }
  // Offer a stored reply for THIS conversation once, when the composer opens (the key= remount makes it per thread).
  useEffect(() => {
    if (!draftKey) return
    const found = loadReplyDraft(getDraftStorage(), draftKey, Date.now())
    restorableRef.current = found
    setRestorable(found)
  }, [draftKey])
  // Save shortly after any change (not on every keystroke) ...
  useEffect(() => {
    if (!draftKey) return
    const id = window.setTimeout(() => persistRef.current(), 600)
    return () => window.clearTimeout(id)
  }, [draftKey, bodyHtml, richStyle, frozenTarget, toAddresses, quoteMode, signatureVariant, attachments.files.length])
  // ... and immediately when the page is being left or hidden, or this composer goes away (thread switch).
  useEffect(() => {
    if (!draftKey) return
    const flush = () => persistRef.current()
    const onHidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
      flush()
    }
  }, [draftKey])
  const handleRestore = () => {
    const d = restorable
    if (!d) return
    restorableRef.current = null
    setRestorable(null)
    suppressPersistRef.current = false
    setRichStyle(d.style)
    setQuoteMode(d.quoteMode)
    if (d.signatureVariant) setSignatureVariant(d.signatureVariant as SignatureVariant)
    if (d.target && !explicitReplyTarget) {
      pendingRestoreTo.current = d.to.length > 0 ? d.to : null
      setFrozenTarget(d.target)
    }
    setComposing(true)
    // The HTML only ever enters through the editor, whose schema drops anything it does not allow.
    editorRef.current?.applyHtml(d.html)
    focusBoxQuietly()
  }

  const sendMutation = useMutation({
    mutationFn: async ({ text, html, rich, allowPlaceholders }: { text: string; html: string; rich: boolean; allowPlaceholders?: boolean }) => {
      const staged = attachments.uploaded()
      // A dropped connection or a gateway timeout does not tell us whether Gmail already sent it. Those are marked, so
      // the box warns and the saved copy keeps its "may have been sent" stamp — the route has no duplicate guard.
      const MAYBE_SENT = ' It may still have gone out — check Sent before you send it again.'
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          message: text,
          ...(isEmail && rich && { messageHtml: html, style: richStyle }),
          channel: conversation.channel,
          mailbox,
          signature_variant: signatureVariant,
          ...(frozenTarget && { messageId: frozenTarget.messageId, mode: frozenTarget.mode }),
          ...(isEmail && toAddresses.length > 0 && { to: toAddresses }),
          ...(isEmail && { quoteMode }),
          ...(staged.length > 0 && { attachments: staged }),
          ...(allowPlaceholders && { allowPlaceholders: true }),
        }),
      }).catch(() => {
        throw Object.assign(new Error(`The connection dropped before we heard back.${MAYBE_SENT}`), { maybeSent: true })
      })
      if (!res.ok) {
        // R099: surface the server's own words; a gateway timeout returns HTML, not JSON.
        const err = await res.json().catch(() => ({}))
        if (res.status >= 500) throw Object.assign(new Error(`${err.error || `Sending did not finish (error ${res.status}).`}${MAYBE_SENT}`), { maybeSent: true })
        throw new Error(err.error || `Send failed (error ${res.status}) — please try again.`)
      }
      return res.json()
    },
    onError: (err) => {
      // A clear refusal means it did not go out: an ordinary unsent reply again. An unclear failure keeps the stamp.
      if (!(err as { maybeSent?: boolean }).maybeSent) sendStartedRef.current = null
      persistRef.current()
    },
    onSuccess: () => {
      sendStartedRef.current = null
      suppressPersistRef.current = true
      forgetStoredDraft()
      resetAiAfterSend()
      resetBody()
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
      setDetailsOpen(false)
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
    mutationFn: async ({ text, html, rich }: { text: string; html: string; rich: boolean }) => {
      const res = await fetch('/api/inbox/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          message: text,
          ...(rich && { messageHtml: html, style: richStyle }),
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
      suppressPersistRef.current = true
      forgetStoredDraft()
      resetAiAfterSend()
      resetBody()
      setComposing(false)
      setPreviewOpen(false)
      setFrozenTarget(null)
      setToInput('')
      setQuoteMode('message')
      setDetailsOpen(false)
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
    const { text, html, rich } = readBody()
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
    sendStartedRef.current = Date.now()
    persistRef.current()
    sendMutation.mutate({ text, html, rich, allowPlaceholders }, { onSettled: () => { sendingRef.current = false } })
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
    const sentHtml = editorRef.current?.getHTML() ?? htmlRef.current
    // The AI works on plain words, so it cannot carry bold, links, lists, colours or centred lines through. Say so
    // and leave the text exactly as it is — never silently flatten his formatting.
    if (mode === 'polish' && hasInlineFormatting(sentHtml)) {
      setAiNotice({
        tone: 'info',
        text: 'AI Polish cannot keep bold, links, lists, colours or centred lines yet. Remove them first, or polish the text before you format it.',
      })
      return
    }
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
        ? (editorRef.current?.getHTML() ?? htmlRef.current) === sentHtml
        : messageRef.current.trim() === ''
      if (!unchanged) {
        setAiNotice({ tone: 'info', text: 'You changed the text while the AI was working, so its version was not applied.' })
        return
      }
      if (mode === 'polish' && data.changed === false) {
        setAiNotice({ tone: 'info', text: 'Your text already reads well — the AI changed nothing.' })
        return
      }
      const outputHtml = editorRef.current?.applyHtml(textToHtml(result)) ?? textToHtml(result)
      // Keep the FIRST original until Keep/send, even across several AI runs.
      setAiUndo((prev) => ({ originalHtml: prev?.originalHtml ?? sentHtml, outputHtml, mode }))
      focusBoxQuietly()
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
    const nowHtml = editorRef.current?.getHTML() ?? htmlRef.current
    if (nowHtml !== aiUndo.outputHtml && richHtmlToText(nowHtml).trim() && !window.confirm('Replace what is in the box now with your original text?')) return
    editorRef.current?.applyHtml(aiUndo.originalHtml)
    setAiUndo(null)
    setAiNotice(null)
    focusBoxQuietly()
  }

  // The email composer's contents, drawn either inline (popup=false) or inside the pop-up (popup=true).
  // ONE definition so the two can never drift: same state, same handlers, same guards.
  const emailBody = (popup: boolean) => (
    <>
      {/* An unsent reply from earlier in this tab (page refreshed, crashed, or Back pressed): offered, never put in
          silently. It disappears the moment anything is written, or when it is restored or discarded. */}
      {isEmail && restorable && !message.trim() && (
        <div role="status" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="min-w-0 flex-1">{describeStoredDraft(restorable, Date.now())}</span>
          <span className="flex items-center gap-3 font-medium">
            <button type="button" onClick={handleRestore} className="underline decoration-dotted hover:text-blue-950">
              Restore it
            </button>
            <button type="button" onClick={forgetStoredDraft} className="underline decoration-dotted hover:text-blue-950">
              Discard
            </button>
          </span>
        </div>
      )}
      {/* WHO this reply goes to — ONE line instead of the stack of rows that used to eat the writing space
          (Antonio, 2026-10-06: "the space to write is super small and it's a mess"). The recipient is still
          always visible (and amber when there is none — the one state that must never hide), Reply All still
          says so, and a non-default Quote choice is named in the line. The editable chips, the full From
          address and the Quote chooser sit behind "Details". History kept from the old block: the To list is
          editable for EVERY reply so a wrong target is fixable before sending (Antonio, 2026-09-03: "I want to
          see the from and to addresses... option to see them and delete one or add if needed"); an edited
          list overrides the server's own resolution outright — the server re-validates every address. The
          Portal Chats / account-page mount passes no reply-target callbacks, so frozenTarget stays null there:
          the line then says "Replies to the sender" and NEVER shows a false "no recipient" warning. */}
      {isEmail && (composing || frozenTarget) && (
        <div className="mb-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {frozenTarget ? (
              noRecipient ? (
                <span className="font-medium text-amber-700">Add a recipient — this email has none yet</span>
              ) : (
                <>
                  <span className="shrink-0 text-zinc-500">
                    {frozenTarget.mode === 'replyAll' ? 'Reply All to' : 'To'}:
                  </span>
                  {/* Up to three recipients stay readable on the line (a wrong or look-alike recipient must not hide
                      behind "+N"); the full address is in the tooltip when it is cut short. */}
                  {shownAddresses.slice(0, 3).map((addr) => (
                    <span
                      key={addr}
                      title={addr}
                      className="max-w-[12rem] truncate rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-800 sm:max-w-[18rem]"
                    >
                      {addr}
                    </span>
                  ))}
                  {shownAddresses.length > 3 && (
                    <span
                      title={shownAddresses.slice(3).join(', ')}
                      className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-zinc-600"
                    >
                      +{shownAddresses.length - 3}
                    </span>
                  )}
                </>
              )
            ) : (
              <span className="text-zinc-500">Recipient set automatically</span>
            )}
            <span className="text-zinc-300" aria-hidden="true">·</span>
            <span className="text-zinc-500">From {mailbox === 'antonio' ? 'antonio@' : 'support@'}</span>
            {quoteMode !== 'message' && (
              <>
                <span className="text-zinc-300" aria-hidden="true">·</span>
                <span className="text-zinc-500">Quote: {QUOTE_LABELS[quoteMode]}</span>
              </>
            )}
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={showDetails}
              className="ml-auto inline-flex items-center gap-0.5 text-zinc-500 hover:text-zinc-800"
            >
              Details
              {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>
          {showDetails && (
            <div className="mt-1.5 space-y-2 rounded-lg bg-zinc-50 px-3 py-2">
              {frozenTarget && (
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="shrink-0 text-zinc-500">
                      {frozenTarget.mode === 'replyAll' ? 'Reply All to' : 'To'}:
                    </span>
                    {toAddresses.map((addr) => (
                      <span
                        key={addr}
                        className="inline-flex max-w-full items-center gap-1 break-all rounded-full bg-white pl-2 pr-1 py-0.5 text-zinc-700 ring-1 ring-zinc-200"
                      >
                        {addr}
                        <button
                          type="button"
                          onClick={() => {
                            // Removing the last one keeps Details open so a replacement can be typed straight away.
                            if (toAddresses.length === 1) setDetailsOpen(true)
                            setToAddresses((prev) => prev.filter((a) => a !== addr))
                          }}
                          aria-label={`Remove ${addr}`}
                          className="rounded-full p-0.5 text-zinc-500 hover:bg-zinc-300/60 hover:text-zinc-700"
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
                        commitToInput()
                        setToInput('')
                      }}
                      onBlur={commitToInput}
                      placeholder={toAddresses.length ? 'add another…' : 'add a recipient…'}
                      className="min-w-[100px] flex-1 bg-transparent py-0.5 text-zinc-700 outline-none placeholder:text-zinc-400"
                    />
                  </div>
                  {toAddresses.length === 0 && (
                    <p className="text-xs text-amber-600">At least one recipient is required.</p>
                  )}
                  <p className="text-xs text-zinc-400">
                    {/* frozenTarget.sender is the RECIPIENT for one of our own messages (the message card shows
                        "To: X"), not always an author — "replying to the message from X" read backwards on that
                        card, so this stays direction-agnostic. */}
                    From: {mailbox === 'antonio' ? 'antonio.durante@tonydurante.us' : 'support@tonydurante.us'} · replying to the message {popup ? 'on the left' : 'shown above'}
                  </p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="shrink-0 text-zinc-500">Quote:</span>
                {(['message', 'thread', 'none'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setQuoteMode(value)}
                    className={cn(
                      'rounded-full px-2.5 py-1 transition-colors',
                      quoteMode === value
                        ? 'bg-blue-100 font-medium text-blue-700'
                        : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:bg-zinc-100'
                    )}
                  >
                    {QUOTE_LABELS[value]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

          {/* THE WRITING AREA — the point of the whole composer. Full width on its own line, taller while writing,
              still user-resizable inline. Compact until the reader starts replying so a long thread keeps its
              reading space. The class `compose-reply-textarea` (put on the editor's writing surface by
              RichEditor) must stay on ONE element only (the Reply button finds it by class). The toolbar is the
              slim set while composing inline, the full set in the pop-up. */}
          <RichEditor
            ref={editorRef}
            initialHtml={htmlRef.current}
            style={richStyle}
            onStyleChange={setRichStyle}
            toolbar={popup ? 'full' : composing ? 'slim' : null}
            onChange={handleEditorChange}
            onFocus={() => {
              setComposing(true)
              setDraftNotice(null)
              // With "open replies in the pop-up by default" on, clicking into the inline box opens the pop-up.
              if (!popup && popupDefault && !suppressAutoOpenRef.current && !keepInlineRef.current) setExpanded(true)
            }}
            onSend={() => handleSend()}
            onPasteFiles={(files) => void attachments.add(files)}
            placeholder="Write your reply…  (⌘+Enter sends · drop files to attach)"
            fill={popup}
            autoFocus={popup}
            surfaceClassName={cn(
              'block w-full overflow-y-auto rounded-xl border border-zinc-300 px-4 py-2.5',
              'focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500',
              popup ? 'min-h-[200px] flex-1' : cn('max-h-[50vh] resize-y', composing ? 'min-h-[150px]' : 'min-h-[76px]')
            )}
          />

          {/* Notices sit right under the box, where the eye already is. The wrapper exists only while there is
              something to show, so an idle composer has no dead gap between the box and the footer. */}
          {(sendMutation.isError || attachNotice || draftNotice || aiUndo || aiNotice || placeholderWarn ||
            attachments.files.length > 0 || (composing && previewOpen)) && (
          <div className="mt-2 space-y-2">
            {sendMutation.isError && (
              <p className="text-xs text-red-500">Failed to send: {sendMutation.error.message}</p>
            )}
            {attachNotice && <p className="text-xs text-amber-600">{attachNotice}</p>}
            {draftNotice && <p className="text-xs text-emerald-700">{draftNotice}</p>}
            {/* After the AI replaces text, the original stays one click away until Keep or send. */}
            {aiUndo && (
              <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  {aiUndo.mode === 'draft'
                    ? 'AI wrote a first draft from this thread. Read every line and check each fact before sending.'
                    : 'AI polished your text. Your original is one click away.'}
                </span>
                <span className="flex items-center gap-3 font-medium">
                  <button type="button" onClick={handleUndoAi} className="underline decoration-dotted hover:text-violet-950">
                    {bodyHtml === aiUndo.outputHtml ? 'Undo' : 'Restore my original'}
                  </button>
                  <button type="button" onClick={() => setAiUndo(null)} className="underline decoration-dotted hover:text-violet-950">
                    Keep
                  </button>
                </span>
              </div>
            )}
            {aiNotice && (
              <p
                role={aiNotice.tone === 'error' ? 'alert' : 'status'}
                className={cn('text-xs', aiNotice.tone === 'error' ? 'text-red-600' : 'text-zinc-500')}
              >
                {aiNotice.text}
              </p>
            )}
            {/* Send found a [blank to fill in] — fix it, or send knowingly. */}
            {placeholderWarn && (
              <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span>
                  This email still has a blank to fill in: <strong>{placeholderWarn.slice(0, 4).join(', ')}</strong>
                  {placeholderWarn.length > 4 ? '…' : ''}. Replace it before sending.
                </span>
                <span className="flex items-center gap-3 font-medium">
                  <button
                    type="button"
                    onClick={() => { setPlaceholderWarn(null); focusBoxQuietly() }}
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
            <EmailAttachmentChips attachments={attachments} />
            {/* The preview shows exactly what will be appended under the typed reply — one click away, never
                always open, so the thread above stays readable. */}
            {composing && previewOpen && (
              <SignaturePreview
                sender={mailbox === 'antonio' ? 'antonio' : 'support'}
                variant={signatureVariant}
              />
            )}
          </div>
          )}

          {/* THE FOOTER — every control, labelled, in one row that WRAPS instead of clipping. Left: what you
              add to the message (files, AI, signature). Right: what you do with it. Send is always on screen:
              if the row runs out of width the right-hand group drops to a second line, still right-aligned.
              Replies default to the compact signature so a portrait does not stack down a twenty-message
              thread; overridable per reply. The mailbox is NOT selectable here — a reply must go through the
              same mailbox the thread lives in, which is the one being viewed. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-2">
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
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-zinc-100 px-3 py-2.5 text-xs font-medium text-zinc-600
                  transition-colors hover:bg-zinc-200 hover:text-zinc-800"
                aria-label="Attach files"
              >
                <Paperclip className="h-4 w-4" />
                <span>Attach</span>
              </button>
            </FastTooltip>
            {/* ONE AI button, named for what it will do RIGHT NOW (a hover label does not exist on a phone):
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
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-violet-100 px-3 py-2.5 text-xs font-medium text-violet-700
                  transition-colors hover:bg-violet-200 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={aiMode === 'polish' ? 'AI Polish — improve my text' : 'AI Draft — write a first draft from the thread'}
              >
                {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
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
            {composing && (
              <div className="flex items-center gap-2">
                <SignatureControls
                  sender={mailbox === 'antonio' ? 'antonio' : 'support'}
                  variant={signatureVariant}
                  onVariantChange={setSignatureVariant}
                  disabled={sendMutation.isPending}
                  alwaysShowLabel
                />
                <button
                  type="button"
                  onClick={() => setPreviewOpen((v) => !v)}
                  className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700"
                >
                  {previewOpen ? 'Hide preview' : 'Preview'}
                </button>
              </div>
            )}

            <div className="ml-auto flex items-center gap-2">
              {/* Expand — opens the reply in a large window with the email beside the editor. Inline only; the
                  pop-up has its own ✕ / Esc. */}
              {!popup && (
                <FastTooltip label="Open the reply in a larger window, with the email beside it">
                  <button
                    ref={expandBtnRef}
                    type="button"
                    onClick={openPopup}
                    aria-label="Expand — open the reply in a larger window"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-zinc-100 px-3 py-2.5 text-xs font-medium text-zinc-600
                      transition-colors hover:bg-zinc-200 hover:text-zinc-800"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    <span>Expand</span>
                  </button>
                </FastTooltip>
              )}
              {/* Save draft — needs text, refuses while files are staged: drafts are text-only for now and
                  silently dropping a staged passport would be worse than a disabled button. */}
              {composing && message.trim() && (
                <FastTooltip
                  label={
                    attachments.files.length > 0
                      ? 'Drafts cannot carry attachments yet — send directly, or remove the files first.'
                      : 'Save as a Gmail draft (threaded to this conversation)'
                  }
                >
                  <button
                    onClick={() => draftMutation.mutate(readBody())}
                    disabled={
                      draftMutation.isPending ||
                      sendMutation.isPending ||
                      aiLoading ||
                      attachments.files.length > 0 ||
                      // with every recipient removed the server would fall back to the very person just removed
                      (!!frozenTarget && toAddresses.length === 0)
                    }
                    aria-label={
                      attachments.files.length > 0
                        ? 'Drafts cannot carry attachments yet — send directly, or remove the files first.'
                        : 'Save as a Gmail draft (threaded to this conversation)'
                    }
                    className="shrink-0 rounded-xl bg-zinc-100 px-3 py-2.5 text-xs font-medium text-zinc-600
                      transition-colors hover:bg-zinc-200 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
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
                  (!!frozenTarget && toAddresses.length === 0)
                }
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white
                  transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sendMutation.isPending ? (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span>Send</span>
                <span className="hidden text-[10px] font-normal opacity-70 md:inline">⌘↵</span>
              </button>
            </div>
          </div>
          {popup && (
            <label className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={popupDefault}
                onChange={(e) => togglePopupDefault(e.target.checked)}
                className="h-3.5 w-3.5 accent-blue-600"
              />
              Open replies like this by default on this device
            </label>
          )}
    </>
  )

  const composer = (
    <div
      className="border-t bg-white px-4 py-3"
      // The way BACK to reading (Antonio's QA, 2026-08-05): clicking anywhere
      // outside the composer with an EMPTY draft folds the signature area
      // away again. Checked against the whole container, not the textarea —
      // a blur caused by touching the picker or a button inside stays open.
      // A draft with text never auto-folds: typed words must not vanish.
      onPointerDownCapture={() => {
        pointerInsideRef.current = true
        window.setTimeout(() => { pointerInsideRef.current = false }, 400)
      }}
      onBlur={(e) => {
        if (pointerInsideRef.current) return
        if (
          !e.currentTarget.contains(e.relatedTarget as Node | null) &&
          !message.trim()
        ) {
          setComposing(false)
        }
      }}
    >
      {isEmail ? (
        expanded ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
            <span>You are writing this reply in the pop-up window.</span>
            <button
              type="button"
              onClick={closePopup}
              className="font-medium text-blue-700 underline decoration-dotted hover:text-blue-900"
            >
              Bring it back here
            </button>
          </div>
        ) : (
          emailBody(false)
        )
      ) : (
        // Chat channels (Telegram etc.) keep their original single-row composer. A failed send is shown again
        // here (it was lost in the layout rewrite — R099: never fail silently).
        <>
        {sendMutation.isError && (
          <p className="mb-2 text-xs text-red-500">Failed to send: {sendMutation.error.message}</p>
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
            placeholder={`Reply via ${conversation.channel}...`}
            rows={1}
            className={cn(
              'compose-reply-textarea flex-1 rounded-xl border border-zinc-300 px-4 py-2.5 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-400',
              'resize-none max-h-32'
            )}
            style={{ minHeight: '42px' }}
          />
          <button
            onClick={() => handleSend()}
            aria-label="Send reply"
            disabled={!message.trim() || sendMutation.isPending}
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
        </>
      )}
    </div>
  )

  if (!isEmail) return composer

  return (
    <>
      <WorkerDropZone onFiles={(f) => void attachments.add(f)} label="Drop files to attach to the reply">
        {composer}
      </WorkerDropZone>
      {/* The pop-up is a SIBLING of the inline composer, never a child: React events bubble up the React tree
          even through a portal, and the inline composer's blur/fold handlers must not see what happens in here. */}
      {expanded && (
        <ReplyPopup
          title={`Reply to ${conversation.name}`}
          subtitle={conversation.subject}
          onClose={closePopup}
          onFiles={(f) => void attachments.add(f)}
          thread={<MessageThread conversation={conversation} mailbox={mailbox} />}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">{emailBody(true)}</div>
        </ReplyPopup>
      )}
    </>
  )
}
