'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import { resolveCallHours, type TimePrefs } from '@/lib/marketing/time-prefs'
import { zoneName } from '@/lib/marketing/zones'
import { useZoneOptions } from '@/components/marketing/use-zone-options'
import type { CalendlyLink, CallHoursInput } from '@/lib/marketing/settings-schema'

export interface TimeMemberView { userId: string; email: string | null; role: 'owner' | 'member'; status: string; isAdmin: boolean; /** a setter and nothing more: she books the seller's calls and takes none, so she gets no call hours, no calendar and no owner time */ setterOnly: boolean; /** the login is a company mailbox, so its Google calendars can be read */ workMailbox: boolean }
export interface ShareView { userId: string; id: string; state: 'free_busy' | 'wide' | 'missing' | 'error' }

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
const sel = 'rounded-lg border px-2 py-1.5'
const SLOTS = [15, 20, 30, 45, 60, 90]
const GAPS = [0, 5, 10, 15, 20, 30, 45, 60]
const NOTICES = [0, 15, 30, 60, 120, 240, 1440]
const AHEADS = [7, 14, 21, 30, 45, 60]
const WEEK: Array<[number, string]> = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'link'

/**
 * The Team page's "Time zones and calendars" section (TD Marketing, dev job 9aec66fa, Addendum K, B1/B4/B5). Antonio sets each person's zone, who takes calls and their working hours, the Calendly links, the
 * personal calendars whose Busy time counts, and the two switches. Every change is one setting saved on its own (the settings screen's rules: validated, kept in the history). The share of a personal
 * calendar is checked against Google when the page opens; "Check again" reads it again. Every server answer, including a refusal, is shown as the server wrote it.
 */
export function TeamTimes({ teamId, adminEmail, adminLabel, members, prefs: initial, share }: { teamId: string; adminEmail: string | null; adminLabel: string; members: TimeMemberView[]; prefs: TimePrefs; share: ShareView[] }) {
  const router = useRouter()
  const t = useT()
  const [prefs, setPrefs] = useState<TimePrefs>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [newLink, setNewLink] = useState<Record<string, { name: string; url: string }>>({})
  const [newCal, setNewCal] = useState<Record<string, string>>({})
  const options = useZoneOptions()

  async function put(key: string, value: unknown, apply: (p: TimePrefs, v: never) => TimePrefs): Promise<boolean> {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch('/api/marketing-admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId, key, value }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.'))
      setPrefs(p => apply(p, d.value as never))
      setDone(t('Saved.'))
      return true
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
      return false
    } finally { setBusy(false) }
  }

  const zoneSelect = (value: string, onChange: (z: string) => void, label: string) => (
    <select className={sel} value={value} disabled={busy} onChange={e => onChange(e.target.value)} aria-label={label} data-testid="time-zone-select">
      {options.map(o => <option key={o.zone} value={o.zone}>{o.label}</option>)}
    </select>
  )
  const row = (label: string, children: React.ReactNode) => (
    <div className="mt-3 grid grid-cols-[9rem_minmax(0,1fr)] items-center gap-3 border-t pt-3"><span className="text-slate-500">{label}</span><div className="flex flex-wrap items-center gap-2">{children}</div></div>
  )
  const setHours = (id: string, patch: Partial<CallHoursInput>) => put('member_call_hours', { ...prefs.callHours, [id]: { ...(prefs.callHours[id] ?? {}), ...patch } }, (p, v) => ({ ...p, callHours: v as TimePrefs['callHours'] }))
  const shareLabel = (st: ShareView['state']) => st === 'free_busy' ? t('Free/busy only ✓') : st === 'wide' ? t('Shared wider than free/busy only') : st === 'missing' ? t('Not shared with this mailbox') : t('Could not check')
  const shareTone = (st: ShareView['state']) => st === 'free_busy' ? 'bg-emerald-100 text-emerald-900' : st === 'error' ? 'bg-amber-100 text-amber-900' : 'bg-rose-100 text-rose-800'

  return (
    <section className="rounded-xl border bg-white p-4 text-sm" data-testid="team-times">
      <h2 className="text-sm font-semibold text-slate-600">{t('Time zones and calendars')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('Every time on the Marketing screens is read in the zone of the person looking. The setter never sees the owner\'s time.')}</p>
      <p className="mt-1 text-xs text-slate-500">{t("A person's zone follows where they connect: their browser reports it each time they open Marketing, so a change made here lasts until they connect from somewhere else.")}</p>
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-rose-800">{error}</p>}
      {done && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">{done}</p>}

      <div className="mt-3 rounded-lg border p-3" data-testid="owner-times">
        <p className="font-medium">{adminLabel} <span className="text-xs text-slate-400">{t('(you)')}</span></p>
        {row(t('Time zone'), <>{zoneSelect(prefs.ownerClock.zone, z => put('owner_clock', { zone: z, label: adminLabel, ...(adminEmail ? { email: adminEmail } : {}) }, (p, v) => ({ ...p, ownerClock: v as TimePrefs['ownerClock'] })), t('Time zone'))}<span className="text-xs text-slate-500">{t('Shown to Rocco and to you, never to the setter.')}</span></>)}
        {row(t('Google calendar'), adminEmail ? <span className="text-xs text-slate-500">{adminEmail} · {t('view, add, move · no delete')}</span> : <span className="text-xs text-slate-500">{t('No email on this login.')}</span>)}
      </div>

      <ul className="mt-3 space-y-3">
        {members.filter(m => !m.isAdmin && m.status !== 'removed').map(m => {
          const takes = Object.prototype.hasOwnProperty.call(prefs.callHours, m.userId)
          const h = resolveCallHours(prefs.callHours[m.userId])
          const links: CalendlyLink[] = prefs.links[m.userId] ?? []
          const cals = prefs.personalCalendars[m.userId] ?? []
          const nl = newLink[m.userId] ?? { name: '', url: '' }
          const zone = prefs.memberZones[m.userId] ?? 'Europe/Rome'
          return (
            <li key={m.userId} className="rounded-lg border p-3" data-testid="member-times">
              <p className="truncate font-medium">{m.email ?? t('Unknown login')} <span className="text-xs font-normal text-slate-500">{m.role === 'owner' ? t('Team owner') : ''}</span></p>
              {row(t('Time zone'), zoneSelect(zone, z => put('member_time_zones', { ...prefs.memberZones, [m.userId]: z }, (p, v) => ({ ...p, memberZones: v as TimePrefs['memberZones'] })), t('Time zone')))}
              {m.setterOnly ? row(t('Takes calls'), <span className="text-xs text-slate-500" data-testid="setter-no-calls">{t('No: the setter books the seller\'s calls and takes none herself.')}</span>) : row(t('Takes calls'), <label className="flex items-center gap-2"><input type="checkbox" checked={takes} disabled={busy} data-testid="takes-calls" onChange={e => {
                const next = { ...prefs.callHours }
                if (e.target.checked) next[m.userId] = {}; else delete next[m.userId]
                void put('member_call_hours', next, (p, v) => ({ ...p, callHours: v as TimePrefs['callHours'] }))
              }} /><span>{takes ? t('Yes: the setter books this person\'s calls') : t('No')}</span></label>)}
              {takes && !m.setterOnly && <>
                {row(t('Working hours'), <>
                  <select className={sel} value={h.start} disabled={busy} aria-label={t('Starts')} onChange={e => void setHours(m.userId, { start: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, i) => i).map(v => <option key={v} value={v}>{String(v).padStart(2, '0')}:00</option>)}</select>
                  <span className="text-slate-500">{t('to')}</span>
                  <select className={sel} value={h.end} disabled={busy} aria-label={t('Ends')} onChange={e => void setHours(m.userId, { end: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, i) => i + 1).map(v => <option key={v} value={v}>{String(v === 24 ? 0 : v).padStart(2, '0')}:00</option>)}</select>
                  <span className="text-xs text-slate-500">{t('in his own time zone')}</span>
                </>)}
                {row(t('Days'), WEEK.map(([d, name]) => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={h.days.includes(d)} disabled={busy} onChange={e => { const days = e.target.checked ? [...h.days, d] : h.days.filter(x => x !== d); if (days.length) void setHours(m.userId, { days }) }} />{t(name)}</label>))}
                {row(t('Slots'), <>
                  <select className={sel} value={h.slot} disabled={busy} aria-label={t('Slot length')} onChange={e => void setHours(m.userId, { slot: Number(e.target.value) })}>{SLOTS.map(v => <option key={v} value={v}>{v} min</option>)}</select>
                  <span className="text-slate-500">{t('long, with a')}</span>
                  <select className={sel} value={h.gap} disabled={busy} aria-label={t('Gap')} onChange={e => void setHours(m.userId, { gap: Number(e.target.value) })}>{GAPS.map(v => <option key={v} value={v}>{v} min</option>)}</select>
                  <span className="text-slate-500">{t('gap')}</span>
                </>)}
                {row(t('Notice and look-ahead'), <>
                  <select className={sel} value={h.notice} disabled={busy} aria-label={t('Notice')} onChange={e => void setHours(m.userId, { notice: Number(e.target.value) })}>{NOTICES.map(v => <option key={v} value={v}>{v === 0 ? t('no notice') : v >= 60 ? `${v / 60} h` : `${v} min`}</option>)}</select>
                  <span className="text-slate-500">{t('and slots up to')}</span>
                  <select className={sel} value={h.ahead} disabled={busy} aria-label={t('Look-ahead')} onChange={e => void setHours(m.userId, { ahead: Number(e.target.value) })}>{AHEADS.map(v => <option key={v} value={v}>{v} {t('days')}</option>)}</select>
                </>)}
                {row(t('Google calendars'), m.workMailbox
                  ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">{t('Work calendar ✓')} · {m.email}</span>
                  : <span className="text-xs text-amber-800">{t("This login is not a company mailbox, so no Google calendar can be read for this person.")}</span>)}
                <div className="mt-3 border-t pt-3" data-testid="personal-calendars">
                  <p className="text-slate-500">{t('Personal calendars (their Busy time counts; shared with the work mailbox as "free/busy only")')}</p>
                  {cals.length === 0 && <p className="mt-1 text-xs text-slate-500">{t('None added.')}</p>}
                  <ul className="mt-2 space-y-1.5">
                    {cals.map(c => {
                      const st = share.find(x => x.userId === m.userId && x.id.toLowerCase() === c.toLowerCase())?.state ?? 'error'
                      return (
                        <li key={c} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" data-testid="personal-calendar">
                          <span className="min-w-0 truncate">{c}</span>
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-xs ${shareTone(st)}`} data-testid="share-state" data-state={st}>{shareLabel(st)}</span>
                            {st !== 'free_busy' && <span className="text-xs text-rose-800">{t('Slots and Busy time stay hidden until this is fixed.')}</span>}
                            <button type="button" className={btn} disabled={busy} onClick={() => router.refresh()} data-testid="share-check-again">{t('Check again')}</button>
                            <button type="button" className={btn} disabled={busy} onClick={() => void put('member_personal_calendars', { ...prefs.personalCalendars, [m.userId]: cals.filter(x => x !== c) }, (p, v) => ({ ...p, personalCalendars: v as TimePrefs['personalCalendars'] }))}>{t('Remove')}</button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input className="min-w-0 flex-1 rounded-lg border px-3 py-2" placeholder={t('Personal address (for example name@gmail.com)')} value={newCal[m.userId] ?? ''} onChange={e => setNewCal({ ...newCal, [m.userId]: e.target.value })} data-testid="personal-calendar-input" />
                    <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || !(newCal[m.userId] ?? '').trim()} data-testid="personal-calendar-add" onClick={async () => {
                      const v = (newCal[m.userId] ?? '').trim().toLowerCase()
                      if (await put('member_personal_calendars', { ...prefs.personalCalendars, [m.userId]: Array.from(new Set([...cals, v])) }, (p, val) => ({ ...p, personalCalendars: val as TimePrefs['personalCalendars'] }))) { setNewCal({ ...newCal, [m.userId]: '' }); router.refresh() }
                    }}>{t('Add')}</button>
                  </div>
                </div>
                <div className="mt-3 border-t pt-3" data-testid="calendly-links">
                  <p className="text-slate-500">{t('Calendly links (any number)')}</p>
                  <ul className="mt-2 space-y-1.5">
                    {links.map(l => (
                      <li key={l.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                        <span className="min-w-0 truncate"><b>{l.name}</b> <span className="text-xs text-slate-500">{l.url}</span></span>
                        <button type="button" className={`${btn} shrink-0`} disabled={busy} data-testid="link-remove" onClick={() => void put('member_calendly_links', { ...prefs.links, [m.userId]: links.filter(x => x.id !== l.id) }, (p, v) => ({ ...p, links: v as TimePrefs['links'] }))}>{t('Remove')}</button>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input className="w-40 rounded-lg border px-3 py-2" placeholder={t('Name')} value={nl.name} onChange={e => setNewLink({ ...newLink, [m.userId]: { ...nl, name: e.target.value } })} data-testid="link-name" />
                    <input className="min-w-0 flex-1 rounded-lg border px-3 py-2" placeholder="https://calendly.com/…" value={nl.url} onChange={e => setNewLink({ ...newLink, [m.userId]: { ...nl, url: e.target.value } })} data-testid="link-url" />
                    <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy} data-testid="link-add" onClick={async () => {
                      const name = nl.name.trim(), url = nl.url.trim()
                      if (!name) { setError(t('Give the link a name.')); return }
                      if (!/^https:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(url)) { setError(t('Use a link that starts with https://')); return }
                      const link: CalendlyLink = { id: `${slug(name)}-${Math.random().toString(36).slice(2, 6)}`, name, url }
                      if (await put('member_calendly_links', { ...prefs.links, [m.userId]: [...links, link] }, (p, v) => ({ ...p, links: v as TimePrefs['links'] }))) setNewLink({ ...newLink, [m.userId]: { name: '', url: '' } })
                    }}>{t('Add link')}</button>
                  </div>
                </div>
              </>}
              {!takes && <p className="mt-2 text-xs text-slate-400">{zoneName(zone)}</p>}
            </li>
          )
        })}
      </ul>

      <div className="mt-4 space-y-2 rounded-lg border p-3" data-testid="calendar-switches">
        <p className="font-medium">{t('Switches')} <span className="text-xs font-normal text-slate-500">{t('(switch these on only after the go-live check)')}</span></p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={prefs.busyEnabled} disabled={busy} data-testid="switch-busy" onChange={e => void put('calendar_busy_enabled', e.target.checked, (p, v) => ({ ...p, busyEnabled: v as boolean }))} />
          <span><b>{t('Busy time and free slots')}</b><br /><span className="text-xs text-slate-500">{t("Show the seller's Busy time on the Calendar and offer the setter only his free slots.")}</span></span></label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={prefs.writeThroughEnabled} disabled={busy} data-testid="switch-write" onChange={e => void put('calendar_write_through_enabled', e.target.checked, (p, v) => ({ ...p, writeThroughEnabled: v as boolean }))} />
          <span><b>{t("Write booked calls into the seller's calendar")}</b><br /><span className="text-xs text-slate-500">{t('So Calendly cannot offer the same hour to someone else.')}</span></span></label>
      </div>
    </section>
  )
}
