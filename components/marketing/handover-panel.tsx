'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ContactState } from '@/lib/marketing/contact-state'
import type { BoardRole } from '@/lib/marketing/board'
import { formatWhen } from '@/lib/marketing/lead-view'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { localeFor } from '@/lib/marketing/i18n'
import { localToIso, zoneName } from '@/lib/marketing/zones'
import { TimesLine } from '@/components/marketing/times-line'
import type { ZoneInfo } from '@/lib/marketing/time-prefs'

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'

/**
 * Passing a lead to the seller (dev job 9aec66fa, Addendum G.2). The SETTER chooses, per lead, between two buttons: "Book Rocco's call" (a day and an hour, an optional note) and
 * "Pass to Rocco" (no date; a note about why and what the lead said — Rocco then fixes the call himself). The SELLER sees what was passed to him and can fix or move the call.
 * Every answer from the server is shown as the server wrote it.
 */
export function HandoverPanel({ leadId, role, canAct, contact, zone }: { leadId: string; role: BoardRole; canAct: boolean; contact: ContactState; zone: ZoneInfo }) {
  const router = useRouter()
  const t = useT()
  const loc = localeFor(useLang())
  const fw = (iso: string) => formatWhen(iso, zone.viewer, loc)
  const [mode, setMode] = useState<'book' | 'pass' | null>(null)
  const [when, setWhen] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seller = role === 'seller'

  async function send(body: Record<string, unknown>) {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.')) }
      setMode(null); setWhen(''); setNote('')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally { setBusy(false) }
  }

  return (
    <section className="rounded-xl border bg-white p-4 text-sm" data-testid="handover-panel">
      <h2 className="text-sm font-semibold text-slate-600">{seller ? t('The call') : t('Lead in target? Pass it to Rocco')}</h2>
      {contact.appointmentAt
        ? <><p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sky-900" data-testid="call-booked">{t('Call booked for {when}', { when: fw(contact.appointmentAt) })} <span className="text-xs text-sky-800">({zoneName(zone.viewer)})</span></p><div className="mt-2"><TimesLine at={contact.appointmentAt} info={zone} /></div></>
        : contact.handedOverAt
          ? <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sky-900" data-testid="passed-no-date">{seller ? t('Passed to you, no call booked yet.') : t('Passed to Rocco, no call booked yet.')}</p>
          : <p className="mt-2 text-slate-500">{seller ? t('No call booked yet.') : t('Not passed to Rocco yet.')}</p>}
      {contact.handoverNote && <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-slate-800" data-testid="handover-note"><span className="text-xs text-slate-500">{t('Note from the setter')}</span><br />{contact.handoverNote}</p>}

      {canAct && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={`${btn} ${mode === 'book' ? 'bg-slate-900 text-white' : ''}`} aria-pressed={mode === 'book'} data-testid="handover-book" onClick={() => setMode(mode === 'book' ? null : 'book')}>
              {seller ? (contact.appointmentAt ? t('Move the call') : t('Fix the call')) : (contact.appointmentAt ? t("Move Rocco's call") : t("Book Rocco's call"))}
            </button>
            {!seller && !contact.appointmentAt && <button type="button" className={`${btn} ${mode === 'pass' ? 'bg-slate-900 text-white' : ''}`} aria-pressed={mode === 'pass'} data-testid="handover-pass" onClick={() => setMode(mode === 'pass' ? null : 'pass')}>{contact.handedOverAt ? t('Pass it again with a new note') : t('Pass to Rocco')}</button>}
            {contact.appointmentAt && <button type="button" className={btn} disabled={busy} onClick={() => send({ action: 'appointment', at: null })}>{t('Cancel the call')}</button>}
          </div>

          {mode === 'book' && (
            <div className="mt-3 space-y-2" data-testid="book-form">
              <label className="block"><span className="text-slate-500">{t('Day and time of the call (your time: {zone})', { zone: zoneName(zone.viewer) })}</span>
                <input type="datetime-local" className="mt-1 w-full rounded-lg border px-3 py-2" value={when} onChange={e => setWhen(e.target.value)} data-testid="appointment-when" /></label>
              <TimesLine at={localToIso(when, zone.viewer)} info={zone} />
              <label className="block"><span className="text-slate-500">{t('Note for Rocco (optional)')}</span>
                <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={t('For example: he wants to know the costs')} /></label>
              <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || !when} data-testid="book-confirm"
                onClick={() => { const at = localToIso(when, zone.viewer); if (!at) { setError(t('Pick a valid day and time.')); return } void send({ action: 'appointment', at, ...(note.trim() ? { note: note.trim() } : {}) }) }}>{t('Save the call')}</button>
            </div>
          )}
          {mode === 'pass' && (
            <div className="mt-3 space-y-2" data-testid="pass-form">
              <label className="block"><span className="text-slate-500">{t('Why you pass it, and what the lead said')}</span>
                <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={t('For example: in target, wants to start within a month, asks about Wyoming')} data-testid="pass-note" /></label>
              <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy} data-testid="pass-confirm"
                onClick={() => send({ action: 'handover', ...(note.trim() ? { note: note.trim() } : {}) })}>{t('Pass to Rocco')}</button>
              <p className="text-xs text-slate-500">{t('The lead appears under "Interested lead" on his board.')}</p>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </section>
  )
}
