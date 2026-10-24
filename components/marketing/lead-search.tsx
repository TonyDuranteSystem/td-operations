'use client'

import { useEffect, useRef, useState } from 'react'
import { useLeadWindows } from '@/components/marketing/lead-windows-host'
import { useT } from '@/components/marketing/lang-provider'

interface Hit { id: string; name: string; detail: string; status: string }

/** The search bar at the top of every workspace screen (dev job 9aec66fa): type a name, an email or a phone number; a lead opens in a floating window. */
export function LeadSearch() {
  const t = useT()
  const { open } = useLeadWindows()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return }
    let cancelled = false
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/marketing/leads/search?q=${encodeURIComponent(q.trim())}`)
        const d = r.ok ? await r.json() : { leads: [] }
        if (!cancelled) setHits(d.leads ?? [])
      } catch { if (!cancelled) setHits([]) } finally { if (!cancelled) setBusy(false) }
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [q])

  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setHits(null) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  return (
    <div ref={box} className="relative w-full max-w-md" role="search">
      <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search a lead: name, email or phone')} aria-label={t('Search leads')} data-testid="lead-search"
        className="h-9 w-full rounded-lg border bg-white px-3 text-sm outline-none focus:border-slate-500" />
      {hits !== null && (
        <ul className="absolute left-0 right-0 top-10 z-30 max-h-80 overflow-y-auto rounded-lg border bg-white shadow-lg" data-testid="search-results">
          {hits.length === 0
            ? <li className="px-3 py-3 text-sm text-slate-500">{busy ? t('Searching…') : t('No lead found.')}</li>
            : hits.map(h => (
              <li key={h.id}>
                <button type="button" onClick={() => { open({ id: h.id, name: h.name }); setHits(null); setQ('') }} data-testid="search-hit" data-lead={h.id}
                  className="block w-full px-3 py-2 text-left hover:bg-slate-50"><b className="block truncate text-sm font-medium">{h.name}</b><span className="block truncate text-xs text-slate-500">{h.detail}</span></button>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}
