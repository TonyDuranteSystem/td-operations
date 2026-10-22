import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { countLeads, countLeadsByStage, getTeamLead, leadTimeline, listAdNames, listTeamLeadsByIds, listTeamLeadsCapped, NO_AD } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { clientFlagText, filterLeads, formatWhen, LEAD_SHOW_OPTIONS, markWords, parseLeadShow, rowFacts, stageLabel, type StageOption } from '@/lib/marketing/lead-view'
import { loadPaymentLinkView } from '@/lib/marketing/sales-server'
import { leadIdsWorkedBy } from '@/lib/marketing/events-read'
import { listMembers } from '@/lib/marketing/members'
import { personName } from '@/lib/marketing/setter-note'
import { canSeeNotes, withoutPhone } from '@/lib/marketing/lead-privacy'
import { loadLeadActivity } from '@/lib/marketing/note-read'
import { FilterMenu } from '@/components/marketing/filter-menu'
import { LeadPane } from '../_lead-pane'

export const dynamic = 'force-dynamic'

type SP = { show?: string; stage?: string; lead?: string; by?: string; ad?: string }

/**
 * TD Marketing — Leads (dev job 9aec66fa): the team's one filterable list on the left; the lead you click, with everything about it and the buttons, on the
 * right. The team id comes from the guard and is in every query, so another team's lead id finds nothing. Everything that narrows the list (stage, ad, whose) is part of the
 * database query, so the newest-500 cap applies to the leads that MATCH; the stage strip shows exact counts from the database.
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
  // "worked on by": only a real member's email counts, and only for people who may see the team's activity; anything else is ignored
  const members = hasPermission(g.ctx.permissions, 'team.activity') ? await listMembers(teamId) : []
  const peopleOptions = members.filter(m => m.status !== 'removed' && m.email).map(m => ({ email: m.email as string }))
  const byEmail = sp.by && hasPermission(g.ctx.permissions, 'team.activity') && members.some(x => x.email === sp.by) ? sp.by : ''
  const [stages, reasons, checklist, selected] = await Promise.all([
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOption[]>,
    getMarketingSetting('not_in_target_reasons', teamId) as Promise<StageOption[]>,
    getMarketingSetting('qualification_checklist', teamId) as Promise<string[]>,
    sp.lead ? getTeamLead(db, teamId, sp.lead) : Promise.resolve(null),
  ])
  const show = parseLeadShow(sp.show)
  const stage = stages.some(s => s.key === sp.stage) ? (sp.stage as string) : ''
  const by = byEmail
  const userId = g.ctx.user.id
  // the ads offered follow the other filters (stage, who picked); an ad that does not exist is ignored
  const adList = await listAdNames(db, teamId, { stage, show, userId })
  const ad = sp.ad && adList.some(a => a.name === sp.ad) ? sp.ad : ''
  // everything that narrows the list is in the database query; the stage counts follow the same filters except the stage itself
  let all: Awaited<ReturnType<typeof listTeamLeadsCapped>>['rows'], cut: boolean, counts: Map<string, number>, every = 0
  if (by) {
    // with a person chosen, the leads come BY ID (everything they worked on, however old)
    const worked = await leadIdsWorkedBy(db, teamId, by)
    const byId = (await listTeamLeadsByIds(db, teamId, worked.ids)).filter(l => (ad ? (ad === NO_AD ? !l.ad_name : l.ad_name === ad) : true))
    const pool = filterLeads(byId, { show }, userId)
    counts = new Map(stages.map(st => [st.key, pool.filter(l => l.status === st.key).length]))
    all = pool.filter(l => (stage ? l.status === stage : true)); cut = worked.truncated; every = pool.length
  } else {
    const [res, c, n] = await Promise.all([
      listTeamLeadsCapped(db, teamId, 500, { stage, ad, show, userId, order: show === 'free' ? 'oldest' : show === 'callbacks' ? 'callback' : 'newest' }),
      countLeadsByStage(db, teamId, stages.map(st => st.key), { ad, show, userId }),
      countLeads(db, teamId, { ad, show, userId }),
    ])
    all = res.rows; cut = res.truncated; counts = c; every = n
  }
  all = withoutPhone(all, g.ctx.permissions)
  const leads = show === 'callbacks' ? filterLeads(all, { show }, userId) : all
  // "Any stage" is the real number of leads, not the sum of the stage chips (a lead at a stage that is no longer in the settings has no chip but is still a lead)
  const totalInStrip = every
  const total = stage ? (counts.get(stage) ?? 0) : totalInStrip
  const anyFilter = !!(stage || ad || by || show !== 'all')
  const stageName = stages.find(st => st.key === stage)?.label
  const showName = LEAD_SHOW_OPTIONS.find(o => o.key === show)?.label
  const applied = [stageName && `Stage: ${stageName}`, show !== 'all' && showName, ad && `Ad: ${ad === NO_AD ? 'No ad name' : ad}`, by && `Worked on by ${personName(by)}`].filter(Boolean) as string[]
  // the setter's name, the mark and the one-line note are for people who may read the team's notes
  const seesNotes = canSeeNotes(g.ctx.permissions)
  const activity = seesNotes && leads.length > 0 ? await loadLeadActivity(db, leads.map(l => l.id)) : null
  const nowMs = Date.now()
  const events = selected ? await leadTimeline(db, selected.id) : []
  const paymentLink = selected && hasPermission(g.ctx.permissions, 'payment_links.create') ? { leadId: selected.id, ...(await loadPaymentLinkView(db, { teamId, userId: g.ctx.user.id }, selected.id)) } : undefined
  const href = (n: Partial<SP>) => {
    const q = new URLSearchParams()
    const m = { show: show !== 'all' ? show : '', stage, lead: sp.lead, by, ad, ...n }
    for (const [k, v] of Object.entries(m)) if (v) q.set(k, v)
    const t = q.toString()
    return t ? `/marketing/leads?${t}` : '/marketing/leads'
  }
  const chip = (on: boolean, dim = false) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-slate-900 bg-slate-900 text-white' : dim ? 'bg-white text-slate-400' : 'bg-white text-slate-600'}`

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-baseline justify-between"><h1 className="text-2xl font-semibold">Leads</h1><span className="text-sm text-slate-500" aria-live="polite" data-testid="list-count">{leads.length < total ? `Showing ${leads.length} of ${total}` : `${total} ${total === 1 ? 'lead' : 'leads'}`}{anyFilter && leads.length >= total ? ' match' : ''}</span></div>
      {cut && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="list-cut">{by ? 'This person worked on more than we can list at once; the oldest are not shown.' : show === 'free' ? 'Showing the 500 that have waited longest. Pick or filter to see the rest.' : 'Showing the newest 500 leads. Use the filters, or open a person from Team activity, to find older ones.'}</p>}
      {anyFilter && (
        <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="applied">
          <span className="text-slate-500">Showing:</span>
          {applied.map(t => <span key={t} className="rounded-full bg-teal-50 px-3 py-1 text-xs text-teal-900">{t}</span>)}
          <Link href="/marketing/leads" className="text-xs text-slate-500 underline" data-testid="clear-filters">Clear all</Link>
        </p>
      )}
      <nav aria-label="Filter leads" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="stage-strip" role="group" aria-label="Stages">
          <Link href={href({ stage: '', lead: '' })} className={chip(stage === '')} aria-current={stage === '' ? 'true' : undefined}>Any stage <b className="ml-1 font-semibold">{totalInStrip}</b></Link>
          {stages.map(st => <Link key={st.key} href={href({ stage: st.key, lead: '' })} className={chip(stage === st.key, (counts.get(st.key) ?? 0) === 0)} data-stage={st.key} aria-current={stage === st.key ? 'true' : undefined}>{st.label} <b className="ml-1 font-semibold">{counts.get(st.key) ?? 0}</b></Link>)}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Whose">{LEAD_SHOW_OPTIONS.map(o => <Link key={o.key} href={href({ show: o.key === 'all' ? '' : o.key, lead: '' })} className={chip(show === o.key)} aria-current={show === o.key ? 'true' : undefined}>{o.key === 'all' ? 'All leads' : o.label}</Link>)}</div>
          {adList.length > 0 && (
            <FilterMenu label="Ad" testId="ad-filter" current={ad ? (ad === NO_AD ? 'No ad name' : ad) : 'Any ad'}
              options={[{ label: 'Any ad', href: href({ ad: '', lead: '' }), on: !ad }, ...adList.map(a => ({ label: `${a.name === NO_AD ? 'No ad name' : a.name} (${a.count})`, href: href({ ad: a.name, lead: '' }), on: ad === a.name }))]} />
          )}
          {hasPermission(g.ctx.permissions, 'team.activity') && peopleOptions.length > 0 && (
            <FilterMenu label="Worked on by" testId="person-filter" current={by ? personName(by) : 'Anyone'}
              options={[{ label: 'Anyone', href: href({ by: '', lead: '' }), on: !by }, ...peopleOptions.map(p => ({ label: personName(p.email), href: href({ by: p.email, lead: '' }), on: by === p.email }))]} />
          )}
        </div>
      </nav>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-xl border bg-white" aria-label="Lead list">
          {leads.length === 0 ? (
            <div className="p-5 text-sm text-slate-600" data-testid="empty">
              {anyFilter
                ? <><p>No leads match {applied.join(', ')}.</p><p className="mt-2"><Link href="/marketing/leads" className="underline">Clear all filters</Link></p></>
                : <p>No leads yet. New leads from the ads appear here by themselves, within a few minutes of someone filling in the form.</p>}
            </div>
          ) : (
            <ul className="divide-y">
              {leads.map(l => {
                const f = rowFacts(l, stages[0]?.key, nowMs)
                const mark = activity?.marks.get(l.id)
                const note = activity?.notes.get(l.id)
                return (
                  <li key={l.id}>
                    <Link href={href({ lead: l.id })} className={`block px-4 py-3 ${l.id === sp.lead ? 'bg-teal-50' : 'hover:bg-slate-50'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><p className="truncate font-medium">{l.full_name || l.email || l.phone || 'Unnamed lead'}</p><p className="truncate text-xs text-slate-500">{[l.phone, l.email].filter(Boolean).join(' · ') || 'No contact details'}</p></div>
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{stageLabel(stages, l.status)}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatWhen(l.meta_created_time ?? l.received_at)}
                        {f.waiting && <span className={f.waiting.late ? 'font-medium text-red-700' : 'text-slate-600'} data-testid="waiting" data-late={f.waiting.late ? '1' : '0'}> · waiting {f.waiting.text}{f.waiting.late ? ' (late)' : ''}</span>}
                        {' · '}{l.claimed_by === null ? 'Not picked' : l.claimed_by === g.ctx.user.id ? 'Picked by you' : `Picked by ${l.claimed_by_label ?? 'a team member'}`}
                        {l.callback_at && <span className="text-sky-700"> · Call back {formatWhen(l.callback_at)}</span>}
                      </p>
                      {(f.ad || mark) && <p className="mt-0.5 truncate text-xs text-slate-500">{f.ad}{mark && <span data-testid="row-mark">{f.ad ? ' · ' : ''}Marked {markWords(mark.outcome).toLowerCase()} by {mark.by}</span>}</p>}
                      {note && <p className="mt-0.5 truncate text-xs text-slate-700" data-testid="row-note">{note.text}</p>}
                      {clientFlagText(l.existing_client) && <p className="mt-1 text-xs text-amber-800">Existing TD client? Check before selling.</p>}
                    </Link>
                  </li>
                )
              })}
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
