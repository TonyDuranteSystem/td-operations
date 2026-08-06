'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { InboxMessage, InboxConversation } from '@/lib/types'
import { sanitizeEmailHtml } from '@/lib/html-escape'
import { emailSnippet } from '@/lib/inbox/email-html'
import { splitQuotedText } from '@/lib/inbox/email-quote'
import { printEmailThread } from '@/lib/inbox/print-email'
import { resolveAttachmentType, shouldOpenInTab } from '@/lib/inbox/attachment-open'
import { EmailHtmlFrame } from './email-html-frame'
import { NoteQuickCreate } from '@/components/dashboard/note-quick-create'
import { Link2 } from 'lucide-react'
import { trackOpenMarkRead } from '@/lib/inbox/pending-mark-read'

type ThreadAttachment = NonNullable<InboxMessage['attachments']>[number]

/**
 * One attachment chip.
 *
 * It is a BUTTON, not a link, on purpose: a top-level navigation to the download
 * URL is rejected at the platform edge with a 503 because Gmail's attachmentId is
 * a ~400-char token in the query string (verified in prod 2026-07-14, dev_task
 * 62ca1b5a — see lib/inbox/attachment-open.ts). The same URL fetched same-origin
 * returns 200, so we fetch the bytes and open them from a blob. An <a href> would
 * also hand the user a broken "open in new tab" on right-click.
 */
function AttachmentChip({
  att,
  messageId,
  mailbox,
  className,
}: {
  att: ThreadAttachment
  messageId: string
  mailbox?: string
  className: string
}) {
  const [busy, setBusy] = useState(false)

  const open = async () => {
    if (busy) return
    setBusy(true)

    const resolved = resolveAttachmentType(att.filename, att.mimeType)
    // Installed-app (PWA) windows very often refuse to open a new tab at all, so
    // we never gamble on window.open there — we download, which works everywhere.
    const standalone =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)').matches === true ||
        (window.navigator as { standalone?: boolean }).standalone === true)

    const viewInTab = shouldOpenInTab({
      inline: resolved.inline,
      standalone,
      size: att.size ?? 0,
    })

    // The tab must be opened SYNCHRONOUSLY inside the click handler — opening it
    // after `await fetch` trips the popup blocker. Only when we intend to render.
    const win = viewInTab ? window.open('', '_blank') : null
    if (win) {
      // Something visible while the bytes are in flight, and — critically — a
      // surface to report a failure ON. Closing this tab and toasting on the tab
      // behind it meant a failed open could look like nothing happened at all.
      win.document.body.style.cssText =
        'font:14px system-ui,sans-serif;color:#3f3f46;padding:24px'
      win.document.body.textContent = `Opening ${att.filename}…`
    }

    const params = new URLSearchParams({
      messageId,
      attachmentId: att.attachmentId,
      filename: att.filename,
      mimeType: att.mimeType,
    })
    if (mailbox) params.set('mailbox', mailbox)

    let objectUrl: string | null = null
    try {
      const res = await fetch(`/api/inbox/attachment?${params}`)
      if (!res.ok) {
        // R099 — surface the server's actual reason, never a blanket "failed".
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Could not open this attachment. Please try again.')
      }

      const raw = await res.blob()
      // Re-type the blob when the sender lied (octet-stream for a PDF): the
      // browser decides how to render from the blob's type, not the filename.
      const blob = raw.type === resolved.type ? raw : new Blob([raw], { type: resolved.type })
      objectUrl = URL.createObjectURL(blob)

      if (win) {
        win.location.href = objectUrl
      } else {
        // Not viewable on our origin, too big to render, an installed app, or the
        // popup was blocked -> download it.
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = att.filename || 'attachment'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
      // Give the tab / download time to consume it before dropping the bytes.
      const url = objectUrl
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Could not open this attachment. Please try again.'
      // Report the failure where the user is actually looking. The pre-opened tab
      // is fronted, so a toast on the tab behind it would go unseen.
      if (win && !win.closed) {
        win.document.body.textContent = `Could not open ${att.filename} — ${message}`
      }
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      title={att.filename}
      className={cn(className, busy && 'opacity-60 cursor-wait')}
    >
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
      </svg>
      <span className="truncate max-w-[200px]">{att.filename}</span>
      <span className="text-[10px] opacity-60 shrink-0">
        {busy
          ? 'Opening…'
          : att.size > 1024 * 1024
            ? `${(att.size / 1024 / 1024).toFixed(1)}MB`
            : `${Math.round(att.size / 1024)}KB`}
      </span>
    </button>
  )
}

/**
 * Plain-text email body: line breaks preserved, quoted history ("On ...
 * wrote:" + "> " lines) collapsed behind a Gmail-style toggle.
 */
function PlainEmailBody({ content }: { content: string }) {
  const { main, quoted } = splitQuotedText(content)
  return (
    <div className="px-2 py-1.5">
      <p className="text-sm whitespace-pre-wrap break-words">{main}</p>
      {quoted && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-xs text-zinc-400 hover:text-zinc-600 list-none inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-0.5">
            ··· Show quoted text
          </summary>
          <p className="mt-1 text-sm whitespace-pre-wrap break-words text-zinc-500 border-l-2 border-zinc-200 pl-3">
            {quoted}
          </p>
        </details>
      )}
    </div>
  )
}

interface MessageThreadProps {
  conversation: InboxConversation
  /** Optional: receives a Print/Save-as-PDF handler for the loaded email thread
   *  (null while unavailable). Lets a parent toolbar trigger printing the thread
   *  it doesn't itself hold the bodies for. Omitted by the portal-chats reuse. */
  registerPrint?: (fn: (() => void) | null) => void
}

interface ThreadResponse {
  conversationId: string
  channel: string
  messages: InboxMessage[]
  subject?: string
  name?: string
}

function formatMessageTime(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function MessageThread({ conversation, mailbox, registerPrint }: MessageThreadProps & { mailbox?: string }) {
  const queryClient = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data, isLoading, error } = useQuery<ThreadResponse>({
    queryKey: ['inbox-messages', conversation.id, mailbox],
    queryFn: async () => {
      const params = mailbox ? `?mailbox=${mailbox}` : ''
      const res = await fetch(
        `/api/inbox/messages/${encodeURIComponent(conversation.id)}${params}`
      )
      if (!res.ok) {
        // R099 + the scroll bug's hidden twin: swallowing a failed poll into
        // `data` used to render the "No messages" branch, unmounting the
        // scroll container — the next good poll remounted it at the top.
        // Throwing keeps react-query's last-good data (and scroll) in place.
        const d = await res.json().catch(() => ({}))
        throw new Error(
          (d as { error?: string }).error || 'Could not load this conversation.'
        )
      }
      return res.json()
    },
    refetchInterval: 15_000,
  })

  // Mark as read when opening a conversation with unread messages
  const markReadMutation = useMutation({
    mutationFn: () => {
      const call = fetch('/api/inbox/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          channel: conversation.channel,
          mailbox,
        }),
      })
      // Recorded so the header's "Mark unread" can WAIT for this to settle:
      // this call is slow (thread fetch + one modify per message) and, raced,
      // it lands after the user's mark-unread and silently undoes it
      // (Antonio's production QA, 2026-08-05).
      trackOpenMarkRead(conversation.id, call)
      return call
    },
    onSuccess: () => {
      // Delay refetch significantly — Gmail's index takes 30-60s to reflect label changes
      // The optimistic update in the useEffect below handles immediate UI
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      }, 60_000)
    },
  })

  useEffect(() => {
    // Mark the thread read in Gmail. The optimistic badge is now handled by the
    // parent's unread OVERRIDE (set in handleSelect) — the single optimistic
    // writer. We deliberately no longer write `unread: 0` straight into the
    // conversations cache: that second write mutated the payload the reconcile
    // treats as "server truth", tripping the baseline check so the just-read row
    // flickered back to unread on the next poll (council code-review 2026-07-15).
    markReadMutation.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id])

  // Chat channels: auto-scroll to bottom (newest last, WhatsApp-style).
  // EMAIL threads render NEWEST FIRST and deliberately have NO scroll-on-data
  // effect: scrolling on payload change was the jump-to-top bug — the 15s
  // poll's mark-read "new"→"read" status flip landed a changed payload a few
  // seconds after opening any unread thread and yanked the reader to the top
  // (Luca 2026-07-28, council-reviewed). Both mount sites key this component
  // by conversation id, so a remount lands at the top on its own; the
  // conversation.id effect below is a belt-and-braces for any unkeyed mount.
  const isEmailThread = data?.channel === 'gmail'
  useEffect(() => {
    if (!scrollRef.current || isEmailThread) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.messages])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [conversation.id])

  // ─── Gmail-style collapse (email threads only) ───────────────────────────
  // Seeded ONCE per mount from the first payload: newest expanded, the rest
  // collapsed. Refetches NEVER re-seed — the mark-read payload delta arrives
  // ~15s after open and must not collapse what the user expanded. Later
  // arrivals render collapsed with a "New" badge; nothing ever auto-collapses
  // or auto-expands under the reader (council decision 2026-07-28).
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const seededRef = useRef(false)
  const knownIdsRef = useRef<Set<string>>(new Set())
  // Scroll anchor for toggles: keep the clicked header at the same viewport
  // offset when content above/around it changes height (Safari has no native
  // scroll anchoring — Antonio reads on the iPhone PWA).
  const anchorRef = useRef<{ id: string; top: number } | null>(null)

  useEffect(() => {
    if (data?.channel !== 'gmail' || !data.messages?.length) return
    const newestFirst = [...data.messages].reverse()
    if (!seededRef.current) {
      seededRef.current = true
      knownIdsRef.current = new Set(newestFirst.map((m) => m.id))
      setExpanded(new Set([newestFirst[0].id]))
      return
    }
    const fresh = newestFirst.filter((m) => !knownIdsRef.current.has(m.id))
    if (fresh.length > 0) {
      fresh.forEach((m) => knownIdsRef.current.add(m.id))
      setNewIds((prev) => {
        const next = new Set(prev)
        fresh.forEach((m) => next.add(m.id))
        return next
      })
    }
  }, [data])

  // One-line previews for collapsed cards, computed once per payload (a
  // multi-MB newsletter must not be re-stripped on every render).
  const snippets = useMemo(() => {
    const map = new Map<string, string>()
    if (data?.channel === 'gmail') {
      for (const m of data.messages || []) {
        map.set(m.id, emailSnippet(m.content || '', m.isHtml))
      }
    }
    return map
  }, [data])

  const toggleMessage = (id: string) => {
    const el = scrollRef.current?.querySelector(`[data-mid="${CSS.escape(id)}"]`)
    if (el) anchorRef.current = { id, top: el.getBoundingClientRect().top }
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setNewIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor || !scrollRef.current) return
    anchorRef.current = null
    const el = scrollRef.current.querySelector(`[data-mid="${CSS.escape(anchor.id)}"]`)
    if (!el) return
    const delta = el.getBoundingClientRect().top - anchor.top
    if (delta !== 0) scrollRef.current.scrollTop += delta
  }, [expanded])

  // Expose a Print/Save-as-PDF handler for the loaded email thread to a parent
  // toolbar. Prints messages chronologically (oldest first), Gmail-print style.
  useEffect(() => {
    if (!registerPrint) return
    const msgs = data?.channel === 'gmail' ? data?.messages : undefined
    if (!msgs || msgs.length === 0) {
      registerPrint(null)
      return
    }
    registerPrint(() =>
      printEmailThread({
        subject: data?.subject,
        messages: msgs.map((m) => ({
          sender: m.sender,
          direction: m.direction,
          createdAt: m.createdAt,
          content: m.content || '',
          isHtml: m.isHtml,
        })),
        formatTime: formatMessageTime,
      })
    )
    return () => registerPrint(null)
  }, [data, registerPrint])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-6 w-6 border-2 border-zinc-300 border-t-zinc-600 rounded-full" />
      </div>
    )
  }

  // A failed FIRST load surfaces the server's reason (R099). A failed POLL
  // never lands here — react-query keeps the last good payload.
  if (error && !data) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-red-600">
        {error instanceof Error && error.message
          ? error.message
          : 'Could not load this conversation.'}
      </div>
    )
  }

  const messages = isEmailThread
    ? [...(data?.messages || [])].reverse() // newest email on top
    : data?.messages || []

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        No messages in this conversation
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {/* Subject + "make a note about this email". The note picks up the client this thread is
          linked to and a link back to this page, so it can find its way home later. */}
      <div className="flex items-center justify-center gap-2 py-2">
        {data?.subject && (
          <span className="inline-block max-w-full break-words text-xs font-medium text-zinc-500 bg-zinc-100 px-3 py-1 rounded-xl">
            {data.subject}
          </span>
        )}
        <NoteQuickCreate
          accountId={conversation.accountId}
          contactId={conversation.contactId}
          prefill={data?.subject || conversation.subject || conversation.name}
          // RELATIVE deep link so the note's From: button opens THIS email (the
          // page URL carries no thread — selection is React state — so without
          // this the note would point at the bare Inbox front page).
          originUrl={
            conversation.id.startsWith('gmail:')
              ? `/inbox?thread=${encodeURIComponent(conversation.id)}${mailbox ? `&mailbox=${mailbox}` : ''}`
              : undefined
          }
        />
        {/* Copy a link that opens this exact email (right mailbox) — gmail threads
            only; other channels have no deep-link consumer. Synchronous write keeps
            the iOS PWA user gesture; honest then/catch, never a false "Copied". */}
        {conversation.id.startsWith('gmail:') && (
          <button
            type="button"
            onClick={() => {
              const rel = `/inbox?thread=${encodeURIComponent(conversation.id)}${mailbox ? `&mailbox=${mailbox}` : ''}`
              navigator.clipboard.writeText(`${window.location.origin}${rel}`)
                .then(() => toast.success('Link copied.'))
                .catch(() => toast.error('Could not copy the link on this device.'))
            }}
            title="Copy link to this email"
            className="flex shrink-0 items-center gap-1 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50"
          >
            <Link2 className="h-3.5 w-3.5" />Copy link
          </button>
        )}
        {isEmailThread && messages.length > 1 && (
          <button
            type="button"
            onClick={() => {
              const allOpen = messages.every((m) => expanded.has(m.id))
              setExpanded(allOpen ? new Set() : new Set(messages.map((m) => m.id)))
              if (!allOpen) setNewIds(new Set())
            }}
            className="shrink-0 text-xs text-zinc-400 hover:text-zinc-600 bg-zinc-100 px-2 py-1 rounded-xl"
          >
            {messages.every((m) => expanded.has(m.id)) ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>

      {messages.map((msg) => {
        const isOutbound = msg.direction === 'outbound'
        const isEmail = msg.type === 'email'

        // Emails render Gmail-style: full-width cards with the body isolated in
        // a sandboxed iframe (email CSS preserved, scripts impossible). Chat
        // channels keep the bubble layout.
        if (isEmail) {
          const isOpen = expanded.has(msg.id)
          const isNew = newIds.has(msg.id)
          return (
            <div
              key={msg.id}
              data-mid={msg.id}
              className={cn(
                'rounded-lg border bg-white overflow-hidden',
                isOutbound ? 'border-blue-200' : 'border-zinc-200'
              )}
            >
              {/* The whole header is the expand/collapse toggle (Gmail-style).
                  Collapsed cards show a one-line snippet and mount NO iframe —
                  a 40-message thread renders one viewer, not forty. */}
              <button
                type="button"
                onClick={() => toggleMessage(msg.id)}
                title={isOpen ? 'Collapse this email' : 'Expand this email'}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-4 py-2 text-xs text-left cursor-pointer',
                  isOpen && 'border-b',
                  isOutbound
                    ? 'bg-blue-50/60 border-blue-100 hover:bg-blue-50'
                    : 'bg-zinc-50 border-zinc-100 hover:bg-zinc-100'
                )}
              >
                <span className="font-semibold text-zinc-700 truncate shrink-0 max-w-[45%]">
                  {isOutbound ? `To: ${msg.sender}` : msg.sender}
                </span>
                {!isOpen && (
                  <span className="flex-1 min-w-0 truncate text-zinc-400 font-normal">
                    {snippets.get(msg.id) || ''}
                  </span>
                )}
                <span className="flex items-center gap-2 shrink-0 text-zinc-400">
                  {isNew && (
                    <span className="rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-[10px] font-semibold">
                      New
                    </span>
                  )}
                  {formatMessageTime(msg.createdAt)}
                </span>
              </button>

              {isOpen && (
                <>
                  <div className="px-2 py-1">
                    {/* Branch on the REAL MIME type from the server — guessing
                        from the content misdetects plain replies quoting an
                        address like `<a@b.com>` as HTML and eats line breaks.
                        Heuristic kept only as fallback for cached payloads. */}
                    {(msg.isHtml ?? (msg.content?.includes('<') && msg.content?.includes('>'))) ? (
                      // Inbound email HTML is attacker-controlled (anyone can email
                      // support@). Defense in depth: sanitized AND rendered in a
                      // sandboxed iframe with scripts disabled (security audit
                      // 2026-06-13, H8/H9).
                      <EmailHtmlFrame html={sanitizeEmailHtml(msg.content)} />
                    ) : (
                      <PlainEmailBody content={msg.content || ''} />
                    )}
                  </div>

                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="px-4 pb-3 pt-1 flex flex-wrap gap-1.5">
                      {msg.attachments.map((att, i) => (
                        <AttachmentChip
                          key={i}
                          att={att}
                          messageId={msg.id}
                          mailbox={mailbox}
                          className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 transition-colors"
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        }

        return (
          <div
            key={msg.id}
            className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[75%] rounded-2xl px-4 py-2.5',
                isOutbound
                  ? 'bg-blue-500 text-white rounded-br-md'
                  : 'bg-white border border-zinc-200 text-zinc-900 rounded-bl-md'
              )}
            >
              {!isOutbound && (
                <p
                  className={cn(
                    'text-xs font-semibold mb-1',
                    isOutbound ? 'text-blue-100' : 'text-zinc-500'
                  )}
                >
                  {msg.sender}
                </p>
              )}

              {msg.content?.includes('<') && msg.content?.includes('>') ? (
                <div
                  className="text-sm prose prose-sm max-w-none break-words [&_a]:text-blue-600 [&_a]:underline"
                  // Inbound HTML is untrusted and renders in the staff CRM
                  // session, so it MUST be sanitized before
                  // dangerouslySetInnerHTML (security audit 2026-06-13, H9).
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msg.content) }}
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap break-words">
                  {msg.content}
                </p>
              )}

              {msg.attachments && msg.attachments.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.attachments.map((att, i) => (
                    <AttachmentChip
                      key={i}
                      att={att}
                      messageId={msg.id}
                      mailbox={mailbox}
                      className={cn(
                        'flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg transition-colors',
                        isOutbound
                          ? 'bg-blue-400/30 hover:bg-blue-400/50 text-white'
                          : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
                      )}
                    />
                  ))}
                </div>
              )}

              <p
                className={cn(
                  'text-[10px] mt-1',
                  isOutbound ? 'text-blue-200' : 'text-zinc-400'
                )}
              >
                {formatMessageTime(msg.createdAt)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
