'use client'

import { useT } from '@/components/marketing/lang-provider'
import { timesAt, type ZoneInfo } from '@/lib/marketing/time-prefs'
import { zoneName } from '@/lib/marketing/zones'

/**
 * Under every box where somebody types a day and time: what that time is for the others (TD Marketing, dev job 9aec66fa, Addendum K, B2). "Their times: Marco 17:00 Rome · Rocco 16:00 Canary Islands ·
 * Antonio 11:00 New York". A setter's information has no owner in it, so the line never carries his time.
 */
export function TimesLine({ at, info }: { at: string | null; info: ZoneInfo }) {
  const t = useT()
  if (!at) return null
  const rows = timesAt(at, info)
  if (rows.length === 0) return null
  return (
    <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700" data-testid="times-line">
      {t('Their times:')} {rows.map((r, i) => <span key={r.key}>{i > 0 && ' · '}{r.label} <b className="font-mono">{r.time}</b> {zoneName(r.zone)}</span>)}
    </p>
  )
}
