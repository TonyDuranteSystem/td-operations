'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ContactState } from '@/lib/marketing/contact-state'
import type { BoardRole } from '@/lib/marketing/board'
import { formatWhen } from '@/lib/marketing/lead-view'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { localeFor } from '@/lib/marketing/i18n'
import { clockText, localToIso, zoneName } from '@/lib/marketing/zones'
import { TimesLine } from '@/components/marketing/times-line'
import type { ZoneInfo } from '@/lib/marketing/time-prefs'
import type { SlotOffer } from '@/lib/marketing/slots-server'

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'

/**
 * Passing a lead to the seller (dev job 9aec66fa, Addendum G.2). The SETTER chooses, per lead, between two buttons: "Book Rocco's call" (a day and an hour, an optional note) and
 * "Pass to Rocco" (no date; a note about why and what the lead said — Rocco then fixes the call himself). The SELLER sees what was passed to him and can fix or move the call.
 * With the calendar switch on (Addendum K, B5) a call is booked from the seller's FREE SLOTS, shown in the lead's own time; the slot list carries start times only. If the seller's calendar cannot be
 * trusted no slot is offered and a plain message says so, and a time can still be typed. Every answer from the server is shown as the server wrote it.
 */
export function HandoverPanel({ leadId, role, canAct, contact, zone, offer = null }: { leadId: string; role: BoardRole; canAct: boolean; contact: ContactState; zone: ZoneInfo; /** the seller's free slots (null: the calendar switch is off, or there is no seller) */ offer?: SlotOffer | null }) {
  const router = useRouter()
  const t = useT()
  const loc = localeFor(useLang())
  const fw = (iso: string) => formatWhen(iso, zone.viewer, loc)
  const [mode, setMode] = useState<'book' | 'pass' | null>(null)
  const [when, setWhen] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [typed, setTyped] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [dayKey, setDayKey] = useState<string | null>(null)
  const seller = role === 'seller'
  const sellerName = zone.seller?.label ?? (offer ? offer.sellerLabel : '')

  const offered = useMemo(() => new Set(offer?.state === 'ok' ? offer.days.flatMap(d => d.slots.map(s => new Date(s).toISOString())) : []), [offer])
  const typedIso = localToIso(when, zone.viewer)
  const typedOffOffer = offer?.state === 'ok' && typedIso !== null && !offered.has(typedIso)

  async function send(body: Record<string, unknown>) {
    setBusy(true); setError(null); setWarn(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.'))
      // the call is saved; if the seller's calendar could not be updated, say so
      if (d.calendar?.state === 'failed') setWarn(t("The call is saved, but {name}'s calendar was not updated. Tell Antonio.", { name: sellerName || t('the seller') }))
      setMode(null); setWhen(''); setNote(''); setPicked(null); setTyped(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally { setBusy(false) }
  }

  const dayLabel = (key: string) => new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`)).replace(',', '')
  const days = offer?.state === 'ok' ? offer.days : []
  const activeDay = days.find(d => d.key === dayKey) ?? days[0] ?? null
  const showSlots = offer?.state === 'ok' && !typed
  const showTyped = !offer || offer.state === 'hidden' || typed

  return (
    <section className="rounded-xl border bg-white p-4 text-sm" data-testid="handover-panel">
      <h2 className="text-sm font-semibold text-slate-600">{seller ? t('The call') : t('Lead in target? Pass it to Rocco')}</h2>
      {contact.appointmentAt
        ? <><p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sky-900" data-testid="call-booked">{t('Call booked for {when}', { when: fw(contact.appointmentAt) })} <span className="text-xs text-sky-800">({zoneName(zone.viewer)})</span></p><div className="mt-2"><TimesLine at={contact.appointmentAt} info={zone} /></div></>
        : contact.handedOverAt
          ? <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sky-900" data-testid="passed-no-date">{seller ? t('Passed to you, no call booked yet.') : t('Passed to Rocco, no call booked yet.')}</p>
          : <p className="mt-2 text-slate-500">{seller ? t('No call booked yet.') : t('Not passed to Rocco yet.')}</p>}
      {contact.handoverNote && <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-slate-800" data-testid="handover-note"><span className="text-xs text-slate-500">{t('Note from the setter')}</span><br />{contact.handoverNote}</p>}
      {warn && <p role="status" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900" data-testid="calendar-warning">{warn}</p>}

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
            <div className="mt-3 space-y-3" data-testid="book-form">
              {offer?.state === 'hidden' && (
                <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-rose-800" data-testid="slots-hidden">
                  <b>{t('Free times are hidden.')}</b>{' '}
                  {offer.reason === 'error' ? t('Google could not be read just now. Try again in a minute.')
                    : role === 'setter' ? t("{name}'s calendar is not shared the right way. Tell Antonio.", { name: offer.sellerLabel })
                    : t("{name}'s personal calendar is shared wider than free/busy only, or not at all. Fix the share, then press Check again on the Team page.", { name: offer.sellerLabel })}{' '}
                  {t('You can still type a time below.')}
                </p>
              )}
              {showSlots && (zone.client === null
                ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900" data-testid="slots-need-zone">{t("Pick {name}'s time zone first. The free times are shown in the lead's own time.", { name: zone.clientName })}</p>
                : (
                  <div data-testid="slot-picker">
                    {days.length === 0
                      ? <p className="text-slate-500">{t('No free slot in the next days. Type a time yourself.')}</p>
                      : <>
                          <p className="text-slate-500">{t("Day ({name}'s day)", { name: offer.sellerLabel })}</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {days.map(d => <button key={d.key} type="button" aria-pressed={activeDay?.key === d.key} onClick={() => { setDayKey(d.key); setPicked(null) }} data-testid="slot-day" className={`rounded-full border px-3 py-1 ${activeDay?.key === d.key ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{dayLabel(d.key)}</button>)}
                          </div>
                          <p className="mt-3 text-slate-500">{t("Free slots (shown in {name}'s time: {zone})", { name: zone.clientName, zone: zoneName(zone.client) })}</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {(activeDay?.slots ?? []).map(s => <button key={s} type="button" aria-pressed={picked === s} onClick={() => setPicked(s)} data-testid="slot" className={`rounded-lg border px-3 py-1.5 font-mono ${picked === s ? 'border-sky-600 bg-sky-50 text-sky-900' : 'border-emerald-300 bg-emerald-50 text-emerald-900'}`}>{clockText(s, zone.client as string)}</button>)}
                          </div>
                        </>}
                    {picked && (
                      <div className="mt-3 space-y-2">
                        <TimesLine at={picked} info={zone} />
                        <label className="block"><span className="text-slate-500">{t('Note for Rocco (optional)')}</span>
                          <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={t('For example: he wants to know the costs')} /></label>
                        <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy} data-testid="book-confirm-slot" onClick={() => void send({ action: 'appointment', at: picked, ...(note.trim() ? { note: note.trim() } : {}) })}>{t('Save the call')}</button>
                      </div>
                    )}
                  </div>
                ))}
              {showTyped && (
                <div className="space-y-2" data-testid="typed-form">
                  <label className="block"><span className="text-slate-500">{t('Day and time of the call (your time: {zone})', { zone: zoneName(zone.viewer) })}</span>
                    <input type="datetime-local" className="mt-1 w-full rounded-lg border px-3 py-2" value={when} onChange={e => setWhen(e.target.value)} data-testid="appointment-when" /></label>
                  <TimesLine at={typedIso} info={zone} />
                  {typedOffOffer && <p className="text-xs text-amber-800" data-testid="typed-off-offer">{t("This time is not one of {name}'s free times. You can still book it, and he decides.", { name: sellerName || t('the seller') })}</p>}
                  <label className="block"><span className="text-slate-500">{t('Note for Rocco (optional)')}</span>
                    <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={t('For example: he wants to know the costs')} /></label>
                  <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || !when} data-testid="book-confirm"
                    onClick={() => { const at = localToIso(when, zone.viewer); if (!at) { setError(t('Pick a valid day and time.')); return } void send({ action: 'appointment', at, ...(note.trim() ? { note: note.trim() } : {}) }) }}>{t('Save the call')}</button>
                </div>
              )}
              {offer?.state === 'ok' && <button type="button" className="text-sm underline" onClick={() => { setTyped(!typed); setPicked(null) }} data-testid="slots-toggle-typed">{typed ? t('Show the free times') : t('Type a time yourself instead')}</button>}
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
