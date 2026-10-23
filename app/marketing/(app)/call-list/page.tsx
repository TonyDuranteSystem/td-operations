import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { getTeamLead, leadTimeline, listTeamLeads } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { ageText } from '@/lib/marketing/master-view'
import { formatWhen, type StageOption } from '@/lib/marketing/lead-view'
import { callQueue, nextInQueue } from '@/lib/marketing/workspace'
import { withoutPhone } from '@/lib/marketing/lead-privacy'
import { LeadPane } from '../_lead-pane'
import { personName } from '@/lib/marketing/setter-note'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the setter's Call list (dev job 9aec66fa): the call backs due today, then the new leads nobody has worked, oldest first. Click a lead (or the
 * first one opens by itself): everything they wrote on the form and the buttons. After Good, Not in target or Call back later, the next lead opens.
 */
export default async function MarketingCallList({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const lang = getLang()
  const t = makeT(lang)
  const fw = (iso: string | null | undefined) => formatWhen(iso, 'Europe/Rome', localeFor(lang))
  const age = (ms: number) => ageText(ms, lang === 'it' ? 'g' : 'd')
  if (!hasPermission(g.ctx.permissions, 'leads.read') || !hasPermission(g.ctx.permissions, 'leads.worklist')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the leads. Ask your team owner.')}</p></main>
  }
  const sp = await searchParams
  const db = leadDb()
  const teamId = g.ctx.team.id
  const [allRaw, stages, reasons, checklist] = await Promise.all([
    listTeamLeads(db, teamId, 1000),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOption[]>,
    getMarketingSetting('not_in_target_reasons', teamId) as Promise<StageOption[]>,
    getMarketingSetting('qualification_checklist', teamId) as Promise<string[]>,
  ])
  const all = withoutPhone(allRaw, g.ctx.permissions)
  const now = new Date()
  const queue = callQueue(all, stages[0]?.key ?? 'new', g.ctx.user.id, now)
  const selectedId = sp.lead && /^[0-9a-f-]{36}$/i.test(sp.lead) ? sp.lead : queue[0]?.id
  const selected = selectedId ? await getTeamLead(db, teamId, selectedId) : null
  const events = selected ? await leadTimeline(db, selected.id) : []
  const next = selected ? nextInQueue(queue, selected.id) : null
  const afterHref = next ? `/marketing/call-list?lead=${next.id}` : '/marketing/call-list'
  const waitText = (l: (typeof queue)[number]) => {
    if (l.callback_at) { const late = now.getTime() - new Date(l.callback_at).getTime(); return late > 0 ? { t: t('Call back {age} late', { age: age(late) }), c: 'text-red-700' } : { t: t('Call back {when}', { when: fw(l.callback_at) }), c: 'text-sky-700' } }
    return { t: t('Waiting {age}', { age: age(now.getTime() - new Date(l.meta_created_time ?? l.received_at).getTime()) }), c: 'text-slate-500' }
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-baseline justify-between"><h1 className="text-2xl font-semibold">{t('Call list')}</h1><span className="text-sm text-slate-500">{t('{n} to call', { n: queue.length })}</span></div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-xl border bg-white" aria-label={t('Leads to call')}>
          {queue.length === 0 ? <p className="p-5 text-sm text-slate-600">{t('Nobody to call right now. New leads from the ads appear here by themselves.')}</p> : (
            <ul className="divide-y">
              {queue.map(l => { const w = waitText(l); return (
                <li key={l.id}>
                  <Link href={`/marketing/call-list?lead=${l.id}`} className={`block px-4 py-3 ${l.id === selected?.id ? 'bg-teal-50' : 'hover:bg-slate-50'}`}>
                    <p className="truncate font-medium">{l.full_name || l.email || l.phone || t('Unnamed lead')}</p>
                    <p className="truncate text-xs text-slate-500">{l.phone ?? (hasPermission(g.ctx.permissions, 'leads.call') ? t('No phone') : t('Phone hidden'))}</p>
                    <p className={`mt-0.5 text-xs ${w.c}`}>{w.t}</p>
                  </Link>
                </li>
              ) })}
            </ul>
          )}
        </section>
        <aside className="min-w-0" aria-label={t('Lead to call')}>
          {selected ? (
            <LeadPane lead={selected} events={events} stages={stages} reasons={reasons} checklist={checklist} permissions={g.ctx.permissions} isOwner={g.ctx.role === 'owner'} myId={g.ctx.user.id} myName={personName(g.ctx.user.email ?? '')} afterHref={afterHref} />
          ) : <div className="rounded-xl border border-dashed p-8 text-sm text-slate-500">{queue.length === 0 ? t('The list is empty. Good work.') : t('Pick a lead on the left.')}</div>}
        </aside>
      </div>
    </div>
  )
}
