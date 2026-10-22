import Link from 'next/link'
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
import { clientFlagText, formatWhen, stageLabel } from '@/lib/marketing/lead-view'
import { canSeeNotes, withoutPhone } from '@/lib/marketing/lead-privacy'
import { personName, type LatestNote } from '@/lib/marketing/setter-note'
import { paidStagesFrom, todayModel, type OutcomeStages } from '@/lib/marketing/workspace'
import { PickButton } from './pick-button'

export const dynamic = 'force-dynamic'

const who = (l: { full_name: string | null; email: string | null; phone: string | null }) => l.full_name || l.email || l.phone || 'Unnamed lead'

/** TD Marketing — Today (dev job 9aec66fa): the owner's home. What is waiting for him right now: call backs, the Good leads nobody has picked yet, his own open leads, and what each person did today. */
export default async function MarketingToday() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.pick')) redirect('/marketing/leads')
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
  const notes = seesNotes ? await loadLatestNotes(db, m.goodWaiting.map(l => l.id)) : new Map<string, LatestNote>()
  const card = 'rounded-xl border bg-white p-5'
  const reasonLabel = (k: string | null) => (k ? reasons.find(r => r.key === k)?.label ?? k : null)
  const late = m.callBacks.filter(c => c.late).length
  const parts = [
    `${m.goodWaiting.length} Good ${m.goodWaiting.length === 1 ? 'lead' : 'leads'} waiting for you`,
    `${m.callBacks.length} call ${m.callBacks.length === 1 ? 'back' : 'backs'} today${late ? ` (${late} late)` : ''}`,
    `${m.waitingOver24h.length} new ${m.waitingOver24h.length === 1 ? 'lead' : 'leads'} untouched for over a day`,
    ...(seesTeam ? [`${m.rejectedToday.length} rejected today`] : []),
  ]
  return (
    <div className="space-y-6 p-6">
      <div><h1 className="text-2xl font-semibold">Today</h1><p data-testid="today-summary" className="mt-1 text-sm text-slate-700">{parts.join(' · ')}</p>{seesTeam && <p className="mt-1 text-sm"><Link href="/marketing/activity" className="underline">What the team did today →</Link></p>}</div>
      {(ev.truncated || leadsRes.truncated) && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">Some older leads or activity are not counted below because there is too much of it to read at once. Tell Antonio.</p>}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className={card} aria-label="Call backs due">
          <h2 className="text-sm font-semibold text-slate-600">Call backs due today ({m.callBacks.length})</h2>
          {m.callBacks.length === 0 ? <p className="mt-3 text-sm text-slate-500">No call backs due today.</p> : (
            <ul className="mt-3 divide-y">
              {m.callBacks.map(({ lead, late }) => (
                <li key={lead.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/marketing/leads?lead=${lead.id}`} className="min-w-0"><span className="block truncate font-medium">{who(lead)}</span><span className="block text-xs text-slate-500">{lead.phone ?? 'No phone'}</span></Link>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${late ? 'bg-red-50 text-red-700' : 'bg-sky-50 text-sky-800'}`}>{late ? `${ageText(now.getTime() - new Date(lead.callback_at as string).getTime())} late` : formatWhen(lead.callback_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={card} aria-label="Good leads waiting">
          <h2 className="text-sm font-semibold text-slate-600">Good leads waiting for a pick ({m.goodWaiting.length})</h2>
          {m.goodWaiting.length === 0 ? <p className="mt-3 text-sm text-slate-500">No Good lead is waiting. When a setter marks one Good, it appears here.</p> : (
            <ul className="mt-3 divide-y">
              {m.goodWaiting.map(l => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-3">
                  <Link href={`/marketing/leads?lead=${l.id}`} className="min-w-0"><span className="block truncate font-medium">{who(l)}</span><span className="block text-xs text-slate-500">{l.phone ?? 'No phone'} · waiting {ageText(now.getTime() - new Date(l.meta_created_time ?? l.received_at).getTime())}</span>{clientFlagText(l.existing_client) && <span className="block text-xs text-amber-800">Existing TD client? Check first.</span>}{notes.get(l.id) && <span className="mt-1 line-clamp-2 block break-words text-xs text-slate-700" data-testid="good-note"><b>{notes.get(l.id)?.by}:</b> {notes.get(l.id)?.text}</span>}</Link>
                  <PickButton leadId={l.id} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={card} aria-label="My leads">
        <h2 className="text-sm font-semibold text-slate-600">Your leads ({m.mine.length})</h2>
        {m.mine.length === 0 ? <p className="mt-3 text-sm text-slate-500">You have not picked a lead yet. Pick one from the Good leads above.</p> : (
          <ul className="mt-3 divide-y">
            {m.mine.map(l => (
              <li key={l.id}><Link href={`/marketing/leads?lead=${l.id}`} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0"><span className="block truncate font-medium">{who(l)}</span><span className="block text-xs text-slate-500">{l.phone ?? 'No phone'}</span></span><span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{stageLabel(stages, l.status)}</span></Link></li>
            ))}
          </ul>
        )}
      </section>

      <section className={card} aria-label="New leads waiting over a day">
        <h2 className="text-sm font-semibold text-slate-600">New leads nobody has touched for over a day ({m.waitingOver24h.length})</h2>
        {m.waitingOver24h.length === 0 ? <p className="mt-3 text-sm text-slate-500">Every new lead has been looked at within a day.</p> : (
          <ul className="mt-3 divide-y" data-testid="waiting-over-24h">
            {m.waitingOver24h.slice(0, 25).map(l => (
              <li key={l.id}><Link href={`/marketing/leads?lead=${l.id}`} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0"><span className="block truncate font-medium">{who(l)}</span><span className="block text-xs text-slate-500">{l.phone ?? 'No phone'}</span></span><span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">waiting {ageText(now.getTime() - new Date(l.meta_created_time ?? l.received_at).getTime())}</span></Link></li>
            ))}
            {m.waitingOver24h.length > 25 && <li className="py-2 text-xs text-slate-500">…and {m.waitingOver24h.length - 25} more, in Leads.</li>}
          </ul>
        )}
      </section>

      {seesTeam && <section className={card} aria-label="Rejected today">
        <h2 className="text-sm font-semibold text-slate-600">Rejected today, for you to look over ({m.rejectedToday.length})</h2>
        {m.rejectedToday.length === 0 ? <p className="mt-3 text-sm text-slate-500">Nobody has marked a lead Not in target today.</p> : (
          <ul className="mt-3 divide-y" data-testid="rejected-today">
            {m.rejectedToday.map(r => (
              <li key={r.lead.id}><Link href={`/marketing/leads?lead=${r.lead.id}`} className="block py-2"><span className="block truncate font-medium">{who(r.lead)}</span><span className="block text-xs text-slate-500">{personName(r.by)} · {reasonLabel(r.reason) ?? 'no reason given'} · {formatWhen(r.at)}</span>{r.note && seesTeamNotes && <span className="mt-1 line-clamp-2 block break-words text-xs text-slate-700">{r.note}</span>}</Link></li>
            ))}
          </ul>
        )}
      </section>}
    </div>
  )
}
