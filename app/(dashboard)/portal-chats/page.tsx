'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Send, Loader2, Building2, Mic, Square, Bell, BellOff, Sparkles, X, Check, Wand2, Search, CheckCheck, ChevronUp, Reply } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { useNotificationSound } from '@/lib/hooks/use-notification-sound'
import { format, parseISO } from 'date-fns'

interface ChatThread {
  account_id: string
  company_name: string
  last_message: string
  last_message_at: string
  unread_count: number
}

interface ChatMessage {
  id: string
  message: string
  sender_type: 'client' | 'admin'
  created_at: string
  attachment_url?: string
  attachment_name?: string
  read_at?: string | null
  reply_to_id?: string | null
}

export default function PortalChatsPage() {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [chatSearch, setChatSearch] = useState('')
  const [replyToMsg, setReplyToMsg] = useState<{ id: string; message: string; sender_type: string } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const prevTotalUnreadRef = useRef(0)
  const lastSuggestedMsgRef = useRef<string | null>(null)
  const queryClient = useQueryClient()
  const { playSound } = useNotificationSound()

  // Voice input
  const handleTranscript = useCallback((text: string) => {
    setReplyText(prev => (prev ? prev + ' ' + text : text).trim())
    inputRef.current?.focus()
  }, [])

  const {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    isSupported: micSupported,
  } = useVoiceInput({ language: 'en-US', onTranscript: handleTranscript })

  // Request browser notification permission
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      setNotificationsEnabled(true)
    }
  }, [])

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') return
    const permission = await Notification.requestPermission()
    setNotificationsEnabled(permission === 'granted')
  }

  // Fetch all portal chat threads
  const { data: threads, isLoading: threadsLoading } = useQuery<ChatThread[]>({
    queryKey: ['portal-chat-threads'],
    queryFn: () => fetch('/api/portal/chat/threads').then(r => r.json()),
    refetchInterval: 8_000, // faster polling for WhatsApp-like feel
  })

  // Fetch messages for selected thread
  const { data: messages, isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ['portal-chat-messages', selectedAccountId],
    queryFn: () => fetch(`/api/portal/chat?account_id=${selectedAccountId}&limit=50`).then(r => r.json()).then(d => d.messages),
    enabled: !!selectedAccountId,
    refetchInterval: 3_000, // faster for active conversation
  })

  // Mark messages as read when admin opens a thread
  useEffect(() => {
    if (!selectedAccountId) return
    setAiSuggestion('')
    setReplyToMsg(null)
    lastSuggestedMsgRef.current = null
    fetch('/api/portal/chat/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: selectedAccountId }),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    }).catch(() => {})
  }, [selectedAccountId, queryClient])

  // Auto-suggest reply when last message is from client
  useEffect(() => {
    if (!messages?.length || !selectedAccountId) return
    const lastMsg = messages[messages.length - 1]
    if (lastMsg.sender_type !== 'client') return
    // Don't re-suggest for the same message
    if (lastSuggestedMsgRef.current === lastMsg.id) return
    lastSuggestedMsgRef.current = lastMsg.id

    setAiLoading(true)
    setAiSuggestion('')
    fetch('/api/portal/chat/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: selectedAccountId }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.suggestion) setAiSuggestion(data.suggestion)
      })
      .catch(() => {})
      .finally(() => setAiLoading(false))
  }, [messages, selectedAccountId])

  // 🔔 WhatsApp-style notifications: sound + browser notification + tab badge
  useEffect(() => {
    if (!threads) return

    const totalUnread = threads.reduce((sum, t) => sum + t.unread_count, 0)

    // Update tab title with unread count
    if (totalUnread > 0) {
      document.title = `(${totalUnread}) Portal Chats`
    } else {
      document.title = 'Portal Chats'
    }

    // New message detected — play sound + show browser notification
    if (totalUnread > prevTotalUnreadRef.current && prevTotalUnreadRef.current >= 0) {
      // Find the thread with new messages
      const newMessageThread = threads.find(t =>
        t.unread_count > 0 && t.last_message_at
      )

      // Play notification sound
      playSound()

      // Browser notification
      if (notificationsEnabled && newMessageThread) {
        try {
          new Notification(`💬 ${newMessageThread.company_name}`, {
            body: newMessageThread.last_message.slice(0, 100) || 'New message',
            icon: '/portal-icon-192.png',
            tag: 'portal-chat', // prevents stacking
          })
        } catch { /* some browsers block */ }
      }
    }

    prevTotalUnreadRef.current = totalUnread
  }, [threads, playSound, notificationsEnabled])

  // Reset tab title on unmount
  useEffect(() => {
    return () => { document.title = 'Portal Chats' }
  }, [])

  // Send reply
  const sendMutation = useMutation({
    mutationFn: async ({ message, reply_to_id }: { message: string; reply_to_id?: string }) => {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: selectedAccountId, message, reply_to_id }),
      })
      if (!res.ok) throw new Error('Failed to send')
      return res.json()
    },
    onSuccess: () => {
      setReplyText('')
      setReplyToMsg(null)
      queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId] })
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    },
  })

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-grow textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.max(44, Math.min(el.scrollHeight, 300)) + 'px'
  }, [replyText])

  const handleSend = () => {
    if (!replyText.trim() || !selectedAccountId) return
    if (isRecording) stopRecording()
    sendMutation.mutate({ message: replyText.trim(), reply_to_id: replyToMsg?.id })
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }

  const handlePolish = async () => {
    if (!replyText.trim() || polishing) return
    setPolishing(true)
    try {
      const res = await fetch('/api/portal/chat/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyText, account_id: selectedAccountId }),
      })
      const data = await res.json()
      if (data.polished) setReplyText(data.polished)
    } catch { /* silent */ }
    finally { setPolishing(false) }
  }

  const totalUnread = threads?.reduce((sum, t) => sum + t.unread_count, 0) ?? 0

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Thread list */}
      <div className={cn(
        'w-full lg:w-[350px] lg:shrink-0 border-r flex flex-col',
        selectedAccountId ? 'hidden lg:flex' : 'flex'
      )}>
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-zinc-900">Portal Chats</h1>
              {totalUnread > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-blue-600 text-white">
                  {totalUnread}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500">{threads?.length ?? 0} conversations</p>
          </div>
          {/* Notification toggle */}
          <button
            onClick={enableNotifications}
            className={cn(
              "p-2 rounded-lg transition-colors",
              notificationsEnabled ? "text-blue-600 bg-blue-50" : "text-zinc-400 hover:bg-zinc-100"
            )}
            title={notificationsEnabled ? 'Notifications enabled' : 'Enable browser notifications'}
          >
            {notificationsEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          </button>
        </div>
        {/* Chat search */}
        <div className="px-3 py-2 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
            <input
              type="text"
              value={chatSearch}
              onChange={e => setChatSearch(e.target.value)}
              placeholder="Search client or company..."
              className="w-full pl-9 pr-3 py-2 text-xs border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-zinc-50"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threadsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : !threads?.length ? (
            <div className="text-center py-12">
              <MessageSquare className="h-10 w-10 text-zinc-200 mx-auto mb-2" />
              <p className="text-sm text-zinc-400">No portal conversations yet</p>
            </div>
          ) : (
            threads.filter(t => !chatSearch.trim() || t.company_name.toLowerCase().includes(chatSearch.toLowerCase())).map(thread => (
              <button
                key={thread.account_id}
                onClick={() => setSelectedAccountId(thread.account_id)}
                className={cn(
                  'w-full px-4 py-3 text-left border-b hover:bg-zinc-50 transition-colors',
                  selectedAccountId === thread.account_id && 'bg-blue-50 border-l-2 border-l-blue-600'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
                    <span className="text-sm font-medium text-zinc-900 truncate">{thread.company_name}</span>
                  </div>
                  {thread.unread_count > 0 && (
                    <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs font-semibold bg-blue-600 text-white">
                      {thread.unread_count}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 mt-1 truncate">{thread.last_message}</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {thread.last_message_at ? format(parseISO(thread.last_message_at), 'MMM d, h:mm a') : ''}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Message thread */}
      <div className={cn(
        'flex-1 min-w-0 flex flex-col overflow-hidden',
        !selectedAccountId ? 'hidden lg:flex' : 'flex'
      )}>
        {!selectedAccountId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="h-12 w-12 text-zinc-200 mx-auto mb-3" />
              <p className="text-zinc-400">Select a conversation</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b bg-white shrink-0">
              <button
                onClick={() => setSelectedAccountId(null)}
                className="lg:hidden text-sm text-blue-600 mb-1"
              >
                &larr; Back
              </button>
              <p className="text-sm font-semibold text-zinc-900">
                {threads?.find(t => t.account_id === selectedAccountId)?.company_name ?? 'Chat'}
              </p>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3">
              {messagesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                </div>
              ) : (
                <>
                {/* Load older messages */}
                {messages && messages.length >= 50 && (
                  <div className="flex justify-center mb-2">
                    <button
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 bg-zinc-100 rounded-full hover:bg-zinc-200 transition-colors"
                      onClick={() => {/* Pagination handled by increasing limit or cursor */}}
                    >
                      <ChevronUp className="h-3 w-3" />
                      Older messages available
                    </button>
                  </div>
                )}
                {messages?.map(msg => {
                  const isAdmin = msg.sender_type === 'admin'
                  const replyRef = msg.reply_to_id ? messages.find(m => m.id === msg.reply_to_id) : null
                  return (
                    <div key={msg.id} className={cn('group flex items-end gap-1', isAdmin ? 'justify-end' : 'justify-start')}>
                      {/* Reply button — left for admin messages */}
                      {isAdmin && (
                        <button
                          onClick={() => setReplyToMsg({ id: msg.id, message: msg.message, sender_type: msg.sender_type })}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all shrink-0"
                          title="Reply"
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <div
                        className={cn(
                          'max-w-[75%] rounded-xl px-4 py-2.5 overflow-hidden',
                          isAdmin
                            ? 'bg-blue-600 text-white'
                            : 'bg-zinc-100 text-zinc-900'
                        )}
                      >
                        {/* Quoted reply */}
                        {replyRef && (
                          <div className={cn(
                            'px-2.5 py-1.5 rounded-lg text-xs mb-1.5 border-l-2',
                            isAdmin
                              ? 'bg-blue-500/30 border-blue-300 text-blue-100'
                              : 'bg-zinc-200 border-zinc-400 text-zinc-600'
                          )}>
                            <p className="font-medium text-[10px] mb-0.5">
                              {replyRef.sender_type === 'admin' ? 'You' : 'Client'}
                            </p>
                            <p className="line-clamp-2">{replyRef.message || '[Attachment]'}</p>
                          </div>
                        )}
                        {msg.attachment_url && (
                          <a
                            href={msg.attachment_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              'flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-1',
                              isAdmin ? 'bg-blue-500/30 hover:bg-blue-500/40' : 'bg-zinc-200 hover:bg-zinc-300'
                            )}
                          >
                            <span className="truncate">{msg.attachment_name || 'Attachment'}</span>
                          </a>
                        )}
                        <p className="text-sm whitespace-pre-wrap break-words" style={{ overflowWrap: 'anywhere' }}>{msg.message}</p>
                        <p className={cn(
                          'text-xs mt-1 flex items-center gap-1',
                          isAdmin ? 'text-blue-200 justify-end' : 'text-zinc-400'
                        )}>
                          {format(parseISO(msg.created_at), 'h:mm a')}
                          {isAdmin && (
                            <CheckCheck className={cn(
                              'h-3 w-3',
                              msg.read_at ? 'text-blue-300' : 'text-blue-200/50'
                            )} />
                          )}
                        </p>
                      </div>
                      {/* Reply button — right for client messages */}
                      {!isAdmin && (
                        <button
                          onClick={() => setReplyToMsg({ id: msg.id, message: msg.message, sender_type: msg.sender_type })}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all shrink-0"
                          title="Reply"
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )
                })}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Recording indicator */}
            {(isRecording || isTranscribing) && (
              <div className="px-4 py-2 bg-red-50 border-t border-red-100 flex items-center gap-2">
                {isRecording && (
                  <>
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-xs text-red-600 font-medium">Recording... tap mic to stop</span>
                  </>
                )}
                {isTranscribing && (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                    <span className="text-xs text-blue-600 font-medium">Transcribing...</span>
                  </>
                )}
              </div>
            )}

            {/* AI Suggestion */}
            {(aiLoading || aiSuggestion) && (
              <div className="px-4 py-3 border-t bg-gradient-to-r from-violet-50 to-blue-50 shrink-0">
                {aiLoading ? (
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-violet-500 animate-pulse" />
                    <span className="text-xs text-violet-600 font-medium">AI is thinking...</span>
                  </div>
                ) : aiSuggestion ? (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                        <span className="text-[11px] font-semibold text-violet-600 uppercase tracking-wide">AI Suggestion</span>
                      </div>
                      <button
                        onClick={() => setAiSuggestion('')}
                        className="p-0.5 rounded hover:bg-violet-100 text-violet-400"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="text-sm text-zinc-700 whitespace-pre-wrap mb-2">{aiSuggestion}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setReplyText(aiSuggestion)
                          setAiSuggestion('')
                          inputRef.current?.focus()
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
                      >
                        <Check className="h-3 w-3" />
                        Use this reply
                      </button>
                      <button
                        onClick={() => {
                          setReplyText(aiSuggestion)
                          setAiSuggestion('')
                          inputRef.current?.focus()
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-violet-600 border border-violet-200 rounded-lg hover:bg-violet-50 transition-colors"
                      >
                        Edit first
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {/* Reply-to preview */}
            {replyToMsg && (
              <div className="px-4 py-2 bg-blue-50 border-t border-blue-100 flex items-center gap-2 shrink-0">
                <Reply className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-medium text-blue-600">
                    {replyToMsg.sender_type === 'admin' ? 'You' : 'Client'}
                  </p>
                  <p className="text-xs text-blue-700 truncate">{replyToMsg.message || '[Attachment]'}</p>
                </div>
                <button
                  onClick={() => setReplyToMsg(null)}
                  className="p-1 rounded-full hover:bg-blue-100 text-blue-400 hover:text-blue-600 shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Reply input */}
            <div className={cn('p-4 border-t bg-white shrink-0', replyToMsg && 'border-t-0')}>
              <div className="flex gap-2 items-end">
                <textarea
                  ref={inputRef}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                  rows={1}
                  placeholder={isRecording ? 'Recording...' : 'Type a reply...'}
                  className={cn(
                    "flex-1 min-w-0 px-4 py-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none overflow-y-auto",
                    isRecording && "ring-2 ring-red-300 bg-red-50/50"
                  )}
                />
                {/* Polish button — shows when there's text */}
                {replyText.trim() && (
                  <button
                    onClick={handlePolish}
                    disabled={polishing}
                    className="p-3 rounded-lg bg-violet-100 text-violet-600 hover:bg-violet-200 disabled:opacity-50 transition-colors shrink-0"
                    title="AI Polish — clean up grammar and make it professional"
                  >
                    {polishing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}
                  </button>
                )}
                {/* Mic — always visible (dictate into empty or append to existing text) */}
                {micSupported && (
                  isRecording ? (
                    <button
                      onClick={stopRecording}
                      className="p-3 rounded-lg bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse transition-all shrink-0"
                      title="Stop recording"
                      aria-label="Stop recording"
                    >
                      <Square className="h-5 w-5 fill-current" />
                    </button>
                  ) : isTranscribing ? (
                    <button disabled className="p-3 rounded-lg bg-blue-100 text-blue-500 shrink-0" aria-label="Transcribing audio">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </button>
                  ) : (
                    <button
                      onClick={startRecording}
                      className="p-3 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-blue-100 hover:text-blue-600 transition-colors shrink-0"
                      title="Dictate — appends to current text"
                      aria-label="Start voice recording"
                    >
                      <Mic className="h-5 w-5" />
                    </button>
                  )
                )}
                {/* Send */}
                <button
                  onClick={handleSend}
                  disabled={!replyText.trim() || sendMutation.isPending}
                  className="p-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {sendMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                </button>
                {replyText.length > 4500 && (
                  <span className={cn('text-xs', replyText.length > 5000 ? 'text-red-500' : 'text-zinc-400')}>
                    {replyText.length}/5000
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
