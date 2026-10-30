'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import { utcOffsetText, zoneName, zoneOptions } from '@/lib/marketing/zones'

interface Props {
  leadId: string
  name: string
  zone: string | null
  /** where the zone came from: a person set it, the phone number gave it, or nobody knows yet */
  source: 'set' | 'phone' | 'none'
  /** who set it, as a name */
  byName: string | null
  /** the phone's country code ("39"), when the number has one */
  callingCode: string | null
  /** for an unknown zone: the zones the number could be in, offered first */
  options: string[]
  canSet: boolean
  nowIso: string
}

/**
 * The lead's time zone, with its source and a way to change it (TD Marketing, dev job 9aec66fa, Addendum K, B1). A zone guessed from the phone number says so; one a person set says who. A number
 * whose country has several clocks (the US, Canada, Spain…) is never guessed: this box asks. The choice is a history entry on the lead (the "zone" action) and the newest one wins.
 */
export function LeadZoneRow({ leadId, name, zone, source, byName, callingCode, options, canSet, nowIso }: Props) {
  const router = useRouter()
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(value: string) {
    if (!value) { setEditing(false); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'zone', zone: value }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.')) }
      setEditing(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally { setBusy(false) }
  }

  const known = zone !== null
  const first = new Set(options)
  const rest = zoneOptions().filter(o => !first.has(o.zone))
  const picker = (
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-slate-500">{known ? t('Time zone:') : t('Choose:')}</span>
      <select className="rounded-lg border px-3 py-2" disabled={busy} defaultValue="" onChange={e => void save(e.target.value)} data-testid="zone-select" aria-label={t('Time zone')}>
        <option value="">{known ? t('Keep {zone}', { zone: zoneName(zone) }) : t('Pick a time zone…')}</option>
        {options.length > 0 && <optgroup label={t("This number's zones")}>{options.map(z => <option key={z} value={z}>{zoneName(z)}</option>)}</optgroup>}
        <optgroup label={t('All time zones')}>{rest.map(o => <option key={o.zone} value={o.zone}>{o.label}</option>)}</optgroup>
      </select>
    </label>
  )

  return (
    <div className={`mt-3 rounded-lg border p-3 text-sm ${known ? 'bg-slate-50' : 'border-amber-300 bg-amber-50'}`} data-testid="zone-row">
      {known && !editing ? (
        <p>
          <span className="text-slate-500">{t('Time zone:')} </span><b>{zoneName(zone)}</b> <span className="text-slate-500">({utcOffsetText(nowIso, zone)}) · {source === 'set' ? t('set by {name}', { name: byName ?? t('a team member') }) : t('from the phone number (+{code})', { code: callingCode ?? '' })}</span>
          {canSet && <button type="button" className="ml-2 underline" onClick={() => { setError(null); setEditing(true) }} data-testid="zone-change">{t('Change')}</button>}
        </p>
      ) : (
        <>
          {!known && <p className="mb-2 text-amber-900"><b>{t('The time zone is not known yet.')}</b> {callingCode ? t('The phone number starts with +{code}, which covers several zones, so the system does not guess.', { code: callingCode }) : t('There is no phone number with a country code, so the system cannot guess.')} {t('Which one is {name} in?', { name })}</p>}
          {canSet ? picker : <p className="text-slate-500">{t('Ask the person who picked this lead to set the time zone.')}</p>}
          {known && <button type="button" className="mt-2 underline" onClick={() => setEditing(false)}>{t('Cancel')}</button>}
        </>
      )}
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-rose-800">{error}</p>}
    </div>
  )
}
