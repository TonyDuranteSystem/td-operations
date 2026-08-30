'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Send, Loader2, MessageCircle, Paperclip, FileText, ExternalLink, Mic, Square, CheckCheck, ChevronUp, ChevronDown, Reply, X, ZoomIn, Smile, RotateCw, ImageIcon, Plus, Pin, MailOpen, Building2, Sparkles, Check, Users, User as UserIcon } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { usePortalChat, type ChatScope } from '@/lib/hooks/use-portal-chat'
import type { PortalChatEntity } from '@/lib/portal/queries'
import type { ChatAttachment, PortalMessage } from '@/lib/types'
import { uploadChatAttachment, validateChatAttachment } from '@/lib/portal/chat-attachment'
import { MessageReactions } from '@/components/chat/message-reactions'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { useLocale } from '@/lib/portal/use-locale'
import { interpolateString } from '@/lib/template-interpolation'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { toast } from 'sonner'
import { format, parseISO, isToday, isYesterday } from 'date-fns'
import dynamic from 'next/dynamic'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

function isImageUrl(url: string): boolean {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || ''
  return ['jpg','jpeg','png','gif','webp','svg','heic','bmp'].includes(ext)
}

const URL_PATTERN = /(https?:\/\/[^\s]+)/

// Convert any URL pointing to this portal into a relative path for in-app
// navigation. External URLs stay absolute and open in a new tab.
function toInternalPath(url: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const parsed = new URL(url)
    if (parsed.origin === window.location.origin) {
      return parsed.pathname + parsed.search + parsed.hash
    }
    return null
  } catch {
    return null
  }
}

function renderMessageText(text: string, isOwn: boolean) {
  // Strip HTML comment markers used as system-message dedup anchors.
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, '').trim()
  const parts = cleaned.split(URL_PATTERN)
  const linkClass = cn(
    'underline underline-offset-2 break-all',
    isOwn ? 'text-blue-100 hover:text-white' : 'text-blue-600 hover:text-blue-800'
  )
  return parts.map((part, i) => {
    if (!URL_PATTERN.test(part)) return part
    const internalPath = toInternalPath(part)
    if (internalPath) {
      // Same-origin link → in-app SPA navigation, stays inside the PWA
      return (
        <Link key={i} href={internalPath} className={linkClass}>
          {part}
        </Link>
      )
    }
    return (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        {part}
      </a>
    )
  })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

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

export function PortalChat({ scope, accountId, contactId, userId, locale = 'en', entities = [], selectedEntityId, initialTopic = null }: { scope: ChatScope; accountId?: string; contactId: string; userId: string; locale?: string; entities?: PortalChatEntity[]; selectedEntityId: string; initialTopic?: string | null }) {
  const { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore, refresh, topics } = usePortalChat(scope, accountId || null, contactId)
  const router = useRouter()
  // Per-company scoping (2026-06-24). Multi-entity clients pick which company a
  // message is about via a first-send popup; the choice is the SEND TAG and the
  // VIEW follows it (cookie switch). Single-entity clients are auto-tagged.
  const isMultiEntity = entities.length > 1
  const currentEntity = entities.find(e => e.id === selectedEntityId) ?? entities[0] ?? null
  const [popupOpen, setPopupOpen] = useState(false)
  // Multi-entity clients must confirm the target on the first send of a session.
  const [targetConfirmed, setTargetConfirmed] = useState(!isMultiEntity)
  // Deep-linked topic (Wave 2, card 4a39e0fd — Antonio's ruling): a tax
  // notification's "open chat" link lands the client ON the tax tab, so
  // whatever they type is tagged without them doing or knowing anything.
  // Production fact that forced this: in 14 months, ZERO client messages ever
  // carried the tax topic — every reply landed in General, because a send
  // inherits the tab the client is standing on and the chat opens on General.
  // Only the deep-linked entry changes; a client opening the chat normally
  // still lands on General (changing that default is PARKED — Antonio has not
  // ruled on the whole-chat product question).
  const [activeTopic, setActiveTopic] = useState<string | null>(initialTopic)
  const [creatingTopic, setCreatingTopic] = useState(false)
  // Deep-link guard: if the linked topic has no messages for this client (an
  // old link, a topic on a different company), fall back to General instead of
  // stranding them on an empty tab they can't explain. Runs once, after load.
  const initialTopicChecked = useRef(false)
  useEffect(() => {
    if (initialTopicChecked.current || loading || !initialTopic) return
    initialTopicChecked.current = true
    if (!topics.includes(initialTopic)) setActiveTopic(null)
  }, [loading, topics, initialTopic])
  const [newTopicInput, setNewTopicInput] = useState('')
  // Map a real account_id → company name for the per-message company badge.
  const accountNameById = new Map(entities.filter(e => e.accountId).map(e => [e.accountId as string, e.label]))
  const { t } = useLocale()
  const personalLabel = t('dashboard.personal')

  // Localized display label + icon per entity (company / formation / personal).
  const entityLabel = useCallback((e: PortalChatEntity): string => {
    if (e.kind === 'formation') return `${e.label} ${t('portalChat.inFormationSuffix')}`
    if (e.kind === 'personal') return t('portalChat.personalGeneral')
    return e.label
  }, [t])

  // Switch the active entity (view-follows-choice). Reuses the same cookies the
  // sidebar CompanySwitcher writes, so chat stays in lock-step with the rest of
  // the portal (portal_account_id / portal_formation; 'personal' sentinel).
  const selectEntity = useCallback((e: PortalChatEntity) => {
    if (e.kind === 'formation') {
      document.cookie = `portal_formation=${e.id}; path=/portal; max-age=31536000; SameSite=Lax`
    } else if (e.kind === 'personal') {
      document.cookie = `portal_account_id=personal; path=/portal; max-age=31536000; SameSite=Lax`
      document.cookie = `portal_formation=; path=/portal; max-age=0; SameSite=Lax`
    } else {
      document.cookie = `portal_account_id=${e.accountId}; path=/portal; max-age=31536000; SameSite=Lax`
      document.cookie = `portal_formation=; path=/portal; max-age=0; SameSite=Lax`
    }
    router.refresh()
  }, [router])

  const draftKey = `chat_draft_${selectedEntityId || contactId}`
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
  const [pinHighlightId, setPinHighlightId] = useState<string | null>(null)

  // Pin/unpin a message (client side). Realtime reconciles both chats; refresh() is a fallback.
  const togglePin = async (id: string, pinned: boolean) => {
    try {
      const res = await fetch(`/api/portal/chat/message/${id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      })
      if (res.ok) refresh()
    } catch {
      /* realtime will reconcile */
    }
  }
  // Mark an admin message as unread (client side) — keeps it counting toward the
  // unread badge even after it's been read. Realtime reconciles the sidebar;
  // refresh() updates this list's local copy.
  const toggleKeepUnread = async (id: string, kept: boolean) => {
    try {
      const res = await fetch(`/api/portal/chat/message/${id}/keep-unread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kept }),
      })
      if (res.ok) refresh()
    } catch {
      /* realtime will reconcile */
    }
  }
  const scrollToPinned = (id: string) => {
    const el = document.getElementById(`pc-msg-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setPinHighlightId(id)
    window.setTimeout(() => setPinHighlightId(null), 2800)
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  // "Jump to latest" floating button + smart auto-scroll. stickToBottomRef is
  // true while the user is pinned near the newest message; the auto-scroll
  // effect only snaps down when it's true, so loading older messages (or
  // reading history) no longer yanks the view to the bottom. jumpRafRef
  // throttles the scroll handler to one recompute per frame.
  const jumpRafRef = useRef<number | null>(null)
  const stickToBottomRef = useRef(true)
  // Mirror of the active-tab messages so the scroll handler (defined before
  // filteredMessages) can count unread-below without a stale closure.
  const filteredMessagesRef = useRef<PortalMessage[]>([])
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [unreadBelowCount, setUnreadBelowCount] = useState(0)

  // Recompute the Jump button state: visible when >200px from the bottom, and
  // how many unread TEAM (admin) messages sit below the fold. Client-side
  // unread mirrors unreadByTopic: an admin message that's unread OR kept-unread.
  // getBoundingClientRect is viewport-relative, so it's robust regardless of
  // the container's positioning context.
  const recomputeJumpState = useCallback(() => {
    const sc = scrollRef.current
    if (!sc) return
    const distanceFromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight
    stickToBottomRef.current = distanceFromBottom <= 120
    const scrolledUp = distanceFromBottom > 200
    setShowJumpToLatest(scrolledUp)
    if (!scrolledUp) {
      setUnreadBelowCount(0)
      return
    }
    const contBottom = sc.getBoundingClientRect().bottom
    let count = 0
    for (const m of filteredMessagesRef.current) {
      if (m.sender_type !== 'admin' || m.deleted_at) continue
      if (m.read_at && !m.client_kept_unread) continue
      const el = document.getElementById(`pc-msg-${m.id}`)
      if (el && el.getBoundingClientRect().top >= contBottom) count++
    }
    setUnreadBelowCount(count)
  }, [])

  const handleMessagesScroll = useCallback(() => {
    if (jumpRafRef.current != null) return
    jumpRafRef.current = requestAnimationFrame(() => {
      jumpRafRef.current = null
      recomputeJumpState()
    })
  }, [recomputeJumpState])

  const jumpToLatest = useCallback(() => {
    const sc = scrollRef.current
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' })
  }, [])

  // Load older messages while preserving the user's scroll position. loadMore()
  // prepends older messages, which would otherwise shift the viewport; we record
  // the pre-fetch height and re-anchor by the delta after the DOM updates.
  const handleLoadMore = useCallback(async () => {
    const sc = scrollRef.current
    const prevHeight = sc?.scrollHeight ?? 0
    const prevTop = sc?.scrollTop ?? 0
    await loadMore()
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
    })
  }, [loadMore])

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

  // Auto-scroll to bottom on new messages — but ONLY when the user is already
  // pinned near the bottom. If they've scrolled up to read history or just
  // loaded older messages, keep their position instead of yanking them down.
  // handleLoadMore re-anchors after a prepend; handleSend forces stick=true so
  // a sent message is always shown.
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    if (stickToBottomRef.current) {
      sc.scrollTop = sc.scrollHeight
    }
  }, [messages])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await refresh()
    setIsRefreshing(false)
  }

  // Actual send, tagged to a target entity (defaults to the entity in view).
  // company → sender_context='company' + that account_id; formation/personal →
  // sender_context='person' + account_id null.
  const doSend = async (target: PortalChatEntity | null = currentEntity) => {
    if ((!input.trim() && pendingFiles.length === 0) || sending || uploading) return
    if (isRecording) stopRecording()
    // Sending implies the user wants to see their message land at the bottom.
    stickToBottomRef.current = true
    const senderContext: 'person' | 'company' = target?.kind === 'company' ? 'company' : 'person'
    const tagAccountId = target?.kind === 'company' ? (target.accountId ?? null) : null
    const msg = input
    const replyId = replyTo?.id
    const filesToSend = pendingFiles
    // Captured now, before the upload await — an upload is a real
    // multi-second network call, and nothing stops switching topic tabs
    // while it's in flight. Reading activeTopic live after the await (as
    // this used to) could tag the send to whatever topic tab is open when
    // the upload finishes, not the one shown when send was pressed (council
    // review, Bug Hunter, 2026-08-30).
    const sendTopic = activeTopic
    setInput('')
    setReplyTo(null)
    setPendingFiles([])
    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      if (filesToSend.length > 0) {
        setUploading(true)
        try {
          const uploaded = await Promise.all(filesToSend.map((pf) =>
            uploadChatAttachment(pf.file, { accountId: tagAccountId ?? undefined, contactId })
          ))
          await sendMessage(msg || '', uploaded, replyId, senderContext, tagAccountId, sendTopic)
        } finally {
          setUploading(false)
        }
      } else {
        await sendMessage(msg, undefined, replyId, senderContext, tagAccountId, sendTopic)
      }
    } catch (err) {
      const errMsg = err instanceof Error && err.message ? err.message : t('portalChat.sendFailed')
      toast.error(errMsg)
      setInput(msg)
    }
    inputRef.current?.focus()
  }

  const handleSend = async () => {
    if ((!input.trim() && pendingFiles.length === 0) || sending || uploading) return
    // First send of the session for a multi-entity client → confirm the target.
    if (isMultiEntity && !targetConfirmed) {
      setPopupOpen(true)
      return
    }
    await doSend()
  }

  // Popup / pill choice: tag the message to the chosen entity AND make the view
  // follow it (so the just-sent message is visible). Confirms the target for the
  // rest of the session.
  const chooseEntity = (entity: PortalChatEntity) => {
    setTargetConfirmed(true)
    setPopupOpen(false)
    if (entity.id !== selectedEntityId) selectEntity(entity)
    // Send only if there's something drafted (the pill "switch" path may have none).
    if (input.trim() || pendingFiles.length > 0) doSend(entity)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileSelect = (file: File) => {
    const validationError = validateChatAttachment(file.name, file.size, file.type)
    if (validationError) {
      toast.error(validationError)
      return
    }
    setPendingFiles(prev => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.error(interpolateString(t('portalChat.maxAttachments'), { count: MAX_ATTACHMENTS }))
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
        const ok = window.confirm(t('portalChat.micConsent'))
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

  // Keep the Jump button's unread-below count in sync with the visible list:
  // mirror the active-tab messages into a ref (read by the scroll handler) and
  // recompute when the list changes (new team message arrives below, topic
  // switch, older page loaded). rAF lets the DOM settle first.
  filteredMessagesRef.current = filteredMessages
  useEffect(() => {
    const id = requestAnimationFrame(recomputeJumpState)
    return () => cancelAnimationFrame(id)
  }, [filteredMessages, recomputeJumpState])

  // Unread count per topic tab (admin messages not yet read by the client)
  const unreadByTopic = messages.reduce<Record<string, number>>((acc, m) => {
    if (m.sender_type !== 'admin' || (m.read_at && !m.client_kept_unread)) return acc
    const key = m.topic ?? ''
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})

  // Tab order (2026-08-30, Antonio): unread topics first — General included,
  // not pinned — then most-recently-active first within each group. Mirrors
  // the same ordering on the staff dashboard's topic tabs.
  const topicLastActivity: Record<string, number> = {}
  for (const m of messages) {
    const key = m.topic ?? ''
    const t = new Date(m.created_at).getTime()
    if (!(key in topicLastActivity) || t > topicLastActivity[key]) topicLastActivity[key] = t
  }
  const topicOrder = Array.from(new Set(['', ...topics])).sort((a, b) => {
    const unreadA = (unreadByTopic[a] ?? 0) > 0 ? 1 : 0
    const unreadB = (unreadByTopic[b] ?? 0) > 0 ? 1 : 0
    if (unreadA !== unreadB) return unreadB - unreadA
    return (topicLastActivity[b] ?? -Infinity) - (topicLastActivity[a] ?? -Infinity)
  })

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
      <FastTooltip label={t('portalChat.refreshMessages')}>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing || loading}
          className="absolute top-2 right-2 z-10 p-1.5 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 transition-colors"
          aria-label={t('portalChat.refreshMessages')}
        >
          <RotateCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
        </button>
      </FastTooltip>
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 rounded-xl pointer-events-none">
          <Paperclip className="h-10 w-10 text-blue-400 mb-2" />
          <p className="text-sm font-medium text-blue-600">{t('portalChat.dropToAttach')}</p>
        </div>
      )}
      {/* Prominent "Chatting about" banner — multi-entity clients only. Big and
          unmissable (Antonio): the client must instantly see which company this
          conversation is tagged to. Single-entity clients are auto-tagged → no
          banner. pr-10 keeps the Switch button clear of the absolute refresh icon. */}
      {isMultiEntity && currentEntity && (() => {
        const accent =
          currentEntity.kind === 'formation'
            ? { bar: 'bg-amber-50 border-amber-200', badge: 'bg-amber-100 text-amber-700', label: 'text-amber-600', name: 'text-amber-900', btn: 'border-amber-300 text-amber-800 hover:bg-amber-100' }
            : currentEntity.kind === 'personal'
              ? { bar: 'bg-zinc-100 border-zinc-200', badge: 'bg-zinc-200 text-zinc-600', label: 'text-zinc-500', name: 'text-zinc-900', btn: 'border-zinc-300 text-zinc-700 hover:bg-zinc-200' }
              : { bar: 'bg-blue-50 border-blue-200', badge: 'bg-blue-100 text-blue-700', label: 'text-blue-600', name: 'text-blue-900', btn: 'border-blue-300 text-blue-800 hover:bg-blue-100' }
        const Icon = currentEntity.kind === 'formation' ? Sparkles : currentEntity.kind === 'personal' ? UserIcon : Building2
        return (
          <div className={cn('flex items-center justify-between gap-3 px-4 py-3 border-b pr-10', accent.bar)}>
            <div className="flex items-center gap-3 min-w-0">
              <span className={cn('flex items-center justify-center h-9 w-9 rounded-full shrink-0', accent.badge)}>
                <Icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className={cn('text-[10px] font-semibold uppercase tracking-wider', accent.label)}>
                  {t('portalChat.chattingAbout')}
                </div>
                <div className={cn('text-base sm:text-lg font-bold leading-tight truncate', accent.name)} title={entityLabel(currentEntity)}>
                  {entityLabel(currentEntity)}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPopupOpen(true)}
              className={cn('shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border text-xs font-semibold transition-colors', accent.btn)}
            >
              {t('portalChat.switch')}
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })()}
      {/* Topic tabs — always visible. General = untagged messages. Named tabs = thread per topic. */}
      <div className="px-3 pt-2 pb-1 border-b border-zinc-100 flex items-center gap-1.5 overflow-x-auto">
        {topicOrder.map(key => {
          const isGeneral = key === ''
          const isActive = isGeneral ? activeTopic === null : activeTopic === key
          const unread = unreadByTopic[key] ?? 0
          // Pulsing highlight (2026-08-30, Antonio: more visible than a dot):
          // only when unread AND not the tab already open.
          const drawAttention = unread > 0 && !isActive
          return (
            <button
              key={key || '__general__'}
              onClick={() => setActiveTopic(isGeneral ? null : (isActive ? null : key))}
              className={cn(
                'shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full transition-colors border font-medium',
                isActive
                  ? (isGeneral ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-blue-600 text-white border-blue-600')
                  : drawAttention
                    ? 'text-red-700 bg-red-100/70 border-red-300 animate-pulse'
                    : 'text-zinc-600 border-zinc-200 hover:bg-zinc-100'
              )}
            >
              {isGeneral ? t('portalChat.topic') : key}
              {unread > 0 && (
                <span className={cn(
                  'inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full text-[9px] font-bold',
                  isActive ? (isGeneral ? 'bg-white text-zinc-900' : 'bg-white text-blue-600') : 'bg-red-500 text-white'
                )}>
                  {unread}
                </span>
              )}
            </button>
          )
        })}
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
            placeholder={t('portalChat.topicNamePlaceholder')}
            className="shrink-0 px-2.5 py-1 text-[11px] rounded-full border border-blue-300 outline-none bg-white text-zinc-800 placeholder:text-zinc-400 w-32"
          />
        ) : (
          <button
            onClick={() => setCreatingTopic(true)}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-full border border-dashed border-zinc-300 text-zinc-500 hover:text-zinc-700 hover:border-zinc-400 transition-colors"
          >
            <Plus className="h-3 w-3" />
            {t('portalChat.createNewTopic')}
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={handleMessagesScroll} className="h-full overflow-y-auto p-4 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400">
            <MessageCircle className="h-12 w-12 mb-3" />
            <p className="text-sm font-medium">{t('chat.noMessages')}</p>
            <p className="text-xs mt-1">{t('chat.noMessagesDesc')}</p>
          </div>
        ) : (
          <>
          {/* Load older messages */}
          {hasMore && (
            <div className="flex justify-center mb-2">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 bg-zinc-100 rounded-full hover:bg-zinc-200 disabled:opacity-50 transition-colors"
              >
                {loadingMore ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ChevronUp className="h-3 w-3" />
                )}
                {t('portalChat.loadOlderMessages')}
              </button>
            </div>
          )}
          {(() => {
            const pinned = (messages ?? []).filter(m => m.pinned_at && !m.deleted_at)
            if (pinned.length === 0) return null
            return (
              <div className="sticky top-0 z-10 bg-amber-50/90 backdrop-blur border border-amber-100 rounded-lg px-2.5 py-1.5 mb-2">
                <div className="flex items-center gap-1 mb-1">
                  <Pin className="h-3 w-3 text-amber-600" />
                  <span className="text-[11px] font-medium text-amber-700">
                    {t('portalChat.pinned')} ({pinned.length})
                  </span>
                </div>
                <div className="space-y-0.5 max-h-28 overflow-y-auto">
                  {pinned.map(pm => (
                    <div key={pm.id} className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-amber-100/60">
                      <button
                        onClick={() => scrollToPinned(pm.id)}
                        className="flex items-start gap-1.5 text-xs text-zinc-700 flex-1 min-w-0 text-left"
                      >
                        <Pin className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                        <span className="truncate flex-1">{pm.message || t('portalChat.attachmentPlaceholder')}</span>
                      </button>
                      <FastTooltip label={t('portalChat.unpin')}>
                        <button
                          onClick={() => togglePin(pm.id, false)}
                          className="shrink-0 text-zinc-400 hover:text-red-600"
                          aria-label={t('portalChat.unpin')}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </FastTooltip>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
          {filteredMessages.map((msg) => {
            const messageDate = formatMessageDate(msg.created_at)
            const showDateHeader = messageDate !== lastDate
            lastDate = messageDate
            const isOwn = msg.sender_id === userId
            const replyMsg = msg.reply_to_id ? messages.find(m => m.id === msg.reply_to_id) : null

            return (
              <div
                key={msg.id}
                id={`pc-msg-${msg.id}`}
                className={cn('group scroll-mt-4', pinHighlightId === msg.id && 'rounded-lg ring-2 ring-amber-400')}
              >
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
                    <>
                      <FastTooltip label={msg.pinned_at ? t('portalChat.unpin') : t('portalChat.pin')}>
                        <button
                          onClick={() => togglePin(msg.id, !msg.pinned_at)}
                          className={cn('p-1 rounded-full hover:bg-zinc-100 transition-colors shrink-0', msg.pinned_at ? 'text-amber-500' : 'text-zinc-300 hover:text-zinc-600')}
                          aria-label={msg.pinned_at ? t('portalChat.unpin') : t('portalChat.pin')}
                        >
                          <Pin className={cn('h-3.5 w-3.5', msg.pinned_at && 'fill-amber-400')} />
                        </button>
                      </FastTooltip>
                      <FastTooltip label={t('portalChat.reply')}>
                        <button
                          onClick={() => setReplyTo({ id: msg.id, message: msg.message, sender_type: msg.sender_type })}
                          className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors shrink-0"
                          aria-label={t('portalChat.reply')}
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </button>
                      </FastTooltip>
                    </>
                  )}
                  <div className={cn(
                    'max-w-[75%] px-3.5 py-2 rounded-2xl text-sm',
                    isOwn
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-zinc-100 text-zinc-900 rounded-bl-md',
                    msg.client_kept_unread && 'border-l-2 border-blue-400'
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
                          : (msg.account_id && accountNameById.get(msg.account_id)) || t('dashboard.company')}
                      </span>
                    )}
                    {!isOwn && (
                      <p className="text-[10px] font-medium text-zinc-500 mb-0.5">
                        {msg.sender_type === 'admin' || msg.sender_type === 'system' ? t('chat.team') : (msg.sender_name || t('chat.you'))}
                      </p>
                    )}
                    {isOwn && msg.sender_name && msg.sender_id !== userId && (
                      <p className="text-[10px] font-medium text-blue-200 mb-0.5">
                        {msg.sender_name}
                      </p>
                    )}
                    {/* Quoted reply */}
                    {replyMsg && (
                      <div
                        className={cn(
                          'px-2.5 py-1.5 rounded-lg text-xs mb-1.5 border-l-2 cursor-pointer',
                          isOwn
                            ? 'bg-blue-500/30 border-blue-300 text-blue-100 hover:bg-blue-500/40'
                            : 'bg-zinc-200 border-zinc-400 text-zinc-600 hover:bg-zinc-300'
                        )}
                        onClick={() => scrollToPinned(replyMsg.id)}
                      >
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
                    {msg.message && <p className="whitespace-pre-wrap break-words">{renderMessageText(msg.message, isOwn)}</p>}
                    <p className={cn(
                      'text-[10px] mt-1 flex items-center gap-1',
                      isOwn ? 'text-blue-200 justify-end' : 'text-zinc-400'
                    )}>
                      {formatTime(msg.created_at)}
                      {msg.edited_at && (
                        <span className="italic opacity-75">(edited)</span>
                      )}
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
                    <>
                      <FastTooltip label={t('portalChat.reply')}>
                        <button
                          onClick={() => setReplyTo({ id: msg.id, message: msg.message, sender_type: msg.sender_type })}
                          className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors shrink-0"
                          aria-label={t('portalChat.reply')}
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </button>
                      </FastTooltip>
                      <FastTooltip label={msg.pinned_at ? t('portalChat.unpin') : t('portalChat.pin')}>
                        <button
                          onClick={() => togglePin(msg.id, !msg.pinned_at)}
                          className={cn('p-1 rounded-full hover:bg-zinc-100 transition-colors shrink-0', msg.pinned_at ? 'text-amber-500' : 'text-zinc-300 hover:text-zinc-600')}
                          aria-label={msg.pinned_at ? t('portalChat.unpin') : t('portalChat.pin')}
                        >
                          <Pin className={cn('h-3.5 w-3.5', msg.pinned_at && 'fill-amber-400')} />
                        </button>
                      </FastTooltip>
                      {msg.sender_type === 'admin' && (
                        <FastTooltip label={msg.client_kept_unread ? t('portalChat.markRead') : t('portalChat.markUnread')}>
                          <button
                            onClick={() => toggleKeepUnread(msg.id, !msg.client_kept_unread)}
                            className={cn('p-1 rounded-full hover:bg-zinc-100 transition-colors shrink-0', msg.client_kept_unread ? 'text-blue-500' : 'text-zinc-300 hover:text-zinc-600')}
                            aria-label={msg.client_kept_unread ? t('portalChat.markRead') : t('portalChat.markUnread')}
                          >
                            <MailOpen className="h-3.5 w-3.5" />
                          </button>
                        </FastTooltip>
                      )}
                    </>
                  )}
                </div>
                {/* Emoji reactions strip — under the bubble, aligned to the message side.
                    Skipped for system messages (e.g. the office-closed auto-reply): the CRM
                    renders those as centered pills with no reaction strip, so allowing a
                    reaction here would be invisible to staff. */}
                {msg.sender_type !== 'system' && (
                  <div className={cn('px-1 mb-1', isOwn ? 'flex justify-end' : 'flex justify-start')}>
                    <MessageReactions
                      messageId={msg.id}
                      reactions={msg.reactions}
                      viewerReactorId={contactId || userId}
                      locale={locale}
                      align={isOwn ? 'right' : 'left'}
                      staffLabel={t('chat.team')}
                    />
                  </div>
                )}
              </div>
            )
          })}
          </>
        )}
      </div>
      {/* Jump to latest — floating pill, bottom-center of the messages area.
          Inverted styling vs the "Older messages" pill. Shows when scrolled
          >200px from the bottom, smooth-scrolls to newest, hides at bottom. */}
      {showJumpToLatest && (
        <FastTooltip label={t('portalChat.jumpToLatest')}>
          <button
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-zinc-800 rounded-full shadow-lg hover:bg-zinc-700 transition-colors"
            aria-label={t('portalChat.jumpToLatest')}
          >
            <ChevronDown className="h-3 w-3" />
            {t('portalChat.latest')}
            {unreadBelowCount > 0 && (
              <span className="ml-0.5 min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none">
                {unreadBelowCount}
              </span>
            )}
          </button>
        </FastTooltip>
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

      {/* "Replying in: [topic]" — always visible above the composer (2026-08-30,
          Antonio): the reader must always see which topic their message is
          about to land in, so they don't answer a named topic while actually
          sitting in General (or vice versa). */}
      <div className={cn(
        'px-4 py-1 border-t text-[11px] font-medium flex items-center gap-1.5',
        activeTopic ? 'bg-blue-50 text-blue-700' : 'bg-zinc-50 text-zinc-500'
      )}>
        {t('portalChat.replyingIn')} <span className="font-semibold">{activeTopic || t('portalChat.general')}</span>
      </div>

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

      {/* (The "Chatting about" indicator moved to the prominent top banner —
          see above. The bottom pill was removed per Antonio's UI feedback.) */}

      {/* Company chooser popup — "Which company is this message about?" */}
      {popupOpen && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPopupOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b">
              <h3 className="text-sm font-semibold text-zinc-900">
                {t('portalChat.whichCompanyTitle')}
              </h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {t('portalChat.whichCompanyDesc')}
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {entities.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => chooseEntity(e)}
                  className="w-full flex items-start gap-2.5 px-4 py-2.5 text-left hover:bg-zinc-50 transition-colors"
                >
                  <span className="mt-0.5 shrink-0">
                    {e.kind === 'formation'
                      ? <Sparkles className="h-4 w-4 text-amber-500" />
                      : e.kind === 'personal'
                        ? <UserIcon className="h-4 w-4 text-zinc-500" />
                        : e.isShared
                          ? <Users className="h-4 w-4 text-blue-600" />
                          : <Building2 className="h-4 w-4 text-blue-600" />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-zinc-900 truncate">{entityLabel(e)}</span>
                      {e.id === selectedEntityId && <Check className="h-3.5 w-3.5 text-blue-600 shrink-0" />}
                    </span>
                    {e.isShared && (
                      <span className="block text-[10px] text-amber-700 mt-0.5">
                        {t('portalChat.sharedEntityNote')}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
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
              <FastTooltip label={t('portalChat.emoji')} align="left">
                <button
                  onClick={() => setShowEmojiPicker(v => !v)}
                  className="p-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                  aria-label={t('portalChat.emoji')}
                >
                  <Smile className="h-5 w-5" />
                </button>
              </FastTooltip>
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
            <FastTooltip label={t('chat.stopRecording') || 'Stop recording'}>
              <button
                onClick={handleMicToggle}
                className="w-12 h-12 rounded-full bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 animate-pulse flex items-center justify-center shrink-0 transition-all"
                aria-label={t('chat.stopRecording') || 'Stop recording'}
              >
                <Square className="h-5 w-5 fill-current" />
              </button>
            </FastTooltip>
          ) : isTranscribing ? (
            <button
              disabled
              className="w-12 h-12 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center shrink-0"
            >
              <Loader2 className="h-5 w-5 animate-spin" />
            </button>
          ) : micSupported ? (
            <FastTooltip label={t('chat.startRecording') || 'Voice input'}>
              <button
                onClick={handleMicToggle}
                className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-600 hover:bg-blue-100 hover:text-blue-600 flex items-center justify-center shrink-0 transition-colors"
                aria-label={t('chat.startRecording') || 'Voice input'}
              >
                <Mic className="h-5 w-5" />
              </button>
            </FastTooltip>
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
