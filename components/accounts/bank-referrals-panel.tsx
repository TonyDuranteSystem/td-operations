'use client'

import { Landmark } from 'lucide-react'

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
  if (entries.length === 0) return null

  return (
    <div className="mt-4 border-t pt-4">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Partner Bank Applications
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {entries.map(r => {
          const clicked = !!r.clicked_at
          return (
            <div
              key={r.slug}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                clicked ? 'bg-emerald-50 border-emerald-200' : 'bg-zinc-50 border-zinc-200'
              }`}
            >
              <Landmark className={`h-4 w-4 shrink-0 ${clicked ? 'text-emerald-700' : 'text-zinc-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{r.label}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                      clicked
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-zinc-200 text-zinc-600'
                    }`}
                  >
                    {clicked ? 'Clicked' : 'Not Clicked'}
                  </span>
                </div>
                {r.clicked_at && (
                  <span className="text-[10px] text-muted-foreground">
                    {formatDate(r.clicked_at)}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
