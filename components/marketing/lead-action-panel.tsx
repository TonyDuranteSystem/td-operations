'use client'

import { localToIso, zoneName, ROME } from '@/lib/marketing/zones'
import { TimesLine } from '@/components/marketing/times-line'
import type { ZoneInfo } from '@/lib/marketing/time-prefs'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { callIsAhead, formatCallTime, resolveStanding, type StandingOverride } from '@/lib/marketing/call-warning'

interface Option { key: string; label: string }
type Mode = null | 'good' | 'not_in_target' | 'call_back' | 'not_ready' | 'closed' | 'not_closed' | 'upsell' | 'waiting' | 'archive' | 'note'

interface Props {
  leadId: string
  canMark: boolean
  /** 'free' nobody picked it · 'me' I picked it · 'other' someone else did */
  claim: 'free' | 'me' | 'other'
  isOwner: boolean
  checklist: string[]
  reasons: Option[]
  /** after Good / Not in target / Call back: go here (the next lead in the call list) instead of staying on this lead */
  afterHref?: string
  /** the seller (Rocco) presses Not in target, Not ready now (with a day) and, once the lead has paid, Upsell / Waiting; Archive closes it. The setter keeps Good / Not in target / Call back later. (No "Pick this lead" and no "Contacted" any more: booking the free call makes the lead his.) */
  role?: 'setter' | 'seller'
  /** the lead has paid or is past paying (booking link sent, upsell, waiting, archived) */
  afterPay?: boolean
  /** the lead is archived */
  archived?: boolean
  /** whose clocks a typed time is shown in (the viewer's own zone, the lead's, the seller's, never the owner's for a setter) */
  zone?: ZoneInfo
  /** the call that stands on this lead now (its time), or null: pressing a result that puts the lead aside while it is still ahead shows the warning below, nothing is cancelled for the person */
  callAt?: string | null
}

/** The buttons a setter or the owner uses on one lead. Every server answer (including the refusals) is shown as the server wrote it. */
export function LeadActionPanel({ leadId, canMark, claim, isOwner, checklist, reasons, afterHref, role = 'setter', afterPay = false, archived = false, zone = { viewer: ROME, client: null, clientName: '', seller: null, owner: null }, callAt = null }: Props) {
  const router = useRouter()
  const t = useT()
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [when, setWhen] = useState('')
  const [note, setNote] = useState('')
  // the call that stands (from the page, or from the server's refusal when the page was out of date); the warning shows while it is still ahead
  const [override, setOverride] = useState<StandingOverride | null>(null)
  const standing = resolveStanding(callAt, override) // an override counts only for the page it was made on: when the page shows another call, the page wins
  const [info, setInfo] = useState<string | null>(null)
  const inFlight = useRef(false) // a double click must not send the cancel twice
  const lang = useLang()

  const blocked = claim === 'other' && !isOwner
  const markOk = canMark && !blocked

  async function send(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        if (d.code === 'CALL_STANDS' && typeof d.callAt === 'string') setOverride({ forPage: callAt, callAt: d.callAt })
        throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.'))
      }
      setMode(null); setNote(''); setTicked([]); setReason(''); setWhen(''); setInfo(null)
      if (afterHref !== undefined && ['good', 'not_in_target', 'call_back', 'not_ready', 'closed', 'not_closed'].includes(String(body.action))) router.push(afterHref)
      else router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  /** Rocco's own choice: take the call off (the same cancel as on the call box: his Google calendar, the booking link and the client follow). The result form stays filled; he presses Save afterwards. */
  async function cancelCall() {
    if (!standing || inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(null); setInfo(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'appointment', at: null, replaces: standing }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.'))
      setOverride({ forPage: callAt, callAt: null })
      setInfo(d.calendar?.state === 'failed' ? t("The call is cancelled, but the seller's calendar was not updated. Tell Antonio.") : t('The call is cancelled. Now press Save.'))
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const callAhead = callIsAhead(standing, Date.now())
  const endsCall = mode === 'not_in_target' || mode === 'not_ready' || mode === 'archive' || mode === 'not_closed'
  const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
  const showInfo = mode !== null ? info : null // the "call cancelled" note belongs to the open result form
  return (
    <section className="mt-5 rounded-xl border bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-600">{t('What to do with this lead')}</h2>
      {claim === 'other' && !isOwner && <p className="mt-2 text-sm text-amber-800">{t('This lead is with someone else, so only they (or the team owner) can change it.')}</p>}

      <div className="mt-3 flex flex-wrap gap-2" data-testid="lead-result">
        {markOk && role === 'setter' && <button className={`${btn} ${mode === 'good' ? 'border-emerald-600 bg-emerald-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'good' ? null : 'good')}>{t('Good')}</button>}
        {markOk && <button className={`${btn} ${mode === 'not_in_target' ? 'border-rose-600 bg-rose-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'not_in_target' ? null : 'not_in_target')}>{t('Not in target')}</button>}
        {markOk && role === 'setter' && <button className={`${btn} ${mode === 'call_back' ? 'border-sky-600 bg-sky-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'call_back' ? null : 'call_back')}>{t('Call back later')}</button>}
        {markOk && role === 'seller' && !afterPay && <button className={`${btn} ${mode === 'not_ready' ? 'border-sky-600 bg-sky-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'not_ready' ? null : 'not_ready')} data-testid="result-not-ready">{t('Not ready now')}</button>}
        {markOk && role === 'seller' && afterPay && !archived && <button className={`${btn} ${mode === 'upsell' ? 'border-violet-600 bg-violet-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'upsell' ? null : 'upsell')} data-testid="result-upsell">{t('Upsell')}</button>}
        {markOk && role === 'seller' && afterPay && !archived && <button className={`${btn} ${mode === 'waiting' ? 'border-amber-600 bg-amber-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'waiting' ? null : 'waiting')} data-testid="result-waiting">{t('Waiting')}</button>}
        {markOk && role === 'seller' && !archived && <button className={`${btn} ${mode === 'archive' ? 'border-slate-600 bg-slate-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'archive' ? null : 'archive')} data-testid="result-archive">{t('Archive')}</button>}
        {markOk && <button className={`${btn} ${mode === 'note' ? 'border-slate-600 bg-slate-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'note' ? null : 'note')}>{t('Add a note')}</button>}
      </div>

      {mode && markOk && (
        <div className="mt-4 space-y-3 text-sm">
          {mode === 'good' && (
            checklist.length === 0
              ? <p className="text-slate-500">{t('No checklist has been set up yet. Add a note and save.')}</p>
              : <fieldset className="space-y-2">
                  <legend className="text-slate-500">{t('Tick what you confirmed on the call')}</legend>
                  {checklist.map(item => (
                    <label key={item} className="flex items-center gap-2">
                      <input type="checkbox" checked={ticked.includes(item)} onChange={e => setTicked(e.target.checked ? [...ticked, item] : ticked.filter(t => t !== item))} />
                      <span>{t(item)}</span>
                    </label>
                  ))}
                </fieldset>
          )}
          {mode === 'not_in_target' && (
            <label className="block">
              <span className="text-slate-500">{t('Why not?')}</span>
              <select className="mt-1 w-full rounded-lg border px-3 py-2" value={reason} onChange={e => setReason(e.target.value)}>
                <option value="">{t('Pick a reason…')}</option>
                {reasons.map(r => <option key={r.key} value={r.key}>{t(r.label)}</option>)}
              </select>
            </label>
          )}
          {(mode === 'call_back' || mode === 'not_ready') && (
            <label className="block">
              <span className="text-slate-500">{mode === 'not_ready' ? t('Day and time to come back (your time: {zone})', { zone: zoneName(zone.viewer) }) : t('Day and time to call back (your time: {zone})', { zone: zoneName(zone.viewer) })}</span>
              <input type="datetime-local" className="mt-1 w-full rounded-lg border px-3 py-2" value={when} onChange={e => setWhen(e.target.value)} />
              <span className="mt-2 block"><TimesLine at={localToIso(when, zone.viewer)} info={zone} /></span>
            </label>
          )}
          {endsCall && callAhead && (
            <div role="alert" data-testid="call-stands-warning" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
              <p>{t('This lead has a call booked for {when} ({zone}). Cancel the call first, or keep it and choose something else.', { when: formatCallTime(standing as string, zone.viewer, lang), zone: zoneName(zone.viewer) })}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={`${btn} bg-white`} disabled={busy} data-testid="call-stands-cancel" onClick={() => void cancelCall()}>{t('Cancel the call')}</button>
                <button type="button" className={`${btn} bg-white`} disabled={busy} data-testid="call-stands-keep" onClick={() => setMode(null)}>{t('Keep the call')}</button>
              </div>
            </div>
          )}
          <label className="block">
            <span className="text-slate-500">{mode === 'note' ? t('Note') : t('Note (optional)')}</span>
            <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} />
          </label>
          <button
            className={`${btn} bg-slate-900 text-white`}
            disabled={busy || (endsCall && callAhead) || (mode === 'not_in_target' && !reason) || ((mode === 'call_back' || mode === 'not_ready') && !when) || (mode === 'note' && !note.trim())}
            onClick={() => {
              const n = note.trim() || undefined
              if (mode === 'good') return send({ action: 'good', ticked, note: n })
              if (mode === 'not_in_target') return send({ action: 'not_in_target', reason, note: n })
              if (mode === 'closed' || mode === 'not_closed' || mode === 'upsell' || mode === 'waiting' || mode === 'archive') return send({ action: mode, note: n })
              if (mode === 'not_ready') return send({ action: 'not_ready', callbackAt: localToIso(when, zone.viewer) ?? '', note: n })
              if (mode === 'call_back') return send({ action: 'call_back', callbackAt: localToIso(when, zone.viewer) ?? '', note: n })
              return send({ action: 'note', note: n })
            }}
          >
            {busy ? t('Saving…') : t('Save')}
          </button>
        </div>
      )}
      {showInfo && <p role="status" data-testid="call-stands-info" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{showInfo}</p>}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </section>
  )
}
