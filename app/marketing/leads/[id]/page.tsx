import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { getTeamLead, leadTimeline } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { clientFlagText, eventText, formatWhen, prettyQuestion, stageLabel, telHref, type StageOption } from '@/lib/marketing/lead-view'
import { LeadActionPanel } from '@/components/marketing/lead-action-panel'

export const dynamic = 'force-dynamic'

/** One lead: everything they answered on the form, where it came from, and what happened to it. Team-scoped: another team's id finds nothing. */
export default async function MarketingLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.read')) redirect('/marketing/leads')
  const { id } = await params
  const db = leadDb()
  const lead = await getTeamLead(db, g.ctx.team.id, id)
  if (!lead) notFound()
  const [events, stages, reasons, checklist] = await Promise.all([
    leadTimeline(db, lead.id),
    getMarketingSetting('pipeline_stages', g.ctx.team.id) as Promise<StageOption[]>,
    getMarketingSetting('not_in_target_reasons', g.ctx.team.id) as Promise<StageOption[]>,
    getMarketingSetting('qualification_checklist', g.ctx.team.id) as Promise<string[]>,
  ])
  const claim = lead.claimed_by === null ? 'free' : lead.claimed_by === g.ctx.user.id ? 'me' : 'other'
  const flag = clientFlagText(lead.existing_client)
  const tel = telHref(lead.phone)
  const where = [lead.campaign_name, lead.adset_name, lead.ad_name].filter(Boolean)
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/marketing/leads" className="text-sm text-slate-500">← Leads</Link>
      <div className="mt-2 flex items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold">{lead.full_name || lead.email || lead.phone || 'Unnamed lead'}</h1>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs">{stageLabel(stages, lead.status)}</span>
      </div>
      {flag && <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{flag}</p>}
      <p className="mt-2 text-sm text-slate-500">
        {lead.claimed_by === null ? 'Nobody has picked this lead yet.' : claim === 'me' ? 'You picked this lead.' : `Picked by ${lead.claimed_by_label ?? 'a team member'}.`}
        {lead.callback_at && <> Call back on <strong className="text-slate-700">{formatWhen(lead.callback_at)}</strong>.</>}
        {lead.not_in_target_reason && <> Reason: {reasons.find(r => r.key === lead.not_in_target_reason)?.label ?? lead.not_in_target_reason}.</>}
      </p>

      <LeadActionPanel
        leadId={lead.id}
        canPick={hasPermission(g.ctx.permissions, 'leads.pick')}
        canMark={hasPermission(g.ctx.permissions, 'leads.mark')}
        claim={claim}
        isOwner={g.ctx.role === 'owner'}
        checklist={checklist}
        reasons={reasons}
      />

      <section className="mt-5 space-y-1 rounded-xl border bg-white p-4 text-sm">
        {tel && <p><span className="text-slate-500">Phone: </span><a className="underline" href={tel}>{lead.phone}</a></p>}
        {lead.email && <p><span className="text-slate-500">Email: </span><a className="underline" href={`mailto:${lead.email}`}>{lead.email}</a></p>}
        {(lead.city || lead.country) && <p><span className="text-slate-500">Place: </span>{[lead.city, lead.country].filter(Boolean).join(', ')}</p>}
        {!tel && !lead.email && <p className="text-slate-500">No contact details were given.</p>}
      </section>

      {lead.qualification && lead.qualification.length > 0 && (
        <section className="mt-5 rounded-xl border bg-white p-4 text-sm">
          <h2 className="text-sm font-semibold text-slate-600">Checklist from the call</h2>
          <ul className="mt-2 space-y-1">{lead.qualification.map(q => <li key={q.item}>{q.ticked ? '✔' : '✘'} {q.item}</li>)}</ul>
        </section>
      )}

      <section className="mt-5">
        <h2 className="text-sm font-semibold text-slate-600">What they answered on the form</h2>
        {lead.answers.length === 0 ? <p className="mt-2 text-sm text-slate-500">No answers were received.</p> : (
          <dl className="mt-2 divide-y rounded-xl border bg-white text-sm">
            {lead.answers.map((a, i) => (
              <div key={`${a.name}-${i}`} className="grid gap-1 px-4 py-2.5 sm:grid-cols-3">
                <dt className="text-slate-500">{prettyQuestion(a.name)}</dt>
                <dd className="sm:col-span-2">{a.values.length ? a.values.join(', ') : <span className="text-slate-400">—</span>}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="mt-5 rounded-xl border bg-white p-4 text-sm">
        <h2 className="text-sm font-semibold text-slate-600">Where it came from</h2>
        <p className="mt-2">{where.length ? where.join(' › ') : 'Meta lead form'}{lead.platform ? ` (${lead.platform === 'ig' ? 'Instagram' : lead.platform === 'fb' ? 'Facebook' : lead.platform})` : ''}</p>
        <p className="mt-1 text-slate-500">Filled in {formatWhen(lead.meta_created_time ?? lead.received_at)}</p>
      </section>

      <section className="mt-5">
        <h2 className="text-sm font-semibold text-slate-600">History</h2>
        <ol className="mt-2 space-y-1 text-sm">
          {events.map(e => (
            <li key={e.id} className="flex justify-between gap-3 rounded-lg bg-white px-3 py-2 border">
              <span>{eventText(e.kind, e.data, stages, reasons)}{e.actor !== 'system' && <span className="text-slate-400"> · {e.actor}</span>}</span>
              <span className="shrink-0 text-xs text-slate-400">{formatWhen(e.created_at)}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}
