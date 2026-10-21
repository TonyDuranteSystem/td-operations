import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { loadNumbersData } from '@/lib/marketing/numbers-read'
import { PERIODS, outcomesIn, parsePeriod, periodStart, personNumbers } from '@/lib/marketing/numbers'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — My numbers (dev job 9aec66fa): the person's OWN numbers for the period: the leads he gave an outcome, how many were Good, his Good rate, how many of
 * the leads he marked Good have paid, and where his outcomes ended. Counted from the history rows he wrote (his email), team-scoped by the guard.
 */
export default async function MarketingMyNumbers({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.mark')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">You do not have numbers of your own here. Ask your team owner.</p></main>
  }
  const period = parsePeriod((await searchParams).period)
  const now = new Date()
  const data = await loadNumbersData(leadDb(), g.ctx.team.id)
  const rows = outcomesIn(data.events, periodStart(period, now))
  const me = g.ctx.user.email ?? ''
  const n = personNumbers(rows, data.sales, me)
  const bars = [{ label: 'Good', v: n.good, c: 'bg-emerald-500' }, { label: 'Not in target', v: n.notInTarget, c: 'bg-rose-500' }, { label: 'Call back', v: n.callBacks, c: 'bg-sky-500' }]
  const max = Math.max(1, ...bars.map(b => b.v))
  const tile = 'rounded-xl border bg-white p-5'
  return (
    <div className="space-y-5 p-6">
      <div><h1 className="text-2xl font-semibold">My numbers</h1><p className="text-sm text-slate-500">What you did with the leads, counted from your own marks. Calls themselves are not recorded yet, so a lead counts once you mark it.</p></div>
      {data.truncated && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">Some older records are not included in these numbers because there are too many to read at once. Tell Antonio.</p>}
      <nav aria-label="Period" className="flex flex-wrap gap-2">
        {PERIODS.map(p => <Link key={p.key} href={`/marketing/my-numbers?period=${p.key}`} aria-current={p.key === period ? 'page' : undefined} className={`rounded-full border px-3 py-1 text-xs ${p.key === period ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-600'}`}>{p.label}</Link>)}
      </nav>
      <section aria-label="Your numbers" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className={tile}><p className="text-sm text-slate-500">Leads you marked</p><p className="mt-1 text-3xl font-semibold" data-testid="worked">{n.worked}</p></div>
        <div className={tile}><p className="text-sm text-slate-500">Marked Good</p><p className="mt-1 text-3xl font-semibold" data-testid="good">{n.good}</p></div>
        <div className={tile}><p className="text-sm text-slate-500">Good rate</p><p className="mt-1 text-3xl font-semibold" data-testid="rate">{n.goodRatePct === null ? '—' : `${n.goodRatePct}%`}</p><p className="mt-1 text-xs text-slate-400">Good out of Good + Not in target</p></div>
        <div className={tile}><p className="text-sm text-slate-500">Good leads that paid a call</p><p className="mt-1 text-3xl font-semibold" data-testid="paid">{n.paidLeads}</p></div>
      </section>
      <section aria-label="Where your leads ended" className={tile}>
        <h2 className="text-sm font-semibold text-slate-600">Where your leads ended</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {bars.map(b => (
            <li key={b.label} className="flex items-center gap-3"><span className="w-28 shrink-0 text-slate-600">{b.label}</span>
              <span className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100"><span className={`block h-3 rounded-full ${b.c}`} style={{ width: `${Math.round((b.v / max) * 100)}%` }} /></span>
              <span className="w-8 text-right font-mono tabular-nums">{b.v}</span></li>
          ))}
        </ul>
      </section>
    </div>
  )
}
