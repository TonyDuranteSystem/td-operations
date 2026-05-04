'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import {
  Send, Loader2, Users, Paperclip, Smile, Wand2, Mic, MicOff,
  FileText, X, CornerUpLeft, Trash2, CheckCheck, Check, Settings,
} from 'lucide-react'
import { useNotificationSound, SOUND_LIBRARY, SOUND_NONE, getSenderSoundId, setSenderSoundId } from '@/lib/hooks/use-notification-sound'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import EmojiPicker from 'emoji-picker-react'
import { format, isToday, isYesterday } from 'date-fns'
import { cn } from '@/lib/utils'
import type { ChatAttachment } from '@/lib/types'

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-orange-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-amber-500', 'bg-indigo-500',
]

function senderColor(senderId: string): string {
  let h = 0
  for (let i = 0; i < senderId.length; i++) { h = (h << 5) - h + senderId.charCodeAt(i); h |= 0 }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')
}

function formatMsgTime(ts: string): string {
  const d = new Date(ts)
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`
  return format(d, 'MMM d, HH:mm')
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface ReplyPreview {
  id: string
  message: string
  sender_name: string
  deleted_at: string | null
}

interface InternalMsg {
  id: string
  sender_id: string
  sender_name: string
  message: string
  created_at: string
  read_at: string | null
  seen_at: string | null
  attachment_url: string | null
  attachment_name: string | null
  attachments: ChatAttachment[] | null
  reply_to_id: string | null
  reply_to_preview: ReplyPreview | null
  deleted_at: string | null
  deleted_by: string | null
}

interface PendingFile { file: File; previewUrl?: string }

const MAX_FILES = 5
const ALLOWED_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export default function TeamChatPage() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [currentUserIsAdmin, setCurrentUserIsAdmin] = useState(false)
  const [messages, setMessages] = useState<InternalMsg[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState<InternalMsg | null>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showSoundSettings, setShowSoundSettings] = useState(false)
  const [senderSounds, setSenderSounds] = useState<Record<string, string>>({})

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { playSenderSound, previewSound } = useNotificationSound()

  const { isRecording, isTranscribing, startRecording, stopRecording, isSupported: voiceSupported } =
    useVoiceInput({
      language: 'en-US',
      onTranscript: (t) => setText(prev => prev ? `${prev} ${t}` : t),
      onError: (msg) => toast.error(msg),
    })

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior })
  }, [])

  // Detect mobile (touch device)
  useEffect(() => {
    setIsMobile(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  // Load per-sender sound prefs from localStorage when we first know who the other senders are
  useEffect(() => {
    if (!currentUserId || messages.length === 0) return
    const senderIds = Array.from(new Set(messages.filter(m => m.sender_id !== currentUserId).map(m => m.sender_id)))
    if (senderIds.length === 0) return
    const sounds: Record<string, string> = {}
    for (const id of senderIds) {
      sounds[id] = getSenderSoundId(id) ?? ''
    }
    setSenderSounds(sounds)
  }, [currentUserId, messages.length]) // eslint-disable-line react-hooks/exhaustive-deps


  // Auto-grow textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.max(44, Math.min(el.scrollHeight, 300)) + 'px'
  }, [text])

  // Close emoji picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Initial load
  useEffect(() => {
    fetch('/api/team-chat')
      .then(r => {
        if (!r.ok) throw new Error('Failed to load team chat')
        return r.json()
      })
      .then(data => {
        setThreadId(data.thread_id)
        setCurrentUserId(data.current_user_id)
        setCurrentUserIsAdmin(data.is_admin ?? false)
        setMessages(data.messages)
      })
      .catch(() => toast.error('Failed to load team chat'))
      .finally(() => setLoading(false))
  }, [])

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && messages.length > 0) scrollToBottom('instant')
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime subscription (INSERT + UPDATE)
  useEffect(() => {
    if (!threadId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`team-chat-${threadId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'internal_messages', filter: `thread_id=eq.${threadId}` }, (payload) => {
        const msg = payload.new as InternalMsg
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev
          return [...prev, { ...msg, reply_to_preview: null }]
        })
        // Use session directly — avoids any React state/ref timing issues
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (session?.user && msg.sender_id !== session.user.id) {
            playSenderSound(msg.sender_id)
            // Mark as seen (fire and forget)
            fetch(`/api/internal/threads/${threadId}`, { method: 'GET' }).catch(() => {})
          }
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'internal_messages', filter: `thread_id=eq.${threadId}` }, (payload) => {
        const updated = payload.new as InternalMsg
        setMessages(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m))
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [threadId, playSenderSound])

  // Scroll on new messages
  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  // File selection
  const handleFileSelect = useCallback((file: File) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error(`File type not allowed (${file.type || 'unknown'})`)
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max 10 MB.`)
      return
    }
    setPendingFiles(prev => {
      if (prev.length >= MAX_FILES) { toast.error(`Max ${MAX_FILES} files per message.`); return prev }
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = e => setPendingFiles(p => [...p, { file, previewUrl: e.target?.result as string }])
        reader.readAsDataURL(file)
        return prev
      }
      return [...prev, { file }]
    })
  }, [])

  const handleSend = useCallback(async () => {
    const msg = text.trim()
    if ((!msg && pendingFiles.length === 0) || !threadId || sending || uploadingFiles) return
    if (isRecording) stopRecording()
    if (inputRef.current) inputRef.current.style.height = 'auto'

    setSending(true)
    const sentText = msg
    const sentReplyTo = replyTo
    setText('')
    setReplyTo(null)
    const filesToUpload = [...pendingFiles]
    setPendingFiles([])

    try {
      let attachments: ChatAttachment[] | null = null
      if (filesToUpload.length > 0) {
        setUploadingFiles(true)
        try {
          attachments = await Promise.all(filesToUpload.map(async (pf) => {
            const fd = new FormData()
            fd.append('file', pf.file)
            const res = await fetch(`/api/internal/threads/${threadId}/upload`, { method: 'POST', body: fd })
            if (!res.ok) {
              const d = await res.json().catch(() => ({}))
              throw new Error(d.error || 'Upload failed')
            }
            return await res.json() as ChatAttachment
          }))
        } finally {
          setUploadingFiles(false)
        }
      }

      const res = await fetch(`/api/internal/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: sentText,
          reply_to_id: sentReplyTo?.id ?? null,
          attachments,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to send')
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to send message')
      setText(sentText)
      setReplyTo(sentReplyTo)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [text, threadId, sending, uploadingFiles, replyTo, pendingFiles, isRecording, stopRecording])

  const handlePolish = async () => {
    if (!text.trim() || polishing) return
    setPolishing(true)
    try {
      const res = await fetch('/api/internal/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Polish failed')
      }
      const data = await res.json()
      if (data.polished) setText(data.polished)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'AI Polish failed')
    } finally {
      setPolishing(false)
    }
  }

  const handleDelete = async (msgId: string) => {
    if (confirmDeleteId !== msgId) {
      setConfirmDeleteId(msgId)
      if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current)
      confirmDeleteTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000)
      return
    }
    // Second click = confirmed
    setConfirmDeleteId(null)
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current)

    // Optimistic update
    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, deleted_at: new Date().toISOString(), deleted_by: currentUserId } : m))

    const res = await fetch(`/api/internal/threads/${threadId}/messages/${msgId}`, { method: 'DELETE' })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      toast.error(d.error || 'Failed to delete message')
      // Revert
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, deleted_at: null, deleted_by: null } : m))
    }
  }

  // Members for the sound picker — derived directly from message history (no API needed)
  const pickerMembers = Array.from(
    new Map(
      messages
        .filter(m => m.sender_id !== currentUserId && m.sender_id)
        .map(m => [m.sender_id, m.sender_name])
    ).entries()
  ).map(([id, name]) => ({ id, name }))

  // For read receipt: find last message sent by me
  const lastSentMsgId = [...messages].reverse().find(m => m.sender_id === currentUserId && !m.deleted_at)?.id

  // Group consecutive messages by sender
  const grouped = messages.reduce<Array<{ senderId: string; senderName: string; msgs: InternalMsg[] }>>((acc, msg) => {
    const last = acc[acc.length - 1]
    if (last && last.senderId === msg.sender_id) { last.msgs.push(msg) }
    else { acc.push({ senderId: msg.sender_id, senderName: msg.sender_name, msgs: [msg] }) }
    return acc
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-zinc-100 rounded-lg">
            <Users className="h-5 w-5 text-zinc-600" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-zinc-900">Team Chat</h1>
            <p className="text-xs text-zinc-500">Internal — not visible to clients</p>
          </div>
        </div>
        {!loading && (
          <button
            onClick={() => setShowSoundSettings(v => !v)}
            className={cn(
              'p-2 rounded-lg transition-colors text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100',
              showSoundSettings && 'bg-zinc-100 text-zinc-700'
            )}
            title="Notification sounds"
          >
            <Settings className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Sound settings panel */}
      {showSoundSettings && (
        <div className="shrink-0 px-4 py-3 border-b border-zinc-100 bg-zinc-50">
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide mb-3">Notification sounds</p>
          {pickerMembers.length === 0 ? (
            <p className="text-xs text-zinc-400">No team messages yet — sounds will appear here once a teammate writes.</p>
          ) : (
          <div className="flex flex-col gap-3">
            {pickerMembers.map(({ id, name }) => {
              const currentSoundId = senderSounds[id] ?? ''
              return (
                <div key={id} className="flex items-start gap-3">
                  <div className="flex items-center gap-2 w-24 shrink-0 pt-0.5">
                    <div className={`w-6 h-6 rounded-full ${senderColor(id)} flex items-center justify-center text-[9px] font-bold text-white shrink-0`}>
                      {initials(name)}
                    </div>
                    <span className="text-xs text-zinc-700 font-medium truncate">{name.split(' ')[0]}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SOUND_LIBRARY.map(s => (
                      <button
                        key={s.id}
                        onClick={() => {
                          previewSound(s.id)
                          setSenderSoundId(id, s.id)
                          setSenderSounds(prev => ({ ...prev, [id]: s.id }))
                        }}
                        className={cn(
                          'text-[11px] px-2.5 py-0.5 rounded-full border transition-colors',
                          currentSoundId === s.id
                            ? 'bg-zinc-800 text-white border-zinc-800'
                            : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-400 hover:text-zinc-800'
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setSenderSoundId(id, SOUND_NONE)
                        setSenderSounds(prev => ({ ...prev, [id]: SOUND_NONE }))
                      }}
                      className={cn(
                        'text-[11px] px-2.5 py-0.5 rounded-full border transition-colors',
                        currentSoundId === SOUND_NONE
                          ? 'bg-zinc-800 text-white border-zinc-800'
                          : 'bg-white text-zinc-400 border-zinc-200 hover:border-zinc-400 hover:text-zinc-600'
                      )}
                    >
                      Silent
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-2">
            <Users className="h-10 w-10" />
            <p className="text-sm">No messages yet. Say hi!</p>
          </div>
        ) : (
          grouped.map((group, gi) => {
            const isMe = group.senderId === currentUserId
            return (
              <div key={gi} className={`flex gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'} items-end mb-2`}>
                {!isMe && (
                  <div className={`w-7 h-7 rounded-full ${senderColor(group.senderId)} flex items-center justify-center text-[10px] font-bold text-white shrink-0 mb-1`}>
                    {initials(group.senderName)}
                  </div>
                )}
                <div className={`flex flex-col gap-0.5 max-w-[72%] ${isMe ? 'items-end' : 'items-start'}`}>
                  {!isMe && (
                    <span className="text-[11px] font-semibold text-zinc-500 px-1">{group.senderName}</span>
                  )}
                  {group.msgs.map((msg, mi) => {
                    const isLast = mi === group.msgs.length - 1
                    const isDeleted = !!msg.deleted_at
                    const attachments = msg.attachments?.length ? msg.attachments : (msg.attachment_url ? [{ url: msg.attachment_url, name: msg.attachment_name ?? 'file' }] : [])

                    return (
                      <div key={msg.id} className="flex flex-col gap-0.5 w-full">
                        {/* Reply preview */}
                        {msg.reply_to_preview && !isDeleted && (
                          <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                            <div className={`text-[11px] px-2 py-1 rounded-lg border-l-2 max-w-[90%] truncate ${isMe ? 'bg-zinc-100 border-zinc-400 text-zinc-500' : 'bg-zinc-50 border-zinc-300 text-zinc-500'}`}>
                              <span className="font-semibold">{msg.reply_to_preview.sender_name}: </span>
                              {msg.reply_to_preview.deleted_at ? 'Message deleted' : msg.reply_to_preview.message.slice(0, 80)}
                            </div>
                          </div>
                        )}

                        {/* Bubble + actions */}
                        <div className={`flex items-end gap-1 group ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                          {/* Delete button (admin only, on hover) */}
                          {currentUserIsAdmin && !isDeleted && (
                            <button
                              onClick={() => handleDelete(msg.id)}
                              className={cn(
                                'opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full shrink-0',
                                confirmDeleteId === msg.id
                                  ? 'opacity-100 text-red-600 bg-red-100'
                                  : 'text-zinc-400 hover:text-red-500 hover:bg-zinc-100'
                              )}
                              title={confirmDeleteId === msg.id ? 'Click again to confirm' : 'Delete message'}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}

                          {/* Reply button (on hover) */}
                          {!isDeleted && (
                            <button
                              onClick={() => { setReplyTo(msg); inputRef.current?.focus() }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 shrink-0"
                              title="Reply"
                            >
                              <CornerUpLeft className="h-3.5 w-3.5" />
                            </button>
                          )}

                          {/* Message bubble */}
                          <div
                            className={cn(
                              'px-3 py-2 rounded-2xl text-sm leading-relaxed max-w-full',
                              isMe ? 'bg-zinc-800 text-white rounded-br-sm' : 'bg-white border border-zinc-200 text-zinc-900 rounded-bl-sm shadow-sm',
                              isDeleted && 'opacity-60 italic'
                            )}
                            style={{ wordBreak: 'break-word' }}
                          >
                            {isDeleted ? (
                              <span className="text-zinc-400 text-xs">🗑 Message deleted</span>
                            ) : (
                              <>
                                {msg.message && <p className="whitespace-pre-wrap">{msg.message}</p>}
                                {/* Attachments */}
                                {attachments.length > 0 && (
                                  <div className={cn('flex flex-col gap-1', msg.message && 'mt-1.5')}>
                                    {attachments.map((att, ai) => {
                                      const isImage = att.url && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(att.url)
                                      return isImage ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img key={ai} src={att.url} alt={att.name} className="max-w-[220px] rounded-lg border border-zinc-200 object-cover cursor-pointer" onClick={() => window.open(att.url, '_blank')} />
                                      ) : (
                                        <a key={ai} href={att.url} target="_blank" rel="noopener noreferrer" className={cn('flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs', isMe ? 'bg-white/10 hover:bg-white/20' : 'bg-zinc-100 hover:bg-zinc-200')}>
                                          <FileText className="h-3.5 w-3.5 shrink-0" />
                                          <span className="truncate max-w-[160px]">{att.name}</span>
                                        </a>
                                      )
                                    })}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </div>

                        {/* Timestamp + read receipt */}
                        {isLast && (
                          <div className={`flex items-center gap-1 px-1 ${isMe ? 'justify-end' : 'justify-start'}`}>
                            <span className="text-[10px] text-zinc-400">{formatMsgTime(msg.created_at)}</span>
                            {isMe && !isDeleted && msg.id === lastSentMsgId && (
                              <span title={msg.seen_at ? 'Seen' : 'Sent'}>
                                {msg.seen_at
                                  ? <CheckCheck className="h-3 w-3 text-blue-500" />
                                  : <Check className="h-3 w-3 text-zinc-400" />
                                }
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply bar */}
      {replyTo && (
        <div className="shrink-0 px-4 py-2 border-t border-zinc-100 bg-zinc-50 flex items-center gap-2">
          <CornerUpLeft className="h-4 w-4 text-zinc-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-zinc-500">{replyTo.sender_name}</p>
            <p className="text-xs text-zinc-600 truncate">{replyTo.message.slice(0, 80) || '📎 Attachment'}</p>
          </div>
          <button onClick={() => setReplyTo(null)} className="p-1 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 shrink-0">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* File preview strip */}
      {pendingFiles.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-t border-zinc-100 bg-zinc-50">
          <div className="flex flex-wrap gap-2">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="flex items-center gap-2 bg-white border border-zinc-200 rounded-lg px-2 py-1.5 max-w-[200px]">
                {pf.previewUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={pf.previewUrl} alt={pf.file.name} className="h-8 w-8 rounded object-cover shrink-0" />
                  : <div className="h-8 w-8 rounded bg-zinc-100 flex items-center justify-center shrink-0"><FileText className="h-4 w-4 text-zinc-400" /></div>
                }
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-zinc-700 truncate">{pf.file.name}</p>
                  <p className="text-[10px] text-zinc-400">{formatFileSize(pf.file.size)}</p>
                </div>
                <button onClick={() => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))} className="p-0.5 rounded-full text-zinc-400 hover:text-zinc-600 shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-zinc-400 mt-1">{pendingFiles.length}/{MAX_FILES} files</p>
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0 px-4 py-3 border-t border-zinc-200 bg-white">
        <div className="flex items-end gap-2">
          {/* Pill */}
          <div className="flex items-end flex-1 min-w-0 bg-white border border-zinc-200 rounded-[24px] px-1 py-1 gap-0.5 min-h-[48px]">
            {/* Emoji */}
            <div className="relative shrink-0" ref={emojiPickerRef}>
              <button onClick={() => setShowEmojiPicker(v => !v)} className="p-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors" title="Emoji">
                <Smile className="h-5 w-5" />
              </button>
              {showEmojiPicker && (
                <div className="absolute bottom-12 left-0 z-30">
                  <EmojiPicker
                    onEmojiClick={(emojiData: { emoji: string }) => {
                      const el = inputRef.current
                      if (el) {
                        const start = el.selectionStart ?? text.length
                        const end = el.selectionEnd ?? start
                        setText(text.slice(0, start) + emojiData.emoji + text.slice(end))
                        setShowEmojiPicker(false)
                        requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + emojiData.emoji.length, start + emojiData.emoji.length) })
                      } else {
                        setText(prev => prev + emojiData.emoji)
                        setShowEmojiPicker(false)
                      }
                    }}
                    width={320}
                    height={400}
                    lazyLoadEmojis
                    skinTonesDisabled
                    previewConfig={{ showPreview: false }}
                  />
                </div>
              )}
            </div>

            {/* Paperclip */}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploadingFiles}
              className={cn('p-2 rounded-full transition-colors shrink-0', pendingFiles.length > 0 ? 'text-blue-600 bg-blue-100' : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100')}
              title="Attach file"
            >
              {uploadingFiles ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ALLOWED_TYPES.join(',')}
              onChange={e => { Array.from(e.target.files ?? []).forEach(f => handleFileSelect(f)); e.target.value = '' }}
              className="hidden"
            />

            {/* Textarea */}
            <textarea
              ref={inputRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); handleSend() } }}
              placeholder={isRecording ? 'Recording…' : isTranscribing ? 'Transcribing…' : 'Message team…'}
              rows={1}
              disabled={loading || !threadId}
              className="flex-1 min-w-0 px-1 py-2.5 text-base bg-transparent border-none focus:outline-none focus:ring-0 resize-none overflow-y-auto max-h-[300px] placeholder:text-zinc-400 disabled:opacity-50"
            />

            {/* Polish button */}
            {text.trim() && (
              <button
                onClick={handlePolish}
                disabled={polishing}
                className="p-2 rounded-full bg-violet-100 text-violet-600 hover:bg-violet-200 disabled:opacity-50 transition-colors shrink-0"
                title="AI Polish — fix grammar and clarity"
              >
                {polishing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}
              </button>
            )}
          </div>

          {/* Voice / Send button */}
          {sending || uploadingFiles ? (
            <button disabled className="w-12 h-12 rounded-full bg-zinc-800 text-white flex items-center justify-center shrink-0">
              <Loader2 className="h-5 w-5 animate-spin" />
            </button>
          ) : (text.trim() || pendingFiles.length > 0) ? (
            <button
              onClick={handleSend}
              disabled={uploadingFiles}
              className="w-12 h-12 rounded-full bg-zinc-800 text-white hover:bg-zinc-700 flex items-center justify-center shrink-0 transition-colors"
            >
              <Send className="h-5 w-5" />
            </button>
          ) : voiceSupported ? (
            <button
              onPointerDown={startRecording}
              onPointerUp={stopRecording}
              onPointerLeave={isRecording ? stopRecording : undefined}
              className={cn('w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-all', isRecording ? 'bg-red-500 text-white shadow-lg shadow-red-500/30 animate-pulse' : isTranscribing ? 'bg-violet-500 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200')}
              title={isRecording ? 'Release to transcribe' : 'Hold for voice input'}
            >
              {isTranscribing ? <Loader2 className="h-5 w-5 animate-spin" /> : isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </button>
          ) : null}
        </div>

        <p className="text-[10px] text-zinc-400 mt-1 px-1">
          {isMobile ? 'Tap send to send • Hold mic for voice' : 'Enter to send • Shift+Enter for newline • Hold mic for voice'}
        </p>
      </div>
    </div>
  )
}
