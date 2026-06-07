'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Send, Loader2, Building2, Mic, Square, Bell, BellOff, Sparkles, X, Check, Wand2, Search, CheckCheck, ChevronUp, Reply, MoreVertical, ClipboardList, Receipt, Truck, MailOpen, MailCheck, Plus, User, Paperclip, FileText, Smile, Users, CheckCircle2, ArrowLeft, AlertCircle, Clock, Hourglass, RotateCw, Trash2, BookmarkPlus, Pencil, FileSignature, Landmark, Calculator, Home, XCircle, MessageCircle, ChevronDown, Pin } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { useNotificationSound } from '@/lib/hooks/use-notification-sound'
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'
import { ThreadTodoPanel } from '@/components/portal-chats/thread-todo-panel'
import { ThreadWhatsNewPanel } from '@/components/portal-chats/thread-whats-new-panel'
import { sortPortalThreads } from '@/lib/portal-chats/sort-threads'
import { uploadChatAttachment, validateChatAttachment } from '@/lib/portal/chat-attachment'
import { NewCardDialog } from '@/components/dashboard/action-board-new-card-dialog'
import { ChatQuickActionsErrorBoundary } from '@/components/chat/chat-quick-actions-error-boundary'
import { filterForSurfaceAndContext, validateMetadata, type ChatContext, type QuickAction } from '@/lib/chat/quick-actions'
import { createInvoice } from '@/app/(dashboard)/payments/invoice-actions'
import { HelpDot } from '@/components/help/help-dot'
import {
  filterForSurfaceAndContext as filterTopicsForSurfaceAndContext,
  validateMetadata as validateTopicMetadata,
  type TopicTemplate,
} from '@/lib/chat/topic-templates'
import { interpolateBodyTemplate, interpolateStringStrict } from '@/lib/chat/handler-primitives'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

// ─── chat_quick_actions catalog integration (Slice 6b) ──────────────────────
//
// Defense-in-depth: the per-message dropdown's "Create" section can be
// rendered from the chat_quick_actions catalog (catalog-driven, future-flex)
// OR from the hardcoded JSX below (today's known-good behavior). The catalog
// path activates only when ALL of these hold:
//   1. NEXT_PUBLIC_CHAT_QUICK_ACTIONS_CATALOG === 'on' (build-time feature flag)
//   2. The GET endpoint returned at least one valid row (validateMetadata pass)
//   3. ChatQuickActionsErrorBoundary did not catch a render-time crash
// Any of those failing → hardcoded fallback renders. Antonio's daily flow
// never breaks if the catalog goes sideways.
//
// IMPORTANT: only the "Create" section is catalog-driven in Slice 6b. The
// Tag Message, Edit message, and Delete message items in the SAME dropdown
// stay hardcoded (different concept: Tag tracks workflow_state, Edit/Delete
// are content operations). If the mixed style ever bothers a future
// reviewer, see master plan §🔒 Principle of Flexibility — the deferral
// is intentional, not incomplete.
const CHAT_QUICK_ACTIONS_CATALOG_FLAG = process.env.NEXT_PUBLIC_CHAT_QUICK_ACTIONS_CATALOG === 'on'
const CHAT_TOPIC_TEMPLATES_CATALOG_FLAG = process.env.NEXT_PUBLIC_CHAT_TOPIC_TEMPLATES_CATALOG === 'on'

/** Modal + icon registries — components mounted by the open_modal primitive
 *  and lucide icons referenced from catalog rows. Today only QuickCreateModal
 *  exists for chat_quick_actions. topic_templates icons (FileSignature,
 *  Landmark, Calculator, Home, XCircle, MessageCircle) are imported separately
 *  and added below. */
const ICON_REGISTRY: Record<string, React.ComponentType<{ className?: string }>> = {
  // chat_quick_actions icons (Slice 6a):
  ClipboardList,
  Truck,
  Receipt,
  Plus,
  // topic_templates icons (Slice 7):
  FileSignature,
  Landmark,
  Calculator,
  Home,
  XCircle,
  MessageCircle,
}

interface ChatThread {
  account_id: string | null
  contact_id: string | null
  company_name: string
  contact_name: string | null
  companies: { id: string; name: string }[]
  /** Non-empty for account-level threads (multi-member LLCs) — list of member contacts */
  members: { id: string; name: string }[]
  last_message: string
  last_message_at: string
  unread_count: number
  /** Manually pinned conversation (staff, shared). Pins sort above everything. */
  is_pinned?: boolean
  /** Active service deliveries for this account — sourced live from service_deliveries, fully dynamic */
  active_services: { service_type: string; stage: string | null }[]
}

interface ChatAttachment {
  url: string
  name: string
  mime_type?: string
  size?: number
}

interface ChatMessage {
  id: string
  message: string
  sender_type: 'client' | 'admin' | 'system'
  sender_name?: string | null
  account_id?: string | null
  // PR 2 Step 6 (2026-05-05): tag chosen by sender. NULL = legacy
  // untagged message (pre-PR 2). Renders without a badge.
  sender_context?: 'person' | 'company' | null
  created_at: string
  attachment_url?: string
  attachment_name?: string
  attachments?: ChatAttachment[] | null
  topic?: string | null
  read_at?: string | null
  reply_to_id?: string | null
  deleted_at?: string | null
  deleted_by?: string | null
  edited_at?: string | null
  pinned_at?: string | null
  pinned_by_type?: 'client' | 'staff' | null
}

interface MessageAction {
  id: string
  message_id: string
  contact_id: string | null
  account_id: string | null
  action_type: 'action_needed' | 'in_progress' | 'waiting_on_client' | 'done'
  label: string | null
  created_by: string | null
  resolved_at: string | null
  created_at: string
}

const ACTION_TAG_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  action_needed: { label: 'Action Needed', color: 'text-red-600', bg: 'bg-red-100', icon: AlertCircle },
  in_progress: { label: 'In Progress', color: 'text-blue-600', bg: 'bg-blue-100', icon: Clock },
  waiting_on_client: { label: 'Waiting on Client', color: 'text-amber-600', bg: 'bg-amber-100', icon: Hourglass },
  done: { label: 'Done', color: 'text-emerald-600', bg: 'bg-emerald-100', icon: CheckCircle2 },
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
  // `?contact=<id>` deep-links a contact-scoped thread (e.g. from the entity
  // summary widget on a contact page). Symmetric with `?account=`; account wins
  // if both are somehow present. See sysdoc notification-center-phase2-cards-summary-plan.
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    urlParams.get('account') ? null : urlParams.get('contact'),
  )
  // Contact_id associated with the currently selected thread — set for BOTH account-
  // and contact-scoped threads so the realtime subscription can listen on BOTH
  // account_id AND contact_id simultaneously, catching all message storage patterns.
  const [selectedThreadContactId, setSelectedThreadContactId] = useState<string | null>(null)
  // `?message=<id>` deep-links to a specific message — used by Notification Center
  // To-Do cards created from a message (the ⋯ → "To Do" action). Once messages for
  // the scoped thread load, we switch to the message's topic, scroll to it, and
  // flash a highlight ring. See message-actions route + action-board card href.
  const [targetMessageId] = useState<string | null>(urlParams.get('message'))
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const didScrollToTargetRef = useRef(false)
  // Unified thread state: which company the admin is sending as, and all companies for badge lookup
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null)
  const [selectedThreadCompanies, setSelectedThreadCompanies] = useState<{ id: string; name: string }[]>([])
  /** Non-empty when selected thread is an account-level (multi-member LLC) thread */
  const [selectedThreadMembers, setSelectedThreadMembers] = useState<{ id: string; name: string }[]>([])
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
  // "To Do" quick action opens this small dialog (pre-filled with the message
  // text) so staff can write/trim the note before the card is created.
  const [todoNote, setTodoNote] = useState<{ messageId: string; note: string } | null>(null)
  const [saveTemplate, setSaveTemplate] = useState<{ messageText: string; title: string } | null>(null)
  const [saveTemplateLoading, setSaveTemplateLoading] = useState(false)
  const [saveTemplatePrompt, setSaveTemplatePrompt] = useState<string | null>(null)
  const [pendingAdminFiles, setPendingAdminFiles] = useState<PendingAdminFile[]>([])
  const [isDraggingAdmin, setIsDraggingAdmin] = useState(false)
  const [uploadingAdminFile, setUploadingAdminFile] = useState(false)
  // Right-pane sub-tab: Messages | What's New (incoming client-action notes) | To Do (cards)
  const [chatViewMode, setChatViewMode] = useState<'messages' | 'whatsnew' | 'todo'>('messages')
  // "Open card" from a What's New note → opens the same dashboard card editor, preset to this client.
  const [cardPreset, setCardPreset] = useState<{
    accountId?: string | null
    contactId?: string | null
    clientName: string
    label?: string
    sourceRef?: string
    noteId?: string // the What's New note this card was opened from (marked handled on save)
  } | null>(null)
  // Internal team chat
  const [sidebarView, setSidebarView] = useState<'chats' | 'internal' | 'actions'>('chats')
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [internalReplyText, setInternalReplyText] = useState('')
  const [internalPendingFile, setInternalPendingFile] = useState<PendingAdminFile | null>(null)
  const [internalUploading, setInternalUploading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
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

  // Message edit state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const prevTotalUnreadRef = useRef(-1)
  const lastSuggestedMsgRef = useRef<string | null>(null)
  const lastSentTextRef = useRef<string>('')
  const queryClient = useQueryClient()
  // Topic-as-thread state for admin
  const [adminActiveTopic, setAdminActiveTopic] = useState<string | null>(null)
  const [adminCreatingTopic, setAdminCreatingTopic] = useState(false)
  const [adminNewTopicInput, setAdminNewTopicInput] = useState('')
  const { playSound } = useNotificationSound()

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    await queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId] })
    await queryClient.invalidateQueries({ queryKey: ['internal-threads'] })
    if (selectedThreadId) {
      await queryClient.invalidateQueries({ queryKey: ['internal-thread-messages', selectedThreadId] })
    }
    setIsRefreshing(false)
  }, [queryClient, selectedAccountId, selectedContactId, selectedThreadId])

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
  } = useVoiceInput({ language: 'en-US', onTranscript: handleTranscript, onError: (msg) => toast.error(msg) })

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
  } = useVoiceInput({ language: 'en-US', onTranscript: handleInternalTranscript, onError: (msg) => toast.error(msg) })

  // Internal file select
  const handleInternalFileSelect = (file: File) => {
    const maxSizeMB = 10
    const maxSize = maxSizeMB * 1024 * 1024
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (file.size > maxSize) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1)
      toast.error(`File too large: ${sizeMB} MB. Maximum allowed: ${maxSizeMB} MB.`)
      return
    }
    if (!allowedTypes.includes(file.type)) { toast.error(`File type not allowed (${file.type || 'unknown'})`); return }
    const isImg = file.type.startsWith('image/')
    if (isImg) {
      const reader = new FileReader()
      reader.onload = () => setInternalPendingFile({ file, previewUrl: reader.result as string })
      reader.readAsDataURL(file)
    } else {
      setInternalPendingFile({ file })
    }
  }

  useEffect(() => {
    setIsMobile(window.matchMedia('(pointer: coarse)').matches)
  }, [])

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
    refetchInterval: 60_000, // fallback reconciliation; realtime thread-list subscription below is primary
  })

  type OpenAction = {
    id: string
    action_type: string
    label: string | null
    updated_at: string | null
    message_id: string | null
    account_id: string | null
    contact_id: string | null
    portal_messages: { message: string } | null
    accounts: { company_name: string } | null
    contacts: { full_name: string } | null
  }
  const { data: openActions, isLoading: openActionsLoading } = useQuery<OpenAction[]>({
    queryKey: ['open-message-actions'],
    queryFn: () => fetch('/api/crm/admin-actions/message-actions?open=true').then(r => r.json()).then(d => d.actions || []),
    refetchInterval: 30_000,
    enabled: sidebarView === 'actions',
  })
  // Board columns (catalog-driven) so the Actions list mirrors the dashboard
  // board — including custom columns like "Wait for the IRS".
  type ActionBoardCol = { slug: string; display_name: string; order: number; terminal: boolean }
  const { data: actionBoardColumns } = useQuery<ActionBoardCol[]>({
    queryKey: ['action-board-columns'],
    queryFn: () => fetch('/api/crm/admin-actions/message-actions?columns=true').then(r => r.json()).then(d => d.columns || []),
    refetchInterval: 60_000,
  })


  // Per-thread PURPLE dot = count of UNHANDLED "What's New" notes (incoming
  // client-action notifications not yet triaged). Ticking a note handled — or
  // opening a card from it — drops it off; unticking brings it back. This is a
  // "needs a look" signal, NOT the tasks table (legacy orange dot) and NOT the
  // open-card count: it clears once you've dealt with the new thing.
  const { data: whatsNewCounts } = useQuery<{
    by_account: Record<string, number>
    by_contact: Record<string, number>
    total: number
  }>({
    queryKey: ['portal-chat-whats-new-counts'],
    queryFn: () => fetch('/api/crm/admin-actions/whats-new?counts=true').then(r => r.json()),
    refetchInterval: 30_000,
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
    refetchInterval: 30_000, // fallback reconciliation; realtime subscription below is primary
  })

  // Topics derived from messages — deduplicated, sorted
  const adminTopics = Array.from(
    new Set((messages ?? []).map(m => m.topic).filter((t): t is string => !!t))
  ).sort()

  // Messages filtered by active topic tab
  const adminFilteredMessages = adminActiveTopic
    ? (messages ?? []).filter(m => m.topic === adminActiveTopic)
    : (messages ?? []).filter(m => !m.topic)

  // Deep-link to a specific message (?message=<id>, set by a Notification Center
  // To-Do card). When the scoped thread's messages have loaded, switch to that
  // message's topic so it renders, scroll it into view, and flash a highlight ring.
  // Runs once per page load (didScrollToTargetRef guard) so a refetch doesn't yank
  // the view back. Missing/old message → no-op, never crashes.
  useEffect(() => {
    if (!targetMessageId || didScrollToTargetRef.current) return
    if (!messages || messages.length === 0) return
    const target = messages.find(m => m.id === targetMessageId)
    if (!target) { didScrollToTargetRef.current = true; return } // outside the loaded window
    didScrollToTargetRef.current = true
    setAdminActiveTopic(target.topic ?? null)
    const flash = window.setTimeout(() => {
      const el = document.getElementById(`pc-msg-${targetMessageId}`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedMessageId(targetMessageId)
      window.setTimeout(() => setHighlightedMessageId(null), 2800)
    }, 120) // let the topic switch re-render the list first
    return () => window.clearTimeout(flash)
  }, [targetMessageId, messages])

  // Unread count per topic tab (client + system messages not yet read by admin).
  // System messages are auto-emitted on client actions (wizard submitted,
  // document uploaded, payment received, etc.) — they must count toward the
  // red badge so staff sees the topic immediately.
  const adminUnreadByTopic = (messages ?? []).reduce<Record<string, number>>((acc, m) => {
    if (m.sender_type === 'admin' || m.read_at) return acc
    const key = m.topic ?? ''
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})

  // Realtime subscription — selected thread messages. Subscribes to portal_messages
  // INSERT/UPDATE events on BOTH account_id AND contact_id so no message is missed
  // regardless of which column was set at write time (MCP tool, dashboard, client portal).
  // Dedup guard (prev.some(m => m.id === newMessage.id)) prevents double-render when
  // a message matches both filters simultaneously.
  useEffect(() => {
    const threadId = selectedAccountId || selectedContactId
    if (!threadId) return
    const primaryColumn = selectedAccountId ? 'account_id' : 'contact_id'
    const supabase = createSupabaseBrowserClient()

    const handleInsert = (payload: { new: unknown }) => {
      const newMessage = payload.new as ChatMessage
      queryClient.setQueryData<ChatMessage[]>(
        ['portal-chat-messages', threadId],
        (prev) => {
          if (!prev) return [newMessage]
          if (prev.some(m => m.id === newMessage.id)) return prev
          return [...prev, newMessage]
        }
      )
    }

    const handleUpdate = (payload: { new: unknown }) => {
      const updated = payload.new as ChatMessage
      queryClient.setQueryData<ChatMessage[]>(
        ['portal-chat-messages', threadId],
        (prev) => prev ? prev.map(m => m.id === updated.id ? { ...m, ...updated } : m) : prev
      )
    }

    let channel = supabase
      .channel(`admin-portal-chat-${threadId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_messages', filter: `${primaryColumn}=eq.${threadId}` }, handleInsert)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'portal_messages', filter: `${primaryColumn}=eq.${threadId}` }, handleUpdate)

    // Secondary subscription: when viewing an account thread, also listen on contact_id
    // so "person"-tagged client messages (account_id=null) are caught immediately.
    // When viewing a contact thread, add account_id subscription if a company is known,
    // catching legacy messages stored with only account_id.
    if (selectedAccountId && selectedThreadContactId) {
      channel = channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_messages', filter: `contact_id=eq.${selectedThreadContactId}` }, handleInsert)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'portal_messages', filter: `contact_id=eq.${selectedThreadContactId}` }, handleUpdate)
    } else if (selectedContactId && selectedCompanyId) {
      channel = channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_messages', filter: `account_id=eq.${selectedCompanyId}` }, handleInsert)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'portal_messages', filter: `account_id=eq.${selectedCompanyId}` }, handleUpdate)
    }

    channel.subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [selectedAccountId, selectedContactId, selectedThreadContactId, selectedCompanyId, queryClient])

  // Realtime subscription — global portal_messages INSERT → invalidate thread list
  // so the sidebar sees new last-message previews and unread badges immediately.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    const channel = supabase
      .channel('admin-portal-chat-thread-list')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'portal_messages',
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  // Realtime subscription — global tasks INSERT/UPDATE/DELETE → invalidate
  // open-task counts + active thread tasks list + fire toast and sound for
  // INSERTs (Phase 2 Layer 1). Covers all task creation paths: sd_advance_stage
  // auto-tasks, the inline Create Task dialog, crm_create_task MCP, and future
  // event-bridge hooks from Phase 4.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    const channel = supabase
      .channel('admin-portal-chat-tasks')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          // Refresh the inline workflow cards shown in What's New (Step 3).
          queryClient.invalidateQueries({ queryKey: ['portal-chat-thread-tasks'] })

          // Toast + sound only on fresh INSERTs (not updates/deletes)
          if (payload.eventType === 'INSERT' && payload.new) {
            const newTask = payload.new as { task_title?: string; account_id?: string; contact_id?: string }
            const threadCompany = threads?.find(t =>
              (newTask.account_id && t.account_id === newTask.account_id)
              || (newTask.contact_id && t.contact_id === newTask.contact_id)
            )?.company_name
            const title = newTask.task_title ?? 'New task'
            const prefix = threadCompany ? `${threadCompany}: ` : ''
            toast(`✅ ${prefix}${title}`, { duration: 6000 })
            playSound()

            // Desktop browser notification (reuses existing permission grant)
            if (notificationsEnabled) {
              try {
                new Notification(`✅ New task${threadCompany ? ' — ' + threadCompany : ''}`, {
                  body: title.slice(0, 120),
                  icon: '/portal-icon-192.png',
                  tag: 'portal-chat-task',
                })
              } catch { /* some browsers block */ }
            }
          }
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient, threads, playSound, notificationsEnabled])

  // Fetch chat_quick_actions catalog (Slice 6b — only when flag is on).
  // Server-side RBAC: endpoint returns only actions allowed for the user's role.
  // Validation: each row's metadata is Zod-validated; malformed rows are dropped.
  // If fetch fails, the catalog path falls back to hardcoded items.
  const { data: catalogActionsRaw } = useQuery<{ actions: unknown[] }>({
    queryKey: ['chat-quick-actions'],
    queryFn: () => fetch('/api/portal/chat/quick-actions').then((r) => {
      if (!r.ok) throw new Error(`quick-actions fetch failed: ${r.status}`)
      return r.json()
    }),
    enabled: CHAT_QUICK_ACTIONS_CATALOG_FLAG,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })

  // Slice 7 — fetch topic_templates catalog (only when flag is on).
  const { data: topicTemplatesRaw } = useQuery<{ templates: unknown[] }>({
    queryKey: ['chat-topic-templates'],
    queryFn: () => fetch('/api/portal/chat/topic-templates').then((r) => {
      if (!r.ok) throw new Error(`topic-templates fetch failed: ${r.status}`)
      return r.json()
    }),
    enabled: CHAT_TOPIC_TEMPLATES_CATALOG_FLAG,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })

  const topicTemplates: TopicTemplate[] = (topicTemplatesRaw?.templates ?? [])
    .map((raw) => {
      const r = raw as { slug?: string; display_name?: string; display_name_translations?: Record<string, string>; description?: string | null; metadata?: unknown }
      if (!r?.slug || typeof r.slug !== 'string') return null
      if (typeof r.display_name !== 'string') return null
      const metadata = validateTopicMetadata(r.metadata)
      if (!metadata) {
        console.warn(`[topic_templates] dropping invalid row: ${r.slug}`)
        return null
      }
      return {
        slug: r.slug,
        display_name: r.display_name,
        display_name_translations: r.display_name_translations ?? {},
        description: r.description ?? null,
        metadata,
      } as TopicTemplate
    })
    .filter((t): t is TopicTemplate => t !== null)

  // Validate every row client-side (defense in depth — server already validates,
  // but if a row was hand-edited via SQL bypass, we drop it here too).
  const catalogActions: QuickAction[] = (catalogActionsRaw?.actions ?? [])
    .map((raw) => {
      const r = raw as { slug?: string; display_name?: string; display_name_translations?: Record<string, string>; description?: string | null; metadata?: unknown }
      if (!r?.slug || typeof r.slug !== 'string') return null
      if (typeof r.display_name !== 'string') return null
      const metadata = validateMetadata(r.metadata)
      if (!metadata) {
        console.warn(`[chat_quick_actions] dropping invalid row: ${r.slug}`)
        return null
      }
      return {
        slug: r.slug,
        display_name: r.display_name,
        display_name_translations: r.display_name_translations ?? {},
        description: r.description ?? null,
        metadata,
      } as QuickAction
    })
    .filter((a): a is QuickAction => a !== null)

  // Fetch message action tags for the selected thread
  const { data: messageActions } = useQuery<MessageAction[]>({
    queryKey: ['message-actions', selectedAccountId || selectedContactId],
    queryFn: () => {
      const param = selectedAccountId ? `account_id=${selectedAccountId}` : `contact_id=${selectedContactId}`
      return fetch(`/api/crm/admin-actions/message-actions?${param}`).then(r => r.json()).then(d => d.actions || [])
    },
    enabled: !!(selectedAccountId || selectedContactId),
    refetchInterval: 10_000,
  })

  // Build a lookup: message_id → action for quick access in render
  const actionsByMessageId = new Map<string, MessageAction>()
  if (messageActions) {
    for (const a of messageActions) {
      actionsByMessageId.set(a.message_id, a)
    }
  }

  // Mutation to tag a message
  const tagMessageMutation = useMutation({
    mutationFn: async ({ messageId, actionType }: { messageId: string; actionType: string }) => {
      const res = await fetch('/api/crm/admin-actions/message-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: messageId,
          contact_id: selectedContactId || null,
          // Contact-scoped threads still belong to a company (single-owner LLC);
          // attach it so the card surfaces on the company's Account page too.
          account_id: selectedAccountId || selectedCompanyId || null,
          action_type: actionType,
        }),
      })
      if (!res.ok) throw new Error('Failed to tag message')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['message-actions', selectedAccountId || selectedContactId] })
      toast.success('Message tagged')
    },
    onError: () => {
      toast.error('Failed to tag message')
    },
  })

  // Create a Notification Center To-Do card FROM a single message. Lands the card
  // in the board's first non-terminal column (action_needed) with message_id set,
  // so the dashboard board card deep-links back to this exact message (?message=).
  // Reuses the message-actions POST (upsert: one card per message) — if the message
  // is already tagged, this re-opens it into action_needed and refreshes the label.
  const addTodoMutation = useMutation({
    mutationFn: async ({ messageId, label }: { messageId: string; label: string }) => {
      const res = await fetch('/api/crm/admin-actions/message-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: messageId,
          contact_id: selectedContactId || null,
          // Contact-scoped threads still belong to a company (single-owner LLC);
          // attach it so the To-Do surfaces on the company's Account page too.
          account_id: selectedAccountId || selectedCompanyId || null,
          action_type: 'action_needed',
          label: label.slice(0, 200) || null,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not add the to-do')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['message-actions', selectedAccountId || selectedContactId] })
      queryClient.invalidateQueries({ queryKey: ['open-message-actions'] })
      queryClient.invalidateQueries({ queryKey: ['portal-chat-open-todo-counts'] })
      toast.success('Added to the To-Do board')
    },
    onError: (err) => {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to add the to-do')
    },
  })

  // Soft-delete a message. Client view hides it entirely; admin view renders a tombstone.
  const deleteMessageMutation = useMutation({
    mutationFn: async (messageId: string) => {
      const res = await fetch(`/api/portal/chat/message/${messageId}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Delete failed — please try again.')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId] })
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
      toast.success('Message deleted')
    },
    onError: (err) => {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to delete message')
    },
  })

  const pinMessageMutation = useMutation({
    mutationFn: async ({ messageId, pinned }: { messageId: string; pinned: boolean }) => {
      const res = await fetch(`/api/portal/chat/message/${messageId}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not update pin — please try again.')
      }
      return res.json()
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId] })
      toast.success(vars.pinned ? 'Message pinned' : 'Message unpinned')
    },
    onError: (err) => {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to update pin')
    },
  })

  const pinThreadMutation = useMutation({
    mutationFn: async ({ account_id, contact_id, pinned }: { account_id: string | null; contact_id: string | null; pinned: boolean }) => {
      const res = await fetch('/api/portal/chat/pin-thread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id, contact_id, pinned }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not update pin — please try again.')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    },
    onError: (err) => {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to pin conversation')
    },
  })

  // Scroll a message into view + flash-highlight it (used by the Pinned strip).
  const scrollToMessage = (messageId: string) => {
    const el = document.getElementById(`pc-msg-${messageId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightedMessageId(messageId)
    window.setTimeout(() => setHighlightedMessageId(null), 2800)
  }

  const editMessage = async (messageId: string, newText: string) => {
    setEditSaving(true)
    try {
      const res = await fetch(`/api/portal/chat/message/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: newText }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Edit failed — please try again.')
      }
      setEditingMessageId(null)
      queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId] })
      toast.success('Message updated')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to edit message')
    } finally {
      setEditSaving(false)
    }
  }

  // Mark messages as read when admin opens a thread (general tab only)
  useEffect(() => {
    if (!selectedAccountId && !selectedContactId) return
    setAiSuggestion('')
    setReplyToMsg(null)
    lastSuggestedMsgRef.current = null
    const readBody = selectedAccountId
      ? { account_id: selectedAccountId, topic: null }
      : { contact_id: selectedContactId, topic: null }
    fetch('/api/portal/chat/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBody),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    }).catch(() => {})
  }, [selectedAccountId, selectedContactId, queryClient])

  // Mark topic messages as read when admin switches to a named topic tab
  useEffect(() => {
    if (!adminActiveTopic) return
    if (!selectedAccountId && !selectedContactId) return
    const readBody = selectedAccountId
      ? { account_id: selectedAccountId, topic: adminActiveTopic }
      : { contact_id: selectedContactId, topic: adminActiveTopic }
    fetch('/api/portal/chat/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBody),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    }).catch(() => {})
  }, [adminActiveTopic, selectedAccountId, selectedContactId, queryClient])

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
      const accountId = selectedCompanyId || selectedAccountId || (selectedThreadId ? internalMessages?.thread?.account_id : null)
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
    const totalNew = whatsNewCounts?.total ?? 0

    // Tab title: unread messages + unhandled What's New items.
    // Format: (52/3) Portal Chats — 52 unread messages, 3 new things to look at.
    // Omits each segment when its count is zero.
    if (totalUnread > 0 && totalNew > 0) {
      document.title = `(${totalUnread}/${totalNew}) Portal Chats`
    } else if (totalUnread > 0) {
      document.title = `(${totalUnread}) Portal Chats`
    } else if (totalNew > 0) {
      document.title = `(${totalNew} new) Portal Chats`
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
  }, [threads, whatsNewCounts?.total, playSound, notificationsEnabled])

  // Reset tab title on unmount
  useEffect(() => {
    return () => { document.title = 'Portal Chats' }
  }, [])

  // Send reply
  const sendMutation = useMutation({
    mutationFn: async ({ message, reply_to_id, attachments }: { message: string; reply_to_id?: string; attachments?: { url: string; name: string }[] }) => {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(selectedAccountId
            ? { account_id: selectedAccountId }
            : {
                contact_id: selectedContactId,
                ...(selectedCompanyId ? { account_id: selectedCompanyId } : {}),
              }
          ),
          message, reply_to_id, attachments,
          topic: adminActiveTopic || undefined,
        }),
      })
      if (!res.ok) throw new Error('Failed to send')
      return res.json()
    },
    onSuccess: async () => {
      const sentText = lastSentTextRef.current
      setReplyText('')
      setReplyToMsg(null)
      setPendingAdminFiles([])
      // Prompt to save as template only for substantive replies (>40 chars)
      if (sentText.trim().length > 40) setSaveTemplatePrompt(sentText.trim())
      const readBody = selectedAccountId
        ? { account_id: selectedAccountId }
        : { contact_id: selectedContactId }
      try {
        await fetch('/api/portal/chat/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readBody),
        })
      } catch { /* non-fatal */ }
      queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId] })
      queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
    },
  })

  // Reset topic when thread changes
  useEffect(() => {
    setAdminActiveTopic(null)
    setAdminCreatingTopic(false)
    setAdminNewTopicInput('')
  }, [selectedAccountId, selectedContactId])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-grow textareas
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.max(44, Math.min(el.scrollHeight, 300)) + 'px'
  }, [replyText])

  useEffect(() => {
    const el = internalInputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.max(44, Math.min(el.scrollHeight, 300)) + 'px'
  }, [internalReplyText])

  const MAX_ADMIN_ATTACHMENTS = 5
  const handleAdminFileSelect = (file: File) => {
    const validationError = validateChatAttachment(file.name, file.size, file.type)
    if (validationError) {
      toast.error(validationError)
      return
    }
    setPendingAdminFiles(prev => {
      if (prev.length >= MAX_ADMIN_ATTACHMENTS) {
        toast.error(`Maximum ${MAX_ADMIN_ATTACHMENTS} files per message.`)
        return prev
      }
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = e => setPendingAdminFiles(p => [...p, { file, previewUrl: e.target?.result as string }])
        reader.readAsDataURL(file)
        return prev
      }
      return [...prev, { file }]
    })
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
    Array.from(e.dataTransfer.files).forEach(file => handleAdminFileSelect(file))
  }

  const handleSend = async () => {
    if ((!replyText.trim() && pendingAdminFiles.length === 0) || (!selectedAccountId && !selectedContactId) || sendMutation.isPending || uploadingAdminFile) return
    if (isRecording) stopRecording()
    if (inputRef.current) inputRef.current.style.height = 'auto'
    lastSentTextRef.current = replyText.trim()

    if (pendingAdminFiles.length > 0) {
      setUploadingAdminFile(true)
      try {
        const uploaded = await Promise.all(pendingAdminFiles.map((pf) =>
          uploadChatAttachment(pf.file, {
            accountId: selectedAccountId || undefined,
            contactId: selectedAccountId ? undefined : selectedContactId,
          })
        ))
        sendMutation.mutate({ message: replyText.trim(), reply_to_id: replyToMsg?.id, attachments: uploaded })
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Failed to upload file')
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

  const markAsUnread = async (thread: { account_id: string | null; contact_id: string | null }) => {
    const body = thread.account_id
      ? { account_id: thread.account_id }
      : { contact_id: thread.contact_id }
    await fetch('/api/portal/chat/unread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] })
  }

  const handleSaveTemplate = async () => {
    if (!saveTemplate || saveTemplateLoading) return
    setSaveTemplateLoading(true)
    try {
      const body: Record<string, string> = { message_text: saveTemplate.messageText, title: saveTemplate.title }
      if (selectedAccountId) body.account_id = selectedAccountId
      else if (selectedContactId) body.contact_id = selectedContactId
      const res = await fetch('/api/portal/chat/save-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) {
        toast.error(`Already saved as "${data.existing_title}"`)
      } else if (!res.ok) {
        toast.error(data.error || 'Failed to save template')
      } else {
        toast.success('Saved to AI knowledge base')
        setSaveTemplate(null)
      }
    } catch {
      toast.error('Failed to save template')
    } finally {
      setSaveTemplateLoading(false)
    }
  }

  const markAsRead = async (thread: { account_id: string | null; contact_id: string | null }) => {
    const body = thread.account_id
      ? { account_id: thread.account_id }
      : { contact_id: thread.contact_id }
    await fetch('/api/portal/chat/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
          // Filter out accounts that already appear in a unified thread
          const accountIdsInThreads = new Set((threads ?? []).flatMap(t => t.companies?.map(c => c.id) ?? []))
          const extras = (data.accounts ?? []).filter((a: { id: string }) => !accountIdsInThreads.has(a.id))
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
            <h1 className="flex items-center gap-1 text-lg font-semibold text-zinc-900">Portal Chats <HelpDot helpKey="chat.page_tabs" /></h1>
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
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 disabled:opacity-40 transition-colors"
                title="Refresh chats"
              >
                <RotateCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
              </button>
            </div>
          </div>
          {/* Sidebar tabs: Chats | Actions | Team */}
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
              onClick={() => { setSidebarView('actions'); setSelectedAccountId(null); setSelectedContactId(null); setSelectedThreadId(null) }}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors',
                sidebarView === 'actions' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
              )}
            >
              <AlertCircle className="h-3.5 w-3.5" />
              Actions
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
            sortPortalThreads(threads, whatsNewCounts).filter(t => {
              if (!chatSearch.trim()) return true
              const q = chatSearch.toLowerCase()
              return (t.contact_name || t.company_name).toLowerCase().includes(q) || (t.companies?.some(c => c.name.toLowerCase().includes(q)) ?? false)
            }).map(thread => {
              const threadKey = thread.account_id || thread.contact_id || ''
              const isSelected = thread.account_id
                ? selectedAccountId === thread.account_id
                : selectedContactId === thread.contact_id
              return (
              <button
                key={threadKey}
                onClick={() => {
                  const members = thread.members ?? []
                  const companies = thread.companies ?? []
                  if (thread.account_id && members.length > 0) {
                    // Account-level thread (multi-member LLC): fetch by account_id
                    setSelectedName({ company: thread.contact_name || thread.company_name, contact: members.map(m => m.name).join(' · ') })
                    setSelectedAccountId(thread.account_id)
                    setSelectedContactId(null)
                    setSelectedThreadContactId(thread.contact_id)
                    setSelectedThreadMembers(members)
                    setSelectedThreadCompanies([])
                    setSelectedCompanyId(null)
                  } else {
                    // Contact-level thread: fetch by contact_id
                    setSelectedName({ company: thread.contact_name || thread.company_name, contact: companies.map(c => c.name).join(' · ') || undefined })
                    setSelectedAccountId(null)
                    setSelectedContactId(thread.contact_id)
                    setSelectedThreadContactId(thread.contact_id)
                    setSelectedThreadMembers([])
                    setSelectedThreadCompanies(companies)
                    setSelectedCompanyId(companies[0]?.id ?? null)
                  }
                  setSidebarView('chats')
                }}
                title={thread.contact_name ? `${thread.company_name} — ${thread.contact_name}` : thread.company_name}
                className={cn(
                  'w-full px-4 py-3 text-left border-b hover:bg-zinc-50 transition-colors',
                  isSelected && 'bg-blue-50 border-l-2 border-l-blue-600'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <User className="h-4 w-4 text-zinc-400 shrink-0" />
                    <div className="min-w-0">
                      {thread.account_id && (thread.members ?? []).length > 0 ? (
                        // Account-level thread: show company name linked to account
                        <Link href={`/accounts/${thread.account_id}`} onClick={e => e.stopPropagation()} className="text-sm font-medium text-zinc-900 truncate block hover:text-blue-600 hover:underline transition-colors">{thread.contact_name || thread.company_name}</Link>
                      ) : thread.contact_id ? (
                        <Link href={`/contacts/${thread.contact_id}`} onClick={e => e.stopPropagation()} className="text-sm font-medium text-zinc-900 truncate block hover:text-blue-600 hover:underline transition-colors">{thread.contact_name || thread.company_name}</Link>
                      ) : (
                        <span className="text-sm font-medium text-zinc-900 truncate block">{thread.contact_name || thread.company_name}</span>
                      )}
                      {/* Account-level: show member names as pills */}
                      {(thread.members ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {thread.members.map(m => (
                            <Link key={m.id} href={`/contacts/${m.id}`} onClick={e => e.stopPropagation()} className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded hover:bg-purple-100 transition-colors truncate max-w-[120px]">{m.name}</Link>
                          ))}
                        </div>
                      )}
                      {/* Contact-level: show company pills */}
                      {(thread.members ?? []).length === 0 && thread.companies?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {thread.companies.map(c => (
                            <Link key={c.id} href={`/accounts/${c.id}`} onClick={e => e.stopPropagation()} className="text-[10px] bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded hover:bg-blue-50 hover:text-blue-600 transition-colors truncate max-w-[120px]">{c.name}</Link>
                          ))}
                        </div>
                      )}
                      {/* Active SD badges — one pill per in-progress service, fully dynamic from DB */}
                      {(thread.active_services ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {thread.active_services.map((sd, i) => (
                            <span key={i} className="inline-flex items-center gap-0.5 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                              {sd.service_type}
                              {sd.stage && <span className="text-amber-500 ml-0.5">· {sd.stage}</span>}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 ml-2 shrink-0">
                    {/* Pin conversation (staff, shared) — pinned threads sort above everything */}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={e => {
                        e.stopPropagation()
                        pinThreadMutation.mutate({ account_id: thread.account_id, contact_id: thread.contact_id, pinned: !thread.is_pinned })
                      }}
                      title={thread.is_pinned ? 'Unpin conversation' : 'Pin conversation to top'}
                      className={cn(
                        'shrink-0 rounded p-0.5 cursor-pointer hover:bg-zinc-200',
                        thread.is_pinned ? 'text-amber-600' : 'text-zinc-300 hover:text-zinc-500'
                      )}
                    >
                      <Pin className={cn('h-3.5 w-3.5', thread.is_pinned && 'fill-amber-500')} />
                    </span>
                    {/* What's New dot: PURPLE pill = UNHANDLED incoming notes for
                        this client. Clears as you tick them handled / open a card;
                        gone at zero. Replaces the legacy orange task dot below. */}
                    {(() => {
                      const newCount = thread.account_id
                        ? whatsNewCounts?.by_account?.[thread.account_id] ?? 0
                        : thread.contact_id
                          ? whatsNewCounts?.by_contact?.[thread.contact_id] ?? 0
                          : 0
                      return newCount > 0 ? (
                        <span
                          className="px-1.5 py-0.5 rounded-full text-xs font-semibold text-white bg-violet-600"
                          title={`${newCount} new item${newCount === 1 ? '' : 's'} to look at`}
                        >
                          {newCount}
                        </span>
                      ) : null
                    })()}
                    {/* (Legacy orange task-count dot retired — purple What's New dot above is the single signal now.) */}
                    {thread.unread_count > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-xs font-semibold bg-blue-600 text-white">
                        {thread.unread_count}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-xs text-zinc-500 truncate flex-1">{thread.last_message}</p>
                  {thread.unread_count > 0 ? (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); markAsRead(thread) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); markAsRead(thread) } }}
                      className="p-1 rounded text-zinc-400 hover:text-blue-600 hover:bg-blue-50 transition-colors shrink-0 ml-1 cursor-pointer"
                      title="Mark as read"
                    >
                      <MailCheck className="h-3 w-3" />
                    </span>
                  ) : (thread.account_id || thread.contact_id) && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); markAsUnread(thread) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); markAsUnread(thread) } }}
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
        ) : sidebarView === 'actions' ? (
        /* Action Items list */
        <div className="flex-1 overflow-y-auto">
          {openActionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : !openActions?.length ? (
            <div className="text-center py-12 px-4">
              <CheckCircle2 className="h-10 w-10 text-zinc-200 mx-auto mb-2" />
              <p className="text-sm text-zinc-400">No open action items</p>
              <p className="text-xs text-zinc-300 mt-1">Tag messages with Action Needed, In Progress, or Waiting on Client to track them here</p>
            </div>
          ) : (
            (() => {
              // Catalog-driven order/labels so this mirrors the dashboard board
              // (incl. custom columns). Falls back to the legacy 3 if the catalog
              // hasn't loaded yet. Terminal (Done) cards are already excluded
              // server-side (open = resolved_at IS NULL).
              const cols = (actionBoardColumns || []).filter(c => !c.terminal).sort((a, b) => a.order - b.order)
              const order: string[] = cols.length ? cols.map(c => c.slug) : ['action_needed', 'in_progress', 'waiting_on_client']
              const nameFor = (slug: string) => cols.find(c => c.slug === slug)?.display_name || ACTION_TAG_CONFIG[slug]?.label || slug
              const grouped = order
                .map(type => ({ type, items: openActions.filter(a => a.action_type === type) }))
                .filter(g => g.items.length > 0)
              return grouped.map(({ type, items }) => {
                const cfg = ACTION_TAG_CONFIG[type]
                const TagIcon = cfg?.icon ?? AlertCircle
                return (
                  <div key={type}>
                    <div className="px-4 py-2 bg-zinc-50 border-b flex items-center gap-2">
                      <TagIcon className={cn('h-3.5 w-3.5', cfg?.color ?? 'text-zinc-500')} />
                      <span className={cn('text-xs font-semibold uppercase tracking-wider', cfg?.color ?? 'text-zinc-600')}>{nameFor(type)}</span>
                      <span className={cn('ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full', cfg?.bg ?? 'bg-zinc-200', cfg?.color ?? 'text-zinc-700')}>{items.length}</span>
                    </div>
                    {items.map(action => {
                      const clientName = action.accounts?.company_name || action.contacts?.full_name || '—'
                      // Staff action cards carry their "what to do" in label; fall back to a message preview.
                      const detail = action.label || action.portal_messages?.message?.slice(0, 90) || '(no details)'
                      return (
                        <button
                          key={action.id}
                          onClick={() => {
                            if (action.account_id) { setSelectedAccountId(action.account_id); setSelectedContactId(null) }
                            else if (action.contact_id) { setSelectedContactId(action.contact_id); setSelectedAccountId(null) }
                            setSidebarView('chats')
                          }}
                          className="w-full px-4 py-3 text-left border-b hover:bg-zinc-50 transition-colors"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-zinc-900 truncate">{clientName}</span>
                            <span className="text-[10px] text-zinc-400 shrink-0 ml-2">
                              {action.updated_at ? format(parseISO(action.updated_at), 'MMM d') : ''}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 line-clamp-2">{detail}</p>
                        </button>
                      )
                    })}
                  </div>
                )
              })
            })()
          )}
        </div>
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
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); sendInternalMessage() } }}
                rows={1}
                placeholder={internalIsRecording ? 'Recording...' : 'Team message...'}
                className={cn(
                  "flex-1 min-w-0 px-4 py-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none overflow-y-auto max-h-[300px]",
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
                onClick={() => { setSelectedAccountId(null); setSelectedContactId(null); setSelectedCompanyId(null); setSelectedThreadCompanies([]); setSelectedThreadMembers([]) }}
                className="lg:hidden text-sm text-blue-600 mb-1"
              >
                &larr; Back
              </button>
              {(() => {
                const currentThread = threads?.find(t => selectedAccountId ? t.account_id === selectedAccountId : t.contact_id === selectedContactId)
                const displayName = selectedName?.company || currentThread?.contact_name || currentThread?.company_name || 'Chat'
                const companies = selectedThreadCompanies.length > 0 ? selectedThreadCompanies : (currentThread?.companies ?? [])
                return (
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      {selectedContactId ? (
                        <Link href={`/contacts/${selectedContactId}`} className="text-sm font-semibold text-zinc-900 hover:text-blue-600 hover:underline transition-colors">
                          {displayName}
                        </Link>
                      ) : selectedAccountId ? (
                        <Link href={`/accounts/${selectedAccountId}`} className="text-sm font-semibold text-zinc-900 hover:text-blue-600 hover:underline transition-colors">
                          {displayName}
                        </Link>
                      ) : (
                        <p className="text-sm font-semibold text-zinc-900">{displayName}</p>
                      )}
                      {companies.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {companies.map(c => (
                            <Link key={c.id} href={`/accounts/${c.id}`} className="text-[10px] bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded hover:bg-blue-50 hover:text-blue-600 transition-colors">{c.name}</Link>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {(selectedAccountId || selectedContactId) && (
                        <button
                          onClick={async () => {
                            await markAsUnread({ account_id: selectedAccountId, contact_id: selectedContactId })
                            toast.success('Marked as unread')
                          }}
                          className="p-2 rounded-lg text-zinc-400 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                          title="Mark this conversation as unread"
                        >
                          <MailOpen className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        onClick={handleRefresh}
                        disabled={isRefreshing}
                        className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 disabled:opacity-40 transition-colors"
                        title="Refresh messages"
                      >
                        <RotateCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
                      </button>
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
                  </div>
                )
              })()}
            </div>

            {/* Sub-tabs: Messages | Tasks (shown when a client thread is selected) */}
            {(selectedAccountId || selectedContactId) && (
              <div className="flex border-b bg-white shrink-0">
                <button
                  onClick={() => setChatViewMode('messages')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
                    chatViewMode === 'messages'
                      ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/30'
                      : 'text-zinc-500 hover:text-zinc-700 border-b-2 border-transparent'
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Messages
                </button>
                {(() => {
                  // Count for THIS thread only — not the global total. Mirrors the
                  // conversation-list dot (by_account / by_contact). Using
                  // whatsNewCounts.total here would show the global count on every
                  // client's tab (the "70 on one company" bug).
                  const threadNew = selectedAccountId
                    ? (whatsNewCounts?.by_account?.[selectedAccountId] ?? 0)
                    : selectedContactId
                      ? (whatsNewCounts?.by_contact?.[selectedContactId] ?? 0)
                      : 0
                  const isActive = chatViewMode === 'whatsnew'
                  // When unhandled items exist and this tab isn't selected, draw
                  // attention with a pulsing amber background + a count badge.
                  const inactiveCls = threadNew > 0
                    ? 'text-amber-700 bg-amber-100/70 border-b-2 border-amber-300 animate-pulse'
                    : 'text-zinc-500 hover:text-zinc-700 border-b-2 border-transparent'
                  return (
                    <button
                      onClick={() => setChatViewMode('whatsnew')}
                      className={cn(
                        'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
                        isActive
                          ? 'text-amber-600 border-b-2 border-amber-500 bg-amber-50/30'
                          : inactiveCls
                      )}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      What&apos;s New
                      {threadNew > 0 && (
                        <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full text-[9px] font-bold bg-amber-500 text-white">
                          {threadNew > 999 ? '999+' : threadNew}
                        </span>
                      )}
                    </button>
                  )
                })()}
                <button
                  onClick={() => setChatViewMode('todo')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
                    chatViewMode === 'todo'
                      ? 'text-violet-600 border-b-2 border-violet-600 bg-violet-50/30'
                      : 'text-zinc-500 hover:text-zinc-700 border-b-2 border-transparent'
                  )}
                >
                  <ClipboardList className="h-3.5 w-3.5" />
                  To Do
                </button>
                <div className="flex items-center px-2 shrink-0">
                  <HelpDot helpKey="chat.tabs" />
                </div>
              </div>
            )}

            {/* Topic tabs — always visible when a thread is selected and we're in messages view */}
            {chatViewMode === 'messages' && (selectedAccountId || selectedContactId) && (
              <div className="px-3 py-1.5 border-b bg-white flex items-center gap-1.5 overflow-x-auto shrink-0">
                <HelpDot helpKey="chat.topics" className="shrink-0" />
                <button
                  onClick={() => setAdminActiveTopic(null)}
                  className={cn(
                    'shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full transition-colors border font-medium',
                    adminActiveTopic === null
                      ? 'bg-zinc-900 text-white border-zinc-900'
                      : 'text-zinc-600 border-zinc-200 hover:bg-zinc-100'
                  )}
                >
                  Topic
                  {(adminUnreadByTopic[''] ?? 0) > 0 && (
                    <span className={cn(
                      'inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full text-[9px] font-bold',
                      adminActiveTopic === null ? 'bg-white text-zinc-900' : 'bg-red-500 text-white'
                    )}>
                      {adminUnreadByTopic['']}
                    </span>
                  )}
                </button>
                {adminTopics.map(tp => (
                  <button
                    key={tp}
                    onClick={() => setAdminActiveTopic(tp === adminActiveTopic ? null : tp)}
                    className={cn(
                      'shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full transition-colors border font-medium',
                      adminActiveTopic === tp
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'text-zinc-600 border-zinc-200 hover:bg-zinc-100'
                    )}
                  >
                    {tp}
                    {(adminUnreadByTopic[tp] ?? 0) > 0 && (
                      <span className={cn(
                        'inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full text-[9px] font-bold',
                        adminActiveTopic === tp ? 'bg-white text-blue-600' : 'bg-red-500 text-white'
                      )}>
                        {adminUnreadByTopic[tp]}
                      </span>
                    )}
                  </button>
                ))}
                {adminCreatingTopic ? (
                  <input
                    autoFocus
                    type="text"
                    value={adminNewTopicInput}
                    onChange={e => setAdminNewTopicInput(e.target.value.slice(0, 100))}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && adminNewTopicInput.trim()) {
                        setAdminActiveTopic(adminNewTopicInput.trim())
                        setAdminNewTopicInput('')
                        setAdminCreatingTopic(false)
                      } else if (e.key === 'Escape') {
                        setAdminNewTopicInput('')
                        setAdminCreatingTopic(false)
                      }
                    }}
                    onBlur={() => {
                      if (adminNewTopicInput.trim()) setAdminActiveTopic(adminNewTopicInput.trim())
                      setAdminNewTopicInput('')
                      setAdminCreatingTopic(false)
                    }}
                    placeholder="Topic name…"
                    className="shrink-0 px-2.5 py-1 text-[11px] rounded-full border border-blue-300 outline-none bg-white text-zinc-800 placeholder:text-zinc-400 w-32"
                  />
                ) : (
                  (() => {
                    // Slice 7 — topic_templates catalog integration with 3-layer fallback.
                    // Default UX (flag off OR fetch fail OR validation fail OR render crash):
                    // the existing free-text "Create a new topic" button below. Catalog path:
                    // dropdown of templates + "Custom..." fallback that reveals the same input.
                    const hardcodedButton = (
                      <button
                        onClick={() => setAdminCreatingTopic(true)}
                        className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-full border border-dashed border-zinc-300 text-zinc-500 hover:text-zinc-700 hover:border-zinc-400 transition-colors"
                      >
                        <Plus className="h-3 w-3" />
                        Create a new topic
                      </button>
                    )

                    if (!CHAT_TOPIC_TEMPLATES_CATALOG_FLAG) return hardcodedButton
                    if (!topicTemplatesRaw || topicTemplates.length === 0) return hardcodedButton

                    const topicCtx = {
                      account_id: selectedAccountId,
                      contact_id: selectedContactId,
                      thread_id: selectedThreadId,
                    }
                    const items = filterTopicsForSurfaceAndContext(topicTemplates, 'portal_chat_topic_create', topicCtx)
                    if (items.length === 0) return hardcodedButton

                    const dispatchTopic = async (template: TopicTemplate) => {
                      const h = template.metadata.handler
                      if (h.kind !== 'api_call') {
                        console.warn(`[topic dispatch] unsupported handler kind for ${template.slug}:`, h.kind)
                        return
                      }
                      const url = interpolateStringStrict(h.url_template, topicCtx)
                      if (!url) {
                        toast.error('Missing context — cannot open topic on this thread')
                        return
                      }
                      const body = h.body_template
                        ? interpolateBodyTemplate(h.body_template, topicCtx)
                        : {}
                      try {
                        const res = await fetch(url, {
                          method: h.method,
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body),
                        })
                        if (!res.ok) {
                          const d = await res.json().catch(() => ({}))
                          throw new Error(d.error || `Failed to open topic (HTTP ${res.status})`)
                        }
                        const data = (await res.json()) as { topic_name?: string }
                        const onSuccess = template.metadata.on_success
                        if (onSuccess?.toast) toast.success(onSuccess.toast)
                        if (onSuccess?.set_active_topic && data.topic_name) {
                          setAdminActiveTopic(data.topic_name)
                          // Refetch messages so the new topic tab appears immediately.
                          queryClient.invalidateQueries({ queryKey: ['portal-chat-messages', selectedAccountId || selectedContactId] })
                        }
                      } catch (err) {
                        toast.error(err instanceof Error && err.message ? err.message : 'Failed to open topic')
                      }
                    }

                    return (
                      <ChatQuickActionsErrorBoundary fallback={hardcodedButton}>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-full border border-dashed border-zinc-300 text-zinc-500 hover:text-zinc-700 hover:border-zinc-400 transition-colors">
                              <Plus className="h-3 w-3" />
                              Create a new topic
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              className="min-w-[180px] rounded-lg bg-white shadow-lg border border-zinc-200 py-1 z-50"
                              align="start"
                              sideOffset={4}
                            >
                              {items.map((template) => {
                                const Icon = ICON_REGISTRY[template.metadata.icon] ?? MessageCircle
                                return (
                                  <DropdownMenu.Item
                                    key={template.slug}
                                    className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                                    onSelect={() => dispatchTopic(template)}
                                  >
                                    <Icon className="h-3.5 w-3.5 text-zinc-400" /> {template.display_name}
                                  </DropdownMenu.Item>
                                )
                              })}
                              <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                              <DropdownMenu.Item
                                className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                                onSelect={() => setAdminCreatingTopic(true)}
                              >
                                <Pencil className="h-3.5 w-3.5 text-zinc-400" /> Custom…
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </ChatQuickActionsErrorBoundary>
                    )
                  })()
                )}
              </div>
            )}

            {chatViewMode === 'whatsnew' && (selectedAccountId || selectedContactId || selectedCompanyId) ? (
              <ThreadWhatsNewPanel
                accountId={selectedAccountId}
                contactId={selectedContactId}
                cardAccountId={selectedAccountId || selectedCompanyId}
                onOpenCard={({ noteId, label }) => {
                  const acctId = selectedAccountId || selectedCompanyId
                  setCardPreset({
                    accountId: acctId ?? null,
                    contactId: acctId ? null : selectedContactId,
                    clientName:
                      selectedName?.company ||
                      threads?.find((t) => (selectedAccountId ? t.account_id === selectedAccountId : t.contact_id === selectedContactId))?.company_name ||
                      'this client',
                    label,
                    noteId,
                  })
                }}
              />
            ) : chatViewMode === 'todo' && (selectedAccountId || selectedContactId || selectedCompanyId) ? (
              <ThreadTodoPanel accountId={selectedAccountId || selectedCompanyId} contactId={selectedContactId} />
            ) : (
            <>

            {/* Pinned messages strip — shared with the client; click to jump. No limit. */}
            {(() => {
              const pinned = (messages ?? []).filter(m => m.pinned_at && !m.deleted_at)
              if (pinned.length === 0) return null
              return (
                <div className="shrink-0 border-b border-amber-100 bg-amber-50/70 px-3 py-1.5">
                  <div className="flex items-center gap-1 mb-1">
                    <Pin className="h-3 w-3 text-amber-600" />
                    <span className="text-[11px] font-medium text-amber-700">Pinned ({pinned.length})</span>
                  </div>
                  <div className="space-y-0.5 max-h-28 overflow-y-auto">
                    {pinned.map(pm => (
                      <div key={pm.id} className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-amber-100/60">
                        <button
                          onClick={() => scrollToMessage(pm.id)}
                          className="flex items-start gap-1.5 text-xs text-zinc-700 flex-1 min-w-0 text-left"
                          title="Jump to message"
                        >
                          <Pin className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                          <span className="truncate flex-1">{pm.message || '[Attachment]'}</span>
                        </button>
                        <button
                          onClick={() => pinMessageMutation.mutate({ messageId: pm.id, pinned: false })}
                          className="shrink-0 text-[10px] text-zinc-400 hover:text-red-600 sm:opacity-0 sm:group-hover:opacity-100"
                          title="Unpin"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
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
                {/* Empty topic thread */}
                {messages && messages.length > 0 && adminFilteredMessages.length === 0 && !messagesLoading && (
                  <div className="flex-1 flex items-center justify-center py-12">
                    <div className="text-center">
                      <MessageSquare className="h-10 w-10 text-zinc-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-zinc-500 mb-1">No messages in this topic yet</p>
                      <p className="text-xs text-zinc-400">Send the first message below</p>
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
                {adminFilteredMessages.map(msg => {
                  const isAdmin = msg.sender_type === 'admin'
                  const isSystem = msg.sender_type === 'system'
                  const replyRef = msg.reply_to_id ? messages.find(m => m.id === msg.reply_to_id) : null
                  const isDeleted = !!msg.deleted_at

                  // System events (auto-emitted on client actions: wizard submitted,
                  // payment received, doc uploaded, SS-4 signed, etc.). Render as a
                  // centered amber pill with a distinct neutral style — not a chat
                  // bubble. Strip the embedded idempotency marker before display.
                  if (isSystem && !isDeleted) {
                    const displayBody = msg.message.replace(/<!--[\s\S]*?-->/g, '').trim()
                    const isUnread = !msg.read_at
                    return (
                      <div key={msg.id} className="flex justify-center my-1.5">
                        <div className={cn(
                          'inline-flex items-center gap-2 max-w-[85%] px-3 py-1.5 rounded-full border text-xs',
                          isUnread
                            ? 'bg-amber-50 border-amber-300 text-amber-900'
                            : 'bg-zinc-50 border-zinc-200 text-zinc-600',
                        )}>
                          {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />}
                          <Bell className="h-3 w-3 shrink-0" />
                          <span className="leading-snug">{displayBody}</span>
                          <span className="text-[10px] opacity-70 shrink-0">{format(parseISO(msg.created_at), 'h:mm a')}</span>
                        </div>
                      </div>
                    )
                  }

                  if (isDeleted) {
                    return (
                      <div key={msg.id} className={cn('flex items-end gap-1', isAdmin ? 'justify-end' : 'justify-start')}>
                        <div className={cn(
                          'max-w-[75%] rounded-xl px-3 py-2 border border-dashed',
                          isAdmin ? 'border-blue-200 bg-blue-50/40 text-zinc-500' : 'border-zinc-200 bg-zinc-50 text-zinc-500'
                        )}>
                          <p className="text-xs italic flex items-center gap-1.5">
                            <Trash2 className="h-3 w-3" /> Message deleted
                          </p>
                          <p className="text-[10px] text-zinc-400 mt-0.5">
                            {msg.deleted_at ? `Deleted ${format(parseISO(msg.deleted_at), 'MMM d, h:mm a')}` : 'Deleted'} · originally sent {format(parseISO(msg.created_at), 'MMM d, h:mm a')}
                          </p>
                        </div>
                      </div>
                    )
                  }

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
                          className="z-50 w-48 py-1 bg-white rounded-lg shadow-lg border text-sm animate-in fade-in-0 zoom-in-95 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
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
                            onSelect={() => { const acctId = selectedCompanyId || selectedAccountId; if (acctId) createInternalThread(acctId, msg.id, msg.message) }}
                          >
                            <Users className="h-3.5 w-3.5 text-zinc-400" /> Discuss with Team
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-violet-700 hover:bg-violet-50 cursor-pointer outline-none"
                            onSelect={() => setTodoNote({ messageId: msg.id, note: msg.message })}
                          >
                            <ClipboardList className="h-3.5 w-3.5 text-violet-500" /> To Do
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                          <DropdownMenu.Label className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                            Tag Message
                          </DropdownMenu.Label>
                          {Object.entries(ACTION_TAG_CONFIG).map(([key, cfg]) => {
                            const TagIcon = cfg.icon
                            const currentAction = actionsByMessageId.get(msg.id)
                            const isActive = currentAction?.action_type === key
                            return (
                              <DropdownMenu.Item
                                key={key}
                                className={cn(
                                  'flex items-center gap-2.5 px-3 py-2 cursor-pointer outline-none',
                                  isActive ? `${cfg.bg} ${cfg.color} font-medium` : 'text-zinc-700 hover:bg-zinc-50'
                                )}
                                onSelect={() => tagMessageMutation.mutate({ messageId: msg.id, actionType: key })}
                              >
                                <TagIcon className={cn('h-3.5 w-3.5', isActive ? cfg.color : 'text-zinc-400')} />
                                {cfg.label}
                                {isActive && <Check className="h-3 w-3 ml-auto" />}
                              </DropdownMenu.Item>
                            )
                          })}
                          {(() => {
                            // Slice 6b — chat_quick_actions catalog integration with 3-layer fallback.
                            // See banner near the top of this file for the full design.
                            const hardcodedCreate = (
                              <>
                                <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                                <DropdownMenu.Label className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                                  Create
                                </DropdownMenu.Label>
                                <DropdownMenu.Item
                                  className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                                  onSelect={() => setQuickCreate({ type: 'task', messageText: msg.message })}
                                >
                                  <ClipboardList className="h-3.5 w-3.5 text-zinc-400" /> Task
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                                  onSelect={() => setQuickCreate({ type: 'sd', messageText: msg.message })}
                                >
                                  <Truck className="h-3.5 w-3.5 text-zinc-400" /> Service
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                                  onSelect={() => setQuickCreate({ type: 'invoice', messageText: msg.message })}
                                >
                                  <Receipt className="h-3.5 w-3.5 text-zinc-400" /> Invoice
                                </DropdownMenu.Item>
                              </>
                            )

                            // Layer 1: flag off → hardcoded (default, today's behavior)
                            if (!CHAT_QUICK_ACTIONS_CATALOG_FLAG) return hardcodedCreate

                            // Layer 2: fetch failed / no valid rows → hardcoded
                            if (!catalogActionsRaw || catalogActions.length === 0) return hardcodedCreate

                            // Build the per-message context for filter + dispatch
                            const chatContext: ChatContext = {
                              account_id: selectedAccountId,
                              contact_id: selectedContactId,
                              thread_id: selectedThreadId,
                              message_id: msg.id,
                              message_text: msg.message,
                              sender_type: msg.sender_type,
                            }

                            const items = filterForSurfaceAndContext(catalogActions, 'portal_chat_message', chatContext)

                            // Intentional empty (every item correctly filtered out by requires_*)
                            // → hide the Create section. This is the catalog working correctly,
                            // not a failure. With flag ON, contact-only threads now correctly
                            // hide items that require account_id (today's hardcoded items
                            // appear-but-do-nothing on contact-only threads — see commit 6a).
                            if (items.length === 0) return null

                            const dispatch = (action: QuickAction) => {
                              const h = action.metadata.handler
                              if (h.kind === 'open_modal' && h.modal_id === 'quick_create') {
                                const ct = h.modal_params?.create_type
                                if (ct !== 'task' && ct !== 'sd' && ct !== 'invoice') {
                                  console.warn(`[chat dispatch] invalid create_type on ${action.slug}:`, ct)
                                  return
                                }
                                setQuickCreate({ type: ct, messageText: msg.message })
                                return
                              }
                              console.warn(`[chat dispatch] unhandled handler for ${action.slug}:`, h)
                            }

                            // Layer 3: render-time crash → error boundary swaps to hardcoded
                            return (
                              <ChatQuickActionsErrorBoundary fallback={hardcodedCreate}>
                                <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                                <DropdownMenu.Label className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                                  Create
                                </DropdownMenu.Label>
                                {items.map((action) => {
                                  const Icon = ICON_REGISTRY[action.metadata.icon] ?? ClipboardList
                                  return (
                                    <DropdownMenu.Item
                                      key={action.slug}
                                      className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                                      onSelect={() => dispatch(action)}
                                    >
                                      <Icon className="h-3.5 w-3.5 text-zinc-400" /> {action.display_name}
                                    </DropdownMenu.Item>
                                  )
                                })}
                              </ChatQuickActionsErrorBoundary>
                            )
                          })()}
                          <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                            onSelect={() => pinMessageMutation.mutate({ messageId: msg.id, pinned: !msg.pinned_at })}
                          >
                            <Pin className="h-3.5 w-3.5 text-zinc-400" /> {msg.pinned_at ? 'Unpin message' : 'Pin message'}
                          </DropdownMenu.Item>
                          {isAdmin && (
                            <DropdownMenu.Item
                              className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                              onSelect={() => { setEditingMessageId(msg.id); setEditDraft(msg.message) }}
                            >
                              <Pencil className="h-3.5 w-3.5 text-zinc-400" /> Edit message
                            </DropdownMenu.Item>
                          )}
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 px-3 py-2 text-red-600 hover:bg-red-50 cursor-pointer outline-none"
                            onSelect={() => {
                              const preview = msg.message ? (msg.message.length > 80 ? msg.message.slice(0, 80) + '…' : msg.message) : '[Attachment]'
                              if (window.confirm(`Delete this message?\n\n"${preview}"\n\nThe client will no longer see it. An audit trail (deleted by, when) is kept on the admin side.`)) {
                                deleteMessageMutation.mutate(msg.id)
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete message
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  )

                  return (
                    <div key={msg.id} id={`pc-msg-${msg.id}`} className={cn('flex items-end gap-1 scroll-mt-4', isAdmin ? 'justify-end' : 'justify-start')}>
                      {isAdmin && actionButton}
                      <div
                        className={cn(
                          'max-w-[75%] rounded-xl px-4 py-2.5 overflow-hidden transition-shadow',
                          isAdmin
                            ? 'bg-blue-600 text-white'
                            : 'bg-zinc-100 text-zinc-900',
                          highlightedMessageId === msg.id && 'ring-2 ring-amber-400 ring-offset-2'
                        )}
                      >
                        {/* Member badge — for account-level threads (multi-member LLC), show who wrote each client message */}
                        {selectedThreadMembers.length > 0 && !isAdmin && msg.sender_name && (
                          <span className="inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded mb-0.5 bg-purple-100 text-purple-700">
                            {msg.sender_name}
                          </span>
                        )}
                        {/* Company badge — show on every message with an account_id when viewing a contact-level unified thread */}
                        {(() => {
                          if (selectedThreadMembers.length > 0) return null // handled above
                          const accountNameById = new Map(selectedThreadCompanies.map(c => [c.id, c.name]))
                          const companyName = msg.account_id ? accountNameById.get(msg.account_id) : null
                          // Show badge if we have a company name (multi-company thread) or sender_context is set
                          const showBadge = companyName || msg.sender_context
                          if (!showBadge) return null
                          const label = msg.sender_context === 'person'
                            ? 'Personal'
                            : companyName || 'Company'
                          return (
                            <span className={cn(
                              'inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded mb-0.5',
                              isAdmin
                                ? 'bg-blue-500/40 text-blue-100'
                                : msg.sender_context === 'person'
                                  ? 'bg-zinc-200 text-zinc-600'
                                  : 'bg-blue-100 text-blue-700'
                            )}>
                              {label}
                            </span>
                          )
                        })()}
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
                        {(() => {
                          const atts: ChatAttachment[] = msg.attachments?.length
                            ? msg.attachments
                            : msg.attachment_url
                            ? [{ url: msg.attachment_url, name: msg.attachment_name || 'Attachment' }]
                            : []
                          if (!atts.length) return null
                          return (
                            <>
                              {atts.map((att, i) => {
                                const ext = att.url.split('?')[0].split('.').pop()?.toLowerCase() || ''
                                const isImg = ['jpg','jpeg','png','gif','webp','svg','heic','bmp'].includes(ext)
                                return isImg ? (
                                  <a key={i} href={att.url} target="_blank" rel="noopener noreferrer" className="block mb-1">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={att.url} alt={att.name} className="max-w-[200px] rounded-lg" loading="lazy" />
                                  </a>
                                ) : (
                                  <a
                                    key={i}
                                    href={att.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn(
                                      'flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-1',
                                      isAdmin ? 'bg-blue-500/30 hover:bg-blue-500/40' : 'bg-zinc-200 hover:bg-zinc-300'
                                    )}
                                  >
                                    <FileText className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{att.name}</span>
                                  </a>
                                )
                              })}
                            </>
                          )
                        })()}
                        {editingMessageId === msg.id ? (
                          <div className="mt-1 space-y-1.5">
                            <textarea
                              value={editDraft}
                              onChange={e => setEditDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Escape') { setEditingMessageId(null); setEditDraft('') }
                              }}
                              rows={3}
                              className="w-full px-2 py-1.5 text-sm text-zinc-900 bg-white border border-blue-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                              autoFocus
                            />
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={() => { setEditingMessageId(null); setEditDraft('') }}
                                disabled={editSaving}
                                className="px-2 py-1 text-xs rounded bg-white/20 hover:bg-white/30 text-white"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => editMessage(msg.id, editDraft)}
                                disabled={editSaving || !editDraft.trim() || editDraft === msg.message}
                                className="px-2 py-1 text-xs rounded bg-white text-blue-700 font-medium hover:bg-blue-50 disabled:opacity-50 flex items-center gap-1"
                              >
                                {editSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                Save
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm whitespace-pre-wrap break-words" style={{ overflowWrap: 'anywhere' }}>{msg.message}</p>
                        )}
                        <p className={cn(
                          'text-xs mt-1 flex items-center gap-1',
                          isAdmin ? 'text-blue-200 justify-end' : 'text-zinc-400'
                        )}>
                          {format(parseISO(msg.created_at), 'MMM d, h:mm a')}
                          {msg.edited_at && (
                            <span className="italic opacity-75">(edited)</span>
                          )}
                          {isAdmin && (
                            <span title={msg.read_at ? `Read by client: ${format(parseISO(msg.read_at), 'MMM d, h:mm a')}` : 'Not read yet'}>
                              <CheckCheck className={cn(
                                'h-3 w-3',
                                msg.read_at ? 'text-green-300' : 'text-blue-200/50'
                              )} />
                            </span>
                          )}
                        </p>
                        {(() => {
                          const msgAction = actionsByMessageId.get(msg.id)
                          if (!msgAction || msgAction.action_type === 'done') return null
                          const cfg = ACTION_TAG_CONFIG[msgAction.action_type]
                          if (!cfg) return null
                          const TagIcon = cfg.icon
                          return (
                            <div className={cn('flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-[10px] font-medium w-fit', cfg.bg, cfg.color)}>
                              <TagIcon className="h-2.5 w-2.5" />
                              {cfg.label}
                            </div>
                          )
                        })()}
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
            {pendingAdminFiles.length > 0 && (
              <div className="px-4 py-2 border-t border-zinc-100 bg-zinc-50 shrink-0">
                <div className="flex flex-wrap gap-2">
                  {pendingAdminFiles.map((pf, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white border border-zinc-200 rounded-lg px-2 py-1.5 max-w-[200px]">
                      {pf.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={pf.previewUrl} alt={pf.file.name} className="h-8 w-8 rounded object-cover shrink-0" />
                      ) : (
                        <div className="h-8 w-8 rounded bg-zinc-100 flex items-center justify-center shrink-0">
                          <FileText className="h-4 w-4 text-zinc-400" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-medium text-zinc-700 truncate">{pf.file.name}</p>
                        <p className="text-[10px] text-zinc-400">{formatFileSize(pf.file.size)}</p>
                      </div>
                      <button
                        onClick={() => setPendingAdminFiles(prev => prev.filter((_, idx) => idx !== i))}
                        className="p-0.5 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 shrink-0"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-400 mt-1">{pendingAdminFiles.length}/{MAX_ADMIN_ATTACHMENTS} files</p>
              </div>
            )}

            {/* Company picker — shown when the thread has multiple companies so admin can tag which company the reply is about */}
            {selectedThreadCompanies.length > 0 && !selectedAccountId && (
              <div className="px-3 py-2 border-t bg-zinc-50/60 flex items-center gap-2 flex-wrap shrink-0">
                <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium shrink-0">Send as</span>
                <div className="flex gap-1 flex-wrap">
                  {selectedThreadCompanies.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedCompanyId(c.id)}
                      className={cn(
                        'px-2.5 py-0.5 text-[11px] rounded-full transition-colors max-w-[180px] truncate',
                        selectedCompanyId === c.id
                          ? 'bg-blue-600 text-white'
                          : 'bg-white border text-zinc-600 hover:bg-zinc-100'
                      )}
                      title={c.name}
                    >
                      {c.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSelectedCompanyId(null)}
                    className={cn(
                      'px-2.5 py-0.5 text-[11px] rounded-full transition-colors',
                      !selectedCompanyId
                        ? 'bg-zinc-900 text-white'
                        : 'bg-white border text-zinc-600 hover:bg-zinc-100'
                    )}
                  >
                    No tag
                  </button>
                </div>
              </div>
            )}

            {/* Reply input — WhatsApp-style pill + action button */}
            <div className={cn('p-2 sm:p-3 border-t bg-white shrink-0', (replyToMsg || pendingAdminFiles.length > 0) && 'border-t-0')}>
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
                      pendingAdminFiles.length > 0
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
                    multiple
                    onChange={e => { Array.from(e.target.files ?? []).forEach(f => handleAdminFileSelect(f)) }}
                    className="hidden"
                  />
                  {/* Textarea */}
                  <textarea
                    ref={inputRef}
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); handleSend() } }}
                    rows={1}
                    placeholder={isRecording ? 'Recording...' : 'Type a message...'}
                    className="flex-1 min-w-0 px-1 py-2.5 text-base bg-transparent border-none focus:outline-none focus:ring-0 resize-none overflow-y-auto max-h-[300px] placeholder:text-zinc-400"
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
                ) : (replyText.trim() || pendingAdminFiles.length > 0) ? (
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

      {/* Save-as-template prompt banner — appears after sending a substantive reply */}
      {saveTemplatePrompt && !saveTemplate && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-zinc-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg animate-in slide-in-from-bottom-2">
          <BookmarkPlus className="h-4 w-4 text-violet-400 shrink-0" />
          <span>Save this reply as an AI template?</span>
          <button
            onClick={() => {
              const firstLine = saveTemplatePrompt.split('\n').find(l => l.trim()) ?? saveTemplatePrompt
              setSaveTemplate({ messageText: saveTemplatePrompt, title: firstLine.trim().slice(0, 80) })
              setSaveTemplatePrompt(null)
            }}
            className="px-3 py-1 bg-violet-600 hover:bg-violet-500 rounded-lg font-medium transition-colors"
          >
            Yes
          </button>
          <button
            onClick={() => setSaveTemplatePrompt(null)}
            className="px-3 py-1 bg-zinc-700 hover:bg-zinc-600 rounded-lg transition-colors"
          >
            No
          </button>
        </div>
      )}

      {/* Save-as-template title-edit modal — opened from the prompt banner */}
      {saveTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center gap-2">
              <BookmarkPlus className="h-5 w-5 text-violet-600 shrink-0" />
              <h2 className="text-base font-semibold text-zinc-900">Save as AI Template</h2>
            </div>
            <p className="text-xs text-zinc-500">Give this reply a short title so the AI can find it when a similar question comes up.</p>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-700">Title</label>
              <input
                type="text"
                value={saveTemplate.title}
                onChange={e => setSaveTemplate(t => t ? { ...t, title: e.target.value } : null)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                maxLength={120}
                autoFocus
              />
            </div>
            <div className="bg-zinc-50 rounded-lg p-3 max-h-32 overflow-y-auto">
              <p className="text-xs text-zinc-600 whitespace-pre-wrap">{saveTemplate.messageText}</p>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setSaveTemplate(null)}
                className="px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTemplate}
                disabled={saveTemplateLoading || !saveTemplate.title.trim()}
                className="px-4 py-2 text-sm bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {saveTemplateLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
                Save
              </button>
            </div>
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

      {/* To-Do card editor — same card used on the dashboard, opened from a What's New note */}
      <NewCardDialog
        open={!!cardPreset}
        preset={cardPreset}
        columns={(actionBoardColumns || []).map((c) => ({ slug: c.slug, display_name: c.display_name, terminal: c.terminal }))}
        onClose={() => setCardPreset(null)}
        onCreated={async () => {
          // Opening a card from a What's New note marks that note handled, so it
          // drops off the purple dot. (No note → manual card, nothing to mark.)
          const noteId = cardPreset?.noteId
          if (noteId) {
            try {
              await fetch('/api/crm/admin-actions/whats-new', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message_id: noteId, handled: true }),
              })
            } catch { /* non-fatal: the manual Handled tick still works */ }
          }
          setCardPreset(null)
          queryClient.invalidateQueries({ queryKey: ['thread-whats-new'] })
          queryClient.invalidateQueries({ queryKey: ['portal-chat-whats-new-counts'] })
          queryClient.invalidateQueries({ queryKey: ['thread-todos'] })
          queryClient.invalidateQueries({ queryKey: ['open-message-actions'] })
        }}
      />

      {/* To-Do note dialog — opened by the per-message "To Do" action. Pre-filled
          with the message text; staff can edit/trim before creating the card. */}
      {todoNote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setTodoNote(null)}>
          <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <ClipboardList className="h-4 w-4 text-violet-500" />
              <h3 className="text-sm font-semibold text-zinc-800">Add a To-Do</h3>
              <button onClick={() => setTodoNote(null)} className="ml-auto p-1 rounded hover:bg-zinc-100 text-zinc-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-2">
              <label className="block text-xs font-medium text-zinc-500">Note</label>
              <textarea
                value={todoNote.note}
                onChange={(e) => setTodoNote(prev => prev ? { ...prev, note: e.target.value } : prev)}
                rows={4}
                autoFocus
                placeholder="What needs doing for this client?"
                className="w-full text-sm border rounded px-2 py-1.5 resize-none"
              />
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t">
              <button onClick={() => setTodoNote(null)} className="text-sm text-zinc-600 border rounded px-3 py-1.5">Cancel</button>
              <button
                disabled={!todoNote.note.trim() || addTodoMutation.isPending}
                onClick={() => {
                  const { messageId, note } = todoNote
                  addTodoMutation.mutate({ messageId, label: note }, { onSuccess: () => setTodoNote(null) })
                }}
                className="flex items-center gap-1 text-sm font-medium bg-violet-600 text-white rounded px-3 py-1.5 disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" /> {addTodoMutation.isPending ? 'Adding…' : 'Add to board'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Assistant side panel */}
      {aiPanelOpen && (selectedAccountId || selectedContactId || selectedThreadId) && (
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
        // Create a TD invoice in our system (Supabase) — NOT QuickBooks. QB is
        // decommissioned; this is the canonical path used by the account page and
        // the Notification Center card button (createInvoice → createTDInvoice,
        // content-idempotent). Creates a Draft; staff "Send" separately.
        const amount = Number(invAmount) || 0
        const today = new Date().toISOString().split('T')[0]
        const r = await createInvoice({
          account_id: accountId,
          description: invDescription || 'Invoice',
          amount_currency: 'USD',
          issue_date: today,
          discount: 0,
          items: [{ description: invDescription || 'Invoice', quantity: 1, unit_price: amount, amount, sort_order: 0 }],
          message: invMemo || undefined,
        })
        if (!r.success) throw new Error(r.error || 'Failed to create invoice')
        toast.success('Invoice created (Draft)')
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
