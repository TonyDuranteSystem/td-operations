'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { clockText, isoToLocal, localToIso, zoneName } from '@/lib/marketing/zones'
import type { GoogleBlock } from '@/lib/marketing/calendar-visibility'

/** Close on Escape, wherever the focus is. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
}

const shell = 'fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4'

/**
 * Antonio adds an event to his own Google calendar (TD Marketing, dev job 9aec66fa, Addendum K, B3). A title, a day and start in his own zone, and a length. Every answer from the server is
 * shown as the server wrote it.
 */
export function AddEventDialog({ zone, startValue, onClose, onDone }: { zone: string; startValue: string; onClose: () => void; onDone: (message: string) => void }) {
  const t = useT()
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState(startValue)
  const [minutes, setMinutes] = useState(30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEscape(onClose)

  async function save() {
    const start = localToIso(when, zone)
    if (!title.trim()) { setError(t('Give the event a title.')); return }
    if (!start) { setError(t('Pick a valid day and time.')); return }
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/marketing/owner-calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), startIso: start, endIso: new Date(Date.parse(start) + minutes * 60_000).toISOString() }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('Could not add the event. Please try again.'))
      onDone(t('Added to your Google calendar.'))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not add the event. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <div className={shell} role="dialog" aria-modal="true" aria-label={t('Add an event to your calendar')} data-testid="add-event-dialog">
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold">{t('Add an event to your calendar')}</h2>
        <label className="block text-xs text-slate-600">{t('Title')}
          <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} data-testid="add-title" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" /></label>
        <label className="block text-xs text-slate-600">{t('Day and start (your time: {zone})', { zone: zoneName(zone) })}
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} data-testid="add-when" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" /></label>
        <label className="block text-xs text-slate-600">{t('Length')}
          <select value={minutes} onChange={e => setMinutes(Number(e.target.value))} data-testid="add-length" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm">
            <option value={30}>{t('30 minutes')}</option><option value={60}>{t('1 hour')}</option><option value={90}>{t('1 hour 30')}</option>
          </select></label>
        {error && <p role="alert" className="text-sm text-red-700" data-testid="add-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">{t('Cancel')}</button>
          <button type="button" onClick={save} disabled={busy} data-testid="add-save" className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-40">{busy ? t('Saving…') : t('Add event')}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Antonio moves one of his own Google events (same length). An event with guests asks first, naming them: the server refuses the move until he has said yes. There is no delete anywhere.
 */
export function MoveEventDialog({ block, zone, onClose, onDone }: { block: GoogleBlock; zone: string; onClose: () => void; onDone: (message: string) => void }) {
  const t = useT()
  const [when, setWhen] = useState(isoToLocal(block.start, zone))
  const [asked, setAsked] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEscape(onClose)

  async function move(confirmGuests: boolean) {
    const start = localToIso(when, zone)
    if (!start) { setError(t('Pick a valid day and time.')); return }
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/marketing/owner-calendar/${encodeURIComponent(block.id.replace(/^o:/, ''))}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startIso: start, confirmGuests }) })
      const d = await res.json().catch(() => ({}))
      if (res.status === 409 && d.code === 'GUESTS') { setAsked(Array.isArray(d.guests) ? d.guests : []); setBusy(false); return }
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('Could not move the event. Please try again.'))
      onDone(asked ? t("Moved. It changed on the guests' calendars too.") : t('Moved.'))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not move the event. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <div className={shell} role="dialog" aria-modal="true" aria-label={t('Move this event')} data-testid="move-event-dialog">
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold">{t('Move this event')}</h2>
        <p className="rounded-lg bg-slate-100 p-2.5 text-sm"><b>{block.title}</b><br />{clockText(block.start, zone)}–{clockText(block.end, zone)} ({zoneName(zone)})</p>
        {asked && (
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="guest-warning">
            <b>{asked.length === 1 ? t('This event has a guest:') : t('This event has guests:')}</b> {asked.join(', ')}. {t('Moving it changes it on their calendar too. Move it anyway?')}
          </p>
        )}
        <label className="block text-xs text-slate-600">{t('New day and time (your time: {zone})', { zone: zoneName(zone) })}
          <input type="datetime-local" value={when} onChange={e => { setWhen(e.target.value); setAsked(null) }} data-testid="move-event-when" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" /></label>
        {error && <p role="alert" className="text-sm text-red-700" data-testid="move-event-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50" data-testid="move-event-keep">{t('Keep it')}</button>
          <button type="button" onClick={() => void move(asked !== null)} disabled={busy} data-testid="move-event-save" className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-40">{busy ? t('Saving…') : asked ? t('Yes, move it') : t('Move it')}</button>
        </div>
      </div>
    </div>
  )
}
