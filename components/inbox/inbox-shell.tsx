'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { ArrowLeft, MessageSquare, Mail, PenSquare, Archive, Star, Forward, Trash2, MailOpen, ClipboardList, Cog, Receipt, X, CheckSquare, Search, FolderInput, Reply, Bot, MessagesSquare, Palette, Ban, Link2, Send, Printer, ArchiveRestore } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { InboxHeader } from './inbox-header'
import { InboxSidebar } from './inbox-sidebar'
import { ConversationList } from './conversation-list'
import { MessageThread } from './message-thread'
import { WhatsappThread } from './whatsapp-thread'
import { ComposeReply } from './compose-reply'
import { ComposeDialog } from './compose-dialog'
import { CreateFromEmailDialog } from './create-from-email-dialog'
import { WorkerChatPanel } from './worker-chat-panel'
import { LinkClientDialog } from './link-client-dialog'
import { ShareToTeamDialog, type ShareItem } from '@/components/team/share-to-team-dialog'
import { HoverHint } from './hover-hint'
import { COLOR_MARKS, markByKey } from '@/lib/inbox/color-marks'
import {
  type RowOverride,
  type UnreadOverride,
  makeHiddenOverride,
  makeMoveOverrides,
  makeUnreadOverride,
  overrideKey,
} from '@/lib/inbox/conversation-reconcile'
import { ORIGIN_UNKNOWN, viewKey, type RowAction, type ViewScope } from '@/lib/inbox/view-query'
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client'
import type { InboxConversation, InboxChannel } from '@/lib/types'

const channelIcons: Record<InboxChannel, React.ElementType> = {
  gmail: Mail,
  portal: MessagesSquare,
  whatsapp: MessageSquare,
}

const channelLabels: Record<InboxChannel, string> = {
  gmail: 'Gmail',
  portal: 'Portal',
  whatsapp: 'WhatsApp',
}

/** Strip an email's HTML to readable plain text (drops style/script, collapses
 *  blank runs). Browser-only (uses the DOM); mirrors the Forward flow's logic. */
function stripEmailHtml(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  const raw = tmp.textContent || tmp.innerText || ''
  return raw.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

interface GmailLabel {
  id: string
  name: string
  type: 'system' | 'user'
}

interface InboxShellProps {
  /** Admin only — shows the antonio@ personal-mailbox toggle. The API routes
   *  enforce this server-side regardless. */
  canUsePersonalMailbox?: boolean
}

export function InboxShell({ canUsePersonalMailbox = false }: InboxShellProps) {
  const [activeChannel, setActiveChannel] = useState<InboxChannel | null>('gmail')
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [activeMailbox, setActiveMailbox] = useState<'support' | 'antonio'>('support')
  const [selected, setSelected] = useState<InboxConversation | null>(null)
  // WHICH LIST the open email was opened from. `selected` is a row source that
  // OUTLIVES its list: clearing the search reverts the pane to the Inbox while
  // the email stays open, and a ?thread= deep link opens one with no list behind
  // it at all. The toolbar Delete acts on THIS row, so it must be stamped with
  // this origin — not with whatever list happens to be showing (council,
  // 2026-07-16: deleting a cleared-search result would otherwise be 'confirmed'
  // by the Inbox, and Undo would inject an archived email into it).
  const [selectedOrigin, setSelectedOrigin] = useState<string>(ORIGIN_UNKNOWN)
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeMenuOpen, setComposeMenuOpen] = useState(false)
  const [forwardData, setForwardData] = useState<{ subject: string; body: string; from: string } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [createDialog, setCreateDialog] = useState<{ type: 'task' | 'service' | 'invoice'; conversation: InboxConversation } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const [moveToOpen, setMoveToOpen] = useState(false)
  const [restoreToOpen, setRestoreToOpen] = useState(false)
  const [colorMenuOpen, setColorMenuOpen] = useState(false)
  const [workerOpen, setWorkerOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [shareItems, setShareItems] = useState<ShareItem[] | null>(null)
  const [shareFromBulk, setShareFromBulk] = useState(false)
  const [deepLinkDone, setDeepLinkDone] = useState(false)
  const [unreadFilter, setUnreadFilter] = useState<'all' | 'unread' | 'read'>('all')
  // Optimistic overrides — the single source of "what the list shows" layered
  // on the eventually-consistent Gmail payload (Luca flicker fix). `overrides`
  // holds hidden (deleted) + pinned (restored) intents and is PERSISTED so a
  // remount inside the window doesn't un-hide a just-deleted row; `unread` holds
  // mark-read/unread optimism and is in-memory. The reconcile pass in
  // ConversationList releases both only on confirmed server agreement.
  // The key is versioned on the ENTRY SHAPE — and BOTH the entry and the map key
  // changed again (entries now carry `id`; the key is (id + view) so one email can
  // hold two overrides at once). A v3 entry is unkeyable under these rules, so it
  // is dropped rather than stranded. Cost: a browser mid-window at deploy time
  // loses its pending hides and a just-deleted row pops back once — it self-heals
  // within 5 minutes, and it is the accepted price of every bump here.
  // Older keys are read once — only to DELETE them: the blob holds real client
  // email (sender, subject, preview), and an unread key would keep it in every
  // staff browser forever instead of self-expiring after 5 min.
  const [overrides, setOverrides] = useState<Map<string, RowOverride>>(() => {
    if (typeof window === 'undefined') return new Map()
    try {
      const stored = localStorage.getItem('inbox-overrides-v4')
      if (!stored) return new Map()
      const parsed = JSON.parse(stored) as { entries: [string, RowOverride][]; ts: number }
      if (Date.now() - parsed.ts > 5 * 60 * 1000) {
        localStorage.removeItem('inbox-overrides-v4')
        return new Map()
      }
      return new Map(parsed.entries)
    } catch { return new Map() }
  })
  const [unread, setUnread] = useState<Map<string, UnreadOverride>>(new Map())
  // Evict superseded versions of the store (they can never be read again).
  useEffect(() => {
    try { for (const k of ['inbox-overrides', 'inbox-overrides-v2', 'inbox-overrides-v3']) localStorage.removeItem(k) } catch { /* ignore */ }
  }, [])
  // Persist hidden/pinned intents so a PWA remount mid-window keeps them.
  useEffect(() => {
    try {
      if (overrides.size === 0) localStorage.removeItem('inbox-overrides-v4')
      else localStorage.setItem('inbox-overrides-v4', JSON.stringify({ entries: Array.from(overrides.entries()), ts: Date.now() }))
    } catch { /* ignore */ }
  }, [overrides])
  // Overrides are optimistic state for ONE mailbox's list. On a mailbox switch,
  // clear them so a support@ pin/hide can't leak into the antonio@ view (a
  // pinned row would otherwise render in the wrong mailbox). Guarded so the
  // persisted overrides loaded at mount survive the initial render.
  const mailboxMountRef = useRef(true)
  useEffect(() => {
    if (mailboxMountRef.current) { mailboxMountRef.current = false; return }
    setOverrides(new Map())
    setUnread(new Map())
  }, [activeMailbox])
  // WHICH LIST the rows on screen came from, reported by ConversationList (which
  // owns the payload). Every override is stamped with THIS.
  //
  // The shell deliberately does NOT derive a view of its own any more. It knows
  // what was SELECTED (label/search/mailbox/channel), and that is a different
  // thing: clicking a folder flips the selection instantly while the previous
  // rows stay on screen and clickable for the whole fetch (by design —
  // `keepPreviousData`, so the pane never flashes empty). Stamping the selection
  // marked rows with a list that never held them, which then "confirmed" a delete
  // it never saw and, on Undo, injected those emails into that folder. Both
  // reviewers found it independently (2026-07-16) — the same mistake as judging
  // by the current view, on the write side. One owner, one answer.
  // The id-universe these lists are drawn from. Used ONLY to NAME a list other
  // than the one on screen — the Trash a Restore takes a row OUT of, and the
  // destination it puts it INTO. It is NOT "the current view": that mistake is
  // exactly what the payload stamp below exists to prevent.
  const viewScope = useMemo<ViewScope>(
    () => ({ mailbox: activeMailbox, channel: activeChannel ?? 'gmail' }),
    [activeMailbox, activeChannel]
  )
  const trashViewKey = useMemo(() => viewKey({ kind: 'trash' }, viewScope), [viewScope])
  const [payloadViewKey, setPayloadViewKey] = useState<string | null>(null)
  // No payload yet → no list to attribute a row to. Say so rather than guessing:
  // any REAL key is one some payload will match and "confirm" with. Unknown must
  // mean unknown — the override still APPLIES (action-derived) and retires via
  // the TTL tombstone instead of being confirmed by a stranger.
  const originViewKey = payloadViewKey ?? ORIGIN_UNKNOWN
  const queryClient = useQueryClient()
  // Print/Save-as-PDF handler registered by the open MessageThread (it holds the
  // email bodies; the toolbar only holds the conversation metadata).
  const printRef = useRef<(() => void) | null>(null)

  const isWhatsApp = activeChannel === 'whatsapp'
  const isGmail = selected?.channel === 'gmail'
  // Read/unread state of the OPEN email: optimistic override wins, else the row.
  const openUnread = selected
    ? (unread.has(selected.id)
        ? (unread.get(selected.id)?.value ?? 0) > 0
        : selected.unread > 0)
    : false

  // Real-time inbox refresh: Gmail push (users.watch → Pub/Sub → webhook →
  // gmail_push_events row) — new mail appears within seconds instead of the
  // 30s poll, which remains the fallback. DEBOUNCED (trailing 2.5s): every
  // archive/delete also fires a push event, so a bulk action on N emails
  // used to trigger N back-to-back full refetches (each up to ~300 Gmail
  // calls server-side) — a storm that rate-limited Gmail and blanked the
  // list (Antonio 2026-07-08). One refetch after the burst settles.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel('inbox-gmail-push')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'gmail_push_events' },
        () => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
            queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
            queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
          }, 2500)
        }
      )
      .subscribe()
    return () => {
      if (debounce) clearTimeout(debounce)
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deep-link: /inbox?thread=gmail:<id>&mailbox=support|antonio opens a specific
  // email (used by the "Share to team chat" card link back to the source). Read
  // from window.location once on mount (no useSearchParams → no Suspense need on
  // this client component). The messages endpoint gives us subject + sender to
  // fill the thread header; MessageThread fetches the body itself.
  useEffect(() => {
    if (deepLinkDone) return
    setDeepLinkDone(true)
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const thread = params.get('thread')
    if (!thread || !thread.startsWith('gmail:')) return
    const mailbox = params.get('mailbox') === 'antonio' ? 'antonio' : 'support'
    setActiveMailbox(mailbox)
    setActiveChannel('gmail')
    ;(async () => {
      try {
        const res = await fetch(`/api/inbox/messages/${encodeURIComponent(thread)}?mailbox=${mailbox}`)
        const data = await res.json().catch(() => ({}))
        setSelected({
          id: thread,
          channel: 'gmail',
          name: data?.name || '',
          preview: '',
          unread: 0,
          lastMessageAt: '',
          subject: data?.subject || '',
        })
      } catch {
        // Fall back to a bare stub so the thread still opens by id.
        setSelected({ id: thread, channel: 'gmail', name: '', preview: '', unread: 0, lastMessageAt: '' })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkDone])

  // Build a ShareItem for an email conversation (email → 'link' card: subject as
  // title, sender + snippet as subtitle, deep-link back to /inbox).
  const buildEmailShareItem = useCallback((c: InboxConversation): ShareItem => ({
    kind: 'link',
    title: c.subject || c.name || 'Email',
    subtitle: c.name ? (c.preview ? `${c.name} · ${c.preview}` : c.name) : (c.preview || ''),
    url: `/inbox?thread=${encodeURIComponent(c.id)}&mailbox=${activeMailbox}`,
    entity_type: 'email',
    entity_id: c.id,
  }), [activeMailbox])

  // Single-email share: fetch the full email body and embed it as the shared
  // message's text (Antonio wants the entire email, not just the snippet). Falls
  // back to a card-only share if the fetch fails.
  const openShareForSelectedEmail = useCallback(async () => {
    if (!selected) return
    setShareFromBulk(false)
    const base = buildEmailShareItem(selected)
    try {
      const params = activeMailbox ? `?mailbox=${activeMailbox}` : ''
      const res = await fetch(`/api/inbox/messages/${encodeURIComponent(selected.id)}${params}`)
      const data = await res.json().catch(() => ({}))
      const msgs: Array<{ content?: string }> = data?.messages || []
      const last = msgs[msgs.length - 1]
      const fullText = stripEmailHtml(last?.content || '') || selected.preview || ''
      setShareItems([{ ...base, body: fullText }])
    } catch {
      setShareItems([base])
    }
  }, [selected, activeMailbox, buildEmailShareItem])

  // Bulk "Share to Support": resolve the selected ids to conversation objects
  // from the react-query cache (the list that populated the checkboxes), then
  // open the share dialog with one item per email.
  const handleBulkShare = useCallback(() => {
    const cached = queryClient.getQueriesData<{ conversations: InboxConversation[] }>({ queryKey: ['inbox-conversations'] })
    const map = new Map<string, InboxConversation>()
    for (const [, data] of cached) {
      (data?.conversations || []).forEach(c => map.set(c.id, c))
    }
    const items = Array.from(selectedIds).map(id => {
      const c = map.get(id)
      return c
        ? buildEmailShareItem(c)
        : { kind: 'link' as const, title: 'Email', url: `/inbox?thread=${encodeURIComponent(id)}&mailbox=${activeMailbox}`, entity_type: 'email', entity_id: id }
    })
    setShareFromBulk(true)
    setShareItems(items)
  }, [queryClient, selectedIds, buildEmailShareItem, activeMailbox])

  // ALWAYS clears the open email; CONDITIONALLY records the hide. The hide carries
  // the ACTION so each view decides for itself whether the row is gone from it:
  // 'trash' removes it everywhere but Trash; 'archive' only from inbox-scoped
  // views (it keeps the folder label — archiving from a folder legitimately leaves
  // the email there, so hiding it created a claim the server could never confirm).
  const handleEmailDeleted = useCallback((action: RowAction, conv: InboxConversation, originView: string) => {
    setOverrides(prev => dropClaimsFor(prev, conv.id).set(overrideKey(conv.id, originView), makeHiddenOverride(Date.now(), conv.id, action, originView, conv)))
    setSelected(prev => prev?.id === conv.id ? null : prev)
  }, [])

  // Undo of a delete. Convert the hidden intent into a PINNED one: the restored
  // row stays visible (from its snapshot) until Gmail re-indexes the untrash and
  // the server confirms it's back — no more "restored but invisible for 5 min"
  // (Luca, 2026-07-13). The reconcile pass releases the pin on server agreement.
  /** The most recent DELETE (`trash`/`archive`) for a row, whatever list it was
   *  made in — i.e. "was this deleted, and from where?". The map is keyed by
   *  (id + view) and the key is opaque, so scanning is the only honest way to ask.
   *  `untrash` hides are excluded: a restore is not a delete, and treating one as
   *  the answer sends the Undo's pin back to Trash (where it is dropped, since
   *  `to === from`) instead of to the list the row actually came from. */
  const findHide = (m: Map<string, RowOverride>, id: string): RowOverride | undefined => {
    let best: RowOverride | undefined
    for (const o of Array.from(m.values())) {
      if (o.id === id && o.kind === 'hidden' && !o.releasedAt && o.action !== 'untrash') {
        if (!best || o.createdAt > best.createdAt) best = o
      }
    }
    return best
  }
  /** Drop EVERY existing claim about a row. A new user intent supersedes all of
   *  them, and a stale half is not harmless: a hide left over from the folder a
   *  row was deleted in still APPLIES in the Inbox (trash removes it from there
   *  too), and a hide outranks a pin — so restoring would land the email in
   *  NEITHER list until the TTL, up to 6.5 minutes. Likewise a re-delete must
   *  drop the `untrash` hide holding the row out of Trash, or the row is missing
   *  from Trash — the one place it now is (bug-hunter, 2026-07-16). */
  const dropClaimsFor = (m: Map<string, RowOverride>, id: string): Map<string, RowOverride> => {
    const next = new Map(m)
    for (const [k, o] of Array.from(m)) if (o.id === id) next.delete(k)
    return next
  }
  const snapshotOf = (m: Map<string, RowOverride>, id: string): InboxConversation | undefined => {
    for (const o of Array.from(m.values())) if (o.id === id && o.snapshot) return o.snapshot
    return undefined
  }

  // Undo of a delete = a MOVE: the row leaves Trash and returns to the list it
  // was deleted from. Both halves are optimistic, so it is instant in BOTH places
  // — which also fixes a live bug for free: until now Undo only flipped the hide
  // to a pin in ONE view, so the restored email sat in Trash for another 30-60s.
  //
  // The destination is the HIDE's own `originView` — the list the snapshot came
  // from, recorded at delete time. Re-deriving it here would depend on the Undo
  // toast's closure still holding the delete-time value, which stops being true
  // the moment a payload for another list lands inside the toast's 8s life.
  const handleEmailRestored = useCallback((id: string) => {
    setOverrides(prev => {
      const hide = findHide(prev, id)
      if (!hide) return prev
      // Every prior claim about this row must GO — not just the one hide we
      // matched. The row is coming back, and any surviving hide would suppress
      // the pin we are about to add (a hide outranks a pin).
      const next = dropClaimsFor(prev, id)
      for (const [k, ov] of makeMoveOverrides({
        now: Date.now(),
        id,
        action: 'untrash',
        from: trashViewKey,
        to: hide.originView ?? null,
        snapshot: hide.snapshot,
      })) next.set(k, ov)
      return next
    })
  }, [trashViewKey])

  // Restore FROM Trash — the button Antonio asked for. A MOVE: the row leaves
  // Trash and appears at its destination, both optimistically, so neither waits
  // on Gmail's 30-60s index. No destination = the Inbox (what `untrash` does
  // server-side); a destination = that folder instead.
  //
  // The `from` is the TRASH key rather than the payload's key on purpose: this is
  // only reachable from the Trash list, and naming it explicitly means the hide
  // says what it means even if the button is ever reused elsewhere.
  /** `scope` is passed explicitly by the late `filedTo` correction, which must use
   *  the scope of the CLICK, not of whatever mailbox is open when the response
   *  lands (a mid-flight mailbox switch clears the map for a reason). */
  const handleRestoredTo = useCallback((conv: InboxConversation, destLabelId: string | null, scope?: ViewScope) => {
    const dest = viewKey(destLabelId ? { kind: 'label', label: destLabelId } : { kind: 'inbox' }, scope ?? viewScope)
    setOverrides(prev => {
      // Clear every stale claim first — above all the hide from the list this row
      // was deleted IN. It still applies wherever a trash removes a row (i.e. the
      // Inbox), and a hide outranks a pin, so leaving it would restore the email
      // into NEITHER list.
      const next = dropClaimsFor(prev, conv.id)
      for (const [k, ov] of makeMoveOverrides({
        now: Date.now(),
        id: conv.id,
        action: 'untrash',
        from: trashViewKey,
        to: dest,
        snapshot: conv,
      })) next.set(k, ov)
      return next
    })
    setSelected(prev => (prev?.id === conv.id ? null : prev))
  }, [trashViewKey, viewScope])

  // Restore the OPEN email (Trash only). Mirrors the row Restore; the row travels
  // as a mutation variable, never read live at settle.
  const restoreOpenMutation = useMutation({
    mutationFn: async ({ conv, destLabelId }: { conv: InboxConversation; destLabelId: string | null; scope: ViewScope; pinnedAt: string }) => {
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: conv.id.replace('gmail:', ''),
          action: 'untrash',
          mailbox: activeMailbox,
          destLabelId: destLabelId ?? undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to restore email.')
      }
      return res.json().catch(() => ({}))
    },
    onError: (err, { conv }) => {
      // Roll the optimistic move BACK. Without this the email is hidden from
      // Trash — the one list it is actually still in — and phantom-pinned into
      // the Inbox for minutes, while the toast tells the user to retry on a row
      // he cannot see. The bulk path already concedes this principle on a partial
      // failure (bug-hunter, 2026-07-16).
      setOverrides(prev => dropClaimsFor(prev, conv.id))
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to restore email.')
    },
    onSuccess: (data, { conv, destLabelId, scope, pinnedAt }) => {
      // Trust WHERE IT ACTUALLY LANDED, not where we asked. The server files down
      // a ladder (destination → Inbox → back to Trash), so on a fallback our
      // optimistic pin would otherwise sit on a folder the email is not in and
      // the toast would name it — a row that isn't there, under a lie.
      const filedTo = (data as { filedTo?: string } | undefined)?.filedTo ?? destLabelId ?? 'INBOX'
      if (filedTo !== (destLabelId ?? 'INBOX')) {
        // Correct the pin to where it ACTUALLY landed — but only if our own pin is
        // still this row's live claim. He may have deleted it again while the
        // request was in flight, and re-writing then would resurrect an email he
        // just deleted (senior engineer, 2026-07-16).
        setOverrides(prev => {
          const stillOurs = Array.from(prev.values()).some(o => o.id === conv.id && o.kind === 'pinned' && o.originView === pinnedAt)
          if (!stillOurs) return prev
          const next = dropClaimsFor(prev, conv.id)
          for (const [k, ov] of makeMoveOverrides({
            now: Date.now(), id: conv.id, action: 'untrash',
            from: viewKey({ kind: 'trash' }, scope),
            to: viewKey(filedTo === 'INBOX' ? { kind: 'inbox' } : { kind: 'label', label: filedTo }, scope),
            snapshot: conv,
          })) next.set(k, ov)
          return new Map(next)
        })
      }
      const name = filedTo === 'INBOX' ? 'Inbox' : (userLabels.find(l => l.id === filedTo)?.name ?? 'folder')
      toast.success(`Email restored to ${name}`)
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
    },
  })
  const handleRestoreOpen = useCallback((conv: InboxConversation, destLabelId: string | null) => {
    // Freeze the scope + the pin's key at CLICK time; a late correction must not
    // read whatever mailbox is open when the response lands.
    const scope = viewScope
    const pinnedAt = viewKey(destLabelId ? { kind: 'label', label: destLabelId } : { kind: 'inbox' }, scope)
    handleRestoredTo(conv, destLabelId, scope) // optimistic move first — instant in both lists
    restoreOpenMutation.mutate({ conv, destLabelId, scope, pinnedAt })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleRestoredTo, viewScope])

  // Is the list ON SCREEN the Trash? From the PAYLOAD's key, never the selection —
  // during a view switch the rows shown are still the previous list's.
  const viewingTrash = payloadViewKey === trashViewKey

  // Bulk Restore out of Trash. Each row is a MOVE (out of Trash, into the Inbox),
  // and the failures are un-hidden individually — the route reports which ids
  // failed, and a row that is still in Trash must be visible there.
  const bulkRestoreMutation = useMutation({
    mutationFn: async ({ ids }: { ids: string[] }) => {
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadIds: ids.map(id => id.replace('gmail:', '')),
          action: 'untrash',
          bulk: true,
          mailbox: activeMailbox,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to restore emails.')
      }
      return res.json().catch(() => ({}))
    },
    onError: (err, { ids }) => {
      setOverrides(prev => {
        let next = prev
        ids.forEach(id => { next = dropClaimsFor(next, id) })
        return new Map(next)
      })
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to restore emails.')
    },
    onSuccess: (data, { ids }) => {
      const out = data as { succeeded?: number; failed?: number; failedIds?: string[] } | undefined
      const failedSet = new Set((out?.failedIds ?? []).map(t => `gmail:${t}`))
      if (failedSet.size > 0) {
        setOverrides(prev => {
          let next = prev
          failedSet.forEach(id => { next = dropClaimsFor(next, id) })
          return new Map(next)
        })
        toast.warning(`Restored ${ids.length - failedSet.size} of ${ids.length} — ${failedSet.size} are still in Trash.`)
      } else {
        toast.success(`${ids.length} email${ids.length > 1 ? 's' : ''} restored to Inbox`)
      }
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
    },
  })
  const handleBulkRestore = useCallback(() => {
    const ids = Array.from(selectedIds)
    const rowsById = new Map<string, InboxConversation>()
    for (const [, d] of queryClient.getQueriesData<{ conversations: InboxConversation[] }>({ queryKey: ['inbox-conversations'] })) {
      d?.conversations?.forEach(c => { if (ids.includes(c.id)) rowsById.set(c.id, c) })
    }
    ids.forEach(id => {
      const row = rowsById.get(id)
      if (row) handleRestoredTo(row, null)
    })
    setSelectedIds(new Set())
    bulkRestoreMutation.mutate({ ids })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, handleRestoredTo])

  const bulkMode = selectedIds.size > 0

  const { data: labelsData } = useQuery<{ labels: GmailLabel[] }>({
    queryKey: ['gmail-labels', activeMailbox],
    queryFn: () => fetch(`/api/inbox/labels?mailbox=${activeMailbox}`).then(r => r.json()),
    refetchInterval: 60_000,
    enabled: !isWhatsApp,
  })
  const userLabels = (labelsData?.labels || []).filter(l => l.type === 'user')

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setMoveToOpen(false)
  }, [])

  const handleLabelChange = (labelId: string | null) => {
    setActiveLabel(labelId)
    if (labelId) setActiveChannel('gmail')
    setSelected(null)
  }

  const emailActionMutation = useMutation({
    // THE ROW AND ITS LIST BOTH TRAVEL WITH THE REQUEST, frozen at click time —
    // the same rule the bulk path's `ids` follows, and for the same reasons.
    // NEVER read `selected` in `mutationFn` or `onSuccess`: react-query refreshes
    // a pending mutation's options every render and reads the NEWEST closure at
    // settle, and when the PWA is offline it PAUSES before sending and re-reads
    // `mutationFn` on resume. Reading it live meant: open A → Delete → (drop
    // signal / click row B) → the resumed request trashes **B**, a live client
    // email, with no Undo, while A survives (council, 2026-07-16).
    mutationFn: async ({ action, forwardTo, color, conv }: { action: string; forwardTo?: string; color?: string | null; originView?: string; conv?: InboxConversation | null }) => {
      if (!conv) return
      const threadId = conv.id.replace('gmail:', '')
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, action, forwardTo, color, mailbox: activeMailbox }),
      })
      if (!res.ok) throw new Error('Action failed')
      return res.json()
    },
    onSuccess: (data, variables) => {
      // `acted` is the row the REQUEST was about — never `selected`, which by now
      // may be a different email entirely (see mutationFn).
      const acted = variables.conv
      if (variables.action === 'set_color') {
        // Optimistically paint the list row + the open conversation
        const colorMark = variables.color ?? null
        if (acted) {
          queryClient.setQueriesData<{ conversations: InboxConversation[]; total: number }>(
            { queryKey: ['inbox-conversations'] },
            (old) => old
              ? { ...old, conversations: old.conversations.map(c => c.id === acted.id ? { ...c, colorMark } : c) }
              : old
          )
          // Only repaint the open email if it IS the one we recoloured.
          setSelected(prev => prev && prev.id === acted.id ? { ...prev, colorMark } : prev)
        }
        toast.success(colorMark ? `Marked ${markByKey(colorMark)?.label ?? colorMark}` : 'Mark removed')
        return
      }
      if (variables.action === 'archive' || variables.action === 'trash') {
        if (acted) {
          handleEmailDeleted(variables.action as RowAction, acted, variables.originView ?? ORIGIN_UNKNOWN)
        }
      }
      if (variables.action === 'trash') {
        // The open-email Delete gets the same Undo as the list-row Delete
        // (Antonio, 2026-07-14 — it previously had none). Capture the id now:
        // handleEmailDeleted above clears `selected`, and the toast callback runs
        // later.
        const deletedId = acted?.id
        const snapshot = (data as { restore?: unknown } | undefined)?.restore
        toast('Email deleted', {
          action: {
            label: 'Undo',
            onClick: async () => {
              if (!deletedId) return
              try {
                const res = await fetch('/api/inbox/email-actions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    threadId: deletedId.replace('gmail:', ''),
                    action: 'untrash',
                    mailbox: activeMailbox,
                    restore: snapshot,
                  }),
                })
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}))
                  throw new Error(err.error || 'Failed to restore email.')
                }
                // Pin the restored row visible — do NOT immediately refetch the
                // conversations list: that racing refetch into Gmail's untrash
                // lag is exactly what made the row vanish for a few seconds. The
                // pin holds it until the server confirms it's back.
                handleEmailRestored(deletedId)
                toast.success('Email restored')
                queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
                queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
              } catch (err) {
                toast.error(
                  err instanceof Error && err.message ? err.message : 'Failed to restore email.',
                )
              }
            },
          },
          duration: 8000,
        })
      }
      if (variables.action === 'archive') {
        toast.success('Email archived')
      }
      if (variables.action === 'mark_unread') {
        if (selected) {
          setUnread(prev => new Map(prev).set(selected.id, makeUnreadOverride(Math.max(selected.unread, 1), prev.get(selected.id)?.baseline ?? selected.unread, Date.now())))
        }
        setSelected(null)
        toast.success('Marked as unread')
      }
      if (variables.action === 'mark_unread' || variables.action === 'mark_read') {
        // Optimistic unread already updated the badge — do NOT force a heavy
        // (~300-Gmail-call) conversations refetch just to flip a read dot. The
        // reconcile releases the override once Gmail catches up. Stats/labels
        // are cheap.
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      } else if (variables.action === 'trash' || variables.action === 'archive') {
        // Handled optimistically by the hide override; the Gmail push event +
        // the poll reconcile the server list. No immediate conversations
        // refetch — that racing refetch into Gmail's untrash lag is what made
        // restored emails vanish. Refresh cheap stats/labels only.
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      } else {
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
      }
    },
  })

  const bulkActionMutation = useMutation({
    // The selection AND the view we acted from travel WITH the request as
    // variables, captured once at click time by the caller. Both the send (below)
    // and the optimistic hide (onSuccess) read that SAME frozen pair, so they can
    // never diverge — the hide is stamped with the list the rows were deleted
    // FROM, even if the user has since clicked into another one.
    // Reading live `selectedIds` in either place is a trap: onSuccess gets the
    // newest render's closure, and — when the PWA is offline — react-query PAUSES
    // the mutation before sending and re-reads `mutationFn` on resume, so a
    // checkbox ticked meanwhile would be trashed with no Undo (or a de-selected
    // one hidden though never sent, sticky + persisted for 5 min).
    mutationFn: async ({ action, labelId, ids }: { action: string; labelId?: string; ids: string[]; originView: string }) => {
      const threadIds = ids.map(id => id.replace('gmail:', ''))
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadIds, action, labelId, bulk: true, mailbox: activeMailbox }),
      })
      if (!res.ok) {
        // R099 — surface the server's actual reason; a bare throw made a failed
        // bulk action a silent no-op (no toast at all) under Gmail rate-limits.
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Bulk action failed — please try again.')
      }
      return res.json()
    },
    onError: (err) => {
      toast.error(err instanceof Error && err.message ? err.message : 'Bulk action failed — please try again.')
    },
    onSuccess: (data, variables) => {
      const idsAtStart = variables.ids
      const idSet = new Set(idsAtStart)
      const count = idsAtStart.length
      if (variables.action === 'archive' || variables.action === 'trash') {
        // Hide via the SAME override map as the single-row delete, snapshotting
        // the full rows FIRST. The old cache-filter threw the rows away, so (a)
        // the next push refetch repopulated them from Gmail's lagging index and
        // they popped back for 30-60s, and (b) a bulk Undo had nothing to put
        // back and relied on a refetch into the untrash lag (invisible ~1 min).
        const rowsById = new Map<string, InboxConversation>()
        for (const [, d] of queryClient.getQueriesData<{ conversations: InboxConversation[] }>({ queryKey: ['inbox-conversations'] })) {
          d?.conversations?.forEach(c => { if (idSet.has(c.id)) rowsById.set(c.id, c) })
        }
        setOverrides(prev => {
          let next = prev
          // Snapshot source, best → worst: the raw cached row; else an existing
          // override's snapshot (e.g. re-deleting a row that is currently PINNED
          // from an earlier Undo — such a row is injected from its snapshot and
          // is NOT in the raw payload). If both miss (a carried-forward
          // unenriched row), the reconcile falls back to the list's last-known
          // copy, which conversation-list retains for overridden ids.
          //
          // Drop each row's prior claims FIRST — this is an intent-writer like
          // the other three. Re-deleting a row that was restored leaves its
          // `untrash` hide behind otherwise, and that hide holds the row OUT of
          // Trash while it is genuinely IN Trash: it can never be witnessed away,
          // so the email is missing from Trash for the full TTL (bug-hunter).
          idsAtStart.forEach(id => {
            const snap = rowsById.get(id) ?? snapshotOf(next, id)
            next = dropClaimsFor(next, id)
            next.set(overrideKey(id, variables.originView), makeHiddenOverride(Date.now(), id, variables.action as RowAction, variables.originView, snap))
          })
          return new Map(next)
        })
        if (selected && idSet.has(selected.id)) setSelected(null)
      }
      // Optimistic unread badges — Gmail's index lags label changes
      if (variables.action === 'mark_read' || variables.action === 'mark_unread') {
        const v = variables.action === 'mark_read' ? 0 : 1
        // Baselines from the cached list so each override releases only when
        // Gmail moves OFF the pre-action value (not on a stale lagging read).
        const unreadById = new Map<string, number>()
        for (const [, d] of queryClient.getQueriesData<{ conversations: InboxConversation[] }>({ queryKey: ['inbox-conversations'] })) {
          d?.conversations?.forEach(c => unreadById.set(c.id, c.unread))
        }
        setUnread(prev => {
          const next = new Map(prev)
          idsAtStart.forEach(id => next.set(id, makeUnreadOverride(v, next.get(id)?.baseline ?? unreadById.get(id) ?? (v === 0 ? 1 : 0), Date.now())))
          return next
        })
      }
      clearSelection()

      // The bulk route runs the threads through Promise.allSettled and reports
      // `succeeded`/`failed` — a per-thread Gmail failure still returns HTTP 200.
      // Reporting `count` regardless would tell the user every email was handled
      // when some were not (Antonio 2026-07-14). Always report what the SERVER
      // actually did; fall back to `count` only if the field is absent.
      const summary = data as { succeeded?: number; failed?: number; failedIds?: string[]; restore?: unknown } | undefined
      const okCount = typeof summary?.succeeded === 'number' ? summary.succeeded : count
      const failCount = typeof summary?.failed === 'number' ? summary.failed : 0

      // Read/unread already reflected by the optimistic badges above +
      // the archive/trash rows already filtered optimistically — a heavy
      // conversations refetch here is what blanked the list under Gmail load
      // (Antonio 2026-07-08). Only refetch the list for label MOVES (which
      // change membership and aren't optimistically handled).
      //
      // EXCEPT on a PARTIAL FAILURE. The optimistic filter above removed EVERY
      // selected row, including the ones Gmail refused to delete/archive — so
      // without this the toast says "1 failed" while that very email is hidden
      // from the list, and the user hunts for an email the screen is denying
      // exists. It reappears on the 30s poll, but a warning you cannot act on
      // for 30s is barely better than no warning. Refetch immediately so the
      // survivors come back. Failure-path only, so the 2026-07-08 "don't refetch
      // on every bulk action" guard (a SUCCESS-path concern) is untouched.
      // PARTIAL FAILURE: some selected emails were NOT actually deleted/archived.
      // We hid the whole batch optimistically, and the route reports COUNTS, not
      // which ids failed — so drop the hides for the entire batch rather than
      // leave a still-live email invisible while the toast says "1 failed". The
      // genuinely-trashed ones linger until Gmail's index catches up, which is
      // strictly better than hiding an email the user still has.
      if (failCount > 0 && (variables.action === 'trash' || variables.action === 'archive')) {
        // The route now reports WHICH ids failed, so un-hide exactly those rather
        // than the whole batch. (Delete by the SAME composite key the hide was
        // written with: this deleted by bare id and silently became a no-op the
        // moment the map was re-keyed — the valve was dead while its own comment
        // promised it worked, leaving 12 live emails hidden for 5 min.)
        const failedIds = (summary?.failedIds ?? []).map(t => `gmail:${t}`)
        const toClear = failedIds.length > 0 ? failedIds : idsAtStart // unknown → all
        setOverrides(prev => {
          const next = new Map(prev)
          toClear.forEach(id => next.delete(overrideKey(id, variables.originView)))
          return next
        })
      }
      if (variables.action === 'move_to_label' || failCount > 0) {
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      }
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })

      const actionLabel = variables.action === 'trash' ? 'deleted' : variables.action === 'archive' ? 'archived' : variables.action === 'mark_read' ? 'marked as read' : variables.action === 'mark_unread' ? 'marked as unread' : 'moved'

      // Bulk Delete gets an Undo too (Antonio, 2026-07-14 — it previously had
      // none). `ids` is captured here because clearSelection() above has already
      // emptied selectedIds by the time the toast callback runs. Bulk delete now
      // hides via the shared override map (with row snapshots), so the Undo pins
      // the exact rows back instead of relying on a refetch into Gmail's lag.
      if (variables.action === 'trash') {
        const ids = idsAtStart
        const snapshot = summary?.restore
        const deletedMsg = failCount > 0
          ? `${okCount} of ${count} email${count > 1 ? 's' : ''} deleted — ${failCount} failed`
          : `${okCount} email${okCount > 1 ? 's' : ''} deleted`
        const showDeleted = failCount > 0 ? toast.warning : toast
        showDeleted(deletedMsg, {
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                const res = await fetch('/api/inbox/email-actions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    threadIds: ids.map(id => id.replace('gmail:', '')),
                    action: 'untrash',
                    bulk: true,
                    mailbox: activeMailbox,
                    restore: snapshot,
                  }),
                })
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}))
                  throw new Error(err.error || 'Failed to restore emails.')
                }
                // Same honesty rule on the way back: a partial restore must NOT
                // be announced as a full one.
                const out = await res.json().catch(() => ({})) as { succeeded?: number; failed?: number; failedIds?: string[] }
                const rOk = typeof out.succeeded === 'number' ? out.succeeded : ids.length
                const rFail = typeof out.failed === 'number' ? out.failed : 0
                // WHICH ones failed — the route reports the ids now. Restoring a
                // thread that is still in Trash writes an `untrash` hide that
                // Trash can never witness away (it keeps returning the row), so
                // the email is invisible for the full TTL — in the one place this
                // toast tells him to look (senior engineer, 2026-07-16).
                const failedSet = new Set((out.failedIds ?? []).map(t => `gmail:${t}`))

                // Flip each hidden intent to PINNED (handleEmailRestored) so the
                // rows come straight back from their snapshots and STAY until
                // Gmail confirms the untrash. No conversations refetch here: that
                // racing refetch lands inside the untrash lag and returns without
                // them — the exact "restored but invisible" bug.
                ids.filter(id => !failedSet.has(id)).forEach(id => handleEmailRestored(id))
                // The ones that failed are still deleted: clear their claims so
                // they show up in Trash, where they actually are.
                if (failedSet.size > 0) {
                  setOverrides(prev => {
                    let next = prev
                    failedSet.forEach(id => { next = dropClaimsFor(next, id) })
                    return new Map(next)
                  })
                }
                queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
                queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })

                if (rFail > 0) {
                  toast.warning(
                    `Restored ${rOk} of ${ids.length} — ${rFail} could not be restored and are still in Trash.`,
                  )
                } else {
                  toast.success(`${rOk} email${rOk > 1 ? 's' : ''} restored`)
                }
              } catch (err) {
                toast.error(
                  err instanceof Error && err.message ? err.message : 'Failed to restore emails.',
                )
              }
            },
          },
          duration: 8000,
        })
        return
      }

      if (failCount > 0) {
        toast.warning(`${okCount} of ${count} email${count > 1 ? 's' : ''} ${actionLabel} — ${failCount} failed`)
      } else {
        toast.success(`${okCount} email${okCount > 1 ? 's' : ''} ${actionLabel}`)
      }
    },
  })

  const handleSelect = (conversation: InboxConversation) => {
    setSelected(conversation)
    setSelectedOrigin(originViewKey) // the list this row was picked from
    setWorkerOpen(false) // worker chat is per email thread
    if (conversation.unread > 0) {
      setUnread(prev => new Map(prev).set(conversation.id, makeUnreadOverride(0, prev.get(conversation.id)?.baseline ?? conversation.unread, Date.now())))
    }
  }

  const handleBack = () => {
    setSelected(null)
    setWorkerOpen(false)
  }

  const handleForward = async () => {
    if (!selected) return
    try {
      const params = activeMailbox ? `?mailbox=${activeMailbox}` : ''
      const res = await fetch(`/api/inbox/messages/${encodeURIComponent(selected.id)}${params}`)
      const data = await res.json()
      const messages = data?.messages || []
      const lastMsg = messages[messages.length - 1]

      const htmlContent = lastMsg?.content || ''
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = htmlContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      const rawText = tempDiv.textContent || tempDiv.innerText || ''
      const plainText = rawText
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || selected.preview || ''

      const fwdBody = lastMsg
        ? `\n\n---------- Forwarded message ----------\nFrom: ${lastMsg.sender || selected.name}\nDate: ${lastMsg.createdAt ? new Date(lastMsg.createdAt).toLocaleString() : ''}\nSubject: ${selected.subject || ''}\n\n${plainText}`
        : ''
      setForwardData({
        subject: selected.subject || '',
        body: fwdBody,
        from: lastMsg?.sender || selected.name,
      })
      setComposeOpen(true)
    } catch {
      setForwardData({ subject: selected.subject || '', body: '', from: selected.name })
      setComposeOpen(true)
    }
  }

  const handleSearch = () => {
    if (!searchQuery.trim()) return
    setSearchActive(true)
    setActiveChannel('gmail')
    setActiveLabel(null)
    queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
  }

  const clearSearch = () => {
    setSearchQuery('')
    setSearchActive(false)
    queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
  }

  // Antonio 2026-07-08: the inbox assistant is the SLACK WORKER (read-only
  // DB/CRM/KB tools + central memory), not the generic AI Assist panel.
  const handleWorker = () => {
    if (!selected) return
    setWorkerOpen(true)
  }

  const handleReply = () => {
    const textarea = document.querySelector('.compose-reply-textarea') as HTMLTextAreaElement
    if (textarea) {
      textarea.scrollIntoView({ behavior: 'smooth', block: 'end' })
      setTimeout(() => textarea.focus(), 300)
    }
  }

  // Derive group ID from whatsapp conversation ID (format: "whatsapp:{uuid}")
  const whatsappGroupId = selected?.channel === 'whatsapp'
    ? selected.id.replace('whatsapp:', '')
    : null

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header with channel tabs + compose button */}
      <div className="flex items-center justify-between border-b bg-white">
        <InboxHeader
          activeChannel={activeChannel}
          onChannelChange={(ch) => {
            setActiveChannel(ch)
            setActiveLabel(null)
            setSearchActive(false)
            setSearchQuery('')
            setSelected(null)
          }}
        />
        <div className="pr-4 relative">
          <button
            onClick={() => setComposeMenuOpen(!composeMenuOpen)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
          >
            <PenSquare className="h-3.5 w-3.5" />
            Compose
          </button>
          {composeMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setComposeMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 w-48">
                <button
                  onClick={() => {
                    setComposeMenuOpen(false)
                    setForwardData(null)
                    setComposeOpen(true)
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  <Mail className="h-4 w-4 text-blue-500" />
                  New Email
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Mailbox selector — Gmail only; antonio@ is personal (admin only) */}
      {!isWhatsApp && canUsePersonalMailbox && (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b bg-zinc-50/50">
          <span className="text-xs text-zinc-400 mr-2">Mailbox:</span>
          {(['support', 'antonio'] as const).map(mb => (
            <button
              key={mb}
              onClick={() => { setActiveMailbox(mb); setSelected(null) }}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                activeMailbox === mb
                  ? 'bg-blue-100 text-blue-700'
                  : 'text-zinc-500 hover:bg-zinc-100'
              )}
            >
              {mb === 'support' ? 'support@' : 'antonio@'}
            </button>
          ))}
        </div>
      )}

      {/* Search bar + Read/Unread filter — Gmail only */}
      {!isWhatsApp && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b bg-zinc-50">
          <Search className="h-4 w-4 text-zinc-400 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
            placeholder="Search emails... (from:, subject:, has:attachment)"
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-zinc-400"
          />
          {searchActive && (
            <button onClick={clearSearch} className="p-0.5 rounded hover:bg-zinc-200 text-zinc-400">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="flex items-center gap-0.5 border-l pl-2 ml-1">
            {(['all', 'unread', 'read'] as const).map(f => (
              <button
                key={f}
                onClick={() => setUnreadFilter(f)}
                className={cn(
                  'px-2 py-1 rounded text-xs font-medium transition-colors',
                  unreadFilter === f
                    ? f === 'unread' ? 'bg-blue-100 text-blue-700' : f === 'read' ? 'bg-zinc-200 text-zinc-700' : 'bg-zinc-100 text-zinc-600'
                    : 'text-zinc-400 hover:bg-zinc-100'
                )}
              >
                {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Read'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bulk Action Bar — Gmail only */}
      {bulkMode && !isWhatsApp && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-blue-50 border-b shrink-0">
          <CheckSquare className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-medium text-blue-700">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-1 ml-auto relative">
            {viewingTrash ? (
              /* In Trash, Delete and Archive are NO-OPS that still toast "3 emails
                 deleted" — and the Undo on that toast would UN-delete them, the
                 opposite of what was asked. Restore is the action that belongs on
                 a selection of trashed emails, and it matches the row and the open
                 email (senior engineer, 2026-07-16: the bulk bar was the surface I
                 fixed everywhere else and missed here). */
              <button
                onClick={() => handleBulkRestore()}
                disabled={bulkActionMutation.isPending}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-green-100 text-green-700 hover:bg-green-200 transition-colors"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                Restore
              </button>
            ) : (
              <>
                <button
                  onClick={() => bulkActionMutation.mutate({ action: 'trash', ids: Array.from(selectedIds), originView: originViewKey })}
                  disabled={bulkActionMutation.isPending}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
                <button
                  onClick={() => bulkActionMutation.mutate({ action: 'archive', ids: Array.from(selectedIds), originView: originViewKey })}
                  disabled={bulkActionMutation.isPending}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archive
                </button>
              </>
            )}
            <button
              onClick={() => bulkActionMutation.mutate({ action: 'mark_read', ids: Array.from(selectedIds), originView: originViewKey })}
              disabled={bulkActionMutation.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
            >
              <MailOpen className="h-3.5 w-3.5" />
              Mark Read
            </button>
            <button
              onClick={() => bulkActionMutation.mutate({ action: 'mark_unread', ids: Array.from(selectedIds), originView: originViewKey })}
              disabled={bulkActionMutation.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
            >
              <Mail className="h-3.5 w-3.5" />
              Mark Unread
            </button>
            <div className="relative">
              <button
                onClick={() => setMoveToOpen(!moveToOpen)}
                disabled={bulkActionMutation.isPending}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
              >
                <FolderInput className="h-3.5 w-3.5" />
                Move to
              </button>
              {moveToOpen && userLabels.length > 0 && (
                <div className="absolute right-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 min-w-[160px]">
                  {userLabels.map(label => (
                    <button
                      key={label.id}
                      onClick={() => {
                        bulkActionMutation.mutate({ action: 'move_to_label', labelId: label.id, ids: Array.from(selectedIds), originView: originViewKey })
                        setMoveToOpen(false)
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 transition-colors"
                    >
                      {label.name}
                    </button>
                  ))}
                </div>
              )}
              {moveToOpen && userLabels.length === 0 && (
                <div className="absolute right-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 px-3 py-2 text-xs text-zinc-400 min-w-[160px]">
                  No folders yet. Create one in the sidebar.
                </div>
              )}
            </div>
            <button
              onClick={handleBulkShare}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
            >
              <Send className="h-3.5 w-3.5" />
              Share to team
            </button>
            <button
              onClick={clearSelection}
              className="p-1 rounded hover:bg-zinc-200 text-zinc-500 ml-1"
              title="Clear selection"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* ─── Gmail Sidebar (folders) ──────────────── */}
        {(activeChannel === 'gmail' || activeChannel === null) && (
          <div className="hidden lg:flex w-[180px] shrink-0 border-r bg-zinc-50/50 overflow-y-auto">
            <InboxSidebar
              activeLabel={activeLabel}
              onLabelChange={handleLabelChange}
              mailbox={activeMailbox}
            />
          </div>
        )}

        {/* ─── Conversation List ─────────────── */}
        <div
          className={cn(
            'w-full lg:w-[350px] lg:shrink-0 flex flex-col border-r',
            selected ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ConversationList
            activeChannel={activeChannel}
            selectedId={selected?.id || null}
            onSelect={handleSelect}
            onDeleted={(conv) => handleEmailDeleted('trash', conv, originViewKey)}
            onRestored={handleEmailRestored}
            overrides={overrides}
            unread={unread}
            onUnreadOverride={(id, value, baseline) => setUnread(prev => new Map(prev).set(id, makeUnreadOverride(value, prev.get(id)?.baseline ?? baseline, Date.now())))}
            onReconciled={(o, u) => { setOverrides(o); setUnread(u) }}
            onPayloadOrigin={setPayloadViewKey}
            onRestoredTo={handleRestoredTo}
            onRestoreFailed={(id) => setOverrides(prev => dropClaimsFor(prev, id))}
            bulkMode={bulkMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            labelFilter={activeLabel}
            searchQuery={searchActive ? searchQuery : undefined}
            mailbox={activeMailbox}
            unreadFilter={unreadFilter}
          />
        </div>

        {/* ─── Message Thread ────────────── */}
        <div
          className={cn(
            'flex-1 flex flex-col min-w-0',
            !selected ? 'hidden lg:flex' : 'flex'
          )}
        >
          {selected ? (
            <>
              {/* Thread header with actions. flex-wrap + basis on the title:
                  on narrow windows/mobile the button cluster wraps to its own
                  row instead of crushing the subject to one word per line. */}
              <div className="flex items-center gap-x-3 gap-y-1.5 px-4 py-2.5 border-b bg-white shrink-0 flex-wrap">
                <button onClick={handleBack} className="lg:hidden p-1 rounded hover:bg-zinc-100">
                  <ArrowLeft className="h-5 w-5" />
                </button>

                {(() => {
                  const Icon = channelIcons[selected.channel]
                  const iconClass = selected.channel === 'whatsapp' ? 'text-green-500' : 'text-zinc-400'
                  return <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
                })()}

                <div className="min-w-0 flex-1 basis-44">
                  <p className="text-sm font-semibold text-zinc-900 truncate">
                    {selected.name}
                  </p>
                  <p className="text-xs text-zinc-500 truncate">
                    {channelLabels[selected.channel]}
                    {selected.subject && ` — ${selected.subject}`}
                  </p>
                </div>

                {/* Action buttons — not shown for WhatsApp (read-only) */}
                {!isWhatsApp && (
                  <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end ml-auto">
                    <HoverHint label="Create Task">
                      <button
                        onClick={() => setCreateDialog({ type: 'task', conversation: selected })}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-orange-500 transition-colors"
                      >
                        <ClipboardList className="h-4 w-4" />
                      </button>
                    </HoverHint>
                    <HoverHint label="Create Service">
                      <button
                        onClick={() => setCreateDialog({ type: 'service', conversation: selected })}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-emerald-500 transition-colors"
                      >
                        <Cog className="h-4 w-4" />
                      </button>
                    </HoverHint>
                    <HoverHint label="Create Invoice">
                      <button
                        onClick={() => setCreateDialog({ type: 'invoice', conversation: selected })}
                        className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-500 transition-colors"
                      >
                        <Receipt className="h-4 w-4" />
                      </button>
                    </HoverHint>

                    <div className="w-px h-4 bg-zinc-200 mx-0.5" />

                    <HoverHint label="Write a reply">
                      <button
                        onClick={handleReply}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-50 hover:bg-blue-100 text-blue-600 hover:text-blue-700 text-xs font-medium transition-colors"
                      >
                        <Reply className="h-3.5 w-3.5" />
                        Reply
                      </button>
                    </HoverHint>
                    <HoverHint label="AI worker — reads CRM, DB & memory">
                      <button
                        onClick={handleWorker}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-violet-50 hover:bg-violet-100 text-violet-600 hover:text-violet-700 text-xs font-medium transition-colors"
                      >
                        <Bot className="h-3.5 w-3.5" />
                        Worker
                      </button>
                    </HoverHint>

                    {isGmail && (
                      <>
                        <HoverHint label="Share to team chat">
                          <button
                            onClick={openShareForSelectedEmail}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 hover:bg-emerald-100 text-emerald-600 hover:text-emerald-700 text-xs font-medium transition-colors"
                          >
                            <Send className="h-3.5 w-3.5" />
                            Share
                          </button>
                        </HoverHint>
                        <HoverHint label="Archive">
                          <button
                            onClick={() => emailActionMutation.mutate({ action: 'archive', originView: selectedOrigin, conv: selected })}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            <Archive className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Star">
                          <button
                            onClick={() => emailActionMutation.mutate({ action: 'star', conv: selected })}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-amber-500 transition-colors"
                          >
                            <Star className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <div className="relative">
                          <HoverHint label="Mark with a color">
                          <button
                            onClick={() => setColorMenuOpen(!colorMenuOpen)}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            {selected.colorMark ? (
                              <span
                                className="block h-4 w-4 rounded-full border border-white shadow-sm"
                                style={{ backgroundColor: markByKey(selected.colorMark)?.hex }}
                              />
                            ) : (
                              <Palette className="h-4 w-4" />
                            )}
                          </button>
                          </HoverHint>
                          {colorMenuOpen && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => setColorMenuOpen(false)} />
                              <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-zinc-200 p-2 flex items-center gap-1.5">
                                {COLOR_MARKS.map(m => (
                                  <button
                                    key={m.key}
                                    onClick={() => {
                                      setColorMenuOpen(false)
                                      emailActionMutation.mutate({ action: 'set_color', color: m.key, conv: selected })
                                    }}
                                    className={cn(
                                      'h-5 w-5 rounded-full hover:scale-110 transition-transform',
                                      selected.colorMark === m.key && 'ring-2 ring-offset-1 ring-zinc-400'
                                    )}
                                    style={{ backgroundColor: m.hex }}
                                    title={m.label}
                                  />
                                ))}
                                <button
                                  onClick={() => {
                                    setColorMenuOpen(false)
                                    emailActionMutation.mutate({ action: 'set_color', color: null, conv: selected })
                                  }}
                                  className="h-5 w-5 rounded-full border border-zinc-300 flex items-center justify-center text-zinc-400 hover:text-zinc-600 hover:scale-110 transition-transform"
                                  title="Remove mark"
                                >
                                  <Ban className="h-3 w-3" />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        <HoverHint label="Mark as unread">
                          <button
                            onClick={() => emailActionMutation.mutate({ action: 'mark_unread', conv: selected })}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-500 transition-colors"
                          >
                            <MailOpen className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Forward">
                          <button
                            onClick={handleForward}
                            disabled={emailActionMutation.isPending}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            <Forward className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Link to client / lead / partner">
                          <button
                            onClick={() => setLinkOpen(true)}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-blue-600 transition-colors"
                          >
                            <Link2 className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label="Print / Save as PDF">
                          <button
                            onClick={() => printRef.current?.()}
                            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            <Printer className="h-4 w-4" />
                          </button>
                        </HoverHint>
                        <HoverHint label={openUnread ? 'Mark as read' : 'Mark as unread'}>
                          <button
                            onClick={() => emailActionMutation.mutate({ action: openUnread ? 'mark_read' : 'mark_unread', conv: selected })}
                            disabled={emailActionMutation.isPending}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-100 hover:bg-zinc-200 text-zinc-600 hover:text-zinc-800 text-xs font-medium transition-colors ml-1"
                          >
                            {openUnread ? <Mail className="h-3.5 w-3.5" /> : <MailOpen className="h-3.5 w-3.5" />}
                            {openUnread ? 'Mark read' : 'Mark unread'}
                          </button>
                        </HoverHint>
                        {selectedOrigin === trashViewKey ? (
                          /* The open email came from Trash: Delete here fired
                             `trash` on an already-trashed thread — a no-op that
                             still toasted "Email deleted". Restore is the action
                             that belongs on a trashed email, and it matches the
                             row button one pane over. */
                          <>
                            <HoverHint label="Restore to Inbox">
                              <button
                                onClick={() => selected && handleRestoreOpen(selected, null)}
                                disabled={restoreOpenMutation.isPending}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-green-50 hover:bg-green-100 text-green-600 hover:text-green-800 text-xs font-medium transition-colors ml-1"
                              >
                                <ArchiveRestore className="h-3.5 w-3.5" />
                                Restore
                              </button>
                            </HoverHint>
                            {/* "…and I see it in the folder that I decide to
                                restore" — pick the destination instead of the
                                Inbox. Same optimistic move; the pin lands on the
                                folder you choose. */}
                            <div className="relative">
                              <HoverHint label="Restore to a folder…">
                                <button
                                  onClick={() => setRestoreToOpen(!restoreToOpen)}
                                  disabled={restoreOpenMutation.isPending}
                                  className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md bg-green-50 hover:bg-green-100 text-green-600 hover:text-green-800 text-xs font-medium transition-colors"
                                >
                                  <FolderInput className="h-3.5 w-3.5" />
                                </button>
                              </HoverHint>
                              {restoreToOpen && (
                                <>
                                  <div className="fixed inset-0 z-40" onClick={() => setRestoreToOpen(false)} />
                                  <div className="absolute right-0 top-full mt-1 z-50 bg-white border rounded-md shadow-xl min-w-[180px] py-1">
                                    <button
                                      onClick={() => { setRestoreToOpen(false); if (selected) handleRestoreOpen(selected, null) }}
                                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 transition-colors"
                                    >
                                      Inbox
                                    </button>
                                    {userLabels.length > 0 && <div className="my-1 border-t border-zinc-100" />}
                                    {userLabels.map(label => (
                                      <button
                                        key={label.id}
                                        onClick={() => { setRestoreToOpen(false); if (selected) handleRestoreOpen(selected, label.id) }}
                                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 transition-colors"
                                      >
                                        {label.name}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          </>
                        ) : (
                          <HoverHint label="Delete (moves to Trash)">
                            <button
                              onClick={() => emailActionMutation.mutate({ action: 'trash', originView: selectedOrigin, conv: selected })}
                              disabled={emailActionMutation.isPending}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 hover:bg-red-100 text-red-500 hover:text-red-700 text-xs font-medium transition-colors ml-1"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </button>
                          </HoverHint>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Thread body */}
              {selected.channel === 'whatsapp' && whatsappGroupId ? (
                <WhatsappThread groupId={whatsappGroupId} />
              ) : (
                <div className="flex flex-1 min-h-0">
                  <div className="flex-1 flex flex-col min-w-0">
                    <MessageThread
                      conversation={selected}
                      mailbox={activeMailbox}
                      registerPrint={(fn) => { printRef.current = fn }}
                    />
                    <ComposeReply conversation={selected} mailbox={activeMailbox} />
                  </div>
                  {workerOpen && (
                    <WorkerChatPanel
                      conversation={selected}
                      mailbox={activeMailbox}
                      onClose={() => setWorkerOpen(false)}
                    />
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-400">
              <MessageSquare className="h-12 w-12 mb-3 stroke-1" />
              <p className="text-sm font-medium">Select a conversation</p>
              <p className="text-xs mt-1">
                {isWhatsApp ? 'Choose a WhatsApp conversation' : 'Choose an email from the inbox'}
              </p>
            </div>
          )}
        </div>
      </div>

      <ComposeDialog
        open={composeOpen}
        onClose={() => { setComposeOpen(false); setForwardData(null) }}
        prefillSubject={forwardData ? `Fwd: ${forwardData.subject}` : ''}
        prefillBody={forwardData?.body || ''}
      />

      {createDialog && (
        <CreateFromEmailDialog
          type={createDialog.type}
          conversation={createDialog.conversation}
          onClose={() => setCreateDialog(null)}
        />
      )}

      {linkOpen && selected && (
        <LinkClientDialog
          conversation={selected}
          mailbox={activeMailbox}
          onClose={() => setLinkOpen(false)}
        />
      )}

      {shareItems && (
        <ShareToTeamDialog
          items={shareItems}
          label={shareFromBulk
            ? `${shareItems.length} email${shareItems.length === 1 ? '' : 's'}`
            : `Email — ${shareItems[0]?.title || ''}`}
          onShared={shareFromBulk ? clearSelection : undefined}
          onClose={() => { setShareItems(null); setShareFromBulk(false) }}
        />
      )}
    </div>
  )
}
