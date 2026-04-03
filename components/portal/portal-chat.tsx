'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Loader2, MessageCircle, Paperclip, FileText, ExternalLink, Mic, Square, CheckCheck, ChevronUp, Reply, X, ZoomIn, Smile } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePortalChat } from '@/lib/hooks/use-portal-chat'
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

export function PortalChat({ accountId, contactId, userId, locale = 'en' }: { accountId?: string; contactId: string; userId: string; locale?: string }) {
  const { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore } = usePortalChat(accountId || null, contactId)
  const [input, setInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [micConsented, setMicConsented] = useState(false)
  const [replyTo, setReplyTo] = useState<{ id: string; message: string; sender_type: string } | null>(null)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null)
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
  } = useVoiceInput({ language: speechLang, onTranscript: handleTranscript })

  // Auto-grow textarea whenever input changes (typing, voice, paste)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    // Collapse to 0 first to get true scrollHeight
    el.style.height = '0px'
    const newHeight = Math.max(44, Math.min(el.scrollHeight, 300))
    el.style.height = newHeight + 'px'
  }, [input])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = async () => {
    if ((!input.trim() && !pendingFile) || sending || uploading) return
    if (isRecording) stopRecording()
    const msg = input
    const replyId = replyTo?.id
    const fileToSend = pendingFile
    setInput('')
    setReplyTo(null)
    setPendingFile(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      if (fileToSend) {
        setUploading(true)
        try {
          const formData = new FormData()
          formData.append('file', fileToSend.file)
          formData.append('account_id', accountId || '')
          formData.append('contact_id', contactId)
          const res = await fetch('/api/portal/chat/upload', { method: 'POST', body: formData })
          if (!res.ok) throw new Error('Upload failed')
          const { url, name } = await res.json()
          await sendMessage(msg || '', { url, name }, replyId)
        } finally {
          setUploading(false)
        }
      } else {
        await sendMessage(msg, undefined, replyId)
      }
    } catch {
      toast.error('Failed to send message')
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
    const ALLOWED_TYPES = ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/csv','text/plain']
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error('Unsupported file type')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File too large (max 10MB)')
      return
    }
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = e => setPendingFile({ file, previewUrl: e.target?.result as string })
      reader.readAsDataURL(file)
    } else {
      setPendingFile({ file })
    }
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
    const file = e.dataTransfer.files?.[0]
    if (file) handleFileSelect(file)
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

  // Group messages by date
  let lastDate = ''

  return (
    <div
      className="flex-1 flex flex-col bg-white rounded-xl border shadow-sm overflow-hidden relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 rounded-xl pointer-events-none">
          <Paperclip className="h-10 w-10 text-blue-400 mb-2" />
          <p className="text-sm font-medium text-blue-600">Drop file to attach</p>
        </div>
      )}
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
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
          {messages.map((msg) => {
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
                    {msg.attachment_url && (
                      isImageUrl(msg.attachment_url) ? (
                        <button
                          onClick={() => setLightboxUrl(msg.attachment_url!)}
                          className="relative group rounded-lg overflow-hidden mb-1 block"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={msg.attachment_url}
                            alt={msg.attachment_name || 'Image'}
                            className="max-w-[240px] rounded-lg"
                            loading="lazy"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                            <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </button>
                      ) : (
                        <a
                          href={msg.attachment_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            'flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-1',
                            isOwn ? 'bg-blue-500/30 hover:bg-blue-500/40' : 'bg-zinc-200 hover:bg-zinc-300'
                          )}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{msg.attachment_name || 'Attachment'}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      )
                    )}
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
      {pendingFile && (
        <div className="px-4 py-2 border-t border-zinc-100 bg-zinc-50 flex items-center gap-3">
          {pendingFile.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pendingFile.previewUrl} alt={pendingFile.file.name} className="h-12 w-12 rounded object-cover border border-zinc-200 shrink-0" />
          ) : (
            <div className="h-12 w-12 rounded border border-zinc-200 bg-white flex items-center justify-center shrink-0">
              <FileText className="h-5 w-5 text-zinc-400" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-zinc-700 truncate">{pendingFile.file.name}</p>
            <p className="text-[10px] text-zinc-400">{formatFileSize(pendingFile.file.size)}</p>
          </div>
          <button
            onClick={() => { setPendingFile(null); if (fileRef.current) fileRef.current.value = '' }}
            className="p-1 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Input */}
      <div className={cn('border-t p-3', (replyTo || pendingFile) && 'border-t-0')}>
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className={cn(
              'p-2 rounded-full transition-colors shrink-0',
              pendingFile
                ? 'text-blue-600 bg-blue-100 hover:bg-blue-200'
                : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'
            )}
          >
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain"
            onChange={e => { if (e.target.files?.[0]) handleFileSelect(e.target.files[0]) }}
            className="hidden"
          />
          {/* Emoji picker */}
          <div className="relative" ref={emojiPickerRef}>
            <button
              onClick={() => setShowEmojiPicker(v => !v)}
              className="p-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors shrink-0"
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
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={isRecording ? (t('chat.recording') || 'Recording...') : t('chat.placeholder')}
            className={cn(
              "flex-1 min-w-0 px-4 py-3 text-sm border rounded-2xl bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors resize-none overflow-y-auto",
              isRecording && "ring-2 ring-red-300 bg-red-50/50"
            )}
          />
          {/* Mic — always visible so user can dictate into existing text */}
          {micSupported && (
            isRecording ? (
              <button
                onClick={handleMicToggle}
                className="p-3 rounded-full bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse transition-all shrink-0"
                title={t('chat.stopRecording') || 'Stop recording'}
                aria-label={t('chat.stopRecording') || 'Stop recording'}
              >
                <Square className="h-5 w-5 fill-current" />
              </button>
            ) : isTranscribing ? (
              <button
                disabled
                className="p-3 rounded-full bg-blue-100 text-blue-500 shrink-0"
                aria-label="Transcribing audio"
              >
                <Loader2 className="h-5 w-5 animate-spin" />
              </button>
            ) : (
              <button
                onClick={handleMicToggle}
                className="p-3 rounded-full bg-zinc-100 text-zinc-600 hover:bg-blue-100 hover:text-blue-600 transition-colors shrink-0"
                title={t('chat.startRecording') || 'Voice input'}
                aria-label={t('chat.startRecording') || 'Start voice recording'}
              >
                <Mic className="h-5 w-5" />
              </button>
            )
          )}
          {/* Send */}
          <button
            onClick={handleSend}
            disabled={(!input.trim() && !pendingFile) || sending || uploading}
            className="p-3 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
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
