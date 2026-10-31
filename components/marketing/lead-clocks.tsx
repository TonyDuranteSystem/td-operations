'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { clockText, utcOffsetText, zoneName } from '@/lib/marketing/zones'
import { isUsableDeviceZone } from '@/lib/marketing/zone-report'
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

/**
 * The persistent banner on every screen of the seller's workspace: his time and the owner's, nothing else (Antonio, 31 Oct 2026: no words, "it must change according to where we connect").
 * Slim, and it stays at the top while the page scrolls. The viewer's OWN clock reads the zone of this browser, so a person who travels sees it change at once (`liveYou`; a "View as" preview
 * is somebody else's page, so it keeps the zone the server holds); the other person's clock is the zone the server holds for them, which their own browser keeps up to date.
 */
export function SellerBanner({ clocks, nowIso, liveYou }: { clocks: Clock[]; nowIso: string; liveYou: boolean }) {
  const [now, setNow] = useState(nowIso)
  const [device, setDevice] = useState<string | null>(null)
  useEffect(() => {
    if (liveYou) { try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (isUsableDeviceZone(z)) setDevice(z) } catch { /* keep the zone from the server */ } }
    const h = setInterval(() => setNow(new Date().toISOString()), 20_000)
    return () => clearInterval(h)
  }, [liveYou])
  if (clocks.length === 0) return null
  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-baseline gap-x-6 gap-y-0.5 border-b border-emerald-300 bg-emerald-50 px-6 py-1.5 text-sm text-emerald-900" data-testid="seller-banner">
      {clocks.map((c, i) => {
        const zone = c.key === 'you' && device ? device : c.zone
        return zone && (
          <span key={c.key} className={`flex items-baseline gap-1.5 ${i > 0 ? 'border-l border-emerald-300 pl-6' : ''}`} data-banner-clock={c.key}>
            <b className="font-mono text-base text-emerald-800" suppressHydrationWarning>{clockText(now, zone)}</b>
            <span className="text-emerald-800" suppressHydrationWarning>{zoneName(zone)} · {utcOffsetText(now, zone)}</span>
          </span>
        )
      })}
    </div>
  )
}
