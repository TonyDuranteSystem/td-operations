'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Send, Loader2, Building2, Mic, Square, Bell, BellOff, Sparkles, X, Check, Wand2, Search, CheckCheck, ChevronUp, Reply, MoreVertical, ClipboardList, Receipt, Truck, MailOpen, Plus, User, Paperclip, FileText, Smile, Users, CheckCircle2, ArrowLeft } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { useNotificationSound } from '@/lib/hooks/use-notification-sound'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

interface ChatThread {
  account_id: string | null
  contact_id: string | null
  company_name: string
  contact_name: string | null
  last_message: string
  last_message_at: string
  unread_count: number
}

interface ChatMessage {
  id: string
  message: string
  sender_type: 'client' | 'admin'
  sender_name?: string | null
  created_at: string
  attachment_url?: string
  attachment_name?: string
  read_at?: string | null
  reply_to_id?: string | null
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const buffer = new ArrayBuffer(rawData.length)
  const outputArray = new Uint8Array(buffer)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

interface PendingAdminFile {
  file: File
  previewUrl?: string
}

export default function PortalChatsPage() {
  const urlParams = useSearchParams()
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(urlParams.get('account'))
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<{ company: string; contact?: string } | null>(null)
  const [replyText, setReplyText] = useState('')
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [chatSearch, setChatSearch] = useState('')
  const [replyToMsg, setReplyToMsg] = useState<{ id: string; message: string; sender_type: string } | null>(null)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatSearch, setNewChatSearch] = useState('')
  const [newChatResults, setNewChatResults] = useState<{ id: string; company_name: string; contact_name: string | null }[]>([])
  const [newChatSearching, setNewChatSearching] = useState(false)
  const [newThreadMode, setNewThreadMode] = useState<'client' | 'team'>('client')
  const [newThreadTitle, setNewThreadTitle] = useState('')
  const [creatingThread, setCreatingThread] = useState(false)
  // Extra accounts found by search that aren't in existing threads
  const [searchExtraAccounts, setSearchExtraAccounts] = useState<{ id: string; company_name: string; contact_name: string | null }[]>([])
  const [quickCreate, setQuickCreate] = useState<{ type: 'task' | 'sd' | 'invoice'; messageText: string } | null>(null)
  const [pendingAdminFile, setPendingAdminFile] = useState<PendingAdminFile | null>(null)
  const [isDraggingAdmin, setIsDraggingAdmin] = useState(false)
  const [uploadingAdminFile, setUploadingAdminFile] = useState(false)
  // Internal team chat
  const [sidebarView, setSidebarView] = useState<'chats' | 'internal'>('chats')
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [internalReplyText, setInternalReplyText] = useState('')
  const [internalPendingFile, setInternalPendingFile] = useState<PendingAdminFile | null>(null)
  const [internalUploading, setInternalUploading] = useState(false)
  // AI assistant panel
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiPanelMessages, setAiPanelMessages] = useState<{ role: 'user' | 'ai'; text: string }[]>([])
  const [aiPanelInput, setAiPanelInput] = useState('')
  const [aiPanelLoading, setAiPanelLoading] = useState(false)
  const aiPanelEndRef = useRef<HTMLDivElement>(null)
  // Emoji picker
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showInternalEmojiPicker, setShowInternalEmojiPicker] = useState(false)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const internalEmojiPickerRef = useRef<HTMLDivElement>(null)
  const internalInputRef = useRef<HTMLTextAreaElement>(null)
  const internalFileRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const internalMessagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const adminFileRef = useRef<HTMLInputElement>(null)
  const prevTotalUnreadRef = useRef(0)
  const lastSuggestedMsgRef = useRef<string | null>(null)
  const queryClient = useQueryClient()
  const { playSound } = useNotificationSound()

  // Voice input for client chat
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

  // Voice input for internal chat
  const handleInternalTranscript = useCallback((text: string) => {
    setInternalReplyText(prev => (prev ? prev + ' ' + text : text).trim())
    internalInputRef.current?.focus()
  }, [])

  const {
    isRecording: internalIsRecording,
    isTranscribing: internalIsTranscribing,
    startRecording: internalStartRecording,
    stopRecording: internalStopRecording,
  } = useVoiceInput({ language: 'en-US', onTranscript: handleInternalTranscript })

  // Internal file select
  const handleInternalFileSelect = (file: File) => {
    const maxSize = 10 * 1024 * 1024
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (file.size > maxSize) { toast.error('File too large (max 10MB)'); return }
    if (!allowedTypes.includes(file.type)) { toast.error('File type not allowed'); return }
    const isImg = file.type.startsWith('image/')
    if (isImg) {
      const reader = new FileReader()
      reader.onload = () => setInternalPendingFile({ file, previewUrl: reader.result as string })
      reader.readAsDataURL(file)
    } else {
      setInternalPendingFile({ file })
    }
  }

  // Request browser notification permission + register service worker for push
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      setNotificationsEnabled(true)
    }
  }, [])

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') return
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return

    setNotificationsEnabled(true)

    // Try to register service worker + subscribe to push
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

      const registration = await navigator.serviceWorker.register('/dashboard-sw.js')
      await navigator.serviceWorker.ready

      // Fetch VAPID public key
      const vapidRes = await fetch('/api/admin/push')
      if (!vapidRes.ok) return // VAPID not configured, fall back to basic notifications
      const { publicKey } = await vapidRes.json()
      if (!publicKey) return

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })

      // Save subscription to server
      await fetch('/api/admin/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      })
    } catch {
      // Push registration failed — basic Notification API still works
    }
  }

  // Fetch all portal chat threads
  const { data: threads, isLoading: threadsLoading } = useQuery<ChatThread[]>({
    queryKey: ['portal-chat-threads'],
    queryFn: () => fetch('/api/portal/chat/threads').then(r => r.json()),
    refetchInterval: 8_000, // faster polling for WhatsApp-like feel
  })

  // Fetch messages for selected thread (by account_id or contact_id)
  const chatQueryParam = selectedAccountId
    ? `account_id=${selectedAccountId}`
    : selectedContactId
      ? `contact_id=${selectedContactId}`
      : null
  const { data: messages, isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId],
    queryFn: () => fetch(`/api/portal/chat?${chatQueryParam}&limit=50`).then(r => r.json()).then(d => d.messages),
    enabled: !!(selectedAccountId || selectedContactId),
    refetchInterval: 3_000, // faster for active conversation
  })

  // Mark messages as read when admin opens a thread
  useEffect(() => {
    if (!selectedAccountId && !selectedContactId) return
    setAiSuggestion('')
    setReplyToMsg(null)
    lastSuggestedMsgRef.current = null
    const readBody = selectedAccountId
      ? { account_id: selectedAccountId }
      : { contact_id: selectedContactId }
    fetch('/api/portal/chat/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBody),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    }).catch(() => {})
  }, [selectedAccountId, selectedContactId, queryClient])

  // Auto-suggest reply when last message is from client
  useEffect(() => {
    if (!messages?.length || (!selectedAccountId && !selectedContactId)) return
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
      body: JSON.stringify(selectedAccountId ? { account_id: selectedAccountId } : { contact_id: selectedContactId }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.suggestion) setAiSuggestion(data.suggestion)
      })
      .catch(() => {})
      .finally(() => setAiLoading(false))
  }, [messages, selectedAccountId, selectedContactId])

  // Internal team threads
  interface InternalThread {
    id: string
    account_id: string | null
    contact_id: string | null
    source_message_id: string | null
    created_by: string
    title: string | null
    resolved_at: string | null
    created_at: string
    company_name?: string
    source_message?: string
    unread_count?: number
    last_message_at?: string
    last_message_preview?: string
  }
  interface InternalMsg {
    id: string
    thread_id: string
    sender_id: string
    sender_name: string
    message: string
    attachment_url: string | null
    attachment_name: string | null
    read_at: string | null
    created_at: string
  }

  const { data: internalThreads, isLoading: internalThreadsLoading } = useQuery<InternalThread[]>({
    queryKey: ['internal-threads'],
    queryFn: () => fetch('/api/internal/threads').then(r => r.json()).then(d => d.threads ?? []),
    refetchInterval: 10_000,
  })

  const { data: internalMessages, isLoading: internalMessagesLoading } = useQuery<{ thread: InternalThread; messages: InternalMsg[] }>({
    queryKey: ['internal-thread-messages', selectedThreadId],
    queryFn: () => fetch(`/api/internal/threads/${selectedThreadId}`).then(r => r.json()),
    enabled: !!selectedThreadId,
    refetchInterval: 5_000,
  })

  // Scroll internal messages to bottom
  useEffect(() => {
    if (internalMessagesEndRef.current) {
      internalMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [internalMessages?.messages])

  const internalTotalUnread = internalThreads?.reduce((sum, t) => sum + (t.unread_count ?? 0), 0) ?? 0

  const createTeamThread = async (title: string) => {
    if (!title.trim()) return
    setCreatingThread(true)
    try {
      const res = await fetch('/api/internal/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      })
      if (!res.ok) throw new Error('Failed to create thread')
      const data = await res.json()
      setSidebarView('internal')
      setSelectedThreadId(data.thread.id)
      setSelectedAccountId(null)
      setSelectedContactId(null)
      queryClient.invalidateQueries({ queryKey: ['internal-threads'] })
      toast.success('Team thread created')
      setNewChatOpen(false)
      setNewThreadTitle('')
      setNewThreadMode('client')
    } catch {
      toast.error('Failed to create team thread')
    } finally {
      setCreatingThread(false)
    }
  }

  const createInternalThread = async (accountId: string, sourceMessageId: string, sourceText: string) => {
    try {
      const res = await fetch('/api/internal/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, source_message_id: sourceMessageId || undefined, title: sourceText.slice(0, 100) || undefined }),
      })
      if (!res.ok) throw new Error('Failed to create thread')
      const data = await res.json()
      setSidebarView('internal')
      setSelectedThreadId(data.thread.id)
      setSelectedAccountId(null)
      queryClient.invalidateQueries({ queryKey: ['internal-threads'] })
      queryClient.invalidateQueries({ queryKey: ['internal-thread-messages', data.thread.id] })
      toast.success(data.reused ? 'Added to existing thread' : 'Internal thread created')
    } catch {
      toast.error('Failed to create internal thread')
    }
  }

  const sendInternalMessage = async () => {
    if (!internalReplyText.trim() && !internalPendingFile) return
    if (!selectedThreadId) return
    const text = internalReplyText.trim()
    setInternalReplyText('')

    // Upload file first if pending
    let attachmentUrl: string | null = null
    let attachmentName: string | null = null
    if (internalPendingFile) {
      setInternalUploading(true)
      try {
        const formData = new FormData()
        formData.append('file', internalPendingFile.file)
        const uploadRes = await fetch(`/api/internal/threads/${selectedThreadId}/upload`, {
          method: 'POST',
          body: formData,
        })
        if (!uploadRes.ok) throw new Error('Upload failed')
        const uploadData = await uploadRes.json()
        attachmentUrl = uploadData.url
        attachmentName = uploadData.name
      } catch {
        toast.error('File upload failed')
        setInternalUploading(false)
        return
      }
      setInternalUploading(false)
      setInternalPendingFile(null)
      if (internalFileRef.current) internalFileRef.current.value = ''
    }

    try {
      const res = await fetch(`/api/internal/threads/${selectedThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, attachment_url: attachmentUrl, attachment_name: attachmentName }),
      })
      if (!res.ok) throw new Error('Failed to send')
      queryClient.invalidateQueries({ queryKey: ['internal-thread-messages', selectedThreadId] })
      queryClient.invalidateQueries({ queryKey: ['internal-threads'] })
    } catch {
      toast.error('Failed to send message')
      setInternalReplyText(text)
    }
  }

  const resolveThread = async (threadId: string, resolved: boolean) => {
    try {
      await fetch(`/api/internal/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved }),
      })
      queryClient.invalidateQueries({ queryKey: ['internal-threads'] })
      queryClient.invalidateQueries({ queryKey: ['internal-thread-messages', threadId] })
    } catch {
      toast.error('Failed to update thread')
    }
  }

  const deleteThread = async (threadId: string) => {
    if (!confirm('Delete this thread and all its messages? This cannot be undone.')) return
    try {
      const res = await fetch(`/api/internal/threads/${threadId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete thread')
      setSelectedThreadId(null)
      queryClient.invalidateQueries({ queryKey: ['internal-threads'] })
      toast.success('Thread deleted')
    } catch {
      toast.error('Failed to delete thread')
    }
  }

  // AI assistant: send question
  const sendAiQuestion = async () => {
    if (!aiPanelInput.trim()) return
    const question = aiPanelInput.trim()
    setAiPanelInput('')
    setAiPanelMessages(prev => [...prev, { role: 'user', text: question }])
    setAiPanelLoading(true)
    try {
      const accountId = selectedAccountId || (selectedThreadId ? internalMessages?.thread?.account_id : null)
      if (!accountId) { toast.error('No client context'); return }
      const res = await fetch('/api/internal/ai-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          user_message: question,
          context_type: selectedThreadId ? 'internal_thread' : 'client_chat',
          thread_id: selectedThreadId || undefined,
        }),
      })
      if (!res.ok) throw new Error('AI failed')
      const data = await res.json()
      setAiPanelMessages(prev => [...prev, { role: 'ai', text: data.reply }])
    } catch {
      setAiPanelMessages(prev => [...prev, { role: 'ai', text: 'Sorry, something went wrong. Try again.' }])
    } finally {
      setAiPanelLoading(false)
    }
  }

  // Reset AI panel when switching chats
  useEffect(() => {
    setAiPanelMessages([])
    setAiPanelInput('')
  }, [selectedAccountId, selectedThreadId])

  // Scroll AI panel to bottom
  useEffect(() => {
    aiPanelEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [aiPanelMessages])

  // WhatsApp-style notifications: sound + browser notification + tab badge
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
    mutationFn: async ({ message, reply_to_id, attachment_url, attachment_name }: { message: string; reply_to_id?: string; attachment_url?: string; attachment_name?: string }) => {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(selectedAccountId ? { account_id: selectedAccountId } : { contact_id: selectedContactId }),
          message, reply_to_id, attachment_url, attachment_name,
        }),
      })
      if (!res.ok) throw new Error('Failed to send')
      return res.json()
    },
    onSuccess: () => {
      setReplyText('')
      setReplyToMsg(null)
      setPendingAdminFile(null)
      queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId] })
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

  const handleAdminFileSelect = (file: File) => {
    const ALLOWED_TYPES = ['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/csv','text/plain','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
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
      reader.onload = e => setPendingAdminFile({ file, previewUrl: e.target?.result as string })
      reader.readAsDataURL(file)
    } else {
      setPendingAdminFile({ file })
    }
  }

  const handleAdminDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingAdmin(true)
  }

  const handleAdminDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDraggingAdmin(false)
    }
  }

  const handleAdminDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingAdmin(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleAdminFileSelect(file)
  }

  const handleSend = async () => {
    if ((!replyText.trim() && !pendingAdminFile) || (!selectedAccountId && !selectedContactId) || sendMutation.isPending || uploadingAdminFile) return
    if (isRecording) stopRecording()
    if (inputRef.current) inputRef.current.style.height = 'auto'

    if (pendingAdminFile) {
      setUploadingAdminFile(true)
      try {
        const formData = new FormData()
        formData.append('file', pendingAdminFile.file)
        formData.append(selectedAccountId ? 'account_id' : 'contact_id', (selectedAccountId || selectedContactId)!)
        const res = await fetch('/api/portal/chat/upload', { method: 'POST', body: formData })
        if (!res.ok) throw new Error('Upload failed')
        const { url, name } = await res.json()
        sendMutation.mutate({ message: replyText.trim(), reply_to_id: replyToMsg?.id, attachment_url: url, attachment_name: name })
      } catch {
        toast.error('Failed to upload file')
      } finally {
        setUploadingAdminFile(false)
        if (adminFileRef.current) adminFileRef.current.value = ''
      }
    } else {
      sendMutation.mutate({ message: replyText.trim(), reply_to_id: replyToMsg?.id })
    }
  }

  const handlePolish = async () => {
    if (!replyText.trim() || polishing) return
    setPolishing(true)
    try {
      const res = await fetch('/api/portal/chat/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyText, ...(selectedAccountId ? { account_id: selectedAccountId } : { contact_id: selectedContactId }) }),
      })
      const data = await res.json()
      if (data.polished) setReplyText(data.polished)
    } catch { /* silent */ }
    finally { setPolishing(false) }
  }

  const markAsUnread = async (accountId: string) => {
    await fetch('/api/portal/chat/unread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId }),
    })
    queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
  }

  // Close emoji picker on click outside
  useEffect(() => {
    if (!showEmojiPicker && !showInternalEmojiPicker) return
    const handler = (e: MouseEvent) => {
      if (showEmojiPicker && emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
      if (showInternalEmojiPicker && internalEmojiPickerRef.current && !internalEmojiPickerRef.current.contains(e.target as Node)) {
        setShowInternalEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showEmojiPicker, showInternalEmojiPicker])

  // Chat search bar: also find accounts without existing threads
  useEffect(() => {
    if (chatSearch.length < 2) {
      setSearchExtraAccounts([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/portal/chat/search-accounts?q=${encodeURIComponent(chatSearch)}`)
        if (res.ok) {
          const data = await res.json()
          // Filter out accounts that already have threads
          const threadIds = new Set((threads ?? []).map(t => t.account_id))
          const extras = (data.accounts ?? []).filter((a: { id: string }) => !threadIds.has(a.id))
          setSearchExtraAccounts(extras)
        }
      } catch { /* ignore */ }
    }, 400)
    return () => clearTimeout(timer)
  }, [chatSearch, threads])

  // New chat: search accounts
  useEffect(() => {
    if (!newChatOpen || newChatSearch.length < 2) {
      setNewChatResults([])
      return
    }
    const timer = setTimeout(async () => {
      setNewChatSearching(true)
      try {
        const res = await fetch(`/api/portal/chat/search-accounts?q=${encodeURIComponent(newChatSearch)}`)
        if (res.ok) {
          const data = await res.json()
          setNewChatResults(data.accounts ?? [])
        }
      } finally {
        setNewChatSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [newChatSearch, newChatOpen])

  const totalUnread = threads?.reduce((sum, t) => sum + t.unread_count, 0) ?? 0

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Thread list */}
      <div className={cn(
        'w-full lg:w-[350px] lg:shrink-0 border-r flex flex-col',
        (selectedAccountId || selectedContactId || selectedThreadId) ? 'hidden lg:flex' : 'flex'
      )}>
        <div className="px-4 py-3 border-b">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-lg font-semibold text-zinc-900">Portal Chats</h1>
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  setNewChatOpen(true)
                  setNewChatSearch('')
                  setNewChatResults([])
                }}
                className={cn(
                  "p-2 rounded-lg transition-colors",
                  sidebarView === 'internal'
                    ? "text-orange-600 bg-orange-50 hover:bg-orange-100"
                    : "text-blue-600 bg-blue-50 hover:bg-blue-100"
                )}
                title={sidebarView === 'internal' ? 'New team discussion' : 'Start new chat with a client'}
              >
                <Plus className="h-4 w-4" />
              </button>
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
          </div>
          {/* Sidebar tabs: Chats | Team */}
          <div className="flex rounded-lg bg-zinc-100 p-0.5">
            <button
              onClick={() => { setSidebarView('chats'); setSelectedThreadId(null) }}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors',
                sidebarView === 'chats' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Chats
              {totalUnread > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-600 text-white">{totalUnread}</span>
              )}
            </button>
            <button
              onClick={() => { setSidebarView('internal'); setSelectedAccountId(null) }}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors',
                sidebarView === 'internal' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
              )}
            >
              <Users className="h-3.5 w-3.5" />
              Team
              {internalTotalUnread > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-orange-500 text-white">{internalTotalUnread}</span>
              )}
            </button>
          </div>
        </div>
        {sidebarView === 'chats' ? (
        <>
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
            threads.filter(t => {
              if (!chatSearch.trim()) return true
              const q = chatSearch.toLowerCase()
              return t.company_name.toLowerCase().includes(q) || (t.contact_name?.toLowerCase().includes(q) ?? false)
            }).map(thread => {
              const threadKey = thread.account_id || thread.contact_id || ''
              const isSelected = thread.account_id
                ? selectedAccountId === thread.account_id
                : selectedContactId === thread.contact_id
              return (
              <button
                key={threadKey}
                onClick={() => {
                  setSelectedName({ company: thread.company_name, contact: thread.contact_name || undefined })
                  if (thread.account_id) {
                    setSelectedAccountId(thread.account_id)
                    setSelectedContactId(null)
                  } else if (thread.contact_id) {
                    setSelectedContactId(thread.contact_id)
                    setSelectedAccountId(null)
                  }
                }}
                title={thread.contact_name ? `${thread.company_name} — ${thread.contact_name}` : thread.company_name}
                className={cn(
                  'w-full px-4 py-3 text-left border-b hover:bg-zinc-50 transition-colors',
                  isSelected && 'bg-blue-50 border-l-2 border-l-blue-600'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-zinc-900 truncate block">{thread.company_name}</span>
                      {thread.contact_name && (
                        <span className="text-[11px] text-zinc-400 truncate block">{thread.contact_name}</span>
                      )}
                    </div>
                  </div>
                  {thread.unread_count > 0 && (
                    <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs font-semibold bg-blue-600 text-white">
                      {thread.unread_count}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-xs text-zinc-500 truncate flex-1">{thread.last_message}</p>
                  {thread.unread_count === 0 && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); markAsUnread(thread.account_id) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); markAsUnread(thread.account_id) } }}
                      className="p-1 rounded text-zinc-300 hover:text-blue-600 hover:bg-blue-50 transition-colors shrink-0 ml-1 cursor-pointer"
                      title="Mark as unread"
                    >
                      <MailOpen className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {thread.last_message_at ? format(parseISO(thread.last_message_at), 'MMM d, h:mm a') : ''}
                </p>
              </button>
              )
            })
          )}
          {/* Extra accounts from search (no existing thread) */}
          {chatSearch.length >= 2 && searchExtraAccounts.length > 0 && (
            <>
              <div className="px-4 py-1.5 bg-zinc-50 border-y">
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Other Clients</p>
              </div>
              {searchExtraAccounts.map(acct => (
                <button
                  key={acct.id}
                  onClick={() => { setSelectedAccountId(acct.id); setChatSearch('') }}
                  className="w-full px-4 py-3 text-left border-b hover:bg-blue-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-full bg-blue-50">
                      <Plus className="h-3 w-3 text-blue-500" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-zinc-900 truncate block">{acct.company_name}</span>
                      {acct.contact_name && (
                        <span className="text-[11px] text-zinc-400 truncate block">{acct.contact_name}</span>
                      )}
                    </div>
                  </div>
                  <p className="text-[10px] text-blue-500 mt-1 ml-7">Start new conversation</p>
                </button>
              ))}
            </>
          )}
        </div>
        </>
        ) : (
        /* Internal team threads list */
        <div className="flex-1 overflow-y-auto">
          {internalThreadsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : !internalThreads?.length ? (
            <div className="text-center py-12">
              <Users className="h-10 w-10 text-zinc-200 mx-auto mb-2" />
              <p className="text-sm text-zinc-400">No internal threads yet</p>
              <p className="text-xs text-zinc-300 mt-1">Use &quot;Discuss with Team&quot; on any message</p>
            </div>
          ) : (
            internalThreads.map(thread => (
              <button
                key={thread.id}
                onClick={() => { setSelectedThreadId(thread.id); setSelectedAccountId(null) }}
                className={cn(
                  'w-full px-4 py-3 text-left border-b hover:bg-zinc-50 transition-colors',
                  selectedThreadId === thread.id && 'bg-orange-50 border-l-2 border-l-orange-500'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    {thread.account_id || thread.contact_id ? (
                      <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
                    ) : (
                      <Users className="h-4 w-4 text-orange-400 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-zinc-900 truncate">{thread.company_name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {thread.resolved_at && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                    {(thread.unread_count ?? 0) > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-xs font-semibold bg-orange-500 text-white">
                        {thread.unread_count}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-zinc-500 truncate mt-1">{thread.title || thread.source_message || 'Internal discussion'}</p>
                {thread.last_message_at && (
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {format(parseISO(thread.last_message_at), 'MMM d, h:mm a')}
                  </p>
                )}
              </button>
            ))
          )}
        </div>
        )}
      </div>

      {/* Internal thread panel */}
      {selectedThreadId && (
        <div className={cn(
          'flex-1 min-w-0 flex flex-col overflow-hidden',
          !selectedThreadId ? 'hidden lg:flex' : 'flex'
        )}>
          {/* Header */}
          <div className="px-4 py-3 border-b bg-white flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <button onClick={() => setSelectedThreadId(null)} className="lg:hidden text-sm text-orange-600">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <Users className="h-4 w-4 text-orange-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-900 truncate">
                  {internalMessages?.thread?.company_name ?? 'Team Discussion'}
                </p>
                <p className="text-xs text-zinc-500 truncate">{internalMessages?.thread?.title ?? ''}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setAiPanelOpen(v => !v)}
                className={cn(
                  'p-2 rounded-lg transition-colors',
                  aiPanelOpen ? 'bg-violet-100 text-violet-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'
                )}
                title="AI Assistant"
              >
                <Sparkles className="h-4 w-4" />
              </button>
              <button
                onClick={() => resolveThread(selectedThreadId, !internalMessages?.thread?.resolved_at)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                  internalMessages?.thread?.resolved_at
                    ? 'bg-green-50 text-green-700 hover:bg-green-100'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                )}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {internalMessages?.thread?.resolved_at ? 'Resolved' : 'Resolve'}
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors">
                    <MoreVertical className="h-4 w-4" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="min-w-[160px] rounded-lg bg-white shadow-lg border border-zinc-200 py-1 z-50"
                    align="end"
                    sideOffset={4}
                  >
                    <DropdownMenu.Item
                      className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 cursor-pointer outline-none"
                      onClick={() => deleteThread(selectedThreadId)}
                    >
                      <X className="h-3.5 w-3.5" />
                      Delete Thread
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-zinc-50/50">
            {internalMessagesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              </div>
            ) : (
              <>
                {/* Source message card */}
                {internalMessages?.thread?.source_message && (
                  <div className="bg-white border border-zinc-200 rounded-lg p-3 mb-4">
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">Original Message</p>
                    <p className="text-sm text-zinc-700 whitespace-pre-wrap">{internalMessages.thread.source_message}</p>
                  </div>
                )}
                {internalMessages?.messages?.map(msg => {
                  // Simple heuristic: first admin user = blue, second = green
                  const isFirstSender = msg.sender_name === internalMessages.messages[0]?.sender_name
                  return (
                    <div key={msg.id} className={cn('flex', isFirstSender ? 'justify-end' : 'justify-start')}>
                      <div className={cn(
                        'max-w-[75%] rounded-xl px-4 py-2.5',
                        isFirstSender
                          ? 'bg-blue-600 text-white'
                          : 'bg-emerald-600 text-white'
                      )}>
                        <p className="text-[10px] font-semibold opacity-70 mb-0.5">{msg.sender_name}</p>
                        {msg.attachment_url && (() => {
                          const ext = msg.attachment_url.split('?')[0].split('.').pop()?.toLowerCase() || ''
                          const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext)
                          return isImg ? (
                            <a href={msg.attachment_url} target="_blank" rel="noopener noreferrer" className="block mb-1">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={msg.attachment_url} alt={msg.attachment_name || 'Image'} className="max-w-[200px] rounded-lg" loading="lazy" />
                            </a>
                          ) : (
                            <a href={msg.attachment_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-1 bg-white/20 hover:bg-white/30">
                              <FileText className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{msg.attachment_name || 'Attachment'}</span>
                            </a>
                          )
                        })()}
                        {msg.message && <p className="text-sm whitespace-pre-wrap break-words">{msg.message}</p>}
                        <p className="text-xs mt-1 opacity-50 text-right">
                          {format(parseISO(msg.created_at), 'MMM d, h:mm a')}
                        </p>
                      </div>
                    </div>
                  )
                })}
                <div ref={internalMessagesEndRef} />
              </>
            )}
          </div>

          {/* Internal file preview */}
          {internalPendingFile && (
            <div className="px-4 py-2 border-t border-orange-100 bg-orange-50/50 flex items-center gap-3">
              {internalPendingFile.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={internalPendingFile.previewUrl} alt={internalPendingFile.file.name} className="h-12 w-12 rounded object-cover border border-zinc-200 shrink-0" />
              ) : (
                <div className="h-12 w-12 rounded border border-zinc-200 bg-white flex items-center justify-center shrink-0">
                  <FileText className="h-5 w-5 text-zinc-400" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-zinc-700 truncate">{internalPendingFile.file.name}</p>
                <p className="text-[10px] text-zinc-400">{formatFileSize(internalPendingFile.file.size)}</p>
              </div>
              <button onClick={() => { setInternalPendingFile(null); if (internalFileRef.current) internalFileRef.current.value = '' }} className="p-1 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Internal input */}
          <div className={cn('p-4 border-t bg-white shrink-0', internalPendingFile && 'border-t-0')}>
            <div className="flex gap-2 items-end">
              {/* Paperclip */}
              <button
                onClick={() => internalFileRef.current?.click()}
                disabled={internalUploading}
                className={cn(
                  'p-3 rounded-lg transition-colors shrink-0',
                  internalPendingFile
                    ? 'text-orange-600 bg-orange-100 hover:bg-orange-200'
                    : 'text-zinc-400 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50'
                )}
                title="Attach file"
              >
                {internalUploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
              </button>
              <input
                ref={internalFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={e => { if (e.target.files?.[0]) handleInternalFileSelect(e.target.files[0]) }}
                className="hidden"
              />
              {/* Emoji button */}
              <div className="relative" ref={internalEmojiPickerRef}>
                <button
                  onClick={() => setShowInternalEmojiPicker(v => !v)}
                  className="p-3 rounded-lg text-zinc-400 bg-zinc-100 hover:bg-zinc-200 transition-colors shrink-0"
                  title="Emoji"
                >
                  <Smile className="h-5 w-5" />
                </button>
                {showInternalEmojiPicker && (
                  <div className="absolute bottom-14 left-0 z-30">
                    <EmojiPicker
                      onEmojiClick={(emojiData: { emoji: string }) => {
                        const ref = internalInputRef.current
                        if (ref) {
                          const start = ref.selectionStart ?? internalReplyText.length
                          const end = ref.selectionEnd ?? start
                          const newText = internalReplyText.slice(0, start) + emojiData.emoji + internalReplyText.slice(end)
                          setInternalReplyText(newText)
                          setShowInternalEmojiPicker(false)
                          requestAnimationFrame(() => { ref.focus(); ref.setSelectionRange(start + emojiData.emoji.length, start + emojiData.emoji.length) })
                        } else {
                          setInternalReplyText(prev => prev + emojiData.emoji)
                          setShowInternalEmojiPicker(false)
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
                ref={internalInputRef}
                value={internalReplyText}
                onChange={e => setInternalReplyText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInternalMessage() } }}
                rows={1}
                placeholder={internalIsRecording ? 'Recording...' : 'Team message...'}
                className={cn(
                  "flex-1 min-w-0 px-4 py-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none overflow-y-auto",
                  internalIsRecording && "ring-2 ring-red-300 bg-red-50/50"
                )}
              />
              {/* Mic */}
              {micSupported && (
                internalIsRecording ? (
                  <button onClick={internalStopRecording} className="p-3 rounded-lg bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse transition-all shrink-0" title="Stop recording">
                    <Square className="h-5 w-5 fill-current" />
                  </button>
                ) : internalIsTranscribing ? (
                  <button disabled className="p-3 rounded-lg bg-blue-100 text-blue-500 shrink-0">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </button>
                ) : (
                  <button onClick={internalStartRecording} className="p-3 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-blue-100 hover:text-blue-600 transition-colors shrink-0" title="Voice input">
                    <Mic className="h-5 w-5" />
                  </button>
                )
              )}
              {/* Send */}
              <button
                onClick={sendInternalMessage}
                disabled={(!internalReplyText.trim() && !internalPendingFile) || internalUploading}
                className="p-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {internalUploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message thread (client chat) */}
      <div
        className={cn(
          'flex-1 min-w-0 flex flex-col overflow-hidden relative',
          selectedThreadId ? 'hidden' : (!(selectedAccountId || selectedContactId) ? 'hidden lg:flex' : 'flex')
        )}
        onDragOver={handleAdminDragOver}
        onDragLeave={handleAdminDragLeave}
        onDrop={handleAdminDrop}
      >
        {/* Drag overlay */}
        {isDraggingAdmin && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 pointer-events-none">
            <Paperclip className="h-10 w-10 text-blue-400 mb-2" />
            <p className="text-sm font-medium text-blue-600">Drop file to attach</p>
          </div>
        )}
        {!(selectedAccountId || selectedContactId) ? (
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
                onClick={() => { setSelectedAccountId(null); setSelectedContactId(null) }}
                className="lg:hidden text-sm text-blue-600 mb-1"
              >
                &larr; Back
              </button>
              {(() => {
                const threadName = selectedName?.company
                  || threads?.find(t => selectedAccountId ? t.account_id === selectedAccountId : t.contact_id === selectedContactId)?.company_name
                  || 'Chat'
                const contactName = selectedName?.contact
                  || threads?.find(t => selectedAccountId ? t.account_id === selectedAccountId : t.contact_id === selectedContactId)?.contact_name
                return (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-zinc-900">
                        {threadName}
                      </p>
                      {contactName && (
                        <p className="text-xs text-zinc-500">{contactName}</p>
                      )}
                    </div>
                    <button
                      onClick={() => setAiPanelOpen(v => !v)}
                      className={cn(
                        'p-2 rounded-lg transition-colors',
                        aiPanelOpen ? 'bg-violet-100 text-violet-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'
                      )}
                      title="AI Assistant"
                    >
                      <Sparkles className="h-4 w-4" />
                    </button>
                  </div>
                )
              })()}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3">
              {messagesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                </div>
              ) : (
                <>
                {/* Empty conversation — encourage first message */}
                {(!messages || messages.length === 0) && !messagesLoading && (
                  <div className="flex-1 flex items-center justify-center py-12">
                    <div className="text-center">
                      <MessageSquare className="h-10 w-10 text-zinc-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-zinc-500 mb-1">No messages yet</p>
                      <p className="text-xs text-zinc-400">Type a message below to start the conversation</p>
                    </div>
                  </div>
                )}
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
                  const actionButton = (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors shrink-0"
                          title="Actions"
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          className="z-50 w-48 py-1 bg-white rounded-lg shadow-lg border text-sm animate-in fade-in-0 zoom-in-95"
                          sideOffset={4}
                          collisionPadding={8}
                          align={isAdmin ? 'end' : 'start'}
                        >
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                            onSelect={() => { setReplyToMsg({ id: msg.id, message: msg.message, sender_type: msg.sender_type }); inputRef.current?.focus() }}
                          >
                            <Reply className="h-3.5 w-3.5 text-zinc-400" /> Reply
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                            onSelect={() => { const acctId = selectedAccountId; if (acctId) createInternalThread(acctId, msg.id, msg.message) }}
                          >
                            <Users className="h-3.5 w-3.5 text-zinc-400" /> Discuss with Team
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                            onSelect={() => setQuickCreate({ type: 'task', messageText: msg.message })}
                          >
                            <ClipboardList className="h-3.5 w-3.5 text-zinc-400" /> Create Task
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                            onSelect={() => setQuickCreate({ type: 'sd', messageText: msg.message })}
                          >
                            <Truck className="h-3.5 w-3.5 text-zinc-400" /> Create Service
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                            onSelect={() => setQuickCreate({ type: 'invoice', messageText: msg.message })}
                          >
                            <Receipt className="h-3.5 w-3.5 text-zinc-400" /> Create Invoice
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  )

                  return (
                    <div key={msg.id} className={cn('flex items-end gap-1', isAdmin ? 'justify-end' : 'justify-start')}>
                      {isAdmin && actionButton}
                      <div
                        className={cn(
                          'max-w-[75%] rounded-xl px-4 py-2.5 overflow-hidden',
                          isAdmin
                            ? 'bg-blue-600 text-white'
                            : 'bg-zinc-100 text-zinc-900'
                        )}
                      >
                        {/* Sender name for client messages (shows member name in MMLLC) */}
                        {!isAdmin && msg.sender_name && (
                          <p className="text-[10px] font-semibold text-zinc-500 mb-0.5">{msg.sender_name}</p>
                        )}
                        {/* Quoted reply */}
                        {replyRef && (
                          <div className={cn(
                            'px-2.5 py-1.5 rounded-lg text-xs mb-1.5 border-l-2',
                            isAdmin
                              ? 'bg-blue-500/30 border-blue-300 text-blue-100'
                              : 'bg-zinc-200 border-zinc-400 text-zinc-600'
                          )}>
                            <p className="font-medium text-[10px] mb-0.5">
                              {replyRef.sender_type === 'admin' ? 'You' : (replyRef.sender_name || 'Client')}
                            </p>
                            <p className="line-clamp-2">{replyRef.message || '[Attachment]'}</p>
                          </div>
                        )}
                        {msg.attachment_url && (
                          (() => {
                            const ext = msg.attachment_url.split('?')[0].split('.').pop()?.toLowerCase() || ''
                            const isImg = ['jpg','jpeg','png','gif','webp','svg','heic','bmp'].includes(ext)
                            return isImg ? (
                              <a href={msg.attachment_url} target="_blank" rel="noopener noreferrer" className="block mb-1">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={msg.attachment_url} alt={msg.attachment_name || 'Image'} className="max-w-[200px] rounded-lg" loading="lazy" />
                              </a>
                            ) : (
                              <a
                                href={msg.attachment_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={cn(
                                  'flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-1',
                                  isAdmin ? 'bg-blue-500/30 hover:bg-blue-500/40' : 'bg-zinc-200 hover:bg-zinc-300'
                                )}
                              >
                                <FileText className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{msg.attachment_name || 'Attachment'}</span>
                              </a>
                            )
                          })()
                        )}
                        <p className="text-sm whitespace-pre-wrap break-words" style={{ overflowWrap: 'anywhere' }}>{msg.message}</p>
                        <p className={cn(
                          'text-xs mt-1 flex items-center gap-1',
                          isAdmin ? 'text-blue-200 justify-end' : 'text-zinc-400'
                        )}>
                          {format(parseISO(msg.created_at), 'MMM d, h:mm a')}
                          {isAdmin && (
                            <span title={msg.read_at ? `Read by client: ${format(parseISO(msg.read_at), 'MMM d, h:mm a')}` : 'Not read yet'}>
                              <CheckCheck className={cn(
                                'h-3 w-3',
                                msg.read_at ? 'text-green-300' : 'text-blue-200/50'
                              )} />
                            </span>
                          )}
                        </p>
                      </div>
                      {!isAdmin && actionButton}
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

            {/* File preview strip */}
            {pendingAdminFile && (
              <div className="px-4 py-2 border-t border-zinc-100 bg-zinc-50 flex items-center gap-3 shrink-0">
                {pendingAdminFile.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={pendingAdminFile.previewUrl} alt={pendingAdminFile.file.name} className="h-12 w-12 rounded object-cover border border-zinc-200 shrink-0" />
                ) : (
                  <div className="h-12 w-12 rounded border border-zinc-200 bg-white flex items-center justify-center shrink-0">
                    <FileText className="h-5 w-5 text-zinc-400" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-zinc-700 truncate">{pendingAdminFile.file.name}</p>
                  <p className="text-[10px] text-zinc-400">{formatFileSize(pendingAdminFile.file.size)}</p>
                </div>
                <button
                  onClick={() => { setPendingAdminFile(null); if (adminFileRef.current) adminFileRef.current.value = '' }}
                  className="p-1 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Reply input — WhatsApp-style pill + action button */}
            <div className={cn('p-2 sm:p-3 border-t bg-white shrink-0', (replyToMsg || pendingAdminFile) && 'border-t-0')}>
              <div className="flex gap-2 items-end">
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
                              const start = ref.selectionStart ?? replyText.length
                              const end = ref.selectionEnd ?? start
                              const newText = replyText.slice(0, start) + emojiData.emoji + replyText.slice(end)
                              setReplyText(newText)
                              setShowEmojiPicker(false)
                              requestAnimationFrame(() => { ref.focus(); ref.setSelectionRange(start + emojiData.emoji.length, start + emojiData.emoji.length) })
                            } else {
                              setReplyText(prev => prev + emojiData.emoji)
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
                    onClick={() => adminFileRef.current?.click()}
                    disabled={uploadingAdminFile}
                    className={cn(
                      'p-2 rounded-full transition-colors shrink-0',
                      pendingAdminFile
                        ? 'text-blue-600 bg-blue-100 hover:bg-blue-200'
                        : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'
                    )}
                    title="Attach file"
                  >
                    {uploadingAdminFile ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
                  </button>
                  <input
                    ref={adminFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={e => { if (e.target.files?.[0]) handleAdminFileSelect(e.target.files[0]) }}
                    className="hidden"
                  />
                  {/* Textarea */}
                  <textarea
                    ref={inputRef}
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                    rows={1}
                    placeholder={isRecording ? 'Recording...' : 'Type a message...'}
                    className="flex-1 min-w-0 px-1 py-2.5 text-base bg-transparent border-none focus:outline-none focus:ring-0 resize-none overflow-y-auto max-h-[120px] placeholder:text-zinc-400"
                  />
                  {/* Polish button — inside pill, shows when text */}
                  {replyText.trim() && (
                    <button
                      onClick={handlePolish}
                      disabled={polishing}
                      className="p-2 rounded-full bg-violet-100 text-violet-600 hover:bg-violet-200 disabled:opacity-50 transition-colors shrink-0"
                      title="AI Polish — clean up grammar and make it professional"
                    >
                      {polishing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}
                    </button>
                  )}
                  {replyText.length > 4500 && (
                    <span className={cn('text-xs self-center pr-1', replyText.length > 5000 ? 'text-red-500' : 'text-zinc-400')}>
                      {replyText.length}/5000
                    </span>
                  )}
                </div>
                {/* Action button — Send or Mic */}
                {sendMutation.isPending ? (
                  <button disabled className="w-12 h-12 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </button>
                ) : (replyText.trim() || pendingAdminFile) ? (
                  <button
                    onClick={handleSend}
                    disabled={uploadingAdminFile}
                    className="w-12 h-12 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center shrink-0 transition-colors"
                  >
                    <Send className="h-5 w-5" />
                  </button>
                ) : isRecording ? (
                  <button
                    onClick={stopRecording}
                    className="w-12 h-12 rounded-full bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse flex items-center justify-center shrink-0 transition-all"
                    title="Stop recording"
                  >
                    <Square className="h-5 w-5 fill-current" />
                  </button>
                ) : isTranscribing ? (
                  <button disabled className="w-12 h-12 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center shrink-0">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </button>
                ) : micSupported ? (
                  <button
                    onClick={startRecording}
                    className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-600 hover:bg-blue-100 hover:text-blue-600 flex items-center justify-center shrink-0 transition-colors"
                    title="Voice input"
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
          </>
        )}
      </div>

      {/* New Chat / New Team Discussion dialog */}
      {newChatOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[70vh]">
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <div className="flex items-center gap-2">
                {sidebarView === 'internal' ? (
                  <>
                    <Users className="h-4 w-4 text-orange-500" />
                    <h2 className="text-sm font-semibold text-zinc-900">New Team Discussion</h2>
                  </>
                ) : (
                  <>
                    <MessageSquare className="h-4 w-4 text-blue-600" />
                    <h2 className="text-sm font-semibold text-zinc-900">New Chat</h2>
                  </>
                )}
              </div>
              <button onClick={() => { setNewChatOpen(false); setNewThreadMode('client'); setNewThreadTitle('') }} className="p-1 rounded hover:bg-zinc-100 text-zinc-500">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Mode toggle — only in internal/team view */}
            {sidebarView === 'internal' && (
              <div className="flex gap-1 px-4 pt-3 pb-1">
                <button
                  onClick={() => setNewThreadMode('client')}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                    newThreadMode === 'client' ? 'bg-orange-100 text-orange-700' : 'text-zinc-500 hover:bg-zinc-100'
                  )}
                >
                  <Building2 className="h-3 w-3 inline mr-1" />
                  Discuss a Client
                </button>
                <button
                  onClick={() => setNewThreadMode('team')}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                    newThreadMode === 'team' ? 'bg-orange-100 text-orange-700' : 'text-zinc-500 hover:bg-zinc-100'
                  )}
                >
                  <Users className="h-3 w-3 inline mr-1" />
                  Team Thread
                </button>
              </div>
            )}

            {/* Team thread mode — title input */}
            {sidebarView === 'internal' && newThreadMode === 'team' ? (
              <div className="px-4 py-3 flex flex-col gap-3">
                <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
                  <FileText className="h-4 w-4 text-zinc-400" />
                  <input
                    type="text"
                    value={newThreadTitle}
                    onChange={(e) => setNewThreadTitle(e.target.value)}
                    placeholder="Thread title (e.g. Tax Season Planning)"
                    className="flex-1 text-sm outline-none bg-transparent"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter' && newThreadTitle.trim()) createTeamThread(newThreadTitle) }}
                  />
                </div>
                <button
                  onClick={() => createTeamThread(newThreadTitle)}
                  disabled={!newThreadTitle.trim() || creatingThread}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {creatingThread ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create Thread
                </button>
              </div>
            ) : (
              <>
                {/* Client search mode (existing behavior) */}
                <div className="flex items-center gap-2 px-4 py-3 border-b">
                  <Search className="h-4 w-4 text-zinc-400" />
                  <input
                    type="text"
                    value={newChatSearch}
                    onChange={(e) => setNewChatSearch(e.target.value)}
                    placeholder={sidebarView === 'internal' ? 'Search client to discuss...' : 'Search client by name or company...'}
                    className="flex-1 text-sm outline-none bg-transparent"
                    autoFocus
                  />
                  {newChatSearching && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
                </div>
                <div className="flex-1 overflow-y-auto divide-y">
                  {newChatResults.length === 0 && newChatSearch.length >= 2 && !newChatSearching && (
                    <div className="px-4 py-8 text-center text-sm text-zinc-400">
                      No active clients found
                    </div>
                  )}
                  {newChatResults.map((acct) => (
                    <button
                      key={acct.id}
                      onClick={() => {
                        if (sidebarView === 'internal') {
                          createInternalThread(acct.id, '', `Discussion about ${acct.company_name}`)
                        } else {
                          setSelectedAccountId(acct.id)
                          setSelectedContactId(null)
                          setSelectedName({ company: acct.company_name, contact: acct.contact_name || undefined })
                        }
                        setNewChatOpen(false)
                      }}
                      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors text-left"
                    >
                      <div className={cn('p-1.5 rounded-full shrink-0 mt-0.5', sidebarView === 'internal' ? 'bg-orange-50' : 'bg-blue-50')}>
                        <Building2 className={cn('h-3.5 w-3.5', sidebarView === 'internal' ? 'text-orange-500' : 'text-blue-500')} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-900">{acct.company_name}</p>
                        {acct.contact_name && (
                          <div className="flex items-center gap-1 text-xs text-zinc-500 mt-0.5">
                            <User className="h-3 w-3" />
                            <span>{acct.contact_name}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Quick-create modal */}
      {quickCreate && selectedAccountId && (
        <QuickCreateModal
          type={quickCreate.type}
          messageText={quickCreate.messageText}
          accountId={selectedAccountId}
          companyName={threads?.find(t => t.account_id === selectedAccountId)?.company_name ?? ''}
          onClose={() => setQuickCreate(null)}
        />
      )}

      {/* AI Assistant side panel */}
      {aiPanelOpen && (selectedAccountId || selectedThreadId) && (
        <div className="w-[320px] lg:w-[360px] shrink-0 border-l flex flex-col bg-white">
          <div className="px-4 py-3 border-b flex items-center justify-between bg-gradient-to-r from-violet-50 to-blue-50">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              <h3 className="text-sm font-semibold text-violet-900">AI Assistant</h3>
            </div>
            <button onClick={() => setAiPanelOpen(false)} className="p-1 rounded hover:bg-violet-100 text-violet-400">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {aiPanelMessages.length === 0 && (
              <div className="text-center py-8">
                <Sparkles className="h-8 w-8 text-violet-200 mx-auto mb-2" />
                <p className="text-sm text-zinc-500">Ask me anything about this client</p>
                <p className="text-xs text-zinc-400 mt-1">I can help draft replies, explain context, or suggest next steps</p>
              </div>
            )}
            {aiPanelMessages.map((msg, i) => (
              <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[90%] rounded-xl px-3.5 py-2.5 text-sm',
                  msg.role === 'user'
                    ? 'bg-violet-600 text-white'
                    : 'bg-zinc-100 text-zinc-800'
                )}>
                  <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                  {msg.role === 'ai' && (
                    <button
                      onClick={() => {
                        if (selectedThreadId) {
                          setInternalReplyText(msg.text)
                          internalInputRef.current?.focus()
                        } else {
                          setReplyText(msg.text)
                          inputRef.current?.focus()
                        }
                        toast.success('Inserted as reply')
                      }}
                      className="mt-2 flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800 font-medium"
                    >
                      <Reply className="h-3 w-3" /> Use as reply
                    </button>
                  )}
                </div>
              </div>
            ))}
            {aiPanelLoading && (
              <div className="flex items-center gap-2 text-violet-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-xs">Thinking...</span>
              </div>
            )}
            <div ref={aiPanelEndRef} />
          </div>
          <div className="p-3 border-t">
            <div className="flex gap-2">
              <textarea
                value={aiPanelInput}
                onChange={e => setAiPanelInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiQuestion() } }}
                rows={1}
                placeholder="Ask AI..."
                className="flex-1 min-w-0 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
              />
              <button
                onClick={sendAiQuestion}
                disabled={!aiPanelInput.trim() || aiPanelLoading}
                className="p-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors shrink-0"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Quick Create Modal ────────────────────────────────────────────

const SERVICE_TYPES = [
  'Company Formation', 'Tax Return', 'EIN', 'ITIN',
  'Banking Fintech', 'Annual Renewal', 'CMRA Mailing Address',
]

const TASK_CATEGORIES = [
  'Client Response', 'Document', 'Filing', 'Follow-up',
  'Payment', 'CRM Update', 'Internal', 'KYC',
  'Shipping', 'Notarization', 'Client Communication',
]

function QuickCreateModal({ type, messageText, accountId, companyName, onClose }: {
  type: 'task' | 'sd' | 'invoice'
  messageText: string
  accountId: string
  companyName: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  // Task fields
  const [taskTitle, setTaskTitle] = useState(messageText.slice(0, 200))
  const [taskDescription, setTaskDescription] = useState(messageText.length > 200 ? messageText : '')
  const [taskPriority, setTaskPriority] = useState('Normal')
  const [taskCategory, setTaskCategory] = useState('Client Communication')
  const [taskAssignedTo, setTaskAssignedTo] = useState('Luca')
  const [taskDueDate, setTaskDueDate] = useState('')
  // SD fields
  const [sdServiceType, setSdServiceType] = useState('Company Formation')
  const [sdNotes, setSdNotes] = useState(messageText.slice(0, 500))
  const [sdAssignedTo, setSdAssignedTo] = useState('Luca')
  // Invoice fields
  const [invDescription, setInvDescription] = useState(messageText.slice(0, 200))
  const [invAmount, setInvAmount] = useState('')
  const [invMemo, setInvMemo] = useState('')

  const handleSubmit = async () => {
    setLoading(true)
    try {
      if (type === 'task') {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_title: taskTitle,
            description: taskDescription || undefined,
            priority: taskPriority,
            category: taskCategory,
            assigned_to: taskAssignedTo,
            due_date: taskDueDate || undefined,
            account_id: accountId,
            status: 'To Do',
          }),
        })
        if (!res.ok) throw new Error('Failed to create task')
        toast.success('Task created')
      } else if (type === 'sd') {
        const res = await fetch('/api/service-deliveries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service_type: sdServiceType,
            account_id: accountId,
            assigned_to: sdAssignedTo,
            notes: sdNotes || undefined,
          }),
        })
        if (!res.ok) throw new Error('Failed to create service delivery')
        toast.success('Service delivery created')
      } else if (type === 'invoice') {
        const res = await fetch('/api/qb/create-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_name: companyName,
            line_items: [{ description: invDescription, amount: Number(invAmount) || 0, quantity: 1 }],
            memo: invMemo || undefined,
          }),
        })
        if (!res.ok) throw new Error('Failed to create invoice')
        toast.success('Invoice created')
      }
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Creation failed')
    } finally {
      setLoading(false)
    }
  }

  const titles = { task: 'Create Task', sd: 'Create Service Delivery', invoice: 'Create Invoice' }
  const icons = { task: ClipboardList, sd: Truck, invoice: Receipt }
  const Icon = icons[type]

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div className="flex items-center gap-2.5">
              <Icon className="h-5 w-5 text-blue-600" />
              <h2 className="text-base font-semibold">{titles[type]}</h2>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-4 w-4" /></button>
          </div>

          {/* Context */}
          <div className="px-5 py-3 bg-zinc-50 border-b">
            <p className="text-xs text-zinc-500">From chat with <span className="font-medium text-zinc-700">{companyName}</span></p>
            <p className="text-xs text-zinc-400 mt-1 line-clamp-2">&ldquo;{messageText.slice(0, 150)}{messageText.length > 150 ? '...' : ''}&rdquo;</p>
          </div>

          {/* Form */}
          <div className="px-5 py-4 space-y-3">
            {type === 'task' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Title *</label>
                  <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Description</label>
                  <textarea value={taskDescription} onChange={e => setTaskDescription(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Priority</label>
                    <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {['Urgent', 'High', 'Normal', 'Low'].map(p => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Assigned to</label>
                    <select value={taskAssignedTo} onChange={e => setTaskAssignedTo(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option>Luca</option>
                      <option>Antonio</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Category</label>
                    <select value={taskCategory} onChange={e => setTaskCategory(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {TASK_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Due date</label>
                    <input type="date" value={taskDueDate} onChange={e => setTaskDueDate(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              </>
            )}

            {type === 'sd' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Service Type *</label>
                  <select value={sdServiceType} onChange={e => setSdServiceType(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {SERVICE_TYPES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Assigned to</label>
                  <select value={sdAssignedTo} onChange={e => setSdAssignedTo(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option>Luca</option>
                    <option>Antonio</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Notes</label>
                  <textarea value={sdNotes} onChange={e => setSdNotes(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
                </div>
              </>
            )}

            {type === 'invoice' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Customer</label>
                  <input value={companyName} disabled className="w-full px-3 py-2 text-sm border rounded-lg bg-zinc-50 text-zinc-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Description *</label>
                  <input value={invDescription} onChange={e => setInvDescription(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Amount ($) *</label>
                  <input type="number" value={invAmount} onChange={e => setInvAmount(e.target.value)} placeholder="0.00" step="0.01" className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Memo</label>
                  <input value={invMemo} onChange={e => setInvMemo(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-5 py-4 border-t">
            <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={loading || (type === 'task' && !taskTitle.trim()) || (type === 'invoice' && (!invDescription.trim() || !invAmount))}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
