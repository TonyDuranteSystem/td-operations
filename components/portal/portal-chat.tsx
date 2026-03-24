'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Loader2, MessageCircle, Paperclip, FileText, ExternalLink, Mic, Square, CheckCheck, ChevronUp, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePortalChat } from '@/lib/hooks/use-portal-chat'
import { useLocale } from '@/lib/portal/use-locale'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { toast } from 'sonner'
import { format, parseISO, isToday, isYesterday } from 'date-fns'

function formatMessageDate(dateStr: string): string {
  const date = parseISO(dateStr)
  if (isToday(date)) return 'Today'
  if (isYesterday(date)) return 'Yesterday'
  return format(date, 'MMMM d, yyyy')
}

function formatTime(dateStr: string): string {
  return format(parseISO(dateStr), 'h:mm a')
}

export function PortalChat({ accountId, contactId, userId, locale = 'en' }: { accountId?: string; contactId: string; userId: string; locale?: string }) {
  const { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore } = usePortalChat(accountId || null, contactId)
  const [input, setInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [micConsented, setMicConsented] = useState(false)
  const { t } = useLocale()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
    const newHeight = Math.max(44, Math.min(el.scrollHeight, 150))
    el.style.height = newHeight + 'px'
  }, [input])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || sending) return
    // Stop recording if active
    if (isRecording) stopRecording()
    const msg = input
    setInput('')
    // Reset textarea height
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      await sendMessage(msg)
    } catch {
      toast.error('Failed to send message')
      setInput(msg) // Restore on error
    }
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileUpload = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File too large (max 10MB)')
      return
    }
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('account_id', accountId || '')
      formData.append('contact_id', contactId)
      const res = await fetch('/api/portal/chat/upload', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload failed')
      const { url, name } = await res.json()
      await sendMessage(input || '', { url, name })
      setInput('')
    } catch {
      toast.error('Failed to upload file')
    } finally {
      setUploading(false)
    }
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
    <div className="flex-1 flex flex-col bg-white rounded-xl border shadow-sm overflow-hidden">
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

            return (
              <div key={msg.id}>
                {showDateHeader && (
                  <div className="flex items-center justify-center my-4">
                    <span className="text-[10px] text-zinc-400 bg-zinc-100 px-3 py-1 rounded-full">
                      {messageDate}
                    </span>
                  </div>
                )}
                <div className={cn('flex mb-1', isOwn ? 'justify-end' : 'justify-start')}>
                  <div className={cn(
                    'max-w-[75%] px-3.5 py-2 rounded-2xl text-sm',
                    isOwn
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-zinc-100 text-zinc-900 rounded-bl-md'
                  )}>
                    {!isOwn && (
                      <p className="text-[10px] font-medium text-zinc-500 mb-0.5">
                        {msg.sender_type === 'admin' ? t('chat.team') : t('chat.you')}
                      </p>
                    )}
                    {msg.attachment_url && (
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

      {/* Input */}
      <div className="border-t p-3">
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="p-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 transition-colors shrink-0"
          >
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
          </button>
          <input
            ref={fileRef}
            type="file"
            onChange={e => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
            className="hidden"
          />
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
            disabled={!input.trim() || sending}
            className="p-3 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        </div>
      </div>
    </div>
  )
}
