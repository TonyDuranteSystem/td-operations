import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { getTeamLead, leadTimeline, listTeamLeads } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { clientFlagText, filterLeads, formatWhen, LEAD_SHOW_OPTIONS, parseLeadShow, stageLabel, type StageOption } from '@/lib/marketing/lead-view'
import { LeadPane } from '../_lead-pane'

export const dynamic = 'force-dynamic'

type SP = { show?: string; stage?: string; lead?: string }

/**
 * TD Marketing — Leads (dev job 9aec66fa): the team's one filterable list on the left; the lead you click, with everything about it and the buttons, on the
 * right. The team id comes from the guard and is in every query, so another team's lead id finds nothing.
 */
export default async function MarketingLeads({ searchParams }: { searchParams: Promise<SP> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.read')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">You do not have access to the leads. Ask your team owner.</p></main>
  }
  const sp = await searchParams
  const db = leadDb()
  const teamId = g.ctx.team.id
  const [all, stages, reasons, checklist, selected] = await Promise.all([
    listTeamLeads(db, teamId, 500),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOption[]>,
    getMarketingSetting('not_in_target_reasons', teamId) as Promise<StageOption[]>,
    getMarketingSetting('qualification_checklist', teamId) as Promise<string[]>,
    sp.lead ? getTeamLead(db, teamId, sp.lead) : Promise.resolve(null),
  ])
  const show = parseLeadShow(sp.show)
  const stage = stages.some(s => s.key === sp.stage) ? (sp.stage as string) : ''
  const leads = filterLeads(all, { show, stage }, g.ctx.user.id)
  const events = selected ? await leadTimeline(db, selected.id) : []
  const href = (n: Partial<SP>) => {
    const q = new URLSearchParams()
    const m = { show: show !== 'all' ? show : '', stage, lead: sp.lead, ...n }
    for (const [k, v] of Object.entries(m)) if (v) q.set(k, v)
    const t = q.toString()
    return t ? `/marketing/leads?${t}` : '/marketing/leads'
  }
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-600'}`

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-baseline justify-between"><h1 className="text-2xl font-semibold">Leads</h1><span className="text-sm text-slate-500">{leads.length} of {all.length}</span></div>
      <nav aria-label="Filter leads" className="space-y-2">
        <div className="flex flex-wrap gap-2">{LEAD_SHOW_OPTIONS.map(o => <Link key={o.key} href={href({ show: o.key === 'all' ? '' : o.key, lead: '' })} className={chip(show === o.key)}>{o.label}</Link>)}</div>
        <div className="flex flex-wrap gap-2">
          <Link href={href({ stage: '', lead: '' })} className={chip(stage === '')}>Every stage</Link>
          {stages.map(s => <Link key={s.key} href={href({ stage: s.key, lead: '' })} className={chip(stage === s.key)}>{s.label}</Link>)}
        </div>
      </nav>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-xl border bg-white" aria-label="Lead list">
          {leads.length === 0 ? <p className="p-5 text-sm text-slate-600">{all.length === 0 ? 'No leads yet. New leads from the ads appear here by themselves, within a few minutes of someone filling in the form.' : 'No leads match this filter.'}</p> : (
            <ul className="divide-y">
              {leads.map(l => (
                <li key={l.id}>
                  <Link href={href({ lead: l.id })} className={`block px-4 py-3 ${l.id === sp.lead ? 'bg-teal-50' : 'hover:bg-slate-50'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><p className="truncate font-medium">{l.full_name || l.email || l.phone || 'Unnamed lead'}</p><p className="truncate text-xs text-slate-500">{[l.phone, l.email].filter(Boolean).join(' · ') || 'No contact details'}</p></div>
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{stageLabel(stages, l.status)}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{formatWhen(l.meta_created_time ?? l.received_at)} · {l.claimed_by === null ? 'Not picked' : l.claimed_by === g.ctx.user.id ? 'Picked by you' : `Picked by ${l.claimed_by_label ?? 'a team member'}`}{l.callback_at && <span className="text-sky-700"> · Call back {formatWhen(l.callback_at)}</span>}</p>
                    {clientFlagText(l.existing_client) && <p className="mt-1 text-xs text-amber-800">Existing TD client? Check before selling.</p>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside className="min-w-0" aria-label="Lead detail">
          {selected ? (
            <LeadPane lead={selected} events={events} stages={stages} reasons={reasons} checklist={checklist} permissions={g.ctx.permissions} isOwner={g.ctx.role === 'owner'} myId={g.ctx.user.id} />
          ) : <div className="rounded-xl border border-dashed p-8 text-sm text-slate-500">Click a lead on the left to see what they answered, what the setter wrote, and everything that happened to it.</div>}
        </aside>
      </div>
    </div>
  )
}
