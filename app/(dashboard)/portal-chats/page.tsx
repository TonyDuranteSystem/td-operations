'use client'

import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Send, Loader2, Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'
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
}

export default function PortalChatsPage() {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  // Fetch all portal chat threads
  const { data: threads, isLoading: threadsLoading } = useQuery<ChatThread[]>({
    queryKey: ['portal-chat-threads'],
    queryFn: () => fetch('/api/portal/chat/threads').then(r => r.json()),
    refetchInterval: 15_000,
  })

  // Fetch messages for selected thread
  const { data: messages, isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ['portal-chat-messages', selectedAccountId],
    queryFn: () => fetch(`/api/portal/chat?account_id=${selectedAccountId}&limit=50`).then(r => r.json()).then(d => d.messages),
    enabled: !!selectedAccountId,
    refetchInterval: 5_000,
  })

  // Mark messages as read when admin opens a thread
  useEffect(() => {
    if (!selectedAccountId) return
    fetch('/api/portal/chat/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: selectedAccountId }),
    }).then(() => {
      // Refresh threads to update unread count
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    }).catch(() => {})
  }, [selectedAccountId, queryClient])

  // Send reply
  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: selectedAccountId, message }),
      })
      if (!res.ok) throw new Error('Failed to send')
      return res.json()
    },
    onSuccess: () => {
      setReplyText('')
      queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId] })
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    },
  })

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!replyText.trim() || !selectedAccountId) return
    sendMutation.mutate(replyText.trim())
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Thread list */}
      <div className={cn(
        'w-full lg:w-[350px] lg:shrink-0 border-r flex flex-col',
        selectedAccountId ? 'hidden lg:flex' : 'flex'
      )}>
        <div className="px-4 py-3 border-b">
          <h1 className="text-lg font-semibold text-zinc-900">Portal Chats</h1>
          <p className="text-xs text-zinc-500">{threads?.length ?? 0} conversations</p>
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
            threads.map(thread => (
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
                  {format(parseISO(thread.last_message_at), 'MMM d, h:mm a')}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Message thread */}
      <div className={cn(
        'flex-1 flex flex-col',
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
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messagesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                </div>
              ) : (
                messages?.map(msg => (
                  <div
                    key={msg.id}
                    className={cn(
                      'max-w-[75%] rounded-xl px-4 py-2.5',
                      msg.sender_type === 'admin'
                        ? 'ml-auto bg-blue-600 text-white'
                        : 'bg-zinc-100 text-zinc-900'
                    )}
                  >
                    <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
                    <p className={cn(
                      'text-xs mt-1',
                      msg.sender_type === 'admin' ? 'text-blue-200' : 'text-zinc-400'
                    )}>
                      {format(parseISO(msg.created_at), 'h:mm a')}
                    </p>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply input */}
            <div className="p-4 border-t bg-white shrink-0">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="Type a reply..."
                  className="flex-1 px-4 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleSend}
                  disabled={!replyText.trim() || sendMutation.isPending}
                  className="px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
