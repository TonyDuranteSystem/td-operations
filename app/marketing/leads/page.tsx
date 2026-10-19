import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listTeamLeads } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { clientFlagText, formatWhen, stageLabel, type StageOption } from '@/lib/marketing/lead-view'

export const dynamic = 'force-dynamic'

/** TD Marketing — the lead inbox (dev job 9aec66fa, Slice 1): every lead from the ads, newest first, for the signed-in person's team only. */
export default async function MarketingLeads() {
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
  const [leads, stages] = await Promise.all([
    listTeamLeads(leadDb(), g.ctx.team.id),
    getMarketingSetting('pipeline_stages', g.ctx.team.id) as Promise<StageOption[]>,
  ])
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/marketing" className="text-sm text-slate-500">← {g.ctx.team.name}</Link>
      <div className="mt-2 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Leads</h1>
        <span className="text-sm text-slate-500">{leads.length} {leads.length === 1 ? 'lead' : 'leads'}</span>
      </div>
      {leads.length === 0 ? (
        <p className="mt-6 rounded-xl border bg-white p-5 text-sm text-slate-600">No leads yet. New leads from the ads appear here by themselves, within seconds of someone filling in the form.</p>
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
