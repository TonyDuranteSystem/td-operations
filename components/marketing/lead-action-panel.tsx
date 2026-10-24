'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'

interface Option { key: string; label: string }
type Mode = null | 'good' | 'not_in_target' | 'call_back' | 'note'

interface Props {
  leadId: string
  canPick: boolean
  canMark: boolean
  /** 'free' nobody picked it · 'me' I picked it · 'other' someone else did */
  claim: 'free' | 'me' | 'other'
  isOwner: boolean
  checklist: string[]
  reasons: Option[]
  /** after Good / Not in target / Call back: go here (the next lead in the call list) instead of staying on this lead */
  afterHref?: string
}

/** The buttons a setter or the owner uses on one lead. Every server answer (including the refusals) is shown as the server wrote it. */
export function LeadActionPanel({ leadId, canPick, canMark, claim, isOwner, checklist, reasons, afterHref }: Props) {
  const router = useRouter()
  const t = useT()
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [when, setWhen] = useState('')
  const [note, setNote] = useState('')

  const blocked = claim === 'other' && !isOwner
  const markOk = canMark && !blocked

  async function send(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.'))
      }
      setMode(null); setNote(''); setTicked([]); setReason(''); setWhen('')
      if (afterHref !== undefined && ['good', 'not_in_target', 'call_back'].includes(String(body.action))) router.push(afterHref)
      else router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
  return (
    <section className="mt-5 rounded-xl border bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-600">{t('What to do with this lead')}</h2>
      {claim === 'other' && !isOwner && <p className="mt-2 text-sm text-amber-800">{t('Someone else picked this lead, so only they (or the team owner) can change it.')}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {canPick && claim === 'free' && <button className={`${btn} bg-slate-900 text-white`} disabled={busy} onClick={() => send({ action: 'claim' })}>{t('Pick this lead')}</button>}
        {canPick && (claim === 'me' || (claim === 'other' && isOwner)) && <button className={btn} disabled={busy} onClick={() => send({ action: 'release' })}>{t('Give it back')}</button>}
        {markOk && <button className={`${btn} ${mode === 'good' ? 'border-emerald-600 bg-emerald-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'good' ? null : 'good')}>{t('Good')}</button>}
        {markOk && <button className={`${btn} ${mode === 'not_in_target' ? 'border-rose-600 bg-rose-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'not_in_target' ? null : 'not_in_target')}>{t('Not in target')}</button>}
        {markOk && <button className={`${btn} ${mode === 'call_back' ? 'border-sky-600 bg-sky-50' : ''}`} disabled={busy} onClick={() => setMode(mode === 'call_back' ? null : 'call_back')}>{t('Call back later')}</button>}
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
          {mode === 'call_back' && (
            <label className="block">
              <span className="text-slate-500">{t('Day and time to call back')}</span>
              <input type="datetime-local" className="mt-1 w-full rounded-lg border px-3 py-2" value={when} onChange={e => setWhen(e.target.value)} />
            </label>
          )}
          <label className="block">
            <span className="text-slate-500">{mode === 'note' ? t('Note') : t('Note (optional)')}</span>
            <textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} />
          </label>
          <button
            className={`${btn} bg-slate-900 text-white`}
            disabled={busy || (mode === 'not_in_target' && !reason) || (mode === 'call_back' && !when) || (mode === 'note' && !note.trim())}
            onClick={() => {
              const n = note.trim() || undefined
              if (mode === 'good') return send({ action: 'good', ticked, note: n })
              if (mode === 'not_in_target') return send({ action: 'not_in_target', reason, note: n })
              if (mode === 'call_back') return send({ action: 'call_back', callbackAt: new Date(when).toISOString(), note: n })
              return send({ action: 'note', note: n })
            }}
          >
            {busy ? t('Saving…') : t('Save')}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </section>
  )
}
