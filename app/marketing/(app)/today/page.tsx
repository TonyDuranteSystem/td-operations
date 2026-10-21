import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listTeamLeads } from '@/lib/marketing/leads-read'
import { listMembers } from '@/lib/marketing/members'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { ageText, romeStartOfDay, type MasterEvent, type StageOpt } from '@/lib/marketing/master-view'
import { clientFlagText, formatWhen, stageLabel } from '@/lib/marketing/lead-view'
import { todayModel, type OutcomeStages } from '@/lib/marketing/workspace'
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
  const [leads, stages, outcomeStages, members, ev] = await Promise.all([
    listTeamLeads(db, teamId, 2000),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOpt[]>,
    getMarketingSetting('setter_outcome_stages', teamId) as Promise<OutcomeStages>,
    listMembers(teamId),
    db.from('marketing_lead_events').select('lead_id, kind, actor, data, created_at').gte('created_at', romeStartOfDay(now).toISOString()).limit(5000),
  ])
  const ids = new Set(leads.map(l => l.id))
  const events = ((ev.data ?? []) as MasterEvent[]).filter(e => ids.has(e.lead_id))
  const m = todayModel({
    leads, events, stages, outcomeStages, me: g.ctx.user.id, now,
    members: members.map(x => ({ email: x.email, role: x.member_role as 'owner' | 'member', bundle: x.bundle, status: x.status, lastSignInAt: x.last_sign_in_at })),
  })
  const card = 'rounded-xl border bg-white p-5'
  return (
    <div className="space-y-6 p-6">
      <div><h1 className="text-2xl font-semibold">Today</h1><p className="text-sm text-slate-500">What is waiting for you right now.</p></div>

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
                  <Link href={`/marketing/leads?lead=${l.id}`} className="min-w-0"><span className="block truncate font-medium">{who(l)}</span><span className="block text-xs text-slate-500">{l.phone ?? 'No phone'} · waiting {ageText(now.getTime() - new Date(l.meta_created_time ?? l.received_at).getTime())}</span>{clientFlagText(l.existing_client) && <span className="block text-xs text-amber-800">Existing TD client? Check first.</span>}</Link>
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

      <section className={card} aria-label="What the team did today">
        <h2 className="text-sm font-semibold text-slate-600">What the team did today</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-slate-500"><tr><th className="py-2 pr-3">Person</th><th className="pr-3">Role</th><th className="pr-3 text-right">Good</th><th className="pr-3 text-right">Not in target</th><th className="pr-3 text-right">Call backs set</th><th className="pr-3 text-right">Leads picked</th><th>Last active</th></tr></thead>
            <tbody className="divide-y">
              {m.people.length === 0 && <tr><td colSpan={7} className="py-3 text-slate-500">Nobody else has joined yet.</td></tr>}
              {m.people.map(p => (
                <tr key={p.email}><td className="py-2 pr-3 font-medium">{p.email}</td><td className="pr-3 capitalize">{p.role}</td><td className="pr-3 text-right font-mono tabular-nums">{p.good}</td><td className="pr-3 text-right font-mono tabular-nums">{p.notInTarget}</td><td className="pr-3 text-right font-mono tabular-nums">{p.callBacks}</td><td className="pr-3 text-right font-mono tabular-nums">{p.picked}</td><td className="text-slate-500">{p.lastActive ? `${ageText(Date.now() - new Date(p.lastActive).getTime())} ago` : 'never'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
