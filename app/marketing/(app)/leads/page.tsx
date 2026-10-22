import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { getTeamLead, leadTimeline, listTeamLeadsByIds, listTeamLeadsCapped } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { clientFlagText, filterLeads, formatWhen, LEAD_SHOW_OPTIONS, parseLeadShow, stageLabel, type StageOption } from '@/lib/marketing/lead-view'
import { loadPaymentLinkView } from '@/lib/marketing/sales-server'
import { leadIdsWorkedBy } from '@/lib/marketing/events-read'
import { listMembers } from '@/lib/marketing/members'
import { personName } from '@/lib/marketing/setter-note'
import { withoutPhone } from '@/lib/marketing/lead-privacy'
import { LeadPane } from '../_lead-pane'

export const dynamic = 'force-dynamic'

type SP = { show?: string; stage?: string; lead?: string; by?: string }

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
  // "worked by": only a real member's email counts; anything else is ignored
  const members = sp.by && hasPermission(g.ctx.permissions, 'team.activity') ? await listMembers(teamId) : []
  const byEmail = sp.by && hasPermission(g.ctx.permissions, 'team.activity') && members.some(x => x.email === sp.by) ? sp.by : ''
  const [allRes, stages, reasons, checklist, selected] = await Promise.all([
    byEmail ? Promise.resolve({ rows: [], truncated: false }) : listTeamLeadsCapped(db, teamId, 500),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOption[]>,
    getMarketingSetting('not_in_target_reasons', teamId) as Promise<StageOption[]>,
    getMarketingSetting('qualification_checklist', teamId) as Promise<string[]>,
    sp.lead ? getTeamLead(db, teamId, sp.lead) : Promise.resolve(null),
  ])
  const show = parseLeadShow(sp.show)
  const stage = stages.some(s => s.key === sp.stage) ? (sp.stage as string) : ''
  const by = byEmail
  // with a person chosen, the leads come BY ID (everything they worked on, however old); otherwise the newest 500
  const worked = by ? await leadIdsWorkedBy(db, teamId, by) : null
  const all = withoutPhone(worked ? await listTeamLeadsByIds(db, teamId, worked.ids) : allRes.rows, g.ctx.permissions)
  const cut = worked ? worked.truncated : allRes.truncated
  const leads = filterLeads(all, { show, stage }, g.ctx.user.id)
  const events = selected ? await leadTimeline(db, selected.id) : []
  const paymentLink = selected && hasPermission(g.ctx.permissions, 'payment_links.create') ? { leadId: selected.id, ...(await loadPaymentLinkView(db, { teamId, userId: g.ctx.user.id }, selected.id)) } : undefined
  const href = (n: Partial<SP>) => {
    const q = new URLSearchParams()
    const m = { show: show !== 'all' ? show : '', stage, lead: sp.lead, by, ...n }
    for (const [k, v] of Object.entries(m)) if (v) q.set(k, v)
    const t = q.toString()
    return t ? `/marketing/leads?${t}` : '/marketing/leads'
  }
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-600'}`

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-baseline justify-between"><h1 className="text-2xl font-semibold">Leads</h1><span className="text-sm text-slate-500">{leads.length} of {all.length}</span></div>
      {cut && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="list-cut">{by ? 'This person worked on more than we can list at once; the oldest are not shown.' : 'Showing the newest 500 leads. Use the filters, or open a person from Today, to find older ones.'}</p>}
      {by && <p className="flex items-center gap-2 text-sm" data-testid="worked-by"><span className="rounded-full bg-teal-50 px-3 py-1 text-teal-900">Worked on by {personName(by)}</span><Link href={href({ by: '', lead: '' })} className="text-xs text-slate-500 underline">Show everyone</Link></p>}
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
            <LeadPane lead={selected} events={events} stages={stages} reasons={reasons} checklist={checklist} permissions={g.ctx.permissions} isOwner={g.ctx.role === 'owner'} myId={g.ctx.user.id} paymentLink={paymentLink} />
          ) : <div className="rounded-xl border border-dashed p-8 text-sm text-slate-500">Click a lead on the left to see what they answered, what the setter wrote, and everything that happened to it.</div>}
        </aside>
      </div>
    </div>
  )
}
