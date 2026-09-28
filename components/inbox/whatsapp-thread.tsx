'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  OUTBOX_TEAM_LABEL,
  describeOutboxStatus,
  isOutboxPending,
  sendNotice,
  type SendMode,
} from '@/lib/messaging/wabridge-outbox'
import {
  Send, Loader2, Paperclip, Sparkles, X, Smile, MoreVertical, Reply, Link2, Users, ClipboardList,
  StickyNote, Pin, Trash2, Check, AlertCircle, Clock, Hourglass, CheckCircle2, Truck, Receipt, Plus,
  Mic, Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { validateChatAttachment } from '@/lib/portal/chat-attachment'
import { loadWhatsAppDraft, saveWhatsAppDraft } from '@/lib/messaging/whatsapp-draft'
import { trackOpenMarkRead } from '@/lib/inbox/pending-mark-read'
import { mergeDraftIntoComposer } from '@/lib/inbox/whatsapp-worker-context'
import { guessMessageLocale } from '@/lib/messaging/lang-detect'
import { isMediaPending } from '@/lib/messaging/wabridge-media'
import { useAudioNoteRecorder } from '@/lib/hooks/use-audio-note-recorder'
import { WhatsAppVoiceNote, type VoiceInfo } from './whatsapp-voice-note'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { NoteComposeDialog } from '@/components/dashboard/note-quick-create'
import { ShareToTeamDialog, type ShareItem } from '@/components/team/share-to-team-dialog'
import { QuickCreateModal } from '@/components/dashboard/quick-create-modal'

// Same dynamic-import + ssr:false pattern as every other composer in this
// codebase that embeds this picker (portal-chat.tsx, floating-chat.tsx, …).
const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

/** The 4 tag states, matching the SAME catalog-backed columns Portal Chats' menu uses
 *  (message_actions.action_type) — a WhatsApp message tag lands on the SAME To-Do board. */
const ACTION_TAG_CONFIG: Record<string, { label: string; icon: typeof AlertCircle; color: string; bg: string }> = {
  action_needed: { label: 'Action Needed', icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-100' },
  in_progress: { label: 'In Progress', icon: Clock, color: 'text-blue-600', bg: 'bg-blue-100' },
  waiting_on_client: { label: 'Waiting on Client', icon: Hourglass, color: 'text-amber-600', bg: 'bg-amber-100' },
  done: { label: 'Done', icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-100' },
}
/** WhatsApp messages have no portal_messages row to key a tag/to-do card by — this free-text
 *  pointer (message_actions.source_ref) identifies one instead. Parse back with waMessageIdFromSourceRef. */
const waSourceRef = (messageId: string) => `wa_message:${messageId}`
const waMessageIdFromSourceRef = (sourceRef: string | null) =>
  sourceRef?.startsWith('wa_message:') ? sourceRef.slice('wa_message:'.length) : null

interface MessageActionRow {
  source_ref: string | null
  action_type: string
}

interface MessageReactionRow {
  emoji: string
  reactor_id: string
  reactor_name: string | null
}

interface WhatsAppMessage {
  id: string
  content_text: string | null
  direction: 'inbound' | 'outbound'
  sender_name: string | null
  sender_phone: string | null
  created_at: string
  content_type: string | null
  media_url: string | null
  /** Self-hosted line only: a reply still in the CRM's queue (waiting / test mode / not confirmed / failed). */
  outbox_status?: string | null
  /** Self-hosted line: the queue row id (needed to resolve a reply the Mac could not confirm). */
  outbox_id?: string | null
  /** Self-hosted line, staff only: the voice note's audio state + machine transcript. */
  voice?: VoiceInfo
  /** Self-hosted line: the per-message "three dots" menu (Antonio 2026-09-27, matching Portal Chats). */
  reactions?: MessageReactionRow[]
  pinned_at?: string | null
  reply_to_id?: string | null
}

interface WhatsappThreadProps {
  groupId: string
  /**
   * Lets the Worker side panel drop a draft into this message box. Called with the insert
   * function on mount and with null on unmount; the function returns false when it refuses
   * (a send is in flight).
   */
  registerInsertDraft?: (fn: ((draft: string) => boolean) | null) => void
}

interface StagedFile {
  name: string
  size: number
  mimeType: string
  path?: string
  error?: string
}

function formatTimestamp(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function WhatsappThread({ groupId, registerInsertDraft }: WhatsappThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)
  // One id per composed draft: a retry, double click or second tab of the SAME draft can never send twice (the server dedupes on it).
  const clientMsgRef = useRef<{ groupId: string; id: string } | null>(null)
  const getClientMsgId = () => {
    if (!clientMsgRef.current || clientMsgRef.current.groupId !== groupId) {
      clientMsgRef.current = { groupId, id: crypto.randomUUID() }
    }
    return clientMsgRef.current.id
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const suppressDraftSaveRef = useRef(false)
  const groupIdRef = useRef(groupId)
  groupIdRef.current = groupId // read by async callbacks (the language rewrite) to detect a chat switch mid-flight
  const [text, setText] = useState('')
  const [file, setFile] = useState<StagedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // The confirm screen's language dropdown — like the Portal Chats card, switching it REWRITES the message
  // (Antonio, 2026-08-01 precedent). Reset whenever confirm opens, never carried over between chats/drafts.
  const [confirmLocale, setConfirmLocale] = useState<'it' | 'en'>('en')
  const [rewriting, setRewriting] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  // Per-message "three dots" menu (Antonio 2026-09-27, "full menu", matching Portal Chats):
  // reply-to-a-message, pin, react, tag/to-do, discuss with team, share to team chat, a note, and
  // create task/service/invoice all live here. "Edit" is deliberately not offered — WhatsApp's real
  // message on the person's own phone never changes, so editing our own copy would just make it lie
  // about what they actually received. "Delete" (below) only hides OUR OWN copy; it never touches
  // the real message on their phone.
  const [replyTo, setReplyTo] = useState<{ id: string; text: string } | null>(null)
  const [noteSeed, setNoteSeed] = useState<{ accountId: string | null; contactId: string | null; prefill: string; originUrl?: string } | null>(null)
  const [shareItems, setShareItems] = useState<ShareItem[] | null>(null)
  const [quickCreate, setQuickCreate] = useState<{ type: 'task' | 'sd' | 'invoice'; messageText: string } | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [reactingMessageId, setReactingMessageId] = useState<string | null>(null)
  const reactionPickerRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  // Mark this conversation read the moment it's opened — Antonio, 2026-09-18:
  // "the number of unread and read doesn't work." Root cause: unlike Gmail's
  // thread view (message-thread.tsx), nothing here ever called a mark-read
  // endpoint at all — the only way a WhatsApp conversation's unread_count
  // ever reached 0 was the explicit row icon, so real conversations read
  // months ago were still sitting on double-digit unread counts, inflating
  // the WhatsApp tab's badge. Reuses the same dedicated route the row icon
  // already calls (app/api/inbox/whatsapp/mark-read), and the same
  // trackOpenMarkRead/openMarkReadSettled guard Gmail's equivalent open-time
  // mark-read already uses — this call and the row's own "mark unread"
  // toggle both write the same column, and without the guard a fast reopen
  // right after clicking "mark unread" could race this call to land last and
  // silently undo it (the exact incident that guard was built for, 2026-08-05).
  useEffect(() => {
    const call = fetch('/api/inbox/whatsapp/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, unread: false }),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
    })
    trackOpenMarkRead(`whatsapp:${groupId}`, call)
  }, [groupId, queryClient])

  // Auto-grow the textarea as the message gets longer, capped so the reply
  // bar can't push the message list off-screen (Antonio, 2026-09-17: "I don't
  // see the field where I write that is expandable to see the entire text").
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  useEffect(() => {
    if (!reactingMessageId) return
    const handleClick = (e: MouseEvent) => {
      if (reactionPickerRef.current && !reactionPickerRef.current.contains(e.target as Node)) {
        setReactingMessageId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [reactingMessageId])

  useEffect(() => {
    if (!showEmojiPicker) return
    const handleClick = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showEmojiPicker])

  const { data, isLoading, error } = useQuery<{
    messages: WhatsAppMessage[]
    send?: { mode: SendMode; hasInbound: boolean } | null
    chat?: { name: string | null; phone: string | null; language: string | null; accountId: string | null; contactId: string | null } | null
  }>({
    queryKey: ['whatsapp-messages', groupId],
    queryFn: () =>
      fetch(`/api/inbox/whatsapp/messages/${encodeURIComponent(groupId)}`).then((r) =>
        r.json()
      ),
    // 5 s while one of our replies is still waiting to be sent or a voice note is still being prepared, otherwise the usual minute
    refetchInterval: (query) =>
      query.state.data?.messages?.some(
        (m) => (m.outbox_status && isOutboxPending(m.outbox_status)) || (m.voice && isMediaPending(m.voice.status, m.voice.audio_deleted))
      )
        ? 5_000
        : 60_000,
  })

  // Tag/To-Do state for every message in this chat, one query per open chat (same pattern Portal
  // Chats' own menu uses) — only runs once this chat is linked to a CRM account/contact, since an
  // unlinked WhatsApp chat has nothing to scope the lookup to (Tag Message / To Do are hidden then).
  const actionsScopeId = data?.chat?.accountId || data?.chat?.contactId || null
  const actionsScopeParam = data?.chat?.accountId ? `account_id=${data.chat.accountId}` : `contact_id=${data?.chat?.contactId}`
  const { data: messageActions } = useQuery<MessageActionRow[]>({
    queryKey: ['wa-message-actions', actionsScopeId],
    queryFn: () =>
      fetch(`/api/crm/admin-actions/message-actions?${actionsScopeParam}`).then((r) => r.json()).then((d) => d.actions || []),
    enabled: !!actionsScopeId,
    refetchInterval: 15_000,
  })
  const actionByMessageId = new Map<string, string>() // message id -> action_type
  for (const a of messageActions ?? []) {
    const mid = waMessageIdFromSourceRef(a.source_ref)
    if (mid) actionByMessageId.set(mid, a.action_type)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [data?.messages])

  // Deep link: /inbox?thread=whatsapp:<groupId>&message=<id> (the per-message "Copy link" action)
  // scrolls to and briefly highlights that exact message once it's loaded. Read once per chat open —
  // a later normal scroll (a new message arriving) must not re-trigger this.
  const didScrollToMessageRef = useRef(false)
  useEffect(() => { didScrollToMessageRef.current = false }, [groupId])
  useEffect(() => {
    if (didScrollToMessageRef.current || isLoading || typeof window === 'undefined') return
    const targetId = new URLSearchParams(window.location.search).get('message')
    if (!targetId) { didScrollToMessageRef.current = true; return }
    const found = (data?.messages ?? []).some((m) => m.id === targetId)
    if (!found) return // keep waiting — the messages list may still be loading in
    didScrollToMessageRef.current = true
    const el = document.getElementById(`wa-msg-${targetId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedMessageId(targetId)
      setTimeout(() => setHighlightedMessageId((cur) => (cur === targetId ? null : cur)), 2500)
    }
  }, [data?.messages, isLoading])

  // Switching conversations must not carry over a half-composed reply or
  // confirm screen from the previous one — but a draft FOR the conversation
  // being switched to should load back in, same as the new-conversation
  // popup already does (Antonio, 2026-09-18: caught this one missing here).
  //
  // suppressDraftSaveRef guards a real race: the save effect below runs on
  // EVERY text change, but on mount it would otherwise fire with the render's
  // stale pre-load text ('') BEFORE this effect's setText commits — wiping
  // out the very draft just read from storage. Caught live under React's dev
  // double-invoke (StrictMode runs mount effects twice), which reproduced it
  // reliably: the draft was saved correctly, then silently deleted the
  // instant the conversation was reopened. The flag defers the very next
  // save-effect run until after the loaded value has actually committed.
  useEffect(() => {
    suppressDraftSaveRef.current = true
    setText(loadWhatsAppDraft('reply', groupId))
    setFile(null)
    setConfirming(false)
    setReplyTo(null) // a quoted reply belongs to the chat being left, not the one being opened
    setRewriting(false) // an in-flight rewrite belongs to the chat being left, not the one being opened
    audioNoteRecorder.cancelRecording() // an in-progress recording belongs to the chat being left; discard, don't attach it to the new one
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopRecording is stable (useCallback with no changing deps); including the whole object would re-run this on every recorder state change
  }, [groupId])

  // Save on every change, not just on unmount — a crashed tab must not lose it.
  useEffect(() => {
    if (suppressDraftSaveRef.current) {
      suppressDraftSaveRef.current = false
      return
    }
    saveWhatsAppDraft('reply', groupId, text)
  }, [groupId, text])

  // A draft from the Worker panel goes through the same box the staff member types in and
  // still needs their own press of Send. Adds below anything already typed (never overwrites),
  // and drops the confirm screen so what Confirm sends is always what is visibly in the box.
  useEffect(() => {
    if (!registerInsertDraft) return
    registerInsertDraft((draft: string) => {
      if (sendingRef.current) return false
      setText((prev) => mergeDraftIntoComposer(prev, draft))
      setConfirming(false)
      textareaRef.current?.focus()
      return true
    })
    return () => registerInsertDraft(null)
  }, [registerInsertDraft])

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: groupId,
          message: text,
          channel: 'whatsapp',
          attachmentPath: file?.path,
          attachmentMimeType: file?.mimeType,
          clientMsgId: getClientMsgId(),
          replyToId: replyTo?.id,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: (result: { status?: string }) => {
      clientMsgRef.current = null // the next draft gets a fresh id
      if (result?.status === 'shadow') toast.info('Test mode: your reply was recorded but NOT sent to WhatsApp.')
      setText('')
      setFile(null)
      setConfirming(false)
      setReplyTo(null)
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] })
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Send failed')
    },
  })

  const handlePickFile = () => fileInputRef.current?.click()

  // Shared by the paperclip picker AND the mic recorder — a recorded voice note is just a File like any
  // other, and goes through the exact same upload path so it is sent exactly the way a picked file is.
  const uploadAndStageFile = async (picked: File) => {
    // The self-hosted line: any attachment (audio is sent as a voice note), a dedicated upload route
    // (dangerous-type block, size ceiling, a server-built deterministic path keyed to this message's id).
    // Any other provider keeps the older whatsapp-new/ staging path unchanged.
    const isWabridge = !!data?.send
    if (!isWabridge) {
      const validationError = validateChatAttachment(picked.name, picked.size, picked.type)
      if (validationError) {
        toast.error(validationError)
        return
      }
    }

    setFile({ name: picked.name, size: picked.size, mimeType: picked.type })
    setUploading(true)
    try {
      const urlRes = await fetch(isWabridge ? '/api/inbox/whatsapp/attachment-upload-url' : '/api/inbox/whatsapp-new/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isWabridge
            ? { groupId, clientMsgId: getClientMsgId(), fileName: picked.name, fileSize: picked.size, mimeType: picked.type }
            : { file_name: picked.name, file_size: picked.size, mime_type: picked.type }
        ),
      })
      if (!urlRes.ok) {
        const d = await urlRes.json().catch(() => ({}))
        throw new Error(d.error || 'Could not start the upload.')
      }
      const { signedUrl, path } = await urlRes.json()
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': picked.type || 'application/octet-stream' },
        body: picked,
      })
      if (!putRes.ok) throw new Error('Upload failed. Please try again.')
      setFile((prev) => (prev ? { ...prev, path } : prev))
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.'
      setFile((prev) => (prev ? { ...prev, error: msg } : prev))
      toast.error(msg)
    } finally {
      setUploading(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    await uploadAndStageFile(picked)
  }

  const audioNoteRecorder = useAudioNoteRecorder({
    onRecorded: (recordedFile) => { void uploadAndStageFile(recordedFile) },
    onError: (msg) => toast.error(msg),
  })

  const handleSuggest = async () => {
    setSuggesting(true)
    try {
      const res = await fetch('/api/inbox/whatsapp-new/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not generate a suggestion.')
      setText(data.suggestion || '')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not generate a suggestion.')
    } finally {
      setSuggesting(false)
    }
  }

  const handleOpenConfirm = () => {
    // A voice note or an attachment can go with NO caption at all — text is only required when there is no
    // uploaded file (an ordinary text reply still needs real words).
    if ((!text.trim() && !file?.path) || !canSend || audioNoteRecorder.isRecording) return
    if (uploading) {
      toast.error('Wait for the attachment to finish uploading.')
      return
    }
    if (file?.error) {
      toast.error('Remove the attachment or re-attach it before sending.')
      return
    }
    // Default the language dropdown: a guess from the text itself, else the contact's saved language, else English.
    // The staff member sees and can change this before Confirm — it is a starting point, never silent.
    const guessed = guessMessageLocale(text)
    const stored = data?.chat?.language ?? null
    setConfirmLocale(guessed ?? (stored && /ital/i.test(stored) ? 'it' : stored && /engl/i.test(stored) ? 'en' : 'en'))
    setConfirming(true)
  }

  // Rewrite the confirm screen's text into the chosen language — same pattern as the Portal Chats Worker card
  // (Antonio, 2026-08-01): switching the dropdown rewrites in place rather than asking for a manual redo. If the
  // rewrite fails, the dropdown is put back so it can never disagree with what Confirm would actually send.
  const handleConfirmLocaleChange = async (next: 'it' | 'en') => {
    if (next === confirmLocale || rewriting) return
    if (!text.trim()) { setConfirmLocale(next); return } // nothing to rewrite — e.g. a captionless attachment
    const previousLocale = confirmLocale
    const previousText = text
    const requestGroupId = groupId // the chat this rewrite is FOR — a late response must never land in a different one
    setConfirmLocale(next)
    setRewriting(true)
    try {
      const res = await fetch('/api/inbox/whatsapp-new/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: requestGroupId, rewriteText: previousText, language: next }),
      })
      const d = await res.json()
      if (!res.ok || !d.suggestion) throw new Error(d.error || 'Could not rewrite the message.')
      if (groupIdRef.current !== requestGroupId) return // the staff member already moved to a different chat — drop it silently
      setText(d.suggestion)
    } catch (err) {
      if (groupIdRef.current === requestGroupId) setConfirmLocale(previousLocale) // the box still holds the old-language text — the dropdown must say so too
      toast.error(err instanceof Error && err.message ? err.message : 'Could not rewrite the message.')
    } finally {
      if (groupIdRef.current === requestGroupId) setRewriting(false)
    }
  }

  // A reply the Mac could not confirm ("Not confirmed — check the phone"): a person looks at the phone and decides. Never retried automatically.
  const [resolving, setResolving] = useState<string | null>(null)
  const resolveOutbox = async (outboxId: string, action: 'sent' | 'discard') => {
    if (resolving) return
    setResolving(outboxId)
    try {
      const res = await fetch('/api/inbox/whatsapp/outbox/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outboxId, action }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save your decision — please try again.')
      }
      toast.success(action === 'sent' ? 'Marked as sent.' : 'Discarded — it was not sent.')
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save your decision — please try again.')
    } finally {
      setResolving(null)
    }
  }

  const handleConfirmSend = () => {
    if (sendingRef.current || sendMutation.isPending) return
    sendingRef.current = true
    sendMutation.mutate(undefined, { onSettled: () => { sendingRef.current = false } })
  }

  // ── Per-message "three dots" menu actions (Antonio 2026-09-27) ─────────────────────────────
  const reactMutation = useMutation({
    mutationFn: async (vars: { messageId: string; emoji: string }) => {
      const res = await fetch(`/api/inbox/whatsapp/message/${vars.messageId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: vars.emoji }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not react to that message.')
      }
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] }),
    onError: (err: Error) => toast.error(err.message || 'Could not react to that message.'),
  })

  const pinMutation = useMutation({
    mutationFn: async (vars: { messageId: string; pinned: boolean }) => {
      const res = await fetch(`/api/inbox/whatsapp/message/${vars.messageId}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: vars.pinned }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not pin that message.')
      }
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] }),
    onError: (err: Error) => toast.error(err.message || 'Could not pin that message.'),
  })

  // "Delete" — hides the message from OUR OWN screen only. The real WhatsApp message, on the
  // person's own phone, is completely untouched — there is no way to recall or unsend it from here.
  const hideMutation = useMutation({
    mutationFn: async (messageId: string) => {
      const res = await fetch(`/api/inbox/whatsapp/message/${messageId}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not hide that message.')
      }
      return res.json()
    },
    onSuccess: () => {
      toast.success('Hidden from our view — the real WhatsApp message is untouched.')
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] })
    },
    onError: (err: Error) => toast.error(err.message || 'Could not hide that message.'),
  })

  const tagMutation = useMutation({
    mutationFn: async (vars: { messageId: string; actionType: string; label?: string }) => {
      const res = await fetch('/api/crm/admin-actions/message-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_ref: waSourceRef(vars.messageId),
          contact_id: data?.chat?.contactId || null,
          account_id: data?.chat?.accountId || null,
          action_type: vars.actionType,
          label: vars.label,
        }),
      })
      if (!res.ok) throw new Error('Could not tag that message.')
      return res.json()
    },
    onSuccess: () => {
      toast.success('Message tagged')
      queryClient.invalidateQueries({ queryKey: ['wa-message-actions', actionsScopeId] })
    },
    onError: () => toast.error('Could not tag that message.'),
  })

  const [todoNote, setTodoNote] = useState<{ messageId: string; note: string } | null>(null)
  const addTodoMutation = useMutation({
    mutationFn: (vars: { messageId: string; label: string }) =>
      tagMutation.mutateAsync({ messageId: vars.messageId, actionType: 'action_needed', label: vars.label }),
    onSuccess: () => setTodoNote(null),
  })

  const copyDeepLink = (messageId: string) => {
    const url = `${window.location.origin}/inbox?thread=whatsapp:${groupId}&message=${messageId}`
    navigator.clipboard.writeText(url)
      .then(() => toast.success('Link copied'))
      .catch(() => toast.error('Could not copy the link.'))
  }

  const createInternalThread = async (accountId: string, sourceMessageId: string, sourceText: string) => {
    try {
      const res = await fetch('/api/internal/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, source_message_id: sourceMessageId || undefined, title: sourceText.slice(0, 100) || undefined }),
      })
      if (!res.ok) throw new Error('Failed to create thread')
      const d = await res.json()
      toast.success(d.reused ? 'Added to existing thread' : 'Internal thread created')
    } catch {
      toast.error('Failed to create internal thread')
    }
  }

  const messages = data?.messages ?? []
  // Self-hosted line: `send` is present. The server enforces every rule; this only avoids offering a button that would be refused.
  const notice = data?.send ? sendNotice(data.send) : null
  const canSend = !data?.send || (data.send.mode !== 'paused' && data.send.hasInbound)
  // Attachments/voice notes ARE supported on the self-hosted line now (Antonio 2026-09-27) — kept as a named
  // constant since the paperclip button still needs to know "is this the wabridge line" for its upload route.
  const isWabridgeLine = !!data?.send

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {isLoading ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={cn('flex', i % 3 === 0 ? 'justify-end' : 'justify-start')}
            >
              <div className="h-10 bg-zinc-100 rounded-2xl animate-pulse w-48" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          Failed to load messages
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          No messages in this conversation
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-zinc-50">
          {messages.map((msg) => {
            const isOutbound = msg.direction === 'outbound'
            const isImage = msg.content_type === 'image'
            const isOtherMedia = !isImage && msg.content_type !== 'text' && !!msg.media_url
            // Outbox rows are a queued reply not yet sent (synthetic id "outbox:<uuid>") — the
            // "three dots" menu (react/pin/reply-to/tag/…) only applies to a real, sent message.
            const isRealMessage = !msg.id.startsWith('outbox:')
            const quotedMessage = msg.reply_to_id ? messages.find((m) => m.id === msg.reply_to_id) : null
            const activeTag = isRealMessage ? actionByMessageId.get(msg.id) : undefined
            const reactionGroups = (msg.reactions ?? []).reduce<Record<string, number>>((acc, r) => {
              acc[r.emoji] = (acc[r.emoji] ?? 0) + 1
              return acc
            }, {})

            const actionButton = isRealMessage && (
              <DropdownMenu.Root>
                <FastTooltip label="Actions">
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="p-1 rounded-full text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors shrink-0 self-end mb-1"
                      aria-label="Actions"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenu.Trigger>
                </FastTooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="z-50 w-48 py-1 bg-white rounded-lg shadow-lg border text-sm animate-in fade-in-0 zoom-in-95 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
                    sideOffset={4}
                    collisionPadding={8}
                    align={isOutbound ? 'end' : 'start'}
                  >
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                      onSelect={() => { setReplyTo({ id: msg.id, text: msg.content_text || '[Attachment]' }); textareaRef.current?.focus() }}
                    >
                      <Reply className="h-3.5 w-3.5 text-zinc-400" /> Reply
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                      onSelect={() => copyDeepLink(msg.id)}
                    >
                      <Link2 className="h-3.5 w-3.5 text-zinc-400" /> Copy link
                    </DropdownMenu.Item>
                    {data?.chat?.accountId && (
                      <DropdownMenu.Item
                        className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                        onSelect={() => createInternalThread(data.chat!.accountId as string, msg.id, msg.content_text || '')}
                      >
                        <Users className="h-3.5 w-3.5 text-zinc-400" /> Discuss with Team
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                      onSelect={() => setShareItems([{
                        kind: 'client_message',
                        title: data?.chat?.name ?? 'WhatsApp contact',
                        subtitle: msg.content_text || '[Attachment]',
                        body: msg.content_text || undefined,
                        url: `/inbox?thread=whatsapp:${groupId}&message=${msg.id}`,
                        entity_type: 'whatsapp_message',
                        entity_id: msg.id,
                      }])}
                    >
                      <Send className="h-3.5 w-3.5 text-zinc-400" /> Share to team chat
                    </DropdownMenu.Item>
                    {(data?.chat?.accountId || data?.chat?.contactId) && (
                      <DropdownMenu.Item
                        className="flex items-center gap-2.5 px-3 py-2 text-violet-700 hover:bg-violet-50 cursor-pointer outline-none"
                        onSelect={() => setTodoNote({ messageId: msg.id, note: msg.content_text || '' })}
                      >
                        <ClipboardList className="h-3.5 w-3.5 text-violet-500" /> To Do
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 px-3 py-2 text-amber-700 hover:bg-amber-50 cursor-pointer outline-none"
                      onSelect={() => setNoteSeed({
                        accountId: data?.chat?.accountId ?? null,
                        contactId: data?.chat?.contactId ?? null,
                        prefill: msg.content_text || '',
                        originUrl: `/inbox?thread=whatsapp:${groupId}&message=${msg.id}`,
                      })}
                    >
                      <StickyNote className="h-3.5 w-3.5 text-amber-500" /> Make a note
                    </DropdownMenu.Item>
                    {(data?.chat?.accountId || data?.chat?.contactId) && (
                      <>
                        <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                        <DropdownMenu.Label className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                          Tag Message
                        </DropdownMenu.Label>
                        {Object.entries(ACTION_TAG_CONFIG).map(([key, cfg]) => {
                          const TagIcon = cfg.icon
                          const isActive = activeTag === key
                          return (
                            <DropdownMenu.Item
                              key={key}
                              className={cn(
                                'flex items-center gap-2.5 px-3 py-2 cursor-pointer outline-none',
                                isActive ? `${cfg.bg} ${cfg.color} font-medium` : 'text-zinc-700 hover:bg-zinc-50'
                              )}
                              onSelect={() => tagMutation.mutate({ messageId: msg.id, actionType: key })}
                            >
                              <TagIcon className={cn('h-3.5 w-3.5', isActive ? cfg.color : 'text-zinc-400')} />
                              {cfg.label}
                              {isActive && <Check className="h-3 w-3 ml-auto" />}
                            </DropdownMenu.Item>
                          )
                        })}
                      </>
                    )}
                    {data?.chat?.accountId && (
                      <>
                        <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                        <DropdownMenu.Label className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                          Create
                        </DropdownMenu.Label>
                        <DropdownMenu.Item
                          className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                          onSelect={() => setQuickCreate({ type: 'task', messageText: msg.content_text || '' })}
                        >
                          <ClipboardList className="h-3.5 w-3.5 text-zinc-400" /> Task
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                          onSelect={() => setQuickCreate({ type: 'sd', messageText: msg.content_text || '' })}
                        >
                          <Truck className="h-3.5 w-3.5 text-zinc-400" /> Service
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="flex items-center gap-2.5 px-3 py-2 text-zinc-500 hover:bg-zinc-50 cursor-pointer outline-none text-xs"
                          onSelect={() => setQuickCreate({ type: 'invoice', messageText: msg.content_text || '' })}
                        >
                          <Receipt className="h-3.5 w-3.5 text-zinc-400" /> Invoice
                        </DropdownMenu.Item>
                      </>
                    )}
                    <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 px-3 py-2 text-zinc-700 hover:bg-zinc-50 cursor-pointer outline-none"
                      onSelect={() => pinMutation.mutate({ messageId: msg.id, pinned: !msg.pinned_at })}
                    >
                      <Pin className={cn('h-3.5 w-3.5', msg.pinned_at ? 'text-amber-500 fill-amber-400' : 'text-zinc-400')} />
                      {msg.pinned_at ? 'Unpin message' : 'Pin message'}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 px-3 py-2 text-red-600 hover:bg-red-50 cursor-pointer outline-none"
                      onSelect={() => {
                        const preview = msg.content_text ? (msg.content_text.length > 80 ? msg.content_text.slice(0, 80) + '…' : msg.content_text) : '[Attachment]'
                        if (window.confirm(`Hide this message from our view?\n\n"${preview}"\n\nThis only removes it from the CRM — the real message stays exactly where WhatsApp put it, on their phone.`)) {
                          hideMutation.mutate(msg.id)
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
              <div
                key={msg.id}
                id={`wa-msg-${msg.id}`}
                className={cn('flex items-end gap-1', isOutbound ? 'justify-end' : 'justify-start')}
              >
                {!isOutbound && actionButton}
                <div
                  className={cn(
                    'max-w-[70%] px-3 py-2 rounded-2xl shadow-sm transition-colors',
                    isOutbound
                      ? 'bg-green-100 text-zinc-800 rounded-br-sm'
                      : 'bg-white text-zinc-800 rounded-bl-sm',
                    highlightedMessageId === msg.id && 'ring-2 ring-blue-400'
                  )}
                >
                  {msg.pinned_at && (
                    <p className="text-[10px] font-medium text-amber-600 flex items-center gap-1 mb-1">
                      <Pin className="h-2.5 w-2.5 fill-amber-400" /> Pinned
                    </p>
                  )}
                  {quotedMessage && (
                    <div className="mb-1 pl-2 border-l-2 border-zinc-300 text-xs text-zinc-500 truncate">
                      {quotedMessage.content_text || '[Attachment]'}
                    </div>
                  )}
                  {isImage && msg.media_url ? (
                    <a href={msg.media_url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={msg.media_url}
                        alt={msg.content_text || 'Image'}
                        className="max-w-full rounded-lg mb-1"
                      />
                    </a>
                  ) : msg.content_type === 'voice' && msg.voice ? (
                    <WhatsAppVoiceNote messageId={msg.id} voice={msg.voice} />
                  ) : isOtherMedia ? (
                    <a
                      href={msg.media_url ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm italic text-blue-600 underline"
                    >
                      {msg.content_text || `Attachment (${msg.content_type})`}
                    </a>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {msg.content_text}
                    </p>
                  )}
                  {msg.outbox_status && describeOutboxStatus(msg.outbox_status) && (
                    <p
                      className={cn(
                        'text-[11px] mt-1 font-medium',
                        describeOutboxStatus(msg.outbox_status)?.tone === 'bad' ? 'text-red-600' : describeOutboxStatus(msg.outbox_status)?.tone === 'warn' ? 'text-amber-700' : 'text-zinc-500'
                      )}
                    >
                      {describeOutboxStatus(msg.outbox_status)?.label}
                    </p>
                  )}
                  {msg.outbox_status === 'unknown' && msg.outbox_id && (
                    <div className="flex gap-2 mt-1.5">
                      <button
                        type="button"
                        disabled={resolving === msg.outbox_id}
                        onClick={() => resolveOutbox(msg.outbox_id as string, 'sent')}
                        className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                      >
                        It was sent
                      </button>
                      <button
                        type="button"
                        disabled={resolving === msg.outbox_id}
                        onClick={() => resolveOutbox(msg.outbox_id as string, 'discard')}
                        className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        It was not sent — discard
                      </button>
                    </div>
                  )}
                  <p className="text-[10px] text-zinc-400 mt-1 text-right">
                    {msg.sender_name ?? msg.sender_phone ?? (isOutbound ? OUTBOX_TEAM_LABEL : 'Contact')}
                    {' · '}
                    {formatTimestamp(msg.created_at)}
                  </p>
                  {isRealMessage && (
                    <div className={cn('flex flex-wrap items-center gap-1 mt-1', isOutbound ? 'justify-end' : 'justify-start')}>
                      {Object.entries(reactionGroups).map(([emoji, count]) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => reactMutation.mutate({ messageId: msg.id, emoji })}
                          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-1.5 py-0.5 text-xs leading-none hover:bg-zinc-50"
                        >
                          <span className="leading-none">{emoji}</span>
                          <span className="tabular-nums text-zinc-500">{count}</span>
                        </button>
                      ))}
                      <div className="relative" ref={reactingMessageId === msg.id ? reactionPickerRef : undefined}>
                        <FastTooltip label="Add reaction">
                          <button
                            type="button"
                            onClick={() => setReactingMessageId((cur) => (cur === msg.id ? null : msg.id))}
                            className="inline-flex items-center justify-center rounded-full p-1 text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                          >
                            <Smile className="h-3 w-3" />
                          </button>
                        </FastTooltip>
                        {reactingMessageId === msg.id && (
                          <div className={cn('absolute z-50 bottom-full mb-1', isOutbound ? 'right-0' : 'left-0')}>
                            <EmojiPicker
                              onEmojiClick={(emojiData: { emoji: string }) => {
                                reactMutation.mutate({ messageId: msg.id, emoji: emojiData.emoji })
                                setReactingMessageId(null)
                              }}
                              lazyLoadEmojis
                              width={280}
                              height={340}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {isOutbound && actionButton}
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Composer — same feature set as the "start a new WhatsApp
          conversation" popup: attach, AI Suggest, and a confirm step before
          sending, so replying from an open conversation isn't a different,
          thinner experience than starting one (Antonio, 2026-09-17). */}
      <div className="border-t bg-white shrink-0">
        {notice && (
          <p className={cn('text-xs px-3 pt-2', notice.tone === 'warn' ? 'text-amber-700' : 'text-zinc-500')}>{notice.text}</p>
        )}
        {sendMutation.isError && (
          <p className="text-xs text-red-600 px-3 pt-2">
            Failed to send: {sendMutation.error.message}
          </p>
        )}

        {!confirming ? (
          <div className="p-2 space-y-2">
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
            {replyTo && (
              <div className="flex items-center gap-2 text-xs bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
                <Reply className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <span className="truncate flex-1 text-blue-700">{replyTo.text}</span>
                <button onClick={() => setReplyTo(null)} className="text-blue-400 hover:text-blue-700">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {file && (
              <div className="flex items-center gap-2 text-xs bg-zinc-50 border rounded px-2 py-1.5">
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                <span className="truncate flex-1">{file.name}</span>
                {file.error && <span className="text-red-600">{file.error}</span>}
                <button onClick={() => setFile(null)} className="text-zinc-400 hover:text-zinc-700">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="relative shrink-0" ref={emojiPickerRef}>
                <button
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                  aria-label="Insert an emoji"
                >
                  <Smile className="h-4 w-4" />
                </button>
                {showEmojiPicker && (
                  <div className="absolute bottom-11 left-0 z-30">
                    <EmojiPicker
                      onEmojiClick={(emojiData: { emoji: string }) => {
                        const el = textareaRef.current
                        if (el) {
                          const start = el.selectionStart ?? text.length
                          const end = el.selectionEnd ?? start
                          const next = text.slice(0, start) + emojiData.emoji + text.slice(end)
                          setText(next)
                          requestAnimationFrame(() => {
                            el.focus()
                            el.setSelectionRange(start + emojiData.emoji.length, start + emojiData.emoji.length)
                          })
                        } else {
                          setText((prev) => prev + emojiData.emoji)
                        }
                        setShowEmojiPicker(false)
                      }}
                      width={300}
                      height={360}
                      lazyLoadEmojis
                      skinTonesDisabled
                    />
                  </div>
                )}
              </div>
              <textarea
                ref={textareaRef}
                className="compose-reply-textarea flex-1 resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-400 min-h-[40px] max-h-60 disabled:bg-zinc-50 disabled:text-zinc-400"
                rows={1}
                disabled={suggesting || audioNoteRecorder.isRecording}
                placeholder={audioNoteRecorder.isRecording ? 'Recording… tap the mic to stop' : suggesting ? 'Writing a suggestion…' : 'Type a WhatsApp message…'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return
                  e.preventDefault()
                  handleOpenConfirm()
                }}
              />
              {isWabridgeLine && audioNoteRecorder.isSupported && (
                <FastTooltip label={audioNoteRecorder.isRecording ? 'Stop recording' : 'Record a voice note'}>
                  <button
                    type="button"
                    onClick={() => (audioNoteRecorder.isRecording ? audioNoteRecorder.stopRecording() : audioNoteRecorder.startRecording())}
                    disabled={!!file && !audioNoteRecorder.isRecording}
                    className={cn(
                      'inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg border transition-colors disabled:opacity-40',
                      audioNoteRecorder.isRecording
                        ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 animate-pulse'
                        : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50'
                    )}
                    aria-label={audioNoteRecorder.isRecording ? 'Stop recording' : 'Record a voice note'}
                  >
                    {audioNoteRecorder.isRecording ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4 w-4" />}
                  </button>
                </FastTooltip>
              )}
              <button
                onClick={handlePickFile}
                disabled={!!file || audioNoteRecorder.isRecording}
                className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40"
                aria-label="Attach a file"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <button
                onClick={handleSuggest}
                disabled={suggesting || audioNoteRecorder.isRecording}
                className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-40"
                aria-label="AI Suggest"
              >
                {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              </button>
              <button
                onClick={handleOpenConfirm}
                disabled={(!text.trim() && !file?.path) || uploading || !canSend || audioNoteRecorder.isRecording}
                className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg bg-green-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-700 transition-colors"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            {isWabridgeLine && (
              <p className="text-[11px] text-zinc-400 px-1">
                Don&apos;t send ID or tax documents over WhatsApp — use the portal instead.
              </p>
            )}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {/* WHO it is going to — always shown, never assumed (a wrong open chat must be obvious here). */}
            <p className="text-xs text-zinc-500">
              Sending to{' '}
              <span className="font-medium text-zinc-700">
                {data?.chat?.name ?? 'this chat'}
                {data?.chat?.phone ? ` (${data.chat.phone})` : ''}
              </span>
            </p>
            <div className="bg-zinc-50 rounded-lg p-3 text-sm whitespace-pre-wrap break-words">
              {rewriting ? <span className="text-zinc-400">Rewriting…</span> : text || <span className="text-zinc-400">(no caption — just the attachment)</span>}
            </div>
            {file && (
              <p className="text-xs text-zinc-500 flex items-center gap-1">
                <Paperclip className="h-3 w-3" /> Attaching: {file.name}
              </p>
            )}
            {/* Language — same pattern as the Portal Chats card: switching it rewrites the text above in place. */}
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Language:</span>
              <select
                value={confirmLocale}
                onChange={(e) => handleConfirmLocaleChange(e.target.value as 'it' | 'en')}
                disabled={rewriting || sendMutation.isPending}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 disabled:opacity-50"
              >
                <option value="en">English</option>
                <option value="it">Italian</option>
              </select>
              <span className="text-zinc-400">{rewriting ? 'rewriting…' : 'switching rewrites the message'}</span>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setConfirming(false)}
                disabled={rewriting}
                className="px-3 py-1.5 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
              >
                Edit
              </button>
              <button
                onClick={handleConfirmSend}
                disabled={sendMutation.isPending || rewriting}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
              >
                {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Confirm & Send
              </button>
            </div>
          </div>
        )}
      </div>

      {/* "Make a note" from a message's menu — the shared editor, same as Portal Chats. */}
      {noteSeed && (
        <NoteComposeDialog
          accountId={noteSeed.accountId}
          contactId={noteSeed.accountId ? undefined : noteSeed.contactId}
          prefill={noteSeed.prefill}
          originUrl={noteSeed.originUrl}
          onClose={() => setNoteSeed(null)}
        />
      )}

      {/* "Share to team chat" from a message's menu — the shared dialog, same as Portal Chats/Inbox. */}
      {shareItems && (
        <ShareToTeamDialog items={shareItems} onClose={() => setShareItems(null)} label="1 message" />
      )}

      {/* "Create Task / Service / Invoice" from a message's menu. */}
      {quickCreate && data?.chat?.accountId && (
        <QuickCreateModal
          type={quickCreate.type}
          messageText={quickCreate.messageText}
          accountId={data.chat.accountId}
          companyName={data.chat.name ?? ''}
          onClose={() => setQuickCreate(null)}
        />
      )}

      {/* "To Do" from a message's menu — same message_actions mechanism Tag Message uses. */}
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
                onChange={(e) => setTodoNote((prev) => (prev ? { ...prev, note: e.target.value } : prev))}
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
                onClick={() => addTodoMutation.mutate({ messageId: todoNote.messageId, label: todoNote.note })}
                className="flex items-center gap-1 text-sm font-medium bg-violet-600 text-white rounded px-3 py-1.5 disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" /> {addTodoMutation.isPending ? 'Adding…' : 'Add to board'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
