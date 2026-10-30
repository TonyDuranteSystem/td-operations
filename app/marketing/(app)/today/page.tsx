import Link from 'next/link'
import { LeadLink } from '@/components/marketing/lead-link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listTeamLeadsCapped } from '@/lib/marketing/leads-read'
import { listMembers } from '@/lib/marketing/members'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { ageText, romeStartOfMonth, type StageOpt } from '@/lib/marketing/master-view'
import { loadTeamEvents } from '@/lib/marketing/events-read'
import { loadLatestNotes } from '@/lib/marketing/note-read'
import { isSetterOnly } from '@/lib/marketing/lead-chat'
import { setterActorsOf } from '@/lib/marketing/setter-view'
import { clientFlagText, formatWhen, stageLabel } from '@/lib/marketing/lead-view'
import { canSeeNotes, withoutPhone } from '@/lib/marketing/lead-privacy'
import { personName, type LatestNote } from '@/lib/marketing/setter-note'
import { paidStagesFrom, todayModel, type OutcomeStages } from '@/lib/marketing/workspace'
import { PickButton } from './pick-button'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'
import { loadViewerZone } from '@/lib/marketing/time-prefs-server'

export const dynamic = 'force-dynamic'


/** TD Marketing — Today (dev job 9aec66fa): the owner's home. What is waiting for him right now: call backs, the Good leads nobody has picked yet, his own open leads, and what each person did today. */
export default async function MarketingToday() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.pick')) redirect('/marketing/leads')
  const lang = getLang()
  const t = makeT(lang)
  const zone = await loadViewerZone(g.ctx)
  const fw = (iso: string | null | undefined) => formatWhen(iso, zone, localeFor(lang))
  const age = (ms: number) => ageText(ms, lang === 'it' ? 'g' : 'd')
  const who = (l: { full_name: string | null; email: string | null; phone: string | null }) => l.full_name || l.email || l.phone || t('Unnamed lead')
  const db = leadDb()
  const teamId = g.ctx.team.id
  const now = new Date()
  const [leadsRes, stages, outcomeStages, members, ev, saleStages, reasons] = await Promise.all([
    listTeamLeadsCapped(db, teamId, 2000),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOpt[]>,
    getMarketingSetting('setter_outcome_stages', teamId) as Promise<OutcomeStages>,
    listMembers(teamId),
    loadTeamEvents(db, teamId, { since: romeStartOfMonth(now) }),
    getMarketingSetting('sale_kind_stages', teamId) as Promise<Record<string, string>>,
    getMarketingSetting('not_in_target_reasons', teamId) as Promise<StageOpt[]>,
  ])
  const leads = withoutPhone(leadsRes.rows, g.ctx.permissions)
  const events = ev.events
  const m = todayModel({
    leads, events, stages, outcomeStages, me: g.ctx.user.id, now, paidStages: paidStagesFrom(saleStages),
    members: members.map(x => ({ email: x.email, role: x.member_role as 'owner' | 'member', bundle: x.bundle, status: x.status, lastSignInAt: x.last_sign_in_at })),
  })
  const seesTeam = hasPermission(g.ctx.permissions, 'team.activity')
  const seesNotes = canSeeNotes(g.ctx.permissions)
  const seesTeamNotes = hasPermission(g.ctx.permissions, 'team.notes')
  // the setter's newest written note, shown on each Good lead's row so Rocco knows why before he opens it
  const notes = seesNotes ? await loadLatestNotes(db, m.goodWaiting.map(l => l.id), isSetterOnly(g.ctx.permissions) ? await setterActorsOf(teamId) : undefined) : new Map<string, LatestNote>()
  const card = 'rounded-xl border bg-white p-5'
  const reasonLabel = (k: string | null) => (k ? reasons.find(r => r.key === k)?.label ?? k : null)
  const late = m.callBacks.filter(c => c.late).length
  const parts = [
    t(m.goodWaiting.length === 1 ? '{n} Good lead waiting for you' : '{n} Good leads waiting for you', { n: m.goodWaiting.length }),
    t(m.callBacks.length === 1 ? '{n} call back today' : '{n} call backs today', { n: m.callBacks.length }) + (late ? t(' ({n} late)', { n: late }) : ''),
    t(m.waitingOver24h.length === 1 ? '{n} new lead untouched for over a day' : '{n} new leads untouched for over a day', { n: m.waitingOver24h.length }),
    ...(seesTeam ? [t('{n} rejected today', { n: m.rejectedToday.length })] : []),
  ]
  return (
    <div className="space-y-6 p-6">
      <div><h1 className="text-2xl font-semibold">{t('Today')}</h1><p data-testid="today-summary" className="mt-1 text-sm text-slate-700">{parts.join(' · ')}</p>{seesTeam && <p className="mt-1 text-sm"><Link href="/marketing/activity" className="underline">{t('What the team did today →')}</Link></p>}</div>
      {(ev.truncated || leadsRes.truncated) && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Some older leads or activity are not counted below because there is too much of it to read at once. Tell Antonio.')}</p>}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className={card} aria-label={t('Call backs due')}>
          <h2 className="text-sm font-semibold text-slate-600">{t('Call backs due today ({n})', { n: m.callBacks.length })}</h2>
          {m.callBacks.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('No call backs due today.')}</p> : (
            <ul className="mt-3 divide-y">
              {m.callBacks.map(({ lead, late }) => (
                <li key={lead.id} className="flex items-center justify-between gap-3 py-2">
                  <LeadLink leadId={lead.id} name={who(lead)} className="min-w-0"><span className="block truncate font-medium">{who(lead)}</span><span className="block text-xs text-slate-500">{lead.phone ?? t('No phone')}</span></LeadLink>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${late ? 'bg-red-50 text-red-700' : 'bg-sky-50 text-sky-800'}`}>{late ? t('{age} late', { age: age(now.getTime() - new Date(lead.callback_at as string).getTime()) }) : fw(lead.callback_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={card} aria-label={t('Good leads waiting')}>
          <h2 className="text-sm font-semibold text-slate-600">{t('Good leads waiting for a pick ({n})', { n: m.goodWaiting.length })}</h2>
          {m.goodWaiting.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('No Good lead is waiting. When a setter marks one Good, it appears here.')}</p> : (
            <ul className="mt-3 divide-y">
              {m.goodWaiting.map(l => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-3">
                  <LeadLink leadId={l.id} name={who(l)} className="min-w-0"><span className="block truncate font-medium">{who(l)}</span><span className="block text-xs text-slate-500">{t('{phone} · waiting {age}', { phone: l.phone ?? t('No phone'), age: age(now.getTime() - new Date(l.meta_created_time ?? l.received_at).getTime()) })}</span>{clientFlagText(l.existing_client, t) && <span className="block text-xs text-amber-800">{t('Existing TD client? Check first.')}</span>}{notes.get(l.id) && <span className="mt-1 line-clamp-2 block break-words text-xs text-slate-700" data-testid="good-note"><b>{notes.get(l.id)?.by}:</b> {notes.get(l.id)?.text}</span>}</LeadLink>
                  <PickButton leadId={l.id} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={card} aria-label={t('My leads')}>
        <h2 className="text-sm font-semibold text-slate-600">{t('Your leads ({n})', { n: m.mine.length })}</h2>
        {m.mine.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('You have not picked a lead yet. Pick one from the Good leads above.')}</p> : (
          <ul className="mt-3 divide-y">
            {m.mine.map(l => (
              <li key={l.id}><LeadLink leadId={l.id} name={who(l)} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0"><span className="block truncate font-medium">{who(l)}</span><span className="block text-xs text-slate-500">{l.phone ?? t('No phone')}</span></span><span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t(stageLabel(stages, l.status))}</span></LeadLink></li>
            ))}
          </ul>
        )}
      </section>

      <section className={card} aria-label={t('New leads waiting over a day')}>
        <h2 className="text-sm font-semibold text-slate-600">{t('New leads nobody has touched for over a day ({n})', { n: m.waitingOver24h.length })}</h2>
        {m.waitingOver24h.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('Every new lead has been looked at within a day.')}</p> : (
          <ul className="mt-3 divide-y" data-testid="waiting-over-24h">
            {m.waitingOver24h.slice(0, 25).map(l => (
              <li key={l.id}><LeadLink leadId={l.id} name={who(l)} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0"><span className="block truncate font-medium">{who(l)}</span><span className="block text-xs text-slate-500">{l.phone ?? t('No phone')}</span></span><span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">{t('waiting {age}', { age: age(now.getTime() - new Date(l.meta_created_time ?? l.received_at).getTime()) })}</span></LeadLink></li>
            ))}
            {m.waitingOver24h.length > 25 && <li className="py-2 text-xs text-slate-500">{t('…and {n} more, in Leads.', { n: m.waitingOver24h.length - 25 })}</li>}
          </ul>
        )}
      </section>

      {seesTeam && <section className={card} aria-label={t('Rejected today')}>
        <h2 className="text-sm font-semibold text-slate-600">{t('Rejected today, for you to look over ({n})', { n: m.rejectedToday.length })}</h2>
        {m.rejectedToday.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('Nobody has marked a lead Not in target today.')}</p> : (
          <ul className="mt-3 divide-y" data-testid="rejected-today">
            {m.rejectedToday.map(r => (
              <li key={r.lead.id}><LeadLink leadId={r.lead.id} name={who(r.lead)} className="block py-2"><span className="block truncate font-medium">{who(r.lead)}</span><span className="block text-xs text-slate-500">{personName(r.by)} · {reasonLabel(r.reason) ? t(reasonLabel(r.reason) as string) : t('no reason given')} · {fw(r.at)}</span>{r.note && seesTeamNotes && <span className="mt-1 line-clamp-2 block break-words text-xs text-slate-700">{r.note}</span>}</LeadLink></li>
            ))}
          </ul>
        )}
      </section>}
    </div>
  )
}
