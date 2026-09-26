'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  OUTBOX_TEAM_LABEL,
  describeOutboxStatus,
  isOutboxPending,
  sendNotice,
  type SendMode,
} from '@/lib/messaging/wabridge-outbox'
import { Send, Loader2, Paperclip, Sparkles, X, Smile } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { validateChatAttachment } from '@/lib/portal/chat-attachment'
import { loadWhatsAppDraft, saveWhatsAppDraft } from '@/lib/messaging/whatsapp-draft'
import { trackOpenMarkRead } from '@/lib/inbox/pending-mark-read'
import { mergeDraftIntoComposer } from '@/lib/inbox/whatsapp-worker-context'

// Same dynamic-import + ssr:false pattern as every other composer in this
// codebase that embeds this picker (portal-chat.tsx, floating-chat.tsx, …).
const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

interface WhatsAppMessage {
  id: string
  content_text: string | null
  direction: 'inbound' | 'outbound'
  sender_name: string | null
  sender_phone: string | null
  created_at: string
  content_type: string | null
  media_url: string | null
  /** Self-hosted line only: a reply still in the CRM's queue (waiting / test mode / not confirmed / failed). */
  outbox_status?: string | null
  /** Self-hosted line: the queue row id (needed to resolve a reply the Mac could not confirm). */
  outbox_id?: string | null
}

interface WhatsappThreadProps {
  groupId: string
  /**
   * Lets the Worker side panel drop a draft into this message box. Called with the insert
   * function on mount and with null on unmount; the function returns false when it refuses
   * (a send is in flight).
   */
  registerInsertDraft?: (fn: ((draft: string) => boolean) | null) => void
}

interface StagedFile {
  name: string
  size: number
  mimeType: string
  path?: string
  error?: string
}

function formatTimestamp(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function WhatsappThread({ groupId, registerInsertDraft }: WhatsappThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)
  // One id per composed draft: a retry, double click or second tab of the SAME draft can never send twice (the server dedupes on it).
  const clientMsgRef = useRef<{ groupId: string; id: string } | null>(null)
  const getClientMsgId = () => {
    if (!clientMsgRef.current || clientMsgRef.current.groupId !== groupId) {
      clientMsgRef.current = { groupId, id: crypto.randomUUID() }
    }
    return clientMsgRef.current.id
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const suppressDraftSaveRef = useRef(false)
  const [text, setText] = useState('')
  const [file, setFile] = useState<StagedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const queryClient = useQueryClient()

  // Mark this conversation read the moment it's opened — Antonio, 2026-09-18:
  // "the number of unread and read doesn't work." Root cause: unlike Gmail's
  // thread view (message-thread.tsx), nothing here ever called a mark-read
  // endpoint at all — the only way a WhatsApp conversation's unread_count
  // ever reached 0 was the explicit row icon, so real conversations read
  // months ago were still sitting on double-digit unread counts, inflating
  // the WhatsApp tab's badge. Reuses the same dedicated route the row icon
  // already calls (app/api/inbox/whatsapp/mark-read), and the same
  // trackOpenMarkRead/openMarkReadSettled guard Gmail's equivalent open-time
  // mark-read already uses — this call and the row's own "mark unread"
  // toggle both write the same column, and without the guard a fast reopen
  // right after clicking "mark unread" could race this call to land last and
  // silently undo it (the exact incident that guard was built for, 2026-08-05).
  useEffect(() => {
    const call = fetch('/api/inbox/whatsapp/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, unread: false }),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
    })
    trackOpenMarkRead(`whatsapp:${groupId}`, call)
  }, [groupId, queryClient])

  // Auto-grow the textarea as the message gets longer, capped so the reply
  // bar can't push the message list off-screen (Antonio, 2026-09-17: "I don't
  // see the field where I write that is expandable to see the entire text").
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  useEffect(() => {
    if (!showEmojiPicker) return
    const handleClick = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showEmojiPicker])

  const { data, isLoading, error } = useQuery<{ messages: WhatsAppMessage[]; send?: { mode: SendMode; hasInbound: boolean } | null }>({
    queryKey: ['whatsapp-messages', groupId],
    queryFn: () =>
      fetch(`/api/inbox/whatsapp/messages/${encodeURIComponent(groupId)}`).then((r) =>
        r.json()
      ),
    // 5 s while one of our replies is still waiting to be sent, otherwise the usual minute
    refetchInterval: (query) =>
      query.state.data?.messages?.some((m) => m.outbox_status && isOutboxPending(m.outbox_status)) ? 5_000 : 60_000,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [data?.messages])

  // Switching conversations must not carry over a half-composed reply or
  // confirm screen from the previous one — but a draft FOR the conversation
  // being switched to should load back in, same as the new-conversation
  // popup already does (Antonio, 2026-09-18: caught this one missing here).
  //
  // suppressDraftSaveRef guards a real race: the save effect below runs on
  // EVERY text change, but on mount it would otherwise fire with the render's
  // stale pre-load text ('') BEFORE this effect's setText commits — wiping
  // out the very draft just read from storage. Caught live under React's dev
  // double-invoke (StrictMode runs mount effects twice), which reproduced it
  // reliably: the draft was saved correctly, then silently deleted the
  // instant the conversation was reopened. The flag defers the very next
  // save-effect run until after the loaded value has actually committed.
  useEffect(() => {
    suppressDraftSaveRef.current = true
    setText(loadWhatsAppDraft('reply', groupId))
    setFile(null)
    setConfirming(false)
  }, [groupId])

  // Save on every change, not just on unmount — a crashed tab must not lose it.
  useEffect(() => {
    if (suppressDraftSaveRef.current) {
      suppressDraftSaveRef.current = false
      return
    }
    saveWhatsAppDraft('reply', groupId, text)
  }, [groupId, text])

  // A draft from the Worker panel goes through the same box the staff member types in and
  // still needs their own press of Send. Adds below anything already typed (never overwrites),
  // and drops the confirm screen so what Confirm sends is always what is visibly in the box.
  useEffect(() => {
    if (!registerInsertDraft) return
    registerInsertDraft((draft: string) => {
      if (sendingRef.current) return false
      setText((prev) => mergeDraftIntoComposer(prev, draft))
      setConfirming(false)
      textareaRef.current?.focus()
      return true
    })
    return () => registerInsertDraft(null)
  }, [registerInsertDraft])

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: groupId,
          message: text,
          channel: 'whatsapp',
          attachmentPath: file?.path,
          clientMsgId: getClientMsgId(),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: (result: { status?: string }) => {
      clientMsgRef.current = null // the next draft gets a fresh id
      if (result?.status === 'shadow') toast.info('Test mode: your reply was recorded but NOT sent to WhatsApp.')
      setText('')
      setFile(null)
      setConfirming(false)
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] })
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Send failed')
    },
  })

  const handlePickFile = () => fileInputRef.current?.click()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return

    const validationError = validateChatAttachment(picked.name, picked.size, picked.type)
    if (validationError) {
      toast.error(validationError)
      return
    }

    setFile({ name: picked.name, size: picked.size, mimeType: picked.type })
    setUploading(true)
    try {
      const urlRes = await fetch('/api/inbox/whatsapp-new/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: picked.name, file_size: picked.size, mime_type: picked.type }),
      })
      if (!urlRes.ok) {
        const d = await urlRes.json().catch(() => ({}))
        throw new Error(d.error || 'Could not start the upload.')
      }
      const { signedUrl, path } = await urlRes.json()
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': picked.type || 'application/octet-stream' },
        body: picked,
      })
      if (!putRes.ok) throw new Error('Upload failed. Please try again.')
      setFile((prev) => (prev ? { ...prev, path } : prev))
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.'
      setFile((prev) => (prev ? { ...prev, error: msg } : prev))
      toast.error(msg)
    } finally {
      setUploading(false)
    }
  }

  const handleSuggest = async () => {
    setSuggesting(true)
    try {
      const res = await fetch('/api/inbox/whatsapp-new/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not generate a suggestion.')
      setText(data.suggestion || '')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not generate a suggestion.')
    } finally {
      setSuggesting(false)
    }
  }

  const handleOpenConfirm = () => {
    if (!text.trim() || !canSend) return
    if (uploading) {
      toast.error('Wait for the attachment to finish uploading.')
      return
    }
    if (file?.error) {
      toast.error('Remove the attachment or re-attach it before sending.')
      return
    }
    setConfirming(true)
  }

  // A reply the Mac could not confirm ("Not confirmed — check the phone"): a person looks at the phone and decides. Never retried automatically.
  const [resolving, setResolving] = useState<string | null>(null)
  const resolveOutbox = async (outboxId: string, action: 'sent' | 'discard') => {
    if (resolving) return
    setResolving(outboxId)
    try {
      const res = await fetch('/api/inbox/whatsapp/outbox/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outboxId, action }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save your decision — please try again.')
      }
      toast.success(action === 'sent' ? 'Marked as sent.' : 'Discarded — it was not sent.')
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save your decision — please try again.')
    } finally {
      setResolving(null)
    }
  }

  const handleConfirmSend = () => {
    if (sendingRef.current || sendMutation.isPending) return
    sendingRef.current = true
    sendMutation.mutate(undefined, { onSettled: () => { sendingRef.current = false } })
  }

  const messages = data?.messages ?? []
  // Self-hosted line: `send` is present. The server enforces every rule; this only avoids offering a button that would be refused.
  const notice = data?.send ? sendNotice(data.send) : null
  const canSend = !data?.send || (data.send.mode !== 'paused' && data.send.hasInbound)
  const textOnly = !!data?.send

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {isLoading ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={cn('flex', i % 3 === 0 ? 'justify-end' : 'justify-start')}
            >
              <div className="h-10 bg-zinc-100 rounded-2xl animate-pulse w-48" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          Failed to load messages
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          No messages in this conversation
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-zinc-50">
          {messages.map((msg) => {
            const isOutbound = msg.direction === 'outbound'
            const isImage = msg.content_type === 'image'
            const isOtherMedia = !isImage && msg.content_type !== 'text' && !!msg.media_url

            return (
              <div
                key={msg.id}
                className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[70%] px-3 py-2 rounded-2xl shadow-sm',
                    isOutbound
                      ? 'bg-green-100 text-zinc-800 rounded-br-sm'
                      : 'bg-white text-zinc-800 rounded-bl-sm'
                  )}
                >
                  {isImage && msg.media_url ? (
                    <a href={msg.media_url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={msg.media_url}
                        alt={msg.content_text || 'Image'}
                        className="max-w-full rounded-lg mb-1"
                      />
                    </a>
                  ) : isOtherMedia ? (
                    <a
                      href={msg.media_url ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm italic text-blue-600 underline"
                    >
                      {msg.content_text || `Attachment (${msg.content_type})`}
                    </a>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {msg.content_text}
                    </p>
                  )}
                  {msg.outbox_status && describeOutboxStatus(msg.outbox_status) && (
                    <p
                      className={cn(
                        'text-[11px] mt-1 font-medium',
                        describeOutboxStatus(msg.outbox_status)?.tone === 'bad' ? 'text-red-600' : describeOutboxStatus(msg.outbox_status)?.tone === 'warn' ? 'text-amber-700' : 'text-zinc-500'
                      )}
                    >
                      {describeOutboxStatus(msg.outbox_status)?.label}
                    </p>
                  )}
                  {msg.outbox_status === 'unknown' && msg.outbox_id && (
                    <div className="flex gap-2 mt-1.5">
                      <button
                        type="button"
                        disabled={resolving === msg.outbox_id}
                        onClick={() => resolveOutbox(msg.outbox_id as string, 'sent')}
                        className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                      >
                        It was sent
                      </button>
                      <button
                        type="button"
                        disabled={resolving === msg.outbox_id}
                        onClick={() => resolveOutbox(msg.outbox_id as string, 'discard')}
                        className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        It was not sent — discard
                      </button>
                    </div>
                  )}
                  <p className="text-[10px] text-zinc-400 mt-1 text-right">
                    {msg.sender_name ?? msg.sender_phone ?? (isOutbound ? OUTBOX_TEAM_LABEL : 'Contact')}
                    {' · '}
                    {formatTimestamp(msg.created_at)}
                  </p>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Composer — same feature set as the "start a new WhatsApp
          conversation" popup: attach, AI Suggest, and a confirm step before
          sending, so replying from an open conversation isn't a different,
          thinner experience than starting one (Antonio, 2026-09-17). */}
      <div className="border-t bg-white shrink-0">
        {notice && (
          <p className={cn('text-xs px-3 pt-2', notice.tone === 'warn' ? 'text-amber-700' : 'text-zinc-500')}>{notice.text}</p>
        )}
        {sendMutation.isError && (
          <p className="text-xs text-red-600 px-3 pt-2">
            Failed to send: {sendMutation.error.message}
          </p>
        )}

        {!confirming ? (
          <div className="p-2 space-y-2">
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
            {file && (
              <div className="flex items-center gap-2 text-xs bg-zinc-50 border rounded px-2 py-1.5">
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                <span className="truncate flex-1">{file.name}</span>
                {file.error && <span className="text-red-600">{file.error}</span>}
                <button onClick={() => setFile(null)} className="text-zinc-400 hover:text-zinc-700">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="relative shrink-0" ref={emojiPickerRef}>
                <button
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                  aria-label="Insert an emoji"
                >
                  <Smile className="h-4 w-4" />
                </button>
                {showEmojiPicker && (
                  <div className="absolute bottom-11 left-0 z-30">
                    <EmojiPicker
                      onEmojiClick={(emojiData: { emoji: string }) => {
                        const el = textareaRef.current
                        if (el) {
                          const start = el.selectionStart ?? text.length
                          const end = el.selectionEnd ?? start
                          const next = text.slice(0, start) + emojiData.emoji + text.slice(end)
                          setText(next)
                          requestAnimationFrame(() => {
                            el.focus()
                            el.setSelectionRange(start + emojiData.emoji.length, start + emojiData.emoji.length)
                          })
                        } else {
                          setText((prev) => prev + emojiData.emoji)
                        }
                        setShowEmojiPicker(false)
                      }}
                      width={300}
                      height={360}
                      lazyLoadEmojis
                      skinTonesDisabled
                    />
                  </div>
                )}
              </div>
              <textarea
                ref={textareaRef}
                className="compose-reply-textarea flex-1 resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-400 min-h-[40px] max-h-60 disabled:bg-zinc-50 disabled:text-zinc-400"
                rows={1}
                disabled={suggesting}
                placeholder={suggesting ? 'Writing a suggestion…' : 'Type a WhatsApp message…'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return
                  e.preventDefault()
                  handleOpenConfirm()
                }}
              />
              <button
                onClick={handlePickFile}
                disabled={!!file || textOnly}
                className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40"
                aria-label={textOnly ? 'Attachments are not available on this WhatsApp line yet — text only' : 'Attach a file'}
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <button
                onClick={handleSuggest}
                disabled={suggesting}
                className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-40"
                aria-label="AI Suggest"
              >
                {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              </button>
              <button
                onClick={handleOpenConfirm}
                disabled={!text.trim() || uploading || !canSend}
                className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg bg-green-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-700 transition-colors"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="p-3 space-y-2">
            <p className="text-xs text-zinc-500">Sending</p>
            <div className="bg-zinc-50 rounded-lg p-3 text-sm whitespace-pre-wrap break-words">
              {text}
            </div>
            {file && (
              <p className="text-xs text-zinc-500 flex items-center gap-1">
                <Paperclip className="h-3 w-3" /> Attaching: {file.name}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setConfirming(false)}
                className="px-3 py-1.5 text-sm border rounded-md hover:bg-zinc-50"
              >
                Edit
              </button>
              <button
                onClick={handleConfirmSend}
                disabled={sendMutation.isPending}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
              >
                {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Confirm & Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
