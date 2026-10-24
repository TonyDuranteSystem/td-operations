import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { effectivePermissions, hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listTeamLeadsCapped } from '@/lib/marketing/leads-read'
import { listMembers } from '@/lib/marketing/members'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { ageText, romeStartOfMonth, type StageOpt } from '@/lib/marketing/master-view'
import { loadTeamEvents } from '@/lib/marketing/events-read'
import { accessLabel, type Bundles } from '@/lib/marketing/access'
import { personName } from '@/lib/marketing/setter-note'
import { paidStagesFrom, todayModel, type OutcomeStages } from '@/lib/marketing/workspace'
import { getLang } from '@/lib/marketing/lang'
import { makeT, tAccessLabel } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Team activity (dev job 9aec66fa, access popup): what each person on the team did today. Needs "See what the team did today". A name opens the Leads list narrowed to
 * what that person worked on. The team comes from the guard; nothing here can reach another team's rows.
 */
export default async function MarketingActivity() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const lang = getLang()
  const t = makeT(lang)
  const tLabel = (s: string) => tAccessLabel(t, s)
  if (!hasPermission(g.ctx.permissions, 'team.activity')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to Team activity. Ask your team owner.')}</p></main>
  }
  const db = leadDb()
  const teamId = g.ctx.team.id
  const now = new Date()
  const [leadsRes, stages, outcomeStages, members, ev, saleStages, bundles] = await Promise.all([
    listTeamLeadsCapped(db, teamId, 2000),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOpt[]>,
    getMarketingSetting('setter_outcome_stages', teamId) as Promise<OutcomeStages>,
    listMembers(teamId),
    loadTeamEvents(db, teamId, { since: romeStartOfMonth(now) }),
    getMarketingSetting('sale_kind_stages', teamId) as Promise<Record<string, string>>,
    getMarketingSetting('permission_bundles', teamId) as Promise<Bundles>,
  ])
  const m = todayModel({
    leads: leadsRes.rows, events: ev.events, stages, outcomeStages, me: g.ctx.user.id, now, paidStages: paidStagesFrom(saleStages),
    members: members.map(x => ({
      email: x.email, role: x.member_role as 'owner' | 'member', status: x.status, lastSignInAt: x.last_sign_in_at,
      bundle: accessLabel(effectivePermissions({ memberRole: x.member_role as 'owner' | 'member', bundle: x.bundle, bundles, extra: x.permissions }), bundles),
    })),
  })
  return (
    <div className="space-y-6 p-6">
      <div><h1 className="text-2xl font-semibold">{t('Team activity')}</h1><p className="mt-1 text-sm text-slate-500">{t('What each person did today. A name opens the leads that person worked on.')}</p></div>
      {(ev.truncated || leadsRes.truncated) && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Some older leads or activity are not counted below because there is too much of it to read at once. Tell Antonio.')}</p>}
      <section className="rounded-xl border bg-white p-5" aria-label={t('What the team did today')}>
        <h2 className="text-sm font-semibold text-slate-600">{t('What the team did today')}</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-slate-500"><tr><th className="py-2 pr-3">{t('Person')}</th><th className="pr-3">{t('Role')}</th><th className="pr-3 text-right">{t('Good')}</th><th className="pr-3 text-right">{t('Not in target')}</th><th className="pr-3 text-right">{t('Call backs set')}</th><th className="pr-3 text-right">{t('Leads picked')}</th><th>{t('Last active')}</th></tr></thead>
            <tbody className="divide-y">
              {m.people.length === 0 && <tr><td colSpan={7} className="py-3 text-slate-500">{t('Nobody else has joined yet.')}</td></tr>}
              {m.people.map(p => (
                <tr key={p.email}>
                  <td className="py-2 pr-3 font-medium"><Link href={`/marketing/leads?by=${encodeURIComponent(p.email)}`} className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500" title={t('See the leads this person worked on')}>{personName(p.email)}</Link></td>
                  <td className="pr-3">{tLabel(p.role)}</td><td className="pr-3 text-right font-mono tabular-nums">{p.good}</td><td className="pr-3 text-right font-mono tabular-nums">{p.notInTarget}</td><td className="pr-3 text-right font-mono tabular-nums">{p.callBacks}</td><td className="pr-3 text-right font-mono tabular-nums">{p.picked}</td>
                  <td className="text-slate-500">{p.lastActive ? t('{age} ago', { age: ageText(Date.now() - new Date(p.lastActive).getTime(), lang === 'it' ? 'g' : 'd') }) : t('never')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
