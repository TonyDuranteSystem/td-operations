'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Loader2, MessageCircle, Paperclip, FileText, ExternalLink, Mic, Square, CheckCheck, ChevronUp, Reply, X, ZoomIn, Smile, RotateCw, ImageIcon, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePortalChat } from '@/lib/hooks/use-portal-chat'
import type { ChatAttachment } from '@/lib/types'
import { useLocale } from '@/lib/portal/use-locale'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { toast } from 'sonner'
import { format, parseISO, isToday, isYesterday } from 'date-fns'
import dynamic from 'next/dynamic'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

function isImageUrl(url: string): boolean {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || ''
  return ['jpg','jpeg','png','gif','webp','svg','heic','bmp'].includes(ext)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const MAX_FILE_SIZE_MB = 10
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024
const ALLOWED_EXT_LABEL = 'PDF, JPG, PNG, WEBP, GIF, DOC, DOCX, XLS, XLSX, TXT, CSV'
const MAX_ATTACHMENTS = 5

interface PendingFile {
  file: File
  previewUrl?: string // for images
}

function formatMessageDate(dateStr: string): string {
  const date = parseISO(dateStr)
  if (isToday(date)) return 'Today'
  if (isYesterday(date)) return 'Yesterday'
  return format(date, 'MMMM d, yyyy')
}

function formatTime(dateStr: string): string {
  return format(parseISO(dateStr), 'MMM d, h:mm a')
}

export function PortalChat({ accountId, contactId, userId, locale = 'en', accounts = [] }: { accountId?: string; contactId: string; userId: string; locale?: string; accounts?: { id: string; company_name: string }[] }) {
  const { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore, refresh, topics } = usePortalChat(null, contactId)
  // PR 2 Step 6 — sender_context picker. Defaults to "company" when an
  // account is currently viewed, else "person". Hidden entirely when the
  // contact has no accounts (formation-gap clients pre-materialization).
  // Per Antonio's design decision 2026-05-05: binary picker (Person /
  // current company), not a list of all the contact's companies.
  const [tagScope, setTagScope] = useState<'person' | 'company'>(accountId ? 'company' : 'person')
  const [activeTopic, setActiveTopic] = useState<string | null>(null)
  const [creatingTopic, setCreatingTopic] = useState(false)
  const [newTopicInput, setNewTopicInput] = useState('')
  const currentCompanyName = accounts.find(a => a.id === accountId)?.company_name ?? null
  const accountNameById = new Map(accounts.map(a => [a.id, a.company_name]))
  const personalLabel = locale === 'it' ? 'Personale' : 'Personal'
  const draftKey = `chat_draft_${accountId || contactId}`
  const [input, setInput] = useState(() => {
    if (typeof window === 'undefined') return ''
    const draft = localStorage.getItem(draftKey)
    if (draft) { localStorage.removeItem(draftKey); return draft }
    return ''
  })
  const [uploading, setUploading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [micConsented, setMicConsented] = useState(false)
  const [replyTo, setReplyTo] = useState<{ id: string; message: string; sender_type: string } | null>(null)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const { t } = useLocale()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)

  // Close emoji picker on click outside
  useEffect(() => {
    if (!showEmojiPicker) return
    const handler = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showEmojiPicker])

  // Check if mic consent was previously given
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setMicConsented(localStorage.getItem('mic_consent') === 'yes')
    }
  }, [])

  const speechLang = locale === 'it' ? 'it-IT' : 'en-US'

  const handleTranscript = useCallback((text: string) => {
    setInput(prev => (prev ? prev + ' ' + text : text).trim())
    inputRef.current?.focus()
  }, [])

  const {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    isSupported: micSupported,
  } = useVoiceInput({ language: speechLang, onTranscript: handleTranscript, onError: (msg) => toast.error(msg) })

  // Auto-grow textarea whenever input changes (typing, voice, paste)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    // Collapse to 0 first to get true scrollHeight
    el.style.height = '0px'
    const newHeight = Math.max(44, Math.min(el.scrollHeight, 300))
    el.style.height = newHeight + 'px'
  }, [input])

  // Save draft to localStorage before unload (preserves text during PWA update reload)
  useEffect(() => {
    const handler = () => { if (input.trim()) localStorage.setItem(draftKey, input) }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [input, draftKey])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await refresh()
    setIsRefreshing(false)
  }

  const handleSend = async () => {
    if ((!input.trim() && pendingFiles.length === 0) || sending || uploading) return
    if (isRecording) stopRecording()
    const msg = input
    const replyId = replyTo?.id
    const filesToSend = pendingFiles
    setInput('')
    setReplyTo(null)
    setPendingFiles([])
    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      if (filesToSend.length > 0) {
        setUploading(true)
        try {
          const uploaded = await Promise.all(filesToSend.map(async (pf) => {
            const formData = new FormData()
            formData.append('file', pf.file)
            formData.append('account_id', accountId || '')
            formData.append('contact_id', contactId)
            const res = await fetch('/api/portal/chat/upload', { method: 'POST', body: formData })
            if (!res.ok) {
              const data = await res.json().catch(() => ({}))
              throw new Error(data.error || 'Upload failed — please try again.')
            }
            return await res.json() as ChatAttachment
          }))
          await sendMessage(msg || '', uploaded, replyId, tagScope, accountId ?? null, activeTopic)
        } finally {
          setUploading(false)
        }
      } else {
        await sendMessage(msg, undefined, replyId, tagScope, accountId ?? null, activeTopic)
      }
    } catch (err) {
      const errMsg = err instanceof Error && err.message ? err.message : 'Failed to send message'
      toast.error(errMsg)
      setInput(msg)
    }
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileSelect = (file: File) => {
    const ALLOWED_TYPES = ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/csv','text/plain','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error(`File type not allowed (${file.type || 'unknown'}). Please use ${ALLOWED_EXT_LABEL}.`)
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`File too large: ${formatFileSize(file.size)}. Maximum allowed: ${MAX_FILE_SIZE_MB} MB.`)
      return
    }
    setPendingFiles(prev => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.error(`Maximum ${MAX_ATTACHMENTS} files per message.`)
        return prev
      }
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = e => setPendingFiles(p => [...p, { file, previewUrl: e.target?.result as string }])
        reader.readAsDataURL(file)
        return prev
      }
      return [...prev, { file }]
    })
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    Array.from(e.dataTransfer.files).forEach(file => handleFileSelect(file))
  }

  const handleMicToggle = () => {
    if (isRecording) {
      stopRecording()
    } else {
      if (!micConsented) {
        // Show consent notice
        const ok = window.confirm(
          locale === 'it'
            ? 'Per usare l\'input vocale, il tuo audio verrà registrato e inviato per la trascrizione. La registrazione viene eliminata subito dopo. Vuoi continuare?'
            : 'To use voice input, your audio will be recorded and sent for transcription. The recording is deleted immediately after. Continue?'
        )
        if (!ok) return
        localStorage.setItem('mic_consent', 'yes')
        setMicConsented(true)
      }
      startRecording()
    }
  }

  const filteredMessages = activeTopic
    ? messages.filter(m => m.topic === activeTopic)
    : messages.filter(m => !m.topic)

  // Group messages by date
  let lastDate = ''

  return (
    <div
      className="flex-1 min-h-0 flex flex-col bg-white rounded-xl border shadow-sm overflow-hidden relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Refresh button — replaces pull-to-refresh gesture on chat page */}
      <button
        onClick={handleRefresh}
        disabled={isRefreshing || loading}
        className="absolute top-2 right-2 z-10 p-1.5 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 transition-colors"
        title={locale === 'it' ? 'Aggiorna messaggi' : 'Refresh messages'}
      >
        <RotateCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
      </button>
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 rounded-xl pointer-events-none">
          <Paperclip className="h-10 w-10 text-blue-400 mb-2" />
          <p className="text-sm font-medium text-blue-600">Drop file to attach</p>
        </div>
      )}
      {/* Topic tabs — always visible. General = untagged messages. Named tabs = thread per topic. */}
      <div className="px-3 pt-2 pb-1 border-b border-zinc-100 flex items-center gap-1.5 overflow-x-auto">
        <button
          onClick={() => setActiveTopic(null)}
          className={cn(
            'shrink-0 px-2.5 py-1 text-[11px] rounded-full transition-colors border font-medium',
            activeTopic === null
              ? 'bg-zinc-900 text-white border-zinc-900'
              : 'text-zinc-600 border-zinc-200 hover:bg-zinc-100'
          )}
        >
          {locale === 'it' ? 'Generale' : 'General'}
        </button>
        {topics.map(tp => (
          <button
            key={tp}
            onClick={() => setActiveTopic(tp === activeTopic ? null : tp)}
            className={cn(
              'shrink-0 px-2.5 py-1 text-[11px] rounded-full transition-colors border font-medium',
              activeTopic === tp
                ? 'bg-blue-600 text-white border-blue-600'
                : 'text-zinc-600 border-zinc-200 hover:bg-zinc-100'
            )}
          >
            {tp}
          </button>
        ))}
        {creatingTopic ? (
          <input
            autoFocus
            type="text"
            value={newTopicInput}
            onChange={e => setNewTopicInput(e.target.value.slice(0, 100))}
            onKeyDown={e => {
              if (e.key === 'Enter' && newTopicInput.trim()) {
                setActiveTopic(newTopicInput.trim())
                setNewTopicInput('')
                setCreatingTopic(false)
              } else if (e.key === 'Escape') {
                setNewTopicInput('')
                setCreatingTopic(false)
              }
            }}
            onBlur={() => {
              if (newTopicInput.trim()) {
                setActiveTopic(newTopicInput.trim())
              }
              setNewTopicInput('')
              setCreatingTopic(false)
            }}
            placeholder={locale === 'it' ? 'Nome argomento…' : 'Topic name…'}
            className="shrink-0 px-2.5 py-1 text-[11px] rounded-full border border-blue-300 outline-none bg-white text-zinc-800 placeholder:text-zinc-400 w-32"
          />
        ) : (
          <button
            onClick={() => setCreatingTopic(true)}
            className="shrink-0 h-6 w-6 rounded-full border border-zinc-200 flex items-center justify-center text-zinc-400 hover:text-zinc-600 hover:border-zinc-400 transition-colors"
            title={locale === 'it' ? 'Nuovo argomento' : 'New topic'}
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400">
            <MessageCircle className="h-12 w-12 mb-3" />
            <p className="text-sm font-medium">{t('chat.noMessages')}</p>
            <p className="text-xs mt-1">Send a message to start the conversation</p>
          </div>
        ) : (
          <>
          {/* Load older messages */}
          {hasMore && (
            <div className="flex justify-center mb-2">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 bg-zinc-100 rounded-full hover:bg-zinc-200 disabled:opacity-50 transition-colors"
              >
                {loadingMore ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ChevronUp className="h-3 w-3" />
                )}
                {locale === 'it' ? 'Carica messaggi precedenti' : 'Load older messages'}
              </button>
            </div>
          )}
          {filteredMessages.map((msg) => {
            const messageDate = formatMessageDate(msg.created_at)
            const showDateHeader = messageDate !== lastDate
            lastDate = messageDate
            const isOwn = msg.sender_id === userId
            const replyMsg = msg.reply_to_id ? messages.find(m => m.id === msg.reply_to_id) : null

            return (
              <div key={msg.id} className="group">
                {showDateHeader && (
                  <div className="flex items-center justify-center my-4">
                    <span className="text-[10px] text-zinc-400 bg-zinc-100 px-3 py-1 rounded-full">
                      {messageDate}
                    </span>
                  </div>
                )}
                <div className={cn('flex mb-1 items-end gap-1', isOwn ? 'justify-end' : 'justify-start')}>
                  {/* Reply button — left side for own messages */}
                  {isOwn && (
                    <button
                      onClick={() => setReplyTo({ id: msg.id, message: msg.message, sender_type: msg.sender_type })}
                      className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors shrink-0"
                      title="Reply"
                    >
                      <Reply className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <div className={cn(
                    'max-w-[75%] px-3.5 py-2 rounded-2xl text-sm',
                    isOwn
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-zinc-100 text-zinc-900 rounded-bl-md'
                  )}>
                    {/* PR 2 Step 6 — sender_context badge. Shown when the
                        message was tagged at send time. NULL = legacy
                        message (renders without a badge). */}
                    {msg.sender_context && (
                      <span className={cn(
                        'inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded mb-0.5',
                        isOwn
                          ? 'bg-blue-500/40 text-blue-100'
                          : msg.sender_context === 'person'
                            ? 'bg-zinc-200 text-zinc-600'
                            : 'bg-blue-100 text-blue-700'
                      )}>
                        {msg.sender_context === 'person'
                          ? personalLabel
                          : (msg.account_id && accountNameById.get(msg.account_id)) || (locale === 'it' ? 'Azienda' : 'Company')}
                      </span>
                    )}
                    {!isOwn && (
                      <p className="text-[10px] font-medium text-zinc-500 mb-0.5">
                        {msg.sender_type === 'admin' ? t('chat.team') : (msg.sender_name || t('chat.you'))}
                      </p>
                    )}
                    {isOwn && msg.sender_name && msg.sender_id !== userId && (
                      <p className="text-[10px] font-medium text-blue-200 mb-0.5">
                        {msg.sender_name}
                      </p>
                    )}
                    {/* Quoted reply */}
                    {replyMsg && (
                      <div className={cn(
                        'px-2.5 py-1.5 rounded-lg text-xs mb-1.5 border-l-2',
                        isOwn
                          ? 'bg-blue-500/30 border-blue-300 text-blue-100'
                          : 'bg-zinc-200 border-zinc-400 text-zinc-600'
                      )}>
                        <p className="font-medium text-[10px] mb-0.5">
                          {replyMsg.sender_type === 'admin' ? t('chat.team') : (replyMsg.sender_name || t('chat.you'))}
                        </p>
                        <p className="line-clamp-2">{replyMsg.message || '[Attachment]'}</p>
                      </div>
                    )}
                    {(() => {
                      const atts: ChatAttachment[] = msg.attachments?.length
                        ? msg.attachments
                        : msg.attachment_url
                        ? [{ url: msg.attachment_url, name: msg.attachment_name || 'Attachment', mime_type: undefined }]
                        : []
                      if (atts.length === 0) return null
                      const images = atts.filter(a => isImageUrl(a.url))
                      const docs = atts.filter(a => !isImageUrl(a.url))
                      return (
                        <div className="mb-1 space-y-1">
                          {images.length > 0 && (
                            <div className={cn(
                              'grid gap-1',
                              images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
                            )}>
                              {images.slice(0, 4).map((att, i) => (
                                <button
                                  key={i}
                                  onClick={() => setLightboxUrl(att.url)}
                                  className="relative group rounded-lg overflow-hidden block"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={att.url}
                                    alt={att.name}
                                    className="w-full max-w-[200px] rounded-lg object-cover"
                                    loading="lazy"
                                  />
                                  {i === 3 && images.length > 4 && (
                                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg">
                                      <span className="text-white font-bold text-sm">+{images.length - 3}</span>
                                    </div>
                                  )}
                                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                                    <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                          {docs.map((att, i) => (
                            <a
                              key={i}
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cn(
                                'flex items-center gap-2 px-3 py-2 rounded-lg text-xs',
                                isOwn ? 'bg-blue-500/30 hover:bg-blue-500/40' : 'bg-zinc-200 hover:bg-zinc-300'
                              )}
                            >
                              <FileText className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate flex-1">{att.name}</span>
                              {att.size && <span className="text-[10px] opacity-60 shrink-0">{formatFileSize(att.size)}</span>}
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                          ))}
                        </div>
                      )
                    })()}
                    {msg.message && <p className="whitespace-pre-wrap break-words">{msg.message}</p>}
                    <p className={cn(
                      'text-[10px] mt-1 flex items-center gap-1',
                      isOwn ? 'text-blue-200 justify-end' : 'text-zinc-400'
                    )}>
                      {formatTime(msg.created_at)}
                      {isOwn && (
                        <CheckCheck className={cn(
                          'h-3 w-3',
                          msg.read_at ? 'text-blue-300' : 'text-blue-200/50'
                        )} />
                      )}
                    </p>
                  </div>
                  {/* Reply button — right side for other's messages */}
                  {!isOwn && (
                    <button
                      onClick={() => setReplyTo({ id: msg.id, message: msg.message, sender_type: msg.sender_type })}
                      className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors shrink-0"
                      title="Reply"
                    >
                      <Reply className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          </>
        )}
      </div>

      {/* Recording indicator */}
      {(isRecording || isTranscribing) && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-100 flex items-center gap-2">
          {isRecording && (
            <>
              <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs text-red-600 font-medium">
                {t('chat.recording') || 'Recording... tap mic to stop'}
              </span>
            </>
          )}
          {isTranscribing && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
              <span className="text-xs text-blue-600 font-medium">
                {t('chat.transcribing') || 'Transcribing...'}
              </span>
            </>
          )}
        </div>
      )}

      {/* Reply preview */}
      {replyTo && (
        <div className="px-4 py-2 bg-blue-50 border-t border-blue-100 flex items-center gap-2">
          <Reply className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-medium text-blue-600">
              {replyTo.sender_type === 'admin' ? t('chat.team') : t('chat.you')}
            </p>
            <p className="text-xs text-blue-700 truncate">{replyTo.message || '[Attachment]'}</p>
          </div>
          <button
            onClick={() => setReplyTo(null)}
            className="p-1 rounded-full hover:bg-blue-100 text-blue-400 hover:text-blue-600 shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* File preview strip */}
      {pendingFiles.length > 0 && (
        <div className="px-4 py-2 border-t border-zinc-100 bg-zinc-50">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="relative shrink-0 group">
                {pf.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={pf.previewUrl} alt={pf.file.name} className="h-14 w-14 rounded-lg object-cover border border-zinc-200" />
                ) : (
                  <div className="h-14 w-14 rounded-lg border border-zinc-200 bg-white flex flex-col items-center justify-center gap-0.5">
                    <FileText className="h-5 w-5 text-zinc-400" />
                    <span className="text-[9px] text-zinc-400 truncate w-12 text-center px-1">
                      {pf.file.name.split('.').pop()?.toUpperCase()}
                    </span>
                  </div>
                )}
                <div className="absolute -bottom-1 left-0 right-0 text-center">
                  <span className="text-[9px] text-zinc-400 bg-white px-1 rounded truncate block max-w-full">
                    {formatFileSize(pf.file.size)}
                  </span>
                </div>
                <button
                  onClick={() => { setPendingFiles(prev => prev.filter((_, idx) => idx !== i)); if (fileRef.current) fileRef.current.value = '' }}
                  className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-zinc-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
            {pendingFiles.length < MAX_ATTACHMENTS && (
              <button
                onClick={() => fileRef.current?.click()}
                className="h-14 w-14 rounded-lg border-2 border-dashed border-zinc-300 flex items-center justify-center text-zinc-400 hover:text-zinc-600 hover:border-zinc-400 shrink-0 transition-colors"
              >
                <ImageIcon className="h-5 w-5" />
              </button>
            )}
          </div>
          <p className="text-[10px] text-zinc-400 mt-1">{pendingFiles.length}/{MAX_ATTACHMENTS} files</p>
        </div>
      )}

      {/* Sender context picker (PR 2 Step 6) — Person / current Company.
          Hidden when the contact has no accounts (formation-gap clients
          pre-materialization always send as Person). */}
      {accounts.length > 0 && currentCompanyName && (
        <div className="px-3 sm:px-4 pt-2 pb-1 flex items-center gap-2 border-t bg-zinc-50/40">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">
            {locale === 'it' ? 'Invia come' : 'Send as'}
          </span>
          <div className="flex gap-1 bg-white border rounded-full p-0.5">
            <button
              type="button"
              onClick={() => setTagScope('person')}
              className={cn(
                'px-2.5 py-0.5 text-[11px] rounded-full transition-colors',
                tagScope === 'person'
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              {personalLabel}
            </button>
            <button
              type="button"
              onClick={() => setTagScope('company')}
              className={cn(
                'px-2.5 py-0.5 text-[11px] rounded-full transition-colors max-w-[180px] truncate',
                tagScope === 'company'
                  ? 'bg-blue-600 text-white'
                  : 'text-zinc-600 hover:bg-zinc-100'
              )}
              title={currentCompanyName}
            >
              {currentCompanyName}
            </button>
          </div>
        </div>
      )}

      {/* Input — WhatsApp-style pill + action button */}
      <div className={cn('border-t p-2 sm:p-3', (replyTo || pendingFiles.length > 0) && 'border-t-0')}>
        <div className="flex items-end gap-2">
          {/* Pill container */}
          <div className={cn(
            'flex items-end flex-1 min-w-0 bg-white border border-zinc-200 rounded-[24px] px-1 sm:px-2 py-1 gap-0.5 min-h-[48px] transition-colors',
            isRecording && 'border-red-300 bg-red-50/30'
          )}>
            {/* Emoji */}
            <div className="relative shrink-0" ref={emojiPickerRef}>
              <button
                onClick={() => setShowEmojiPicker(v => !v)}
                className="p-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                title="Emoji"
              >
                <Smile className="h-5 w-5" />
              </button>
              {showEmojiPicker && (
                <div className="absolute bottom-12 left-0 z-30">
                  <EmojiPicker
                    onEmojiClick={(emojiData: { emoji: string }) => {
                      const ref = inputRef.current
                      if (ref) {
                        const start = ref.selectionStart ?? input.length
                        const end = ref.selectionEnd ?? start
                        const newText = input.slice(0, start) + emojiData.emoji + input.slice(end)
                        setInput(newText)
                        setShowEmojiPicker(false)
                        requestAnimationFrame(() => { ref.focus(); ref.setSelectionRange(start + emojiData.emoji.length, start + emojiData.emoji.length) })
                      } else {
                        setInput(prev => prev + emojiData.emoji)
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
              disabled={uploading}
              className={cn(
                'p-2 rounded-full transition-colors shrink-0',
                pendingFiles.length > 0
                  ? 'text-blue-600 bg-blue-100 hover:bg-blue-200'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'
              )}
            >
              {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              multiple
              onChange={e => { Array.from(e.target.files ?? []).forEach(f => handleFileSelect(f)) }}
              className="hidden"
            />
            {/* Textarea */}
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={isRecording ? (t('chat.recording') || 'Recording...') : t('chat.placeholder')}
              className="flex-1 min-w-0 px-1 py-2.5 text-base bg-transparent border-none focus:outline-none focus:ring-0 resize-none overflow-y-auto max-h-[120px] placeholder:text-zinc-400"
            />
          </div>
          {/* Action button — Send or Mic (WhatsApp style toggle) */}
          {sending ? (
            <button
              disabled
              className="w-12 h-12 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0"
            >
              <Loader2 className="h-5 w-5 animate-spin" />
            </button>
          ) : (input.trim() || pendingFiles.length > 0) ? (
            <button
              onClick={handleSend}
              disabled={uploading}
              className="w-12 h-12 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center shrink-0 transition-colors"
            >
              <Send className="h-5 w-5" />
            </button>
          ) : isRecording ? (
            <button
              onClick={handleMicToggle}
              className="w-12 h-12 rounded-full bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse flex items-center justify-center shrink-0 transition-all"
              title={t('chat.stopRecording') || 'Stop recording'}
            >
              <Square className="h-5 w-5 fill-current" />
            </button>
          ) : isTranscribing ? (
            <button
              disabled
              className="w-12 h-12 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center shrink-0"
            >
              <Loader2 className="h-5 w-5 animate-spin" />
            </button>
          ) : micSupported ? (
            <button
              onClick={handleMicToggle}
              className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-600 hover:bg-blue-100 hover:text-blue-600 flex items-center justify-center shrink-0 transition-colors"
              title={t('chat.startRecording') || 'Voice input'}
            >
              <Mic className="h-5 w-5" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled
              className="w-12 h-12 rounded-full bg-blue-600 text-white opacity-50 flex items-center justify-center shrink-0"
            >
              <Send className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* Image lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="Full size"
            className="max-h-[90vh] max-w-full rounded-lg object-contain"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
