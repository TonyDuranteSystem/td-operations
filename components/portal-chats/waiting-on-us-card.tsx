'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { daysWaiting } from '@/lib/portal-chats/waiting'
import {
  defaultOwnerFilter,
  ownerCounts,
  waitingUsForCard,
  type OwnedThread,
  type OwnerFilter,
  type WaitingStaff,
} from '@/lib/portal-chats/waiting-owner'

/** The few thread fields the card reads (the page's own thread type satisfies this). */
export interface WaitingCardThread extends OwnedThread {
  account_id: string | null
  contact_id: string | null
  company_name: string
  contact_name: string | null
  last_message: string
}

const AVATAR_COLORS = ['bg-blue-600', 'bg-violet-600', 'bg-teal-600', 'bg-amber-600', 'bg-rose-600', 'bg-sky-600']

/** A stable colour per person, so the same initials always look the same everywhere. */
export function avatarColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

/** The round initials badge; no owner = a dashed "?" circle. Also used on the conversation list rows. */
export function OwnerBadge({ staff, ownerId, className }: { staff: ReadonlyArray<WaitingStaff>; ownerId: string | null | undefined; className?: string }) {
  const person = ownerId ? staff.find(s => s.id === ownerId) : undefined
  if (!ownerId) {
    return <span title="Not assigned" className={cn('inline-grid h-5 w-5 shrink-0 place-items-center rounded-full border border-dashed border-zinc-400 text-[9px] font-bold text-zinc-400', className)}>?</span>
  }
  return (
    <span title={person?.name ?? 'Former team member'} className={cn('inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white', person ? avatarColor(ownerId) : 'bg-zinc-400', className)}>
      {person?.initials ?? '?'}
    </span>
  )
}

const dayLabel = (since: string) => {
  const d = daysWaiting(since, new Date())
  return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`
}

/**
 * The pop-up under the "Waiting on us" chip (Antonio, 2026-11-25): every conversation the client is waiting on us for, with the team
 * member it belongs to and a small filter per team member. It opens on the viewer's own conversations. The owner of a line is changed
 * with the small menu on that line; clicking the name opens the conversation.
 */
export function WaitingOnUsCard({
  threads, staff, viewerId, loading, onOpen, onAssign, onClose,
}: {
  /** Every loaded conversation (the card picks the ones waiting on us). */
  threads: ReadonlyArray<WaitingCardThread>
  staff: ReadonlyArray<WaitingStaff>
  viewerId: string | null
  /** The conversation list is still loading: say so instead of "nothing is waiting". */
  loading?: boolean
  onOpen: (t: WaitingCardThread) => void
  onAssign: (t: WaitingCardThread, ownerId: string | null) => void
  onClose: () => void
}) {
  const [picked, setPicked] = useState<OwnerFilter | null>(null)
  // Until the person picks a pill, the card shows their own conversations (or everyone's when they are not on the team list).
  const filter: OwnerFilter = picked ?? defaultOwnerFilter(viewerId, staff)
  const counts = ownerCounts(threads)
  const shown = waitingUsForCard(threads, filter)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null
      // a click on the chip itself is handled by the chip (it reopens the card)
      if (ref.current && el && !ref.current.contains(el) && !el.closest('[data-waiting-card-keep]')) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [onClose])

  const pills: Array<{ id: OwnerFilter; label: string; count: number; staffId?: string }> = [
    { id: 'all', label: 'Everyone', count: counts.all },
    ...staff.map(s => ({ id: s.id as OwnerFilter, label: s.id === viewerId ? `${s.name} (you)` : s.name, count: counts.byOwner[s.id] ?? 0, staffId: s.id })),
    { id: 'none', label: 'Not assigned', count: counts.none },
  ]

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Waiting on us"
      data-testid="waiting-us-card"
      className="absolute left-2 right-2 top-full z-30 mt-1 flex max-h-[min(440px,70vh)] flex-col rounded-xl border border-zinc-200 bg-white shadow-xl"
    >
      <div className="flex items-start justify-between gap-2 px-3.5 pb-2 pt-3">
        <div>
          <p className="text-sm font-semibold text-rose-600">Waiting on us</p>
          <p className="text-xs text-zinc-500">The client is waiting for our answer. Longest first.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-zinc-200 px-3.5 pb-2.5" data-testid="waiting-us-filter">
        {pills.map(p => (
          <button
            key={p.id}
            type="button"
            aria-pressed={filter === p.id}
            data-testid={`waiting-us-pill-${p.id}`}
            onClick={() => setPicked(p.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 text-xs transition-colors',
              p.id === 'all' ? 'pl-2.5' : 'pl-1',
              filter === p.id ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
            )}
          >
            {p.id === 'none' ? <OwnerBadge staff={staff} ownerId={null} /> : p.staffId ? <OwnerBadge staff={staff} ownerId={p.staffId} /> : null}
            {p.label} <span className="font-bold">{p.count}</span>
          </button>
        ))}
      </div>

      <div className="overflow-y-auto" data-testid="waiting-us-items">
        {shown.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-sm text-zinc-400">
            {loading ? 'Loading…' : filter === viewerId ? 'Nothing is waiting on you.' : 'Nothing is waiting here.'}
          </p>
        ) : shown.map(t => {
          const key = t.account_id ?? t.contact_id ?? ''
          const owner = t.waiting_us_owner ?? ''
          const ownerKnown = !owner || staff.some(s => s.id === owner)
          return (
            <div key={key} data-testid="waiting-us-item" className="flex items-center gap-2.5 border-b border-zinc-100 px-3.5 py-2.5 hover:bg-zinc-50">
              <OwnerBadge staff={staff} ownerId={t.waiting_us_owner} />
              <button type="button" onClick={() => onOpen(t)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[13px] font-medium text-zinc-900">{t.contact_name || t.company_name}</span>
                <span className="block truncate text-xs text-zinc-400">{t.last_message}</span>
              </button>
              <span className="whitespace-nowrap text-[11px] font-bold text-rose-600">{dayLabel(t.waiting_us_since as string)}</span>
              <select
                aria-label={`Who answers ${t.contact_name || t.company_name}`}
                value={owner}
                onChange={e => onAssign(t, e.target.value || null)}
                className="max-w-[120px] rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-700"
              >
                <option value="">Not assigned</option>
                {!ownerKnown && <option value={owner}>Former team member</option>}
                {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )
        })}
      </div>
    </div>
  )
}
