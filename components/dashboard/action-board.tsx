'use client'

/**
 * Notification Center — staff action board (kanban).
 * See sysdoc `notification-center-plan` (dev_task 529b26cc).
 *
 * Shows OPEN action cards (message_actions, resolved_at IS NULL) grouped into
 * catalog-driven columns. Staff move a card with the per-card dropdown (tap-
 * friendly, no drag lib); moving to the terminal column (Done) resolves it and
 * it drops off. Live via 30s poll + refetch-after-move so it never goes stale.
 *
 * Cards are STAFF-ONLY (message_actions with message_id NULL never touch the
 * client chat). Each links back to the client (account thread or contact page).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { AlertCircle, Clock, Hourglass, Landmark, CheckCircle2, Building2, User, Settings2, Plus, CalendarClock, Moon, Check, Pencil, X, Send } from 'lucide-react'
import { ManageColumnsDialog } from './action-board-columns-dialog'
import { NewCardDialog } from './action-board-new-card-dialog'
import { CardCreateActions } from '@/components/notifications/card-create-actions'
import { HelpDot } from '@/components/help/help-dot'
import { ExpandableText } from '@/components/shared/expandable-text'

interface Column {
  slug: string
  display_name: string
  order: number
  terminal: boolean
}

type Priority = 'normal' | 'high' | 'urgent'

interface Card {
  id: string
  action_type: string
  label: string | null
  assigned_to: string | null
  created_at: string
  remind_at: string | null
  snoozed_until: string | null
  priority: Priority | null
  message_id: string | null
  account_id: string | null
  contact_id: string | null
  accounts: { company_name: string } | null
  contacts: { full_name: string } | null
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2 }

/** Reminder urgency for colouring/sorting: -1 none, 0 overdue, 1 due today, 2 upcoming. */
function remindState(remind_at: string | null): { rank: number; overdue: boolean; dueToday: boolean } {
  if (!remind_at) return { rank: 3, overdue: false, dueToday: false }
  const due = new Date(remind_at).getTime()
  const now = Date.now()
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
  if (due < now) return { rank: 0, overdue: true, dueToday: false }
  if (due <= endOfToday.getTime()) return { rank: 1, overdue: false, dueToday: true }
  return { rank: 2, overdue: false, dueToday: false }
}

/** Sort within a column: priority first, then reminder urgency, then oldest first. */
function sortCards(a: Card, b: Card): number {
  const pa = PRIORITY_RANK[(a.priority ?? 'normal') as Priority]
  const pb = PRIORITY_RANK[(b.priority ?? 'normal') as Priority]
  if (pa !== pb) return pa - pb
  const ra = remindState(a.remind_at).rank
  const rb = remindState(b.remind_at).rank
  if (ra !== rb) return ra - rb
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
}

const PRIORITY_PILL: Record<Priority, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-amber-100 text-amber-700 border-amber-200',
  normal: 'bg-zinc-100 text-zinc-500 border-zinc-200',
}

const COLUMN_ICON: Record<string, React.ElementType> = {
  action_needed: AlertCircle,
  in_progress: Clock,
  waiting_on_client: Hourglass,
  send_followup: Send,
  wait_for_irs: Landmark,
  done: CheckCircle2,
}

/** Default reminder text shown in the Follow-up editor. Staff edit it before sending. */
function defaultFollowUpText(clientName: string, label: string | null): string {
  const re = label && label.trim() ? `\n\nRe: ${label.trim()}` : ''
  return `Hi ${clientName},\n\nA friendly reminder that we're still waiting on the information we requested. When you have a moment, please complete it in your portal — let us know if you have any questions.${re}\n\nThank you,\nTony Durante Team`
}

const API = '/api/crm/admin-actions/message-actions'

export function ActionBoard() {
  const [columns, setColumns] = useState<Column[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [editingColumns, setEditingColumns] = useState(false)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const [newCardOpen, setNewCardOpen] = useState(false)
  // Snoozed cards are hidden from the columns; this view makes them recoverable.
  const [snoozedCards, setSnoozedCards] = useState<Card[]>([])
  const [showSnoozed, setShowSnoozed] = useState(false)
  // Inline note (label) editing on a card.
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  // Follow-up: send the client a portal-chat reminder, then move the card to "Followup Sent".
  const [followUpCard, setFollowUpCard] = useState<Card | null>(null)
  const [followUpDraft, setFollowUpDraft] = useState('')
  const [sendingFollowUp, setSendingFollowUp] = useState(false)
  const [followUpError, setFollowUpError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [colRes, cardRes, snoozeRes] = await Promise.all([
        fetch(`${API}?columns=true`).then((r) => r.json()),
        fetch(`${API}?open=true`).then((r) => r.json()),
        fetch(`${API}?snoozed=true`).then((r) => r.json()),
      ])
      if (Array.isArray(colRes.columns)) setColumns(colRes.columns)
      if (Array.isArray(cardRes.actions)) setCards(cardRes.actions)
      if (Array.isArray(snoozeRes.actions)) setSnoozedCards(snoozeRes.actions)
    } catch {
      // Non-fatal: leave current state; next poll retries.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const move = useCallback(
    async (id: string, action_type: string) => {
      setMovingId(id)
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, action_type } : c))) // optimistic
      try {
        const res = await fetch(API, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, action_type }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Move failed')
        }
      } finally {
        await load() // reconcile with the server (Done cards drop off)
        setMovingId(null)
      }
    },
    [load],
  )

  // Follow up: post a reminder into the client's portal chat (reuses the staff
  // send path → fires the same client notification + email), then move the card
  // to the non-terminal "Followup Sent" column so it stays visible.
  const sendFollowUp = useCallback(async () => {
    if (!followUpCard) return
    const card = followUpCard
    const message = followUpDraft.trim()
    if (!message) { setFollowUpError('Write a message first'); return }
    setSendingFollowUp(true)
    setFollowUpError(null)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: card.account_id, contact_id: card.contact_id, message }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not send the reminder')
      }
      await move(card.id, 'send_followup')
      setFollowUpCard(null)
      setFollowUpDraft('')
    } catch (e) {
      setFollowUpError(e instanceof Error && e.message ? e.message : 'Could not send the reminder')
    } finally {
      setSendingFollowUp(false)
    }
  }, [followUpCard, followUpDraft, move])

  // Set reminder date, priority, and/or snooze on a card (no column move).
  // snoozed_until in the future hides the card from the board until that time.
  const updateCard = useCallback(
    async (id: string, patch: { remind_at?: string | null; priority?: Priority; snoozed_until?: string | null }) => {
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c))) // optimistic
      try {
        const res = await fetch(API, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...patch }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not update the card')
        }
      } finally {
        await load() // a freshly-snoozed card drops off on reload
      }
    },
    [load],
  )

  // Snooze from a date input. Empty = un-snooze. Guard: only accept a date
  // strictly in the future — this both enforces "snooze = hide until later" AND
  // ignores the implausible mid-typing dates a native date field emits per
  // keystroke (e.g. year 0202 before 2026 is finished), so we write once, cleanly.
  const snoozeFromInput = useCallback(
    (id: string, value: string) => {
      if (!value) { updateCard(id, { snoozed_until: null }); return }
      const d = new Date(`${value}T09:00:00`)
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) return
      updateCard(id, { snoozed_until: d.toISOString() })
    },
    [updateCard],
  )

  // Edit a card's note (label) inline. PATCH accepts label; reload reconciles.
  const saveNote = useCallback(
    async (id: string) => {
      const next = noteDraft.trim()
      setSavingNote(true)
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, label: next || null } : c)))
      try {
        const res = await fetch(API, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label: next }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not save the note')
        }
      } finally {
        setSavingNote(false)
        setEditingNoteId(null)
        await load()
      }
    },
    [noteDraft, load],
  )

  const todayStr = new Date().toISOString().slice(0, 10)
  const terminalSlug = columns.find((c) => c.terminal)?.slug ?? null

  const visibleColumns = columns.filter((c) => !c.terminal)
  const total = cards.length

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">To Do — from chats</h3>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          To Do — from chats
          <HelpDot helpKey="board.overview" />
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-700 bg-zinc-100 px-2 py-0.5 rounded-full">{total}</span>
          {snoozedCards.length > 0 && (
            <button
              onClick={() => setShowSnoozed((v) => !v)}
              className={`flex items-center gap-1 text-[11px] font-medium border rounded px-2 py-0.5 ${showSnoozed ? 'bg-violet-100 text-violet-700 border-violet-200' : 'text-zinc-600 hover:text-zinc-900'}`}
              title="Show snoozed cards"
            >
              <Moon className="h-3 w-3" /> Snoozed ({snoozedCards.length})
            </button>
          )}
          <button
            onClick={() => setNewCardOpen(true)}
            className="flex items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-900 border rounded px-2 py-0.5"
            title="Add a card"
          >
            <Plus className="h-3 w-3" /> New card
          </button>
          <HelpDot helpKey="board.new_card" />
          <button
            onClick={() => setEditingColumns(true)}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Edit board columns"
            title="Edit columns"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <HelpDot helpKey="board.settings" />
        </div>
      </div>
      <ManageColumnsDialog open={editingColumns} onClose={() => setEditingColumns(false)} onChanged={load} />
      <NewCardDialog open={newCardOpen} onClose={() => setNewCardOpen(false)} onCreated={load} columns={columns} />

      {total > 0 && (
        <p className="text-[11px] text-zinc-400 mb-2">Drag a card between columns, or use the dropdown on each card.</p>
      )}

      {total === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">Nothing needs action right now</p>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {visibleColumns.map((col) => {
            const colCards = cards.filter((c) => c.action_type === col.slug).slice().sort(sortCards)
            const Icon = COLUMN_ICON[col.slug] ?? AlertCircle
            return (
              <div
                key={col.slug}
                onDragOver={(e) => { e.preventDefault(); if (dragOverCol !== col.slug) setDragOverCol(col.slug) }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverCol(null) }}
                onDrop={(e) => {
                  e.preventDefault()
                  const id = e.dataTransfer.getData('text/plain')
                  setDragOverCol(null)
                  if (id) move(id, col.slug)
                }}
                className={`min-w-[230px] w-[230px] shrink-0 rounded-lg border p-2 transition-colors ${dragOverCol === col.slug ? 'bg-violet-50 border-violet-300' : 'bg-zinc-50'}`}
              >
                <div className="flex items-center gap-1.5 mb-2 px-1">
                  <Icon className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="text-xs font-semibold text-zinc-700">{col.display_name}</span>
                  <span className="text-[10px] text-zinc-400 ml-auto">{colCards.length}</span>
                </div>
                <div className="space-y-2">
                  {colCards.map((card) => {
                    const isCompany = !!card.account_id
                    const clientName =
                      card.accounts?.company_name || card.contacts?.full_name || 'Unknown'
                    // A card created FROM a message (message_id set) deep-links back to
                    // that exact message in Portal Chats (?message=<id> scrolls + flashes
                    // it). Cards without a message keep the legacy entity link.
                    const msgParam = card.message_id ? `&message=${card.message_id}` : ''
                    const href = card.account_id
                      ? `/portal-chats?account=${card.account_id}${msgParam}`
                      : card.contact_id
                        ? card.message_id
                          ? `/portal-chats?contact=${card.contact_id}${msgParam}`
                          : `/contacts/${card.contact_id}`
                        : '/portal-chats'
                    const priority = (card.priority ?? 'normal') as Priority
                    const rem = remindState(card.remind_at)
                    // Left accent: red if urgent/overdue, amber if high/due-today.
                    const accent =
                      priority === 'urgent' || rem.overdue
                        ? 'border-l-4 border-l-red-400'
                        : priority === 'high' || rem.dueToday
                          ? 'border-l-4 border-l-amber-400'
                          : ''
                    const remindInput = card.remind_at
                      ? new Date(card.remind_at).toISOString().slice(0, 10)
                      : ''
                    return (
                      <div
                        key={card.id}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move' }}
                        className={`rounded-md bg-white border p-2.5 shadow-sm cursor-grab active:cursor-grabbing ${accent} ${movingId === card.id ? 'opacity-50' : ''}`}
                      >
                        <Link href={href} className="block group">
                          <div className="flex items-center gap-1.5">
                            {isCompany ? (
                              <Building2 className="h-3 w-3 text-zinc-400 shrink-0" />
                            ) : (
                              <User className="h-3 w-3 text-zinc-400 shrink-0" />
                            )}
                            <span className="text-sm font-medium text-zinc-900 truncate group-hover:underline">
                              {clientName}
                            </span>
                            {priority !== 'normal' && (
                              <span className={`ml-auto text-[9px] font-semibold uppercase tracking-wide border rounded px-1 py-px ${PRIORITY_PILL[priority]}`}>
                                {priority}
                              </span>
                            )}
                          </div>
                        </Link>
                        {/* Editable note. Kept OUTSIDE the Link so editing never
                            navigates away. Pencil → textarea → Save (PATCH label). */}
                        {editingNoteId === card.id ? (
                          <div className="mt-1">
                            <textarea
                              value={noteDraft}
                              onChange={(e) => setNoteDraft(e.target.value)}
                              rows={2}
                              autoFocus
                              placeholder="Add a note…"
                              className="w-full text-xs border rounded px-1.5 py-1 resize-none"
                            />
                            <div className="flex gap-1 mt-1">
                              <button
                                onClick={() => saveNote(card.id)}
                                disabled={savingNote}
                                className="flex items-center gap-0.5 text-[11px] text-white bg-violet-600 rounded px-2 py-0.5 disabled:opacity-40"
                              >
                                <Check className="h-3 w-3" /> {savingNote ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                onClick={() => setEditingNoteId(null)}
                                className="flex items-center gap-0.5 text-[11px] text-zinc-500 border rounded px-2 py-0.5"
                              >
                                <X className="h-3 w-3" /> Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="group/note mt-1 flex items-start gap-1">
                            {card.label ? (
                              <ExpandableText text={card.label} lines={2} className="flex-1 min-w-0" textClassName="text-xs text-zinc-600" />
                            ) : (
                              <p className="flex-1 min-w-0 text-xs italic text-zinc-300">No note — click to add</p>
                            )}
                            <button
                              onClick={() => { setEditingNoteId(card.id); setNoteDraft(card.label || '') }}
                              className="shrink-0 text-zinc-300 hover:text-violet-600"
                              title="Edit note"
                              aria-label="Edit note"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                        <div className="flex items-center justify-between mt-2 gap-1">
                          {card.remind_at ? (
                            <span className={`flex items-center gap-1 text-[10px] ${rem.overdue ? 'text-red-600 font-medium' : rem.dueToday ? 'text-amber-600' : 'text-zinc-500'}`}>
                              <CalendarClock className="h-3 w-3" />
                              {rem.overdue ? 'Overdue · ' : ''}
                              {new Date(card.remind_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                            </span>
                          ) : (
                            <span className="text-[10px] text-zinc-300">No reminder</span>
                          )}
                          <span className="text-[10px] text-zinc-400">
                            {formatDistanceToNow(new Date(card.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        <div className="flex gap-1 mt-2">
                          <select
                            aria-label="Move card"
                            disabled={movingId === card.id}
                            value={card.action_type}
                            onChange={(e) => move(card.id, e.target.value)}
                            className="flex-1 min-w-0 text-[11px] border rounded px-1.5 py-1 bg-white text-zinc-600 disabled:opacity-50"
                          >
                            {columns.map((c) => (
                              <option key={c.slug} value={c.slug}>
                                {c.terminal ? `✓ ${c.display_name}` : `Move to: ${c.display_name}`}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="Priority"
                            value={priority}
                            onChange={(e) => updateCard(card.id, { priority: e.target.value as Priority })}
                            className="text-[11px] border rounded px-1 py-1 bg-white text-zinc-600"
                            title="Priority"
                          >
                            <option value="normal">○</option>
                            <option value="high">!</option>
                            <option value="urgent">!!</option>
                          </select>
                          {terminalSlug && (
                            <button
                              disabled={movingId === card.id}
                              onClick={() => move(card.id, terminalSlug)}
                              className="flex items-center gap-0.5 text-[11px] text-emerald-600 hover:text-emerald-800 border border-emerald-200 rounded px-1.5 py-1 disabled:opacity-50"
                              title="Mark done"
                              aria-label="Mark done"
                            >
                              <Check className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        {(card.action_type === 'waiting_on_client' || card.action_type === 'send_followup') && (
                          <button
                            disabled={(!card.account_id && !card.contact_id) || movingId === card.id}
                            onClick={() => { setFollowUpError(null); setFollowUpDraft(defaultFollowUpText(clientName, card.label)); setFollowUpCard(card) }}
                            className="mt-2 w-full flex items-center justify-center gap-1 text-[11px] text-violet-700 hover:text-white hover:bg-violet-600 border border-violet-200 rounded px-1.5 py-1 disabled:opacity-40"
                            title="Send the client a portal-chat reminder and move this card to Followup Sent"
                          >
                            <Send className="h-3 w-3" /> {card.action_type === 'send_followup' ? 'Follow up again' : 'Follow up'}
                          </button>
                        )}
                        {/* Stacked so the native date inputs never overflow the
                            narrow card. Each row: icon + short label + full-width input. */}
                        <div className="mt-1 space-y-1">
                          <label className="flex items-center gap-1 text-[10px] text-zinc-400" title="Set a reminder date (colours the card, does not hide it)">
                            <CalendarClock className="h-3 w-3 shrink-0" />
                            <span className="shrink-0 w-11">Remind</span>
                            <input
                              type="date"
                              aria-label="Reminder date"
                              value={remindInput}
                              onChange={(e) => updateCard(card.id, { remind_at: e.target.value ? new Date(`${e.target.value}T17:00:00`).toISOString() : null })}
                              className="min-w-0 flex-1 text-[11px] border rounded px-1.5 py-1 bg-white text-zinc-500"
                            />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-zinc-400" title="Snooze: hide this card until the chosen date">
                            <Moon className="h-3 w-3 shrink-0" />
                            <span className="shrink-0 w-11">Snooze</span>
                            <input
                              type="date"
                              aria-label="Snooze until"
                              min={todayStr}
                              onChange={(e) => snoozeFromInput(card.id, e.target.value)}
                              className="min-w-0 flex-1 text-[11px] border rounded px-1.5 py-1 bg-white text-zinc-500"
                            />
                          </label>
                        </div>
                        <div className="mt-1.5 pt-1.5 border-t">
                          <CardCreateActions
                            accountId={card.account_id}
                            contactId={card.contact_id}
                            clientName={clientName}
                            onDone={load}
                          />
                        </div>
                      </div>
                    )
                  })}
                  {colCards.length === 0 && (
                    <p className="text-[11px] text-zinc-400 px-1 py-2">—</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showSnoozed && snoozedCards.length > 0 && (
        <div className="mt-4 rounded-lg border border-violet-100 bg-violet-50/40 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Moon className="h-3.5 w-3.5 text-violet-500" />
            <span className="text-xs font-semibold text-violet-700">Snoozed — hidden until their date</span>
            <span className="text-[10px] text-zinc-400 ml-auto">{snoozedCards.length}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {snoozedCards.map((card) => {
              const clientName = card.accounts?.company_name || card.contacts?.full_name || 'Unknown'
              const until = card.snoozed_until
                ? new Date(card.snoozed_until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : ''
              return (
                <div key={card.id} className="rounded-md bg-white border p-2.5 shadow-sm">
                  <div className="flex items-center gap-1.5">
                    {card.account_id ? (
                      <Building2 className="h-3 w-3 text-zinc-400 shrink-0" />
                    ) : (
                      <User className="h-3 w-3 text-zinc-400 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-zinc-900 truncate">{clientName}</span>
                  </div>
                  {card.label && <ExpandableText text={card.label} lines={2} className="mt-1" textClassName="text-xs text-zinc-600" />}
                  <div className="flex items-center justify-between mt-2">
                    <span className="flex items-center gap-1 text-[10px] text-violet-600">
                      <Moon className="h-3 w-3" /> Until {until}
                    </span>
                    <button
                      onClick={() => updateCard(card.id, { snoozed_until: null })}
                      className="text-[11px] text-violet-700 hover:text-violet-900 border border-violet-200 rounded px-1.5 py-0.5"
                      title="Bring this card back to the board now"
                    >
                      Un-snooze
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {followUpCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !sendingFollowUp && setFollowUpCard(null)}>
          <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 mb-2">
              <Send className="h-4 w-4 text-violet-600" />
              <h4 className="text-sm font-semibold text-zinc-800">
                Follow up — {followUpCard.accounts?.company_name || followUpCard.contacts?.full_name || 'client'}
              </h4>
            </div>
            <p className="text-[11px] text-zinc-500 mb-2">
              Sends this as a message in the client&apos;s portal chat (they also get the usual email notification), then moves the card to “Followup Sent”.
            </p>
            <textarea
              value={followUpDraft}
              onChange={(e) => setFollowUpDraft(e.target.value)}
              rows={7}
              autoFocus
              className="w-full text-xs border rounded px-2 py-1.5 resize-none"
            />
            {followUpError && <p className="text-[11px] text-red-600 mt-1">{followUpError}</p>}
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setFollowUpCard(null)}
                disabled={sendingFollowUp}
                className="text-[12px] text-zinc-600 border rounded px-3 py-1 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={sendFollowUp}
                disabled={sendingFollowUp || !followUpDraft.trim()}
                className="flex items-center gap-1 text-[12px] text-white bg-violet-600 hover:bg-violet-700 rounded px-3 py-1 disabled:opacity-40"
              >
                <Send className="h-3 w-3" /> {sendingFollowUp ? 'Sending…' : 'Send & move to Followup Sent'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
