'use client'

/**
 * Staff-side view of which partner banks a client has actually clicked.
 *
 * Quiet by default (Antonio, 2026-07-27): the bank catalog went from one row to
 * seven, so a panel that always listed every bank was a wall of "Not Clicked"
 * on an already-busy account page. It now collapses itself when there is no
 * activity and turns RED when the client has clicked something — the only case
 * where staff need to react. The full list is still one click away.
 */

import { useState } from 'react'
import { Landmark, ChevronDown, ChevronRight } from 'lucide-react'
import { summarizeBankActivity } from '@/lib/bank-referrals'

export interface BankReferralEntry {
  slug: string
  label: string
  clicked_at: string | null
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function BankReferralsPanel({ entries }: { entries: BankReferralEntry[] }) {
  const { clickedCount, hasActivity } = summarizeBankActivity(entries)
  // Open only when there's something to react to; otherwise stay out of the way.
  const [open, setOpen] = useState(hasActivity)

  if (entries.length === 0) return null

  // Activity first — the whole point of expanding is to see what they clicked.
  const ordered = [...entries].sort((a, b) => {
    if (!!a.clicked_at === !!b.clicked_at) return 0
    return a.clicked_at ? -1 : 1
  })

  return (
    <div className="mt-4 border-t pt-4">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <h4
          className={`text-xs font-semibold uppercase tracking-wider ${
            hasActivity ? 'text-red-700' : 'text-muted-foreground'
          }`}
        >
          Partner Bank Applications
        </h4>
        {hasActivity ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
            {clickedCount} applied
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">No activity</span>
        )}
      </button>

      {open && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ordered.map(r => {
            const clicked = !!r.clicked_at
            return (
              <div
                key={r.slug}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                  clicked ? 'border-red-200 bg-red-50' : 'border-zinc-200 bg-zinc-50'
                }`}
              >
                <Landmark className={`h-4 w-4 shrink-0 ${clicked ? 'text-red-700' : 'text-zinc-400'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{r.label}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        clicked ? 'bg-red-100 text-red-700' : 'bg-zinc-200 text-zinc-600'
                      }`}
                    >
                      {clicked ? 'Clicked' : 'Not Clicked'}
                    </span>
                  </div>
                  {r.clicked_at && (
                    <span className="text-[10px] text-muted-foreground">{formatDate(r.clicked_at)}</span>
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
