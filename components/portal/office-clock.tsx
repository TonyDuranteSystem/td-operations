'use client'

import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { getOfficeStatus, OFFICE_TZ } from '@/lib/portal/office-hours'
import { cn } from '@/lib/utils'

const COPY = {
  en: {
    open: 'We are open',
    closed: 'We are closed',
    openSub: 'Our team is online now — Monday to Friday, 9 AM – 3 PM Eastern Time (US).',
    closedSub:
      "Our office is open Monday to Friday, 9 AM – 3 PM Eastern Time (US). We'll reply on the next business day.",
    our: 'Our time',
    your: 'Your time',
    et: 'Eastern Time · US',
  },
  it: {
    open: 'Siamo aperti',
    closed: 'Siamo chiusi',
    openSub: 'Il nostro team è online adesso — dal lunedì al venerdì, 9:00 – 15:00 (ora della costa est USA).',
    closedSub:
      'Il nostro ufficio è aperto dal lunedì al venerdì, 9:00 – 15:00 (ora della costa est USA). Ti risponderemo il prossimo giorno lavorativo.',
    our: 'La nostra ora',
    your: 'La tua ora',
    et: 'Ora orientale · USA',
  },
} as const

function timeFmt(locale: string, timeZone?: string) {
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: locale !== 'it',
    ...(timeZone ? { timeZone } : {}),
  })
}

export function OfficeClock() {
  const { locale } = useLocale()
  const [now, setNow] = useState<Date | null>(null)

  // Render only after mount — the server has no single "now" the client agrees
  // with, so deferring avoids a hydration mismatch (same pattern as the banners).
  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!now) {
    // Reserve height so the layout doesn't jump when the banner mounts.
    return <div className="h-[104px] sm:h-20" aria-hidden />
  }

  const copy = COPY[locale === 'it' ? 'it' : 'en']
  const status = getOfficeStatus(now)
  const open = status.open

  const ourTime = timeFmt(locale, OFFICE_TZ).format(now)
  const yourTime = timeFmt(locale).format(now)
  // The visitor's own timezone, e.g. "Europe/Rome" → "Rome".
  const yourTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone?.split('/').pop()?.replace(/_/g, ' ') ?? ''
    } catch {
      return ''
    }
  })()

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-col gap-4 rounded-2xl border px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-5',
        open ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50',
      )}
    >
      {/* Status + message */}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 inline-flex h-11 w-11 flex-none items-center justify-center rounded-full',
            open ? 'bg-emerald-100' : 'bg-red-100',
          )}
        >
          <Clock className={cn('h-6 w-6', open ? 'text-emerald-600' : 'text-red-600')} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2">
            <span
              className={cn('inline-block h-2.5 w-2.5 flex-none rounded-full', open ? 'bg-emerald-500' : 'bg-red-500')}
              aria-hidden
            />
            <span className={cn('text-lg font-bold sm:text-xl', open ? 'text-emerald-800' : 'text-red-800')}>
              {open ? copy.open : copy.closed}
            </span>
          </p>
          <p className={cn('mt-0.5 text-xs sm:text-sm', open ? 'text-emerald-700/90' : 'text-red-700/90')}>
            {open ? copy.openSub : copy.closedSub}
          </p>
        </div>
      </div>

      {/* Two clocks: our timezone + the client's timezone */}
      <div className="flex flex-none items-stretch gap-3">
        <div className="flex-1 rounded-xl bg-white/80 px-4 py-2 text-center shadow-sm sm:flex-none">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{copy.our}</p>
          <p className="text-base font-bold tabular-nums text-zinc-900">{ourTime}</p>
          <p className="text-[10px] text-zinc-400">{copy.et}</p>
        </div>
        <div className="flex-1 rounded-xl bg-white/80 px-4 py-2 text-center shadow-sm sm:flex-none">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{copy.your}</p>
          <p className="text-base font-bold tabular-nums text-zinc-900">{yourTime}</p>
          <p className="text-[10px] text-zinc-400">{yourTz || ' '}</p>
        </div>
      </div>
    </div>
  )
}
