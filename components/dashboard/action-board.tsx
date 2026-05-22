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
import { AlertCircle, Clock, Hourglass, Landmark, CheckCircle2, Building2, User, Settings2 } from 'lucide-react'
import { ManageColumnsDialog } from './action-board-columns-dialog'

interface Column {
  slug: string
  display_name: string
  order: number
  terminal: boolean
}

interface Card {
  id: string
  action_type: string
  label: string | null
  assigned_to: string | null
  created_at: string
  message_id: string | null
  account_id: string | null
  contact_id: string | null
  accounts: { company_name: string } | null
  contacts: { full_name: string } | null
}

const COLUMN_ICON: Record<string, React.ElementType> = {
  action_needed: AlertCircle,
  in_progress: Clock,
  waiting_on_client: Hourglass,
  wait_for_irs: Landmark,
  done: CheckCircle2,
}

const API = '/api/crm/admin-actions/message-actions'

export function ActionBoard() {
  const [columns, setColumns] = useState<Column[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [editingColumns, setEditingColumns] = useState(false)

  const load = useCallback(async () => {
    try {
      const [colRes, cardRes] = await Promise.all([
        fetch(`${API}?columns=true`).then((r) => r.json()),
        fetch(`${API}?open=true`).then((r) => r.json()),
      ])
      if (Array.isArray(colRes.columns)) setColumns(colRes.columns)
      if (Array.isArray(cardRes.actions)) setCards(cardRes.actions)
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
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">To Do — from chats</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-700 bg-zinc-100 px-2 py-0.5 rounded-full">{total}</span>
          <button
            onClick={() => setEditingColumns(true)}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Edit board columns"
            title="Edit columns"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <ManageColumnsDialog open={editingColumns} onClose={() => setEditingColumns(false)} onChanged={load} />

      {total === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">Nothing needs action right now</p>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {visibleColumns.map((col) => {
            const colCards = cards.filter((c) => c.action_type === col.slug)
            const Icon = COLUMN_ICON[col.slug] ?? AlertCircle
            return (
              <div key={col.slug} className="min-w-[230px] w-[230px] shrink-0 rounded-lg bg-zinc-50 border p-2">
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
                    const href = card.account_id
                      ? `/portal-chats?account=${card.account_id}`
                      : card.contact_id
                        ? `/contacts/${card.contact_id}`
                        : '/portal-chats'
                    return (
                      <div key={card.id} className="rounded-md bg-white border p-2.5 shadow-sm">
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
                          </div>
                          {card.label && <p className="text-xs text-zinc-600 mt-1">{card.label}</p>}
                        </Link>
                        <div className="flex items-center justify-end mt-2">
                          <span className="text-[10px] text-zinc-400">
                            {formatDistanceToNow(new Date(card.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        <select
                          aria-label="Move card"
                          disabled={movingId === card.id}
                          value={card.action_type}
                          onChange={(e) => move(card.id, e.target.value)}
                          className="mt-2 w-full text-[11px] border rounded px-1.5 py-1 bg-white text-zinc-600 disabled:opacity-50"
                        >
                          {columns.map((c) => (
                            <option key={c.slug} value={c.slug}>
                              {c.terminal ? `✓ ${c.display_name}` : `Move to: ${c.display_name}`}
                            </option>
                          ))}
                        </select>
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
    </div>
  )
}
