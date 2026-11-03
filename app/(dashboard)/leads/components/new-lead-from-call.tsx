'use client'

import { useEffect, useMemo, useState } from 'react'
import { PhoneIncoming, X, Loader2 } from 'lucide-react'
import { CreateLeadDialog, type LeadFromCall } from './create-lead-dialog'

interface FreeCall {
  id: string
  title: string
  createdAt: string | null
  durationMinutes: number | null
  outsiders: { name: string | null; email: string | null }[]
  suggestion: { full_name: string; email: string }
}

function when(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
}

export function NewLeadFromCallButton() {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [chosen, setChosen] = useState<LeadFromCall | null>(null)
  const [calls, setCalls] = useState<FreeCall[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!pickerOpen) return
    let cancelled = false
    setCalls(null)
    setError('')
    ;(async () => {
      try {
        const res = await fetch('/api/crm/leads/free-calls')
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Could not load the calls — please try again.')
        if (!cancelled) setCalls(data.calls ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : 'Could not load the calls — please try again.')
      }
    })()
    return () => { cancelled = true }
  }, [pickerOpen])

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f || !calls) return calls ?? []
    return calls.filter(c => (`${c.title} ${c.outsiders.map(o => `${o.name ?? ''} ${o.email ?? ''}`).join(' ')}`).toLowerCase().includes(f))
  }, [calls, filter])

  const pick = (c: FreeCall) => {
    setChosen({ callId: c.id, callTitle: c.title, full_name: c.suggestion.full_name, email: c.suggestion.email })
    setPickerOpen(false)
  }

  return (
    <>
      <button
        onClick={() => { setFilter(''); setPickerOpen(true) }}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border bg-white hover:bg-zinc-50 transition-colors"
      >
        <PhoneIncoming className="h-4 w-4" />
        New Lead from a call
      </button>

      {pickerOpen && (
        <>
          <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setPickerOpen(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[85vh] flex flex-col pointer-events-auto">
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <div>
                  <h2 className="text-lg font-semibold">Which call is the lead from?</h2>
                  <p className="text-xs text-muted-foreground">Recorded calls from the last 30 days that nobody is attached to yet.</p>
                </div>
                <button onClick={() => setPickerOpen(false)} className="p-1 rounded hover:bg-zinc-100" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="px-6 pt-3">
                <input
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="Filter by name or email"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="px-6 py-3 overflow-y-auto space-y-2">
                {error && <p className="text-sm text-red-600">{error}</p>}
                {!error && calls === null && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading calls…</p>
                )}
                {!error && calls !== null && shown.length === 0 && (
                  <p className="text-sm text-muted-foreground">No free calls{filter ? ' match that filter' : ' in the last 30 days'}. A call that already has a lead is on that lead&apos;s page.</p>
                )}
                {shown.map(c => (
                  <button
                    key={c.id}
                    onClick={() => pick(c)}
                    className="w-full text-left border rounded-md px-3 py-2 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium">{c.title}</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {when(c.createdAt)}{c.durationMinutes ? ` · ${c.durationMinutes} min` : ''}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {c.outsiders.length > 0
                        ? c.outsiders.map(o => o.name || o.email).join(', ')
                        : 'No outside email on this call — you will type the name'}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {chosen && <CreateLeadDialog key={chosen.callId} open onClose={() => setChosen(null)} fromCall={chosen} />}
    </>
  )
}
