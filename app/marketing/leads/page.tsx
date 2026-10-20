import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listTeamLeads } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { clientFlagText, filterLeads, formatWhen, LEAD_SHOW_OPTIONS, parseLeadShow, stageLabel, type StageOption } from '@/lib/marketing/lead-view'

export const dynamic = 'force-dynamic'

/** TD Marketing — the lead inbox (dev job 9aec66fa, Slice 1): every lead from the ads, newest first, for the signed-in person's team only. */
export default async function MarketingLeads({ searchParams }: { searchParams: Promise<{ show?: string; stage?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.read')) {
    return (
      <main className="mx-auto max-w-xl px-4 py-10">
        <Link href="/marketing" className="text-sm text-slate-500">← Back</Link>
        <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">You do not have access to the leads. Ask your team owner.</p>
      </main>
    )
  }
  const sp = await searchParams
  const [allLeads, stages] = await Promise.all([
    listTeamLeads(leadDb(), g.ctx.team.id),
    getMarketingSetting('pipeline_stages', g.ctx.team.id) as Promise<StageOption[]>,
  ])
  const show = parseLeadShow(sp.show)
  const stage = stages.some(s => s.key === sp.stage) ? (sp.stage as string) : ''
  const leads = filterLeads(allLeads, { show, stage }, g.ctx.user.id)
  const href = (next: { show?: string; stage?: string }) => {
    const q = new URLSearchParams()
    const sh = next.show ?? show, st = next.stage ?? stage
    if (sh !== 'all') q.set('show', sh)
    if (st) q.set('stage', st)
    const t = q.toString()
    return t ? `/marketing/leads?${t}` : '/marketing/leads'
  }
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-600'}`
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/marketing" className="text-sm text-slate-500">← {g.ctx.team.name}</Link>
      <div className="mt-2 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Leads</h1>
        <span className="text-sm text-slate-500">{leads.length} {leads.length === 1 ? 'lead' : 'leads'}</span>
      </div>
      <nav aria-label="Filter leads" className="mt-3 space-y-2">
        <div className="flex flex-wrap gap-2">
          {LEAD_SHOW_OPTIONS.map(o => <Link key={o.key} href={href({ show: o.key })} className={chip(show === o.key)}>{o.label}</Link>)}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={href({ stage: '' })} className={chip(stage === '')}>Every stage</Link>
          {stages.map(st => <Link key={st.key} href={href({ stage: st.key })} className={chip(stage === st.key)}>{st.label}</Link>)}
        </div>
      </nav>
      {leads.length === 0 ? (
        <p className="mt-6 rounded-xl border bg-white p-5 text-sm text-slate-600">{allLeads.length === 0 ? 'No leads yet. New leads from the ads appear here by themselves, within a few minutes of someone filling in the form.' : 'No leads match this filter.'}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {leads.map(l => {
            const flag = clientFlagText(l.existing_client)
            return (
              <li key={l.id}>
                <Link href={`/marketing/leads/${l.id}`} className="block rounded-xl border bg-white p-4 hover:border-slate-400">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{l.full_name || l.email || l.phone || 'Unnamed lead'}</p>
                      <p className="truncate text-sm text-slate-500">{[l.phone, l.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
                      {l.campaign_name && <p className="mt-1 truncate text-xs text-slate-400">{l.campaign_name}</p>}
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs">{stageLabel(stages, l.status)}</span>
                      <p className="mt-1 text-xs text-slate-400">{formatWhen(l.meta_created_time ?? l.received_at)}</p>
                      {l.callback_at && <p className="mt-1 text-xs font-medium text-sky-700">Call back {formatWhen(l.callback_at)}</p>}
                      <p className="mt-1 text-xs text-slate-400">{l.claimed_by === null ? 'Not picked' : l.claimed_by === g.ctx.user.id ? 'Picked by you' : `Picked by ${l.claimed_by_label ?? 'a team member'}`}</p>
                    </div>
                  </div>
                  {flag && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">{flag}</p>}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
