'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { clockText, utcOffsetText, zoneName } from '@/lib/marketing/zones'
import type { Clock, ClockKey } from '@/lib/marketing/time-prefs'

const TONE: Record<ClockKey, string> = { client: 'text-amber-800', seller: 'text-teal-800', owner: 'text-sky-800', you: 'text-sky-800' }

/**
 * The clocks on a lead (TD Marketing, dev job 9aec66fa, Addendum K, B2): the client's, the seller's and the owner's (a setter's own instead; the page is built without the owner's zone for her).
 * Live ("Right now") ticks every 20 seconds; with `fixedIso` it shows what time a booked call is for everybody. A client whose zone is not known shows an empty clock.
 */
export function ClockRow({ clocks, title, nowIso, fixedIso }: { clocks: Clock[]; title: string; nowIso: string; fixedIso?: string }) {
  const t = useT()
  const [now, setNow] = useState(nowIso)
  useEffect(() => {
    if (fixedIso) return
    const h = setInterval(() => setNow(new Date().toISOString()), 20_000)
    return () => clearInterval(h)
  }, [fixedIso])
  const at = fixedIso ?? now
  return (
    <div data-testid="lead-clocks">
      <p className="mb-1 text-xs font-semibold text-slate-500">{title}</p>
      <div className="flex flex-wrap gap-x-2 gap-y-1.5">
        {clocks.map(c => (
          <div key={c.key} className="flex min-w-0 items-baseline gap-2 rounded-md border bg-white px-2.5 py-1" data-clock={c.key}>
            <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">{c.key === 'client' ? t('{name}, the client', { name: c.label }) : c.key === 'you' ? t('You') : c.label}</span>
            {c.zone
              ? <><span className={`font-mono text-base ${TONE[c.key]}`} suppressHydrationWarning>{clockText(at, c.zone)}</span><span className="text-[11px] text-slate-500" suppressHydrationWarning>{zoneName(c.zone)} · {utcOffsetText(at, c.zone)}</span></>
              : <><span className="font-mono text-base text-slate-400">--:--</span><span className="text-[11px] text-slate-500">{t('Pick a time zone first')}</span></>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The persistent banner on every screen of the seller's workspace: his time and the owner's (Antonio's requests of 30 and 31 Oct 2026). Slim, and it stays at the top while the page scrolls. */
export function SellerBanner({ clocks, nowIso }: { clocks: Clock[]; nowIso: string }) {
  const t = useT()
  const [now, setNow] = useState(nowIso)
  useEffect(() => {
    const h = setInterval(() => setNow(new Date().toISOString()), 20_000)
    return () => clearInterval(h)
  }, [])
  if (clocks.length === 0) return null
  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-center gap-x-6 gap-y-0.5 border-b border-emerald-300 bg-emerald-50 px-6 py-1.5 text-sm text-emerald-900" data-testid="seller-banner">
      {clocks.map(c => c.zone && (
        <span key={c.key}>
          {c.key === 'you' ? t('Your time') : t("{name}'s time", { name: c.label })} <b className="font-mono text-base text-emerald-800" suppressHydrationWarning>{clockText(now, c.zone)}</b> <span className="text-emerald-800">{zoneName(c.zone)} · {utcOffsetText(now, c.zone)}</span>
        </span>
      ))}
    </div>
  )
}
