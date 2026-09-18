'use client'

/**
 * Start a new WhatsApp conversation from a lead's or a contact's own page —
 * exactly one of leadId/contactId is passed by the caller. Feature set
 * (confirm-before-send, draft memory, an attachment, AI-Suggest) mirrors
 * Portal Chats' composer wherever that fits a person with no company
 * structure — see docs/systems/messaging.md for the design decisions this
 * dialog exists to implement, and dev job f331cd43 for the review that shaped
 * it (Antonio approved all four pieces after that review; the two flagged
 * concerns — attachment storage safety, and building AI-Suggest at all — were
 * resolved by using the codebase's existing PRIVATE attachment pattern
 * instead of Portal Chats' public one, and by Antonio's explicit go-ahead).
 */

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Loader2, Send, Paperclip, Sparkles, MessageCircle, Smile } from 'lucide-react'
import { toast } from 'sonner'
import { validateChatAttachment } from '@/lib/portal/chat-attachment'
import { loadWhatsAppDraft, saveWhatsAppDraft } from '@/lib/messaging/whatsapp-draft'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

interface SentConversation {
  id: string
  channel: 'whatsapp'
  name: string
  preview: string
  unread: number
  lastMessageAt: string
  accountId: string | null
}

interface NewWhatsAppConversationDialogProps {
  open: boolean
  onClose: () => void
  leadId?: string
  contactId?: string
  accountId?: string | null
  name: string
  phone: string
  /** Notified with the created/updated conversation right after a successful
   *  send — lets a caller inside the Inbox itself (unlike a lead/contact
   *  page, which has nowhere to navigate to) select it and switch to the
   *  WhatsApp tab. */
  onSent?: (conversation: SentConversation) => void
}

interface StagedFile {
  name: string
  size: number
  mimeType: string
  path?: string
  error?: string
}

const loadDraft = (id: string) => loadWhatsAppDraft('new', id)
const saveDraft = (id: string, text: string) => saveWhatsAppDraft('new', id, text)

export function NewWhatsAppConversationDialog({
  open,
  onClose,
  leadId,
  contactId,
  accountId,
  name,
  phone,
  onSent,
}: NewWhatsAppConversationDialogProps) {
  const identityId = leadId ?? contactId ?? ''
  const queryClient = useQueryClient()
  const [message, setMessage] = useState('')
  const [file, setFile] = useState<StagedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const suppressDraftSaveRef = useRef(false)

  // Auto-grow the message box as the draft gets longer (Antonio, 2026-09-17).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [message])

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

  // Load the draft when the dialog opens; each open re-checks in case the
  // draft aged out (7-day TTL) since it was written.
  //
  // suppressDraftSaveRef guards a real race, found live in the sibling reply
  // composer (components/inbox/whatsapp-thread.tsx, 2026-09-18) and fixed
  // here the same way: without it, the save effect below can fire with the
  // stale pre-load message ('') before this effect's setMessage commits,
  // deleting the very draft just read from storage. Reproduced reliably
  // under React's dev double-invoke (StrictMode runs mount effects twice).
  useEffect(() => {
    if (!open || !identityId) return
    suppressDraftSaveRef.current = true
    setMessage(loadDraft(identityId))
    setFile(null)
    setConfirming(false)
  }, [open, identityId])

  // Save on every change, not just on close — a crashed tab must not lose it.
  useEffect(() => {
    if (!open || !identityId) return
    if (suppressDraftSaveRef.current) {
      suppressDraftSaveRef.current = false
      return
    }
    saveDraft(identityId, message)
  }, [open, identityId, message])

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/inbox/new-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId,
          contactId,
          accountId: accountId || undefined,
          phone,
          message,
          attachmentPath: file?.path,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: (data: { conversation: SentConversation }) => {
      saveDraft(identityId, '') // clears it
      setMessage('')
      setFile(null)
      setConfirming(false)
      toast.success(`Sent to ${name}`)
      // The Inbox's list is keyed 'inbox-conversations' regardless of
      // channel (see conversation-list.tsx) — 'whatsapp-conversations' was
      // never a real query anywhere in this app.
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      onSent?.(data.conversation)
      onClose()
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Send failed')
    },
  })

  if (!open) return null

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
        body: JSON.stringify({ leadId, contactId, phone }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not generate a suggestion.')
      setMessage(data.suggestion || '')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not generate a suggestion.')
    } finally {
      setSuggesting(false)
    }
  }

  const handleOpenConfirm = () => {
    const text = message.trim()
    if (!text) return
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

  const handleConfirmSend = () => {
    if (sendingRef.current || sendMutation.isPending) return
    sendingRef.current = true
    sendMutation.mutate(undefined, { onSettled: () => { sendingRef.current = false } })
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-green-600" />
              Message {name} on WhatsApp
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {!confirming ? (
            <div className="px-6 py-4 space-y-3">
              <p className="text-sm text-zinc-500">{phone}</p>
              <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                disabled={suggesting}
                placeholder={suggesting ? 'Writing a suggestion…' : 'Type a WhatsApp message…'}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 resize-none disabled:bg-zinc-50 disabled:text-zinc-400 max-h-60"
              />
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
              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2">
                  <div className="relative" ref={emojiPickerRef}>
                    <button
                      onClick={() => setShowEmojiPicker((v) => !v)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border hover:bg-zinc-50"
                    >
                      <Smile className="h-3.5 w-3.5" />
                      Emoji
                    </button>
                    {showEmojiPicker && (
                      <div className="absolute bottom-9 left-0 z-30">
                        <EmojiPicker
                          onEmojiClick={(emojiData: { emoji: string }) => {
                            const el = textareaRef.current
                            if (el) {
                              const start = el.selectionStart ?? message.length
                              const end = el.selectionEnd ?? start
                              const next = message.slice(0, start) + emojiData.emoji + message.slice(end)
                              setMessage(next)
                              requestAnimationFrame(() => {
                                el.focus()
                                el.setSelectionRange(start + emojiData.emoji.length, start + emojiData.emoji.length)
                              })
                            } else {
                              setMessage((prev) => prev + emojiData.emoji)
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
                  <button
                    onClick={handlePickFile}
                    disabled={!!file}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border hover:bg-zinc-50 disabled:opacity-40"
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    Attach
                  </button>
                  <button
                    onClick={handleSuggest}
                    disabled={suggesting}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-40"
                  >
                    {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    AI Suggest
                  </button>
                </div>
                <button
                  onClick={handleOpenConfirm}
                  disabled={!message.trim() || uploading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" />
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div className="px-6 py-4 space-y-3">
              <p className="text-sm text-zinc-500">Sending to</p>
              <p className="text-sm font-medium">{name} · {phone}</p>
              <div className="bg-zinc-50 rounded-lg p-3 text-sm whitespace-pre-wrap break-words">
                {message}
              </div>
              {file && (
                <p className="text-xs text-zinc-500 flex items-center gap-1">
                  <Paperclip className="h-3 w-3" /> Attaching: {file.name}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setConfirming(false)}
                  className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
                >
                  Edit
                </button>
                <button
                  onClick={handleConfirmSend}
                  disabled={sendMutation.isPending}
                  className="px-4 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Confirm & Send
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
