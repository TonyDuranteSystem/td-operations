'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Send, Loader2, MessageCircle, Paperclip, FileText, ExternalLink, Mic, Square,
  CheckCheck, Reply, X, ZoomIn, Smile, Pin, MailOpen, Pencil, Trash2, Check,
} from 'lucide-react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { format, parseISO, isToday, isYesterday } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { isOwnMessage } from '@/lib/td-communication/helpers'
import { uploadCommAttachment, validateChatAttachment } from '@/lib/td-communication/upload-attachment'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import type { CommAttachment, CommMessage, CommParticipant } from '@/lib/td-communication/types'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

const MAX_ATTACHMENTS = 5
const URL_PATTERN = /(https?:\/\/[^\s]+)/

function isImageUrl(url: string): boolean {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || ''
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)
}
function formatFileSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
function formatMessageDate(dateStr: string): string {
  const d = parseISO(dateStr)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'MMMM d, yyyy')
}
function formatTime(dateStr: string): string {
  try { return format(parseISO(dateStr), 'MMM d, h:mm a') } catch { return '' }
}
function toInternalPath(url: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const p = new URL(url)
    return p.origin === window.location.origin ? p.pathname + p.search + p.hash : null
  } catch { return null }
}
function renderMessageText(text: string, isOwn: boolean) {
  const linkClass = cn('underline underline-offset-2 break-all', isOwn ? 'text-blue-100 hover:text-white' : 'text-blue-600 hover:text-blue-800')
  return text.split(URL_PATTERN).map((part, i) => {
    if (!URL_PATTERN.test(part)) return part
    const internal = toInternalPath(part)
    if (internal) return <Link key={i} href={internal} className={linkClass}>{part}</Link>
    return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className={linkClass}>{part}</a>
  })
}

interface PendingFile { file: File; previewUrl?: string }

/**
 * Realtime conversation chat for TD Communication — feature parity with the
 * portal chat: attachments, emoji, voice, replies, edit, soft-delete, pin,
 * keep-unread, read receipts, drafts, date headers, jump-to-latest.
 */
export function ConversationChat({ conversationId, viewer }: { conversationId: string; viewer: CommParticipant }) {
  const [messages, setMessages] = useState<CommMessage[]>([])
  const [loading, setLoading] = useState(true)
  const draftKey = `comm_draft_${conversationId}`
  const [input, setInput] = useState(() => {
    if (typeof window === 'undefined') return ''
    const d = localStorage.getItem(draftKey)
    if (d) { localStorage.removeItem(draftKey); return d }
    return ''
  })
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [replyTo, setReplyTo] = useState<CommMessage | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [micConsented, setMicConsented] = useState(false)
  const [pinHighlightId, setPinHighlightId] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const emojiRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const isStaff = viewer.type === 'staff'

  // ── Load + realtime ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true); setMessages([])
    ;(async () => {
      try {
        const res = await fetch(`/api/conversations/messages?conversation_id=${encodeURIComponent(conversationId)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Failed to load messages.')
        if (!cancelled) setMessages((data.messages ?? []) as CommMessage[])
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error && err.message ? err.message : 'Failed to load messages.')
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [conversationId])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`comm-${conversationId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comm_messages', filter: `conversation_id=eq.${conversationId}` }, (p) => {
        const m = p.new as CommMessage
        if (m.deleted_at && !isStaff) return
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'comm_messages', filter: `conversation_id=eq.${conversationId}` }, (p) => {
        const m = p.new as CommMessage
        setMessages((prev) => {
          if (m.deleted_at && !isStaff) return prev.filter((x) => x.id !== m.id)
          const i = prev.findIndex((x) => x.id === m.id)
          if (i === -1) return m.deleted_at && !isStaff ? prev : [...prev, m]
          const next = [...prev]; next[i] = m; return next
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [conversationId, isStaff])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => { scrollToBottom() }, [messages, loading, scrollToBottom])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.max(44, Math.min(el.scrollHeight, 200)) + 'px'
  }, [input])

  useEffect(() => {
    const h = () => { if (input.trim()) localStorage.setItem(draftKey, input) }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [input, draftKey])

  useEffect(() => {
    if (!showEmojiPicker) return
    const h = (e: MouseEvent) => { if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) setShowEmojiPicker(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showEmojiPicker])

  useEffect(() => { if (typeof window !== 'undefined') setMicConsented(localStorage.getItem('mic_consent') === 'yes') }, [])

  const handleTranscript = useCallback((t: string) => {
    setInput((prev) => (prev ? prev + ' ' + t : t).trim()); inputRef.current?.focus()
  }, [])
  const { isRecording, isTranscribing, startRecording, stopRecording, isSupported: micSupported } =
    useVoiceInput({ language: 'en-US', onTranscript: handleTranscript, onError: (m) => toast.error(m) })

  // ── Send ───────────────────────────────────────────────────────────
  const doSend = useCallback(async () => {
    if ((!input.trim() && pendingFiles.length === 0) || sending || uploading) return
    if (isRecording) stopRecording()
    stickRef.current = true
    const text = input
    const files = pendingFiles
    const reply = replyTo?.id ?? null
    setInput(''); setReplyTo(null); setPendingFiles([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setSending(true)
    try {
      let uploaded: CommAttachment[] = []
      if (files.length) {
        setUploading(true)
        try { uploaded = await Promise.all(files.map((pf) => uploadCommAttachment(pf.file, conversationId))) }
        finally { setUploading(false) }
      }
      const res = await fetch('/api/conversations/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, body: text, attachments: uploaded, reply_to_id: reply }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to send message.')
      const sent = data.message as CommMessage
      setMessages((prev) => (prev.some((x) => x.id === sent.id) ? prev : [...prev, sent]))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to send message.')
      setInput(text); setPendingFiles(files)
    } finally { setSending(false); inputRef.current?.focus() }
  }, [input, pendingFiles, sending, uploading, isRecording, stopRecording, replyTo, conversationId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() }
  }

  // ── Per-message actions ────────────────────────────────────────────
  const post = async (url: string, body: object, method = 'POST') => {
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Action failed.') }
    } catch (err) { toast.error(err instanceof Error && err.message ? err.message : 'Action failed.') }
  }
  const togglePin = (m: CommMessage) => post(`/api/conversations/message/${m.id}/pin`, { pinned: !m.pinned_at })
  const toggleKeepUnread = (m: CommMessage) => post(`/api/conversations/message/${m.id}/keep-unread`, { kept: !m.kept_unread })
  const deleteMessage = async (m: CommMessage) => {
    if (!window.confirm('Delete this message?')) return
    await post(`/api/conversations/message/${m.id}`, {}, 'DELETE')
  }
  const startEdit = (m: CommMessage) => { setEditingId(m.id); setEditingText(m.body) }
  const saveEdit = async () => {
    if (!editingId) return
    const text = editingText.trim()
    if (!text) return
    await post(`/api/conversations/message/${editingId}`, { message: text }, 'PATCH')
    setEditingId(null); setEditingText('')
  }

  const scrollToMsg = (id: string) => {
    document.getElementById(`comm-msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setPinHighlightId(id); window.setTimeout(() => setPinHighlightId(null), 2500)
  }

  // ── Attachments ────────────────────────────────────────────────────
  const addFile = (file: File) => {
    const err = validateChatAttachment(file.name, file.size, file.type)
    if (err) { toast.error(err); return }
    setPendingFiles((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) { toast.error(`Maximum ${MAX_ATTACHMENTS} files per message.`); return prev }
      if (file.type.startsWith('image/')) {
        const r = new FileReader()
        r.onload = (e) => setPendingFiles((p) => [...p, { file, previewUrl: e.target?.result as string }])
        r.readAsDataURL(file); return prev
      }
      return [...prev, { file }]
    })
  }
  const handleMic = () => {
    if (isRecording) { stopRecording(); return }
    if (!micConsented) {
      if (!window.confirm('To use voice input, your audio is recorded and sent for transcription, then deleted. Continue?')) return
      localStorage.setItem('mic_consent', 'yes'); setMicConsented(true)
    }
    startRecording()
  }

  const onScroll = () => {
    const sc = scrollRef.current; if (!sc) return
    const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight
    stickRef.current = dist <= 120
    setShowJump(dist > 200)
  }

  const pinned = messages.filter((m) => m.pinned_at && !m.deleted_at)
  let lastDate = ''

  return (
    <div
      className="flex flex-col flex-1 min-h-0 bg-white rounded-xl border shadow-sm overflow-hidden relative"
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false) }}
      onDrop={(e) => { e.preventDefault(); setIsDragging(false); Array.from(e.dataTransfer.files).forEach(addFile) }}
    >
      {isDragging && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 rounded-xl pointer-events-none">
          <Paperclip className="h-10 w-10 text-blue-400 mb-2" />
          <p className="text-sm font-medium text-blue-600">Drop file to attach</p>
        </div>
      )}

      {pinned.length > 0 && (
        <div className="border-b bg-amber-50/80 px-3 py-1.5">
          <div className="flex items-center gap-1 mb-0.5"><Pin className="h-3 w-3 text-amber-600" /><span className="text-[11px] font-medium text-amber-700">Pinned ({pinned.length})</span></div>
          <div className="space-y-0.5 max-h-24 overflow-y-auto">
            {pinned.map((pm) => (
              <div key={pm.id} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-amber-100/60">
                <button onClick={() => scrollToMsg(pm.id)} className="flex items-start gap-1.5 text-xs text-zinc-700 flex-1 min-w-0 text-left">
                  <Pin className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                  <span className="truncate flex-1">{pm.body || '[Attachment]'}</span>
                </button>
                <button onClick={() => togglePin(pm)} className="shrink-0 text-zinc-400 hover:text-red-600" title="Unpin"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400">
            <MessageCircle className="h-12 w-12 mb-3" />
            <p className="text-sm font-medium">No messages yet</p>
            <p className="text-xs mt-1">Send a message to start the conversation</p>
          </div>
        ) : messages.map((m) => {
          const own = isOwnMessage(m, viewer.type, viewer.id)
          const dateHeader = formatMessageDate(m.created_at)
          const showDate = dateHeader !== lastDate
          lastDate = dateHeader
          const replyMsg = m.reply_to_id ? messages.find((x) => x.id === m.reply_to_id) : null
          const atts: CommAttachment[] = m.attachments?.length ? m.attachments : (m.attachment_url ? [{ url: m.attachment_url, name: m.attachment_name || 'Attachment' }] : [])
          const images = atts.filter((a) => isImageUrl(a.url))
          const docs = atts.filter((a) => !isImageUrl(a.url))
          const tombstone = !!m.deleted_at

          return (
            <div key={m.id} id={`comm-msg-${m.id}`} className={cn('group scroll-mt-4', pinHighlightId === m.id && 'rounded-lg ring-2 ring-amber-400')}>
              {showDate && (
                <div className="flex items-center justify-center my-4">
                  <span className="text-[10px] text-zinc-400 bg-zinc-100 px-3 py-1 rounded-full">{dateHeader}</span>
                </div>
              )}
              <div className={cn('flex mb-1 items-end gap-1', own ? 'justify-end' : 'justify-start')}>
                {own && !tombstone && editingId !== m.id && (
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => togglePin(m)} className={cn('p-1 rounded-full hover:bg-zinc-100', m.pinned_at ? 'text-amber-500' : 'text-zinc-300 hover:text-zinc-600')} title={m.pinned_at ? 'Unpin' : 'Pin'}><Pin className={cn('h-3.5 w-3.5', m.pinned_at && 'fill-amber-400')} /></button>
                    {atts.length === 0 && <button onClick={() => startEdit(m)} className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100" title="Edit"><Pencil className="h-3.5 w-3.5" /></button>}
                    <button onClick={() => deleteMessage(m)} className="p-1 rounded-full text-zinc-300 hover:text-red-600 hover:bg-zinc-100" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => setReplyTo(m)} className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100" title="Reply"><Reply className="h-3.5 w-3.5" /></button>
                  </div>
                )}
                <div className={cn('max-w-[78%] px-3.5 py-2 rounded-2xl text-sm', own ? 'bg-blue-600 text-white rounded-br-md' : 'bg-zinc-100 text-zinc-900 rounded-bl-md', m.kept_unread && 'ring-2 ring-blue-300')}>
                  {!own && <p className="text-[10px] font-medium text-zinc-500 mb-0.5">{m.sender_name || (m.sender_type === 'staff' ? 'TD Team' : 'Partner')}</p>}
                  {tombstone ? (
                    <p className="italic text-xs opacity-70">Message deleted{isStaff && m.deleted_at ? ` · ${formatTime(m.deleted_at)}` : ''}</p>
                  ) : editingId === m.id ? (
                    <div className="space-y-1">
                      <textarea value={editingText} onChange={(e) => setEditingText(e.target.value)} rows={2}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === 'Escape') setEditingId(null) }}
                        className="w-full text-sm text-zinc-900 rounded-lg px-2 py-1 border border-blue-300 outline-none resize-none" autoFocus />
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => setEditingId(null)} className="px-2 py-0.5 text-[11px] rounded bg-white/20 hover:bg-white/30">Cancel</button>
                        <button onClick={saveEdit} className="px-2 py-0.5 text-[11px] rounded bg-white text-blue-700 font-medium inline-flex items-center gap-1"><Check className="h-3 w-3" />Save</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {replyMsg && (
                        <div className={cn('px-2.5 py-1.5 rounded-lg text-xs mb-1.5 border-l-2', own ? 'bg-blue-500/30 border-blue-300 text-blue-100' : 'bg-zinc-200 border-zinc-400 text-zinc-600')}>
                          <p className="font-medium text-[10px] mb-0.5">{replyMsg.sender_name || 'Reply'}</p>
                          <p className="line-clamp-2">{replyMsg.body || '[Attachment]'}</p>
                        </div>
                      )}
                      {images.length > 0 && (
                        <div className={cn('grid gap-1 mb-1', images.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
                          {images.slice(0, 4).map((a, i) => (
                            <button key={i} onClick={() => setLightboxUrl(a.url)} className="relative group/img rounded-lg overflow-hidden block">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={a.url} alt={a.name} className="w-full max-w-[200px] rounded-lg object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 flex items-center justify-center"><ZoomIn className="h-5 w-5 text-white opacity-0 group-hover/img:opacity-100" /></div>
                            </button>
                          ))}
                        </div>
                      )}
                      {docs.map((a, i) => (
                        <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className={cn('flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-1', own ? 'bg-blue-500/30 hover:bg-blue-500/40' : 'bg-zinc-200 hover:bg-zinc-300')}>
                          <FileText className="h-3.5 w-3.5 shrink-0" /><span className="truncate flex-1">{a.name}</span>
                          {a.size ? <span className="text-[10px] opacity-60 shrink-0">{formatFileSize(a.size)}</span> : null}
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      ))}
                      {m.body && <p className="whitespace-pre-wrap break-words">{renderMessageText(m.body, own)}</p>}
                      <p className={cn('text-[10px] mt-1 flex items-center gap-1', own ? 'text-blue-200 justify-end' : 'text-zinc-400')}>
                        {formatTime(m.created_at)}
                        {m.edited_at && <span className="italic opacity-75">(edited)</span>}
                        {own && <CheckCheck className={cn('h-3 w-3', m.read_at ? 'text-blue-300' : 'text-blue-200/50')} />}
                      </p>
                    </>
                  )}
                </div>
                {!own && !tombstone && (
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => setReplyTo(m)} className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100" title="Reply"><Reply className="h-3.5 w-3.5" /></button>
                    <button onClick={() => togglePin(m)} className={cn('p-1 rounded-full hover:bg-zinc-100', m.pinned_at ? 'text-amber-500' : 'text-zinc-300 hover:text-zinc-600')} title={m.pinned_at ? 'Unpin' : 'Pin'}><Pin className={cn('h-3.5 w-3.5', m.pinned_at && 'fill-amber-400')} /></button>
                    <button onClick={() => toggleKeepUnread(m)} className={cn('p-1 rounded-full hover:bg-zinc-100', m.kept_unread ? 'text-blue-500' : 'text-zinc-300 hover:text-zinc-600')} title={m.kept_unread ? 'Mark read' : 'Mark unread'}><MailOpen className="h-3.5 w-3.5" /></button>
                    {isStaff && <button onClick={() => deleteMessage(m)} className="p-1 rounded-full text-zinc-300 hover:text-red-600 hover:bg-zinc-100" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {showJump && (
        <button onClick={() => { const sc = scrollRef.current; if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }) }}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 text-xs text-white bg-zinc-800 rounded-full shadow-lg hover:bg-zinc-700">↓ Latest</button>
      )}

      {(isRecording || isTranscribing) && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-100 flex items-center gap-2">
          {isRecording && (<><span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" /><span className="text-xs text-red-600 font-medium">Recording… tap mic to stop</span></>)}
          {isTranscribing && (<><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" /><span className="text-xs text-blue-600 font-medium">Transcribing…</span></>)}
        </div>
      )}

      {replyTo && (
        <div className="px-4 py-2 bg-blue-50 border-t border-blue-100 flex items-center gap-2">
          <Reply className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          <div className="flex-1 min-w-0"><p className="text-[10px] font-medium text-blue-600">{replyTo.sender_name || 'Reply'}</p><p className="text-xs text-blue-700 truncate">{replyTo.body || '[Attachment]'}</p></div>
          <button onClick={() => setReplyTo(null)} className="p-1 rounded-full hover:bg-blue-100 text-blue-400"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="px-4 py-2 border-t border-zinc-100 bg-zinc-50">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="relative shrink-0 group/pf">
                {pf.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={pf.previewUrl} alt={pf.file.name} className="h-14 w-14 rounded-lg object-cover border" />
                ) : (
                  <div className="h-14 w-14 rounded-lg border bg-white flex flex-col items-center justify-center gap-0.5"><FileText className="h-5 w-5 text-zinc-400" /><span className="text-[9px] text-zinc-400 truncate w-12 text-center px-1">{pf.file.name.split('.').pop()?.toUpperCase()}</span></div>
                )}
                <button onClick={() => { setPendingFiles((p) => p.filter((_, idx) => idx !== i)); if (fileRef.current) fileRef.current.value = '' }} className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-zinc-600 text-white flex items-center justify-center opacity-0 group-hover/pf:opacity-100"><X className="h-2.5 w-2.5" /></button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-zinc-400 mt-1">{pendingFiles.length}/{MAX_ATTACHMENTS} files</p>
        </div>
      )}

      <div className={cn('border-t p-2 sm:p-3', (replyTo || pendingFiles.length > 0) && 'border-t-0')}>
        <div className="flex items-end gap-2">
          <div className={cn('flex items-end flex-1 min-w-0 bg-white border border-zinc-200 rounded-[24px] px-1 sm:px-2 py-1 gap-0.5 min-h-[48px]', isRecording && 'border-red-300 bg-red-50/30')}>
            <div className="relative shrink-0" ref={emojiRef}>
              <button onClick={() => setShowEmojiPicker((v) => !v)} className="p-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100" title="Emoji"><Smile className="h-5 w-5" /></button>
              {showEmojiPicker && (
                <div className="absolute bottom-12 left-0 z-30">
                  <EmojiPicker onEmojiClick={(d: { emoji: string }) => {
                    const ref = inputRef.current
                    if (ref) { const s = ref.selectionStart ?? input.length; const e = ref.selectionEnd ?? s; setInput(input.slice(0, s) + d.emoji + input.slice(e)); requestAnimationFrame(() => { ref.focus(); ref.setSelectionRange(s + d.emoji.length, s + d.emoji.length) }) }
                    else setInput((p) => p + d.emoji)
                    setShowEmojiPicker(false)
                  }} width={320} height={400} lazyLoadEmojis skinTonesDisabled previewConfig={{ showPreview: false }} />
                </div>
              )}
            </div>
            <button onClick={() => fileRef.current?.click()} disabled={uploading} className={cn('p-2 rounded-full shrink-0', pendingFiles.length > 0 ? 'text-blue-600 bg-blue-100 hover:bg-blue-200' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-50')}>
              {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
            </button>
            <input ref={fileRef} type="file" multiple onChange={(e) => { Array.from(e.target.files ?? []).forEach(addFile) }} className="hidden" />
            <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} rows={1}
              placeholder={isRecording ? 'Recording…' : 'Type a message…'}
              className="flex-1 min-w-0 px-1 py-2.5 text-base bg-transparent border-none focus:outline-none focus:ring-0 resize-none overflow-y-auto max-h-[120px] placeholder:text-zinc-400" />
          </div>
          {sending ? (
            <button disabled className="w-12 h-12 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0"><Loader2 className="h-5 w-5 animate-spin" /></button>
          ) : (input.trim() || pendingFiles.length > 0) ? (
            <button onClick={doSend} disabled={uploading} className="w-12 h-12 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center shrink-0"><Send className="h-5 w-5" /></button>
          ) : isRecording ? (
            <button onClick={handleMic} className="w-12 h-12 rounded-full bg-red-500 text-white hover:bg-red-600 animate-pulse flex items-center justify-center shrink-0"><Square className="h-5 w-5 fill-current" /></button>
          ) : micSupported ? (
            <button onClick={handleMic} className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-600 hover:bg-blue-100 hover:text-blue-600 flex items-center justify-center shrink-0" title="Voice input"><Mic className="h-5 w-5" /></button>
          ) : (
            <button onClick={doSend} disabled className="w-12 h-12 rounded-full bg-blue-600 text-white opacity-50 flex items-center justify-center shrink-0"><Send className="h-5 w-5" /></button>
          )}
        </div>
      </div>

      {lightboxUrl && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightboxUrl(null)}>
          <button onClick={() => setLightboxUrl(null)} className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70"><X className="h-6 w-6" /></button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightboxUrl} alt="Full size" className="max-h-[90vh] max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
