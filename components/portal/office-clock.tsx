'use client'

import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { getOfficeStatus, OFFICE_TZ } from '@/lib/portal/office-hours'

const COPY = {
  en: {
    tz: 'US Eastern',
    you: 'Your time',
    open: 'Live chat open',
    closed: 'Live chat closed',
    hours: 'Mon–Fri, 9 AM–3 PM ET',
    nextDay: "We'll reply on the next business day.",
  },
  it: {
    tz: 'Costa Est USA',
    you: 'La tua ora',
    open: 'Chat attiva',
    closed: 'Chat chiusa',
    hours: 'Lun–Ven, 9–15 (ET)',
    nextDay: 'Ti risponderemo il prossimo giorno lavorativo.',
  },
} as const

function timeFmt(locale: string, timeZone?: string) {
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: locale !== 'it',
    ...(timeZone ? { timeZone } : {}),
  })
}

export function OfficeClock() {
  const { locale } = useLocale()
  const [now, setNow] = useState<Date | null>(null)

  // Render only after mount — server has no single "now" the client agrees with,
  // so deferring avoids a hydration mismatch (same pattern as the portal banners).
  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!now) {
    // Reserve height so the layout doesn't jump when the clock mounts.
    return <div className="h-9" aria-hidden />
  }

  const copy = COPY[locale === 'it' ? 'it' : 'en']
  const status = getOfficeStatus(now)

  const officeTime = timeFmt(locale, OFFICE_TZ).format(now)
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
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-zinc-200 bg-white/70 px-3 py-1.5 text-xs text-zinc-600 shadow-sm backdrop-blur"
      role="status"
      aria-live="off"
    >
      <span className="flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
        <span
          className={
            'inline-flex items-center gap-1 font-medium ' +
            (status.open ? 'text-emerald-700' : 'text-red-600')
          }
        >
          <span
            className={
              'inline-block h-2 w-2 rounded-full ' +
              (status.open ? 'bg-emerald-500' : 'bg-red-500')
            }
            aria-hidden
          />
          {status.open ? copy.open : copy.closed}
        </span>
      </span>

      <span className="text-zinc-500">
        <span className="font-medium text-zinc-700">{copy.tz}:</span> {officeTime}
      </span>

      <span className="text-zinc-500">
        <span className="font-medium text-zinc-700">{copy.you}:</span> {yourTime}
        {yourTz ? ` (${yourTz})` : ''}
      </span>

      {!status.open && (
        <span className="text-zinc-400">· {copy.hours} · {copy.nextDay}</span>
      )}
    </div>
  )
}
