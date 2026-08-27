'use client'

/**
 * ThreadTodoPanel — per-client To-Do cards inside /portal-chats, driven by the
 * NEW Notification Center board (message_actions), NOT the tasks table. Lets
 * staff CREATE a to-do here (reflected on the CRM dashboard board) and complete
 * one. Pairs with the purple thread-list dot. See sysdoc notification-center-plan.
 */

import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, CalendarClock, Check, Moon } from 'lucide-react'
import { createManualCard } from '@/components/dashboard/action-board-actions'
import { CardCreateActions } from '@/components/notifications/card-create-actions'
import { HelpDot } from '@/components/help/help-dot'
import { FastTooltip } from '@/components/ui/fast-tooltip'

const API = '/api/crm/admin-actions/message-actions'

type Priority = 'normal' | 'high' | 'urgent'

interface TodoCard {
  id: string
  action_type: string
  label: string | null
  remind_at: string | null
  priority: Priority | null
  account_id: string | null
  contact_id: string | null
}
interface Col {
  slug: string
  display_name: string
  order: number
  terminal: boolean
}

const PRIORITY_PILL: Record<Priority, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-amber-100 text-amber-700 border-amber-200',
  normal: 'bg-zinc-100 text-zinc-500 border-zinc-200',
}

export function ThreadTodoPanel({
  accountId,
  contactId,
}: {
  accountId: string | null
  contactId: string | null
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [remind, setRemind] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Scope the fetch SERVER-side. This used to pull every client's open cards and filter
  // them in the browser — which (a) shipped other clients' cards to this page for no
  // reason, and (b) was WRONG once the system passed 200 open cards, because this
  // client's own cards could fall outside the 200 most-recent the server returns and the
  // panel would show empty for a client who actually has to-dos.
  const scopeParam = accountId ? `account_id=${accountId}` : contactId ? `contact_id=${contactId}` : ''
  const { data: scopedOpen, isLoading } = useQuery<TodoCard[]>({
    queryKey: ['thread-todos', accountId ?? contactId],
    queryFn: () => fetch(`${API}?open=true&${scopeParam}`).then((r) => r.json()).then((d) => d.actions || []),
    refetchInterval: 30_000,
    enabled: !!(accountId || contactId),
  })
  const { data: columns } = useQuery<Col[]>({
    queryKey: ['thread-todo-columns'],
    queryFn: () => fetch(`${API}?columns=true`).then((r) => r.json()).then((d) => d.columns || []),
    refetchInterval: 120_000,
  })

  // Already scoped by the server (see the query above) — this is just a belt-and-braces
  // re-check, not the filter that makes the list correct.
  const cards = useMemo(() => {
    const list = scopedOpen ?? []
    return list.filter((c) =>
      accountId ? c.account_id === accountId : contactId ? c.contact_id === contactId : false,
    )
  }, [scopedOpen, accountId, contactId])

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['thread-todos'] })
    qc.invalidateQueries({ queryKey: ['portal-chat-open-todo-counts'] })
    qc.invalidateQueries({ queryKey: ['open-message-actions'] })
  }, [qc])

  const add = useCallback(async () => {
    if (!label.trim() || busy) return
    setBusy(true)
    setError(null)
    const remind_at = remind ? new Date(`${remind}T17:00:00`).toISOString() : null
    const res = await createManualCard({
      label,
      account_id: accountId ?? undefined,
      contact_id: accountId ? undefined : contactId ?? undefined,
      remind_at,
      priority,
    })
    setBusy(false)
    if (!res.success) {
      setError(res.error || 'Could not add the to-do')
      return
    }
    setLabel(''); setPriority('normal'); setRemind(''); setAdding(false)
    refreshAll()
  }, [label, priority, remind, accountId, contactId, busy, refreshAll])

  const complete = useCallback(
    async (id: string) => {
      const terminal = (columns ?? []).find((c) => c.terminal)
      if (!terminal) {
        setError('No "done" column is configured on the board')
        return
      }
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action_type: terminal.slug }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Could not complete the to-do')
        return
      }
      refreshAll()
    },
    [columns, refreshAll],
  )

  // Snooze: hide the card from every open-card reader until the chosen date
  // (09:00 local). The card vanishes on the next refetch. Guard: only accept a
  // future date — enforces "hide until later" AND ignores the implausible
  // mid-typing dates a native date field emits per keystroke (year 0202 etc.),
  // so we write once, cleanly.
  const snooze = useCallback(
    async (id: string, dateStr: string) => {
      const d = new Date(`${dateStr}T09:00:00`)
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) return
      const snoozed_until = d.toISOString()
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, snoozed_until }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Could not snooze the to-do')
        return
      }
      refreshAll()
    },
    [refreshAll],
  )

  const todayStr = new Date().toISOString().slice(0, 10)

  if (!accountId && !contactId) {
    return (
      <div className="flex items-center justify-center py-6">
        <p className="text-sm text-zinc-400">Select a conversation</p>
      </div>
    )
  }

  return (
    <div className="border-b">
      <div className="px-4 py-2 bg-violet-50/60 border-b border-violet-100 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-violet-700">
          <span className="h-2 w-2 rounded-full bg-violet-500" />
          To-Do ({cards.length})
          <HelpDot helpKey="todo.panel" />
        </span>
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:text-violet-900 border border-violet-200 rounded px-2 py-0.5 bg-white"
        >
          <Plus className="h-3 w-3" /> Add to-do
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{error}</div>
      )}

      {adding && (
        <div className="p-3 space-y-2 bg-white border-b">
          <textarea
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            rows={2}
            autoFocus
            placeholder="e.g. Call the client about the missing passport"
            className="w-full text-sm border rounded px-2 py-1.5 resize-none"
          />
          <div className="flex gap-2">
            <input
              type="date"
              value={remind}
              onChange={(e) => setRemind(e.target.value)}
              className="flex-1 text-sm border rounded px-2 py-1.5 bg-white"
              title="Remind me by (optional)"
            />
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="w-28 text-sm border rounded px-2 py-1.5 bg-white"
            >
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            <button
              disabled={!label.trim() || busy}
              onClick={add}
              className="flex items-center gap-1 text-sm font-medium bg-violet-600 text-white rounded px-3 py-1.5 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      <div className="p-3 space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-zinc-400" /></div>
        ) : cards.length === 0 ? (
          <p className="text-xs text-zinc-400 px-1 py-1">No open to-dos for this client.</p>
        ) : (
          cards.map((card) => {
            const p = (card.priority ?? 'normal') as Priority
            const overdue = card.remind_at != null && new Date(card.remind_at).getTime() < Date.now()
            return (
              <div key={card.id} className={`rounded-md border bg-white p-2.5 ${overdue || p === 'urgent' ? 'border-l-4 border-l-red-400' : p === 'high' ? 'border-l-4 border-l-amber-400' : ''}`}>
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-sm text-zinc-800">{card.label || '(no description)'}</p>
                  <FastTooltip label="Mark done">
                    <button
                      onClick={() => complete(card.id)}
                      className="shrink-0 flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-800 border border-emerald-200 rounded px-1.5 py-0.5"
                      aria-label="Mark done"
                    >
                      <Check className="h-3 w-3" /> Done
                    </button>
                  </FastTooltip>
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  {p !== 'normal' && (
                    <span className={`text-[9px] font-semibold uppercase tracking-wide border rounded px-1 py-px ${PRIORITY_PILL[p]}`}>{p}</span>
                  )}
                  {card.remind_at && (
                    <span className={`flex items-center gap-1 text-[10px] ${overdue ? 'text-red-600 font-medium' : 'text-zinc-500'}`}>
                      <CalendarClock className="h-3 w-3" />
                      {overdue ? 'Overdue · ' : ''}
                      {new Date(card.remind_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                  <label className="ml-auto flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer" title="Hide this card until a date">
                    <Moon className="h-3 w-3" />
                    <input
                      type="date"
                      min={todayStr}
                      onChange={(e) => e.target.value && snooze(card.id, e.target.value)}
                      className="text-[10px] border rounded px-1 py-0.5 text-zinc-500 bg-white"
                      aria-label="Snooze until"
                    />
                  </label>
                </div>
                <div className="mt-1.5 pt-1.5 border-t">
                  <CardCreateActions accountId={card.account_id} contactId={card.contact_id} onDone={refreshAll} />
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
