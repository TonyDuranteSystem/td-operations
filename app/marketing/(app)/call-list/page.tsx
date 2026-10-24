import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listTeamLeads } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { ageText } from '@/lib/marketing/master-view'
import { formatWhen, type StageOption } from '@/lib/marketing/lead-view'
import { callQueue } from '@/lib/marketing/workspace'
import { withoutPhone } from '@/lib/marketing/lead-privacy'
import { LeadLink } from '@/components/marketing/lead-link'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the setter's Call list (dev job 9aec66fa): the call backs due today, then the new leads nobody has worked, oldest first. A click opens the lead in a floating
 * window on top of the list (everything they wrote on the form and the buttons); after Good, Not in target or Call back later the lead leaves the list behind the window.
 */
export default async function MarketingCallList() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const lang = getLang()
  const t = makeT(lang)
  const fw = (iso: string | null | undefined) => formatWhen(iso, 'Europe/Rome', localeFor(lang))
  const age = (ms: number) => ageText(ms, lang === 'it' ? 'g' : 'd')
  if (!hasPermission(g.ctx.permissions, 'leads.read') || !hasPermission(g.ctx.permissions, 'leads.worklist')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the leads. Ask your team owner.')}</p></main>
  }
  const db = leadDb()
  const teamId = g.ctx.team.id
  const [allRaw, stages] = await Promise.all([
    listTeamLeads(db, teamId, 1000),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOption[]>,
  ])
  const all = withoutPhone(allRaw, g.ctx.permissions)
  const now = new Date()
  const queue = callQueue(all, stages[0]?.key ?? 'new', g.ctx.user.id, now)
  const waitText = (l: (typeof queue)[number]) => {
    if (l.callback_at) { const late = now.getTime() - new Date(l.callback_at).getTime(); return late > 0 ? { t: t('Call back {age} late', { age: age(late) }), c: 'text-red-700' } : { t: t('Call back {when}', { when: fw(l.callback_at) }), c: 'text-sky-700' } }
    return { t: t('Waiting {age}', { age: age(now.getTime() - new Date(l.meta_created_time ?? l.received_at).getTime()) }), c: 'text-slate-500' }
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-baseline justify-between"><h1 className="text-2xl font-semibold">{t('Call list')}</h1><span className="text-sm text-slate-500">{t('{n} to call', { n: queue.length })}</span></div>
      <section className="min-w-0 rounded-xl border bg-white" aria-label={t('Leads to call')}>
        {queue.length === 0 ? <p className="p-5 text-sm text-slate-600">{t('Nobody to call right now. New leads from the ads appear here by themselves.')}</p> : (
          <ul className="divide-y">
            {queue.map(l => { const w = waitText(l); return (
              <li key={l.id}>
                <LeadLink leadId={l.id} name={l.full_name || l.email || l.phone || t('Unnamed lead')} className="block px-4 py-3 hover:bg-slate-50" testId="queue-lead">
                  <p className="truncate font-medium">{l.full_name || l.email || l.phone || t('Unnamed lead')}</p>
                  <p className="truncate text-xs text-slate-500">{l.phone ?? (hasPermission(g.ctx.permissions, 'leads.call') ? t('No phone') : t('Phone hidden'))}</p>
                  <p className={`mt-0.5 text-xs ${w.c}`}>{w.t}</p>
                </LeadLink>
              </li>
            ) })}
          </ul>
        )}
      </section>
    </div>
  )
}
