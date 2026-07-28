'use client'

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useMemo, useRef, useEffect, useState } from 'react'
import { Mail, MailOpen, CheckSquare, Square, Paperclip, Trash2, MessagesSquare, MessageSquare, ArchiveRestore, Palette, FolderInput, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { markByKey, COLOR_MARKS, MARK_LABEL_PREFIX } from '@/lib/inbox/color-marks'
import type { InboxConversation, InboxChannel } from '@/lib/types'
import {
  advanceReleases,
  computeVisibleList,
  overrideMapsEqual,
  unreadMapsEqual,
  type RowOverride,
  type UnreadOverride,
  type ConversationsPayload,
  type PayloadOrigin,
} from '@/lib/inbox/conversation-reconcile'
import { toInboxView, viewKey } from '@/lib/inbox/view-query'

const EMPTY_OVERRIDES: Map<string, RowOverride> = new Map()
const EMPTY_UNREAD: Map<string, UnreadOverride> = new Map()

interface ConversationListProps {
  activeChannel: InboxChannel | null
  selectedId: string | null
  onSelect: (conversation: InboxConversation) => void
  onDeleted?: (conv: InboxConversation) => void
  /** Undo of a delete — moves the row out of Trash and back to the list it was
   *  deleted from, both optimistically, so neither waits on Gmail. */
  onRestored?: (id: string) => void
  /** Restore FROM the Trash list: the row leaves Trash and appears at `dest`
   *  (its viewKey), both instantly. `destLabelId` is null for the Inbox. */
  onRestoredTo?: (conv: InboxConversation, destLabelId: string | null) => void
  /** The restore FAILED — undo the optimistic move so the row is visible again
   *  in Trash, where it still is. */
  onRestoreFailed?: (id: string) => void
  /** Optimistic hide/pin intents, keyed by conversation id (from the parent). */
  overrides?: Map<string, RowOverride>
  /** Optimistic unread values, keyed by conversation id (from the parent). */
  unread?: Map<string, UnreadOverride>
  /** Optimistically set a row's unread override: value + the server baseline at
   *  action time (so the reconcile releases only when Gmail moves off it). */
  onUnreadOverride?: (id: string, value: number, baseline: number) => void
  /** Push the reconciled (released) override maps back up to the parent. */
  onReconciled?: (overrides: Map<string, RowOverride>, unread: Map<string, UnreadOverride>) => void
  /** Report WHICH list the rows currently on screen came from (its `viewKey`), so
   *  the parent stamps every override with the payload the user actually acted on
   *  — never with the view they have merely selected. Null until the first payload
   *  lands. See the effect below for why the difference is not academic. */
  onPayloadOrigin?: (viewKey: string | null) => void
  // Bulk selection
  bulkMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  // Gmail filters
  labelFilter?: string | null
  searchQuery?: string
  /** Row-level quick actions (Antonio 2026-07-28): color-mark and file-to-folder
   *  straight from the list, without opening the email. Wired to the parent's
   *  single-email action mutation; absent → the buttons don't render. */
  userLabels?: Array<{ id: string; name: string }>
  onSetColor?: (conv: InboxConversation, color: string | null) => void
  onMoveToLabel?: (conv: InboxConversation, labelId: string, labelName: string) => void
}

const channelIcons: Record<InboxChannel, React.ElementType> = {
  gmail: Mail,
  portal: MessagesSquare,
  whatsapp: MessageSquare,
}

const channelColors: Record<InboxChannel, string> = {
  gmail: 'text-red-500',
  portal: 'text-purple-600',
  whatsapp: 'text-green-500',
}

function formatTime(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ConversationList({ activeChannel, selectedId, onSelect, onDeleted, onRestored, onRestoredTo, onRestoreFailed, overrides, unread, onUnreadOverride, onReconciled, onPayloadOrigin, bulkMode, selectedIds, onToggleSelect, labelFilter, searchQuery, mailbox, unreadFilter, userLabels, onSetColor, onMoveToLabel }: ConversationListProps & { mailbox?: string; unreadFilter?: 'all' | 'unread' | 'read' }) {
  const queryClient = useQueryClient()

  // Which row's quick-action popover (color palette / folder list) is open.
  // One at a time; closed by the fixed overlay or by acting.
  const [rowMenu, setRowMenu] = useState<{ id: string; kind: 'color' | 'label' } | null>(null)

  // Toggle a row read/unread from the list (next to the row Delete). Uses the
  // parent's optimistic unread override for instant badge/bold feedback and
  // only invalidates stats/labels — NEVER the conversations list itself, whose
  // ~300-Gmail-call refetch under load is what blanked the inbox (2026-07-08).
  const markMutation = useMutation({
    mutationFn: async ({ conv, action }: { conv: InboxConversation; action: 'mark_read' | 'mark_unread' }) => {
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conv.id.replace('gmail:', ''), action, mailbox }),
      })
      if (!res.ok) throw new Error('Failed to update')
      return action
    },
    onMutate: ({ conv, action }) => {
      onUnreadOverride?.(conv.id, action === 'mark_unread' ? Math.max(conv.unread, 1) : 0, conv.unread)
    },
    onSuccess: (action) => {
      toast.success(action === 'mark_unread' ? 'Marked as unread' : 'Marked as read')
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
    },
  })

  // Restore out of Trash. `untrash` puts the row back where it was — custom
  // folder labels are never stripped by trashing, so they survive and come back
  // on their own; the server re-adds INBOX and re-applies the read/star state it
  // snapshotted. A destination only ADDS a label and drops INBOX, which is what
  // "restore into that folder instead" means.
  const restoreMutation = useMutation({
    // The row travels WITH the request (never read live — see inbox-shell).
    mutationFn: async ({ conv, destLabelId }: { conv: InboxConversation; destLabelId?: string | null }) => {
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: conv.id.replace('gmail:', ''),
          action: 'untrash',
          mailbox,
          destLabelId: destLabelId ?? undefined,
        }),
      })
      if (!res.ok) {
        // R099 — surface the server's reason; a silent failure here looks
        // identical to a success and the row would vanish from Trash anyway.
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to restore email.')
      }
      return res.json().catch(() => ({}))
    },
    onMutate: async ({ conv, destLabelId }) => {
      await queryClient.cancelQueries({ queryKey: ['inbox-conversations'] })
      onRestoredTo?.(conv, destLabelId ?? null)
    },
    onError: (err, { conv }) => {
      // Roll the optimistic move BACK — the email is still in Trash, and hiding
      // it there while telling the user to retry means retrying on an invisible
      // row. (The hide could never be witnessed away either: Trash keeps
      // returning the row, so only the TTL would clear it — bug-hunter.)
      onRestoreFailed?.(conv.id)
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to restore email.')
    },
    onSuccess: (data, { conv, destLabelId }) => {
      // Where it ACTUALLY landed — the server files down a ladder (destination →
      // Inbox → back to Trash), so a fallback must correct our optimistic pin and
      // the toast, or we show a row in a folder it isn't in and name it too.
      const filedTo = (data as { filedTo?: string } | undefined)?.filedTo ?? destLabelId ?? 'INBOX'
      // Correct the pin to where it ACTUALLY landed. `onRestoredTo` drops the
      // row's claims and re-emits the move, so it is safe to repeat — but the
      // parent guards it: if the row has since been deleted again, re-writing
      // would resurrect an email the user just deleted.
      if (filedTo !== (destLabelId ?? 'INBOX')) onRestoredTo?.(conv, filedTo === 'INBOX' ? null : filedTo)
      toast.success(filedTo === 'INBOX' ? 'Email restored to Inbox' : 'Email restored to folder')
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (conv: InboxConversation) => {
      if (conv.channel !== 'gmail') return
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conv.id.replace('gmail:', ''), action: 'trash', mailbox }),
      })
      if (!res.ok) throw new Error('Failed to delete')
      // The server snapshots UNREAD/STARRED/IMPORTANT before stripping them —
      // hand it straight back on Undo so the email returns as it was.
      return res.json().catch(() => ({}))
    },
    onMutate: async (conv) => {
      await queryClient.cancelQueries({ queryKey: ['inbox-conversations'] })
      onDeleted?.(conv)
    },
    onSuccess: (data, conv) => {
      toast('Email deleted', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              const res = await fetch('/api/inbox/email-actions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  threadId: conv.id.replace('gmail:', ''),
                  action: 'untrash',
                  mailbox,
                  restore: (data as { restore?: unknown })?.restore,
                }),
              })
              if (!res.ok) {
                // R099 — a non-2xx used to fall through silently, so a failed
                // restore looked identical to a successful one.
                const err = await res.json().catch(() => ({}))
                throw new Error(err.error || 'Failed to restore email.')
              }
              // Pin the restored row visible — do NOT immediately refetch the
              // conversations list: that racing refetch landed inside Gmail's
              // untrash lag and returned WITHOUT the row, so it vanished for a
              // few seconds (Luca, 2026-07-13). The pin holds it until the
              // reconcile sees the server confirm it's back.
              onRestored?.(conv.id)
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
      // No delayed refetch: the hide override + the Gmail push event + the poll
      // reconcile the server list. The old 15s refetch fired stale (even after
      // an Undo) and re-pulled Gmail's lagging list — a flicker source.
    },
    onError: () => {
      toast.error('Failed to delete email')
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
    },
  })

  const isWhatsApp = activeChannel === 'whatsapp'

  const { data, isLoading, dataUpdatedAt } = useQuery<ConversationsPayload & { total?: number; origin?: PayloadOrigin }>({
    queryKey: ['inbox-conversations', activeChannel, labelFilter, searchQuery, mailbox],
    queryFn: async () => {
      // Throw on non-2xx (R099): a failed refetch must NOT replace the list
      // with emptiness — react-query keeps the previous data on error, so a
      // Gmail rate-limit hiccup leaves the inbox visible instead of showing
      // "No conversations" until a manual refresh (Antonio 2026-07-08).
      const url = isWhatsApp
        ? '/api/inbox/whatsapp/conversations'
        : (() => {
            const params = new URLSearchParams()
            if (activeChannel) params.set('channel', activeChannel)
            if (labelFilter) params.set('label', labelFilter)
            if (searchQuery) params.set('q', searchQuery)
            if (mailbox) params.set('mailbox', mailbox)
            params.set('limit', '100')
            return `/api/inbox/conversations?${params}`
          })()
      const res = await fetch(url)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json.error || 'Failed to load conversations')
      }
      // STAMP the payload with the list it came from — here and nowhere else.
      // This closure captures exactly the queryKey inputs above, so the stamp is
      // correct by construction. The reconcile is never told "the view the user
      // is on": with keepPreviousData (and an instant cache hit when returning to
      // a view) the rows on screen routinely belong to a DIFFERENT list than the
      // one selected, and judging them by the current view's rules is what let a
      // foreign list "confirm" a delete it could never have seen — Luca's 12
      // bulk-deleted emails came back (council, 2026-07-16).
      // ⚠️ A new dimension in the queryKey MUST be added here too.
      const origin: PayloadOrigin = {
        view: toInboxView({ label: labelFilter ?? null, search: searchQuery ?? null }),
        scope: { mailbox: mailbox ?? 'support', channel: activeChannel },
      }
      return { ...json, origin }
    },
    // Push is the primary refresh (see inbox-shell). The poll is a fallback for
    // a missed push (watch lapse / PWA background) — kept reasonably tight so
    // the inbox never goes minutes stale, but no longer the 30s churn that, with
    // full-replace, drove the flicker.
    refetchInterval: searchQuery ? false : 75_000,
    // Never flash an empty pane while a refetch (or a mailbox/filter switch)
    // is in flight — keep showing the list we already have (Antonio
    // 2026-07-08: the list "disappeared" on actions/scroll under Gmail load).
    placeholderData: keepPreviousData,
  })

  // Is the list ON SCREEN the Trash? Derived from the PAYLOAD's own view, never
  // from the selection: during a view switch the rows shown are still the old
  // list's, and a Restore button over Inbox rows would be a Restore that deletes.
  const inTrash = data?.origin?.view.kind === 'trash'

  const ov = overrides ?? EMPTY_OVERRIDES
  const un = unread ?? EMPTY_UNREAD
  const prevRef = useRef<Map<string, InboxConversation>>(new Map())

  // Advance optimistic-override RELEASES once per FETCH. Keyed on dataUpdatedAt
  // (changes every fetch, even a deep-equal one) so the stability counter
  // advances reliably — [data] would skip when react-query structural-shares an
  // unchanged payload, leaving the 5-min TTL as the only release path.
  useEffect(() => {
    // The optimistic-override machinery is Gmail-only (a delete/undo exists
    // nowhere else — see the row Delete below), and a WhatsApp payload lists a
    // different id-universe entirely: it can't contain a `gmail:` id, so letting
    // it judge would "confirm" every pending Gmail delete at once. `origin` also
    // carries the channel, which makes that unrepresentable — this is the second
    // lock, so the foreign list never even pays for the pass.
    if (!data?.origin || !onReconciled || isWhatsApp) return
    const payload: ConversationsPayload = { conversations: data.conversations ?? [], unenrichedIds: data.unenrichedIds, partial: data.partial }
    const advanced = advanceReleases({ payload, origin: data.origin, overrides: ov, unread: un, prev: prevRef.current, now: Date.now() })
    if (!overrideMapsEqual(advanced.overrides, ov) || !unreadMapsEqual(advanced.unread, un)) {
      onReconciled(advanced.overrides, advanced.unread)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt])

  // Tell the parent which list these rows came from, so an override created by a
  // click is stamped with the payload the user was LOOKING AT. The two differ far
  // more often than they sound: `keepPreviousData` deliberately keeps the old
  // rows on screen (and interactive) for the whole of the next view's fetch, and
  // a revisited view renders from cache instantly. Selecting rows in the Inbox,
  // clicking a folder, then hitting Delete would otherwise stamp those Inbox rows
  // with the FOLDER — a list that never held them, which then both "confirms" the
  // delete it never saw and, on Undo, injects the Inbox emails into that folder
  // (council, 2026-07-16).
  useEffect(() => {
    if (!onPayloadOrigin) return
    onPayloadOrigin(data?.origin ? viewKey(data.origin.view, data.origin.scope) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.origin])

  // Build the visible rows (pure — no counter changes here); reads the
  // carried-forward `prev` so a row the server couldn't enrich keeps its real data.
  // Everything is decided against the payload's OWN origin, so a list rendered
  // from `keepPreviousData` is still judged by the rules of the view it came from.
  //
  // NOT gated on `isWhatsApp`: that flips the instant the tab is clicked, while
  // `data` is still the previous GMAIL payload — and returning the raw list there
  // FAILS OPEN, un-applying a hide and flashing a just-deleted email back. The
  // origin is the honest test, and running the reconcile over a genuine WhatsApp
  // payload is a no-op anyway (its ids can't collide with `gmail:`, and a pin's
  // key carries the channel so it can't be injected here).
  const visibleRows = useMemo(() => {
    if (!data?.origin) return data?.conversations ?? []
    const payload: ConversationsPayload = { conversations: data.conversations ?? [], unenrichedIds: data.unenrichedIds, partial: data.partial }
    return computeVisibleList({ payload, origin: data.origin, overrides: ov, unread: un, prev: prevRef.current, now: Date.now() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ov, un])

  // Remember the shown ENRICHED rows for next round's carry-forward (in an
  // effect, never mutating the ref during render). ALSO retain the last-known
  // row for any id currently under an override: a hidden row drops out of
  // `visibleRows`, but an Undo needs its data to pin back. Without this, a
  // carried-forward (unenriched) row that gets deleted has no snapshot anywhere
  // — the raw payload never had it — and its Undo would restore it INVISIBLY,
  // the exact bug this whole reconcile exists to kill (bug-hunter, bulk review).
  // Bounded by (visible rows + active overrides), so it cannot grow unbounded.
  useEffect(() => {
    const next = new Map<string, InboxConversation>()
    for (const c of visibleRows) if (!c.partial) next.set(c.id, c)
    // The override map is keyed by (id + view), so read the row off the entry —
    // the key is opaque. Two entries can share an id (a move hides it from one
    // list and pins it into another); either one keeps the row alive here.
    for (const o of Array.from(ov.values())) {
      if (next.has(o.id)) continue
      const keep = prevRef.current.get(o.id) ?? o.snapshot
      if (keep) next.set(o.id, keep)
    }
    prevRef.current = next
  }, [visibleRows, ov])

  const conversations = useMemo(() => visibleRows.filter(c => {
    if (!unreadFilter || unreadFilter === 'all') return true
    if (unreadFilter === 'unread') return c.unread > 0
    if (unreadFilter === 'read') return c.unread === 0
    return true
  }), [visibleRows, unreadFilter])

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b animate-pulse">
            <div className="h-4 bg-zinc-200 rounded w-2/3 mb-2" />
            <div className="h-3 bg-zinc-100 rounded w-full" />
          </div>
        ))}
      </div>
    )
  }

  if (conversations.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        No conversations
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {conversations.map((conv) => {
        const Icon = channelIcons[conv.channel]
        const isSelected = selectedId === conv.id
        const isChecked = selectedIds.has(conv.id)
        const showCheckbox = !isWhatsApp && (bulkMode || conv.channel === 'gmail')
        const mark = markByKey(conv.colorMark)

        return (
          <div
            key={conv.id}
            // Marked rows are tinted with the mark color across the WHOLE row
            // (Antonio 2026-07-08: "the chat in the picker colored, not just
            // the dot"). Selection state wins over the tint; the colored left
            // edge stays in both states.
            style={
              mark
                ? {
                    boxShadow: `inset 3px 0 0 0 ${mark.hex}`,
                    ...(isSelected || isChecked ? {} : { backgroundColor: `${mark.hex}1f` }),
                  }
                : undefined
            }
            className={cn(
              'group w-full text-left px-4 py-3 border-b transition-colors hover:bg-zinc-50 flex items-start gap-2',
              isSelected && 'bg-blue-50 border-l-2 border-l-blue-500',
              isChecked && !isSelected && 'bg-blue-50/50',
              conv.unread > 0 && !isSelected && !isChecked && 'bg-white'
            )}
          >
            {/* Checkbox (only in bulk mode or Gmail — never WhatsApp) */}
            {showCheckbox && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleSelect(conv.id)
                }}
                className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-zinc-200 transition-colors"
              >
                {isChecked ? (
                  <CheckSquare className="h-4 w-4 text-blue-500" />
                ) : (
                  <Square className="h-4 w-4 text-zinc-300 hover:text-zinc-500" />
                )}
              </button>
            )}

            {/* Conversation content */}
            <button
              onClick={() => onSelect(conv)}
              className="flex-1 text-left min-w-0"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', channelColors[conv.channel])} />
                  <span
                    className={cn(
                      'text-sm truncate',
                      conv.unread > 0 ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'
                    )}
                  >
                    {conv.name}
                  </span>
                </div>
                <span className="text-xs text-zinc-400 shrink-0 ml-2">
                  {formatTime(conv.lastMessageAt)}
                </span>
              </div>

              {conv.subject && conv.channel === 'gmail' && (
                <p className="text-xs font-medium text-zinc-600 truncate mb-0.5">
                  {conv.subject}
                </p>
              )}

              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-500 truncate flex-1">
                  {conv.preview}
                </p>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  {mark && (
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: mark.hex }}
                      title={`Marked ${mark.label}`}
                    />
                  )}
                  {conv.hasAttachment && (
                    <Paperclip className="h-3 w-3 text-zinc-400" />
                  )}
                  {conv.unread > 0 && (
                    <span className="px-1.5 py-0.5 bg-blue-500 text-white text-xs rounded-full font-semibold">
                      {conv.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>

            {/* Row actions — read/unread toggle + Delete (Gmail only). Reveal on
                hover on desktop; ALWAYS visible on mobile (touch has no hover, so
                the row actions would be unreachable — Antonio's phone PWA). */}
            {conv.channel === 'gmail' && (
              <div className="shrink-0 self-center flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                {onSetColor && (
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setRowMenu(rowMenu?.id === conv.id && rowMenu.kind === 'color' ? null : { id: conv.id, kind: 'color' })
                      }}
                      className="p-1.5 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-colors"
                      title="Mark with a color"
                    >
                      {conv.colorMark ? (
                        <span
                          className="block h-4 w-4 rounded-full border border-white shadow-sm"
                          style={{ backgroundColor: markByKey(conv.colorMark)?.hex }}
                        />
                      ) : (
                        <Palette className="h-4 w-4" />
                      )}
                    </button>
                    {rowMenu?.id === conv.id && rowMenu.kind === 'color' && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setRowMenu(null) }} />
                        <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-zinc-200 p-2 flex items-center gap-1.5">
                          {COLOR_MARKS.map(m => (
                            <button
                              key={m.key}
                              onClick={(e) => {
                                e.stopPropagation()
                                setRowMenu(null)
                                onSetColor(conv, m.key)
                              }}
                              className={cn(
                                'h-5 w-5 rounded-full hover:scale-110 transition-transform',
                                conv.colorMark === m.key && 'ring-2 ring-offset-1 ring-zinc-400'
                              )}
                              style={{ backgroundColor: m.hex }}
                              title={m.label}
                            />
                          ))}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setRowMenu(null)
                              onSetColor(conv, null)
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
                )}
                {onMoveToLabel && (userLabels?.length ?? 0) > 0 && (
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setRowMenu(rowMenu?.id === conv.id && rowMenu.kind === 'label' ? null : { id: conv.id, kind: 'label' })
                      }}
                      className="p-1.5 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-colors"
                      title="File to folder"
                    >
                      <FolderInput className="h-4 w-4" />
                    </button>
                    {rowMenu?.id === conv.id && rowMenu.kind === 'label' && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setRowMenu(null) }} />
                        <div className="absolute right-0 top-full mt-1 z-50 bg-white border rounded-md shadow-xl min-w-[180px] max-h-64 overflow-y-auto py-1">
                          {/* Marked/* are the color-mark system's own labels — filing
                              into one by hand would break its one-color-per-thread
                              invariant (set_color swaps marks; move_to_label only
                              adds). The palette next door is the way to color. */}
                          {userLabels!.filter(l => !l.name.startsWith(MARK_LABEL_PREFIX)).map(label => (
                            <button
                              key={label.id}
                              onClick={(e) => {
                                e.stopPropagation()
                                setRowMenu(null)
                                onMoveToLabel(conv, label.id, label.name)
                              }}
                              className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50 transition-colors"
                            >
                              {label.name}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    markMutation.mutate({ conv, action: conv.unread > 0 ? 'mark_read' : 'mark_unread' })
                  }}
                  disabled={markMutation.isPending}
                  className="p-1.5 rounded hover:bg-blue-100 text-zinc-400 hover:text-blue-600 transition-colors"
                  title={conv.unread > 0 ? 'Mark as read' : 'Mark as unread'}
                >
                  {conv.unread > 0 ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
                </button>
                {inTrash ? (
                  /* In Trash, Delete was a lie: it fired `trash` on an already-
                     trashed thread — a no-op that still toasted "Email deleted".
                     Restore is the action that belongs here. */
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      restoreMutation.mutate({ conv })
                    }}
                    disabled={restoreMutation.isPending}
                    className="p-1.5 rounded hover:bg-green-100 text-zinc-400 hover:text-green-600 transition-colors"
                    title="Restore to Inbox"
                  >
                    <ArchiveRestore className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteMutation.mutate(conv)
                    }}
                    disabled={deleteMutation.isPending}
                    className="p-1.5 rounded hover:bg-red-100 text-zinc-400 hover:text-red-600 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
