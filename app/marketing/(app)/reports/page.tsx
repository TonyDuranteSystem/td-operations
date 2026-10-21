import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { loadNumbersData } from '@/lib/marketing/numbers-read'
import { PERIODS, adTable, outcomesIn, parsePeriod, periodStart, reasonCounts, setterTable } from '@/lib/marketing/numbers'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Reports (dev job 9aec66fa): why leads were not in target, how each ad is doing (leads, Good, Not in target, paid), and how each setter does.
 * The setters table is only for people who may pick leads (owner / seller); the ad people see the first two. No ad cost yet: ad spend is not connected to this system.
 */
export default async function MarketingReports({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const seesSetters = hasPermission(g.ctx.permissions, 'leads.pick')
  if (!hasPermission(g.ctx.permissions, 'reports.read') && !seesSetters) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">You do not have access to Reports. Ask your team owner.</p></main>
  }
  const period = parsePeriod((await searchParams).period)
  const from = periodStart(period, new Date())
  const teamId = g.ctx.team.id
  const [data, reasons] = await Promise.all([loadNumbersData(leadDb(), teamId), getMarketingSetting('not_in_target_reasons', teamId) as Promise<{ key: string; label: string }[]>])
  const inPeriod = outcomesIn(data.events, from)
  const all = outcomesIn(data.events, null)
  const why = reasonCounts(inPeriod, reasons)
  const ads = adTable(data.leads, all, data.sales, from)
  const setters = setterTable(inPeriod, data.sales)
  const max = Math.max(1, ...why.map(w => w.n))
  const card = 'rounded-xl border bg-white p-5'
  return (
    <div className="space-y-5 p-6">
      <div><h1 className="text-2xl font-semibold">Reports</h1><p className="text-sm text-slate-500">Numbers for the team, from the leads and what was done with them.</p></div>
      <nav aria-label="Period" className="flex flex-wrap gap-2">
        {PERIODS.map(p => <Link key={p.key} href={`/marketing/reports?period=${p.key}`} aria-current={p.key === period ? 'page' : undefined} className={`rounded-full border px-3 py-1 text-xs ${p.key === period ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-600'}`}>{p.label}</Link>)}
      </nav>

      <section aria-label="Why leads were not in target" className={card}>
        <h2 className="text-sm font-semibold text-slate-600">Why leads were not in target</h2>
        {why.length === 0 ? <p className="mt-2 text-sm text-slate-500">No lead was marked Not in target in this period.</p> : (
          <ul className="mt-3 space-y-2 text-sm">{why.map(w => (
            <li key={w.label} className="flex items-center gap-3"><span className="w-56 shrink-0 truncate text-slate-600">{w.label}</span>
              <span className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100"><span className="block h-3 rounded-full bg-rose-500" style={{ width: `${Math.round((w.n / max) * 100)}%` }} /></span>
              <span className="w-8 text-right font-mono tabular-nums">{w.n}</span></li>
          ))}</ul>
        )}
      </section>

      <section aria-label="Leads by ad" className={card}>
        <h2 className="text-sm font-semibold text-slate-600">Leads by ad</h2>
        <p className="mt-1 text-xs text-slate-500">Leads that arrived in this period, and what became of them. The cost of each ad is not here yet: ad spend is not connected to this system.</p>
        {ads.length === 0 ? <p className="mt-2 text-sm text-slate-500">No leads arrived in this period.</p> : (
          <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">Ad</th><th className="pr-4 text-right">Leads</th><th className="pr-4 text-right">Good</th><th className="pr-4 text-right">Not in target</th><th className="text-right">Paid</th></tr></thead>
            <tbody className="divide-y">{ads.map(a => <tr key={a.ad}><td className="py-2 pr-4">{a.ad}</td><td className="pr-4 text-right font-mono tabular-nums">{a.leads}</td><td className="pr-4 text-right font-mono tabular-nums">{a.good}</td><td className="pr-4 text-right font-mono tabular-nums">{a.notInTarget}</td><td className="text-right font-mono tabular-nums">{a.paid}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>

      {seesSetters && (
        <section aria-label="Setters" className={card}>
          <h2 className="text-sm font-semibold text-slate-600">Setters</h2>
          {setters.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nobody marked a lead in this period.</p> : (
            <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">Person</th><th className="pr-4 text-right">Marked</th><th className="pr-4 text-right">Good</th><th className="pr-4 text-right">Not in target</th><th className="pr-4 text-right">Good rate</th><th className="text-right">Paid a call</th></tr></thead>
              <tbody className="divide-y">{setters.map(s => <tr key={s.actor}><td className="py-2 pr-4">{s.actor}</td><td className="pr-4 text-right font-mono tabular-nums">{s.worked}</td><td className="pr-4 text-right font-mono tabular-nums">{s.good}</td><td className="pr-4 text-right font-mono tabular-nums">{s.notInTarget}</td><td className="pr-4 text-right font-mono tabular-nums">{s.goodRatePct === null ? '—' : `${s.goodRatePct}%`}</td><td className="text-right font-mono tabular-nums">{s.paidLeads}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
      )}
    </div>
  )
}
