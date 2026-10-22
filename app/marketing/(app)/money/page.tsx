import { canSeePhone } from '@/lib/marketing/lead-privacy'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { listTeamSales } from '@/lib/marketing/sales-server'
import { formatMoney, saleStatusLabel, totalsByCurrency } from '@/lib/marketing/sales'
import { formatWhen } from '@/lib/marketing/lead-view'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Money (the team's view; dev job 9aec66fa): the sales of this team, the person's share of each, and what has been paid out to the
 * seller's company. The team owner sees the whole team's sales; a member with the Money permission sees only the sales he made himself.
 * Every total is per currency. Team-scoped by the guard.
 */
export default async function MarketingMoney() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'money.read')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">You do not have access to Money. Ask your team owner.</p></main>
  }
  const db = leadDb()
  const teamId = g.ctx.team.id
  const sales = await listTeamSales(db, teamId, g.ctx.role === 'owner' ? {} : { mineUserId: g.ctx.user.id })
  const [kinds, leadsRes] = await Promise.all([
    getMarketingSetting('sale_kinds', teamId) as Promise<{ key: string; label: string }[]>,
    sales.length ? db.from('marketing_leads').select('id, full_name, email, phone').eq('team_id', teamId).in('id', Array.from(new Set(sales.map(s => s.lead_id)))) : Promise.resolve({ data: [] }),
  ])
  const names = new Map(((leadsRes.data ?? []) as { id: string; full_name: string | null; email: string | null; phone: string | null }[]).map(l => [l.id, l.full_name || l.email || (canSeePhone(g.ctx.permissions) ? l.phone : null) || 'Unnamed lead']))
  const totals = totalsByCurrency(sales)
  const card = 'rounded-xl border bg-white p-5'
  return (
    <div className="space-y-5 p-6">
      <div><h1 className="text-2xl font-semibold">Money</h1>
        <p className="text-sm text-slate-500">{g.ctx.role === 'owner' ? 'Every sale of your team' : 'The sales you made'}. Each amount is in its own currency; nothing is added across currencies.</p></div>

      {totals.length === 0 ? <p className={`${card} text-sm text-slate-600`}>No sales yet. When you make a payment link from a lead and the client pays, it appears here by itself.</p> : (
        <div className="grid gap-4 lg:grid-cols-2" aria-label="Totals">
          {totals.map(t => (
            <section key={t.currency} className={card} aria-label={`Totals in ${t.currency}`}>
              <h2 className="text-sm font-semibold text-slate-600">{t.currency}</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><dt className="text-slate-500">Sold (paid)</dt><dd className="text-xl font-semibold">{formatMoney(t.receivedCents, t.currency)}</dd></div>
                <div><dt className="text-slate-500">Your share</dt><dd className="text-xl font-semibold">{formatMoney(t.sellerCents, t.currency)}</dd></div>
                <div><dt className="text-slate-500">Paid to your company</dt><dd className="font-medium">{formatMoney(t.paidOutCents, t.currency)}</dd></div>
                <div><dt className="text-slate-500">Still to come</dt><dd className="font-medium">{formatMoney(t.owedToSellerCents, t.currency)}</dd></div>
              </dl>
              {t.unsetCount > 0 && <p className="mt-3 text-xs text-amber-800">{t.unsetCount} sale{t.unsetCount === 1 ? '' : 's'} paid but the split is not set yet. Antonio sets it; it is not in “Your share” until then.</p>}
              {t.openLinks > 0 && <p className="mt-1 text-xs text-slate-500">{t.openLinks} link{t.openLinks === 1 ? '' : 's'} sent, not paid yet.</p>}
              {t.refundedCount > 0 && <p className="mt-1 text-xs text-slate-500">{t.refundedCount} refunded sale{t.refundedCount === 1 ? '' : 's'} (not counted).</p>}
            </section>
          ))}
        </div>
      )}

      {sales.length > 0 && (
        <section className={card} aria-label="Sales">
          <h2 className="text-sm font-semibold text-slate-600">Sales</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">Date</th><th className="pr-4">Lead</th><th className="pr-4">Kind</th><th className="pr-4">Amount</th><th className="pr-4">Your share</th><th>Status</th></tr></thead>
              <tbody className="divide-y">
                {sales.map(s => (
                  <tr key={s.id}>
                    <td className="py-2 pr-4 text-slate-500">{formatWhen(s.paid_at ?? s.created_at)}</td>
                    <td className="pr-4">{names.get(s.lead_id) ?? 'Lead'}</td>
                    <td className="pr-4">{kinds.find(k => k.key === s.kind)?.label ?? s.kind}</td>
                    <td className="pr-4 font-medium">{formatMoney(s.amount_cents, s.currency)}</td>
                    <td className="pr-4">{s.status === 'refunded' ? '—' : s.seller_cents === null ? <span className="text-amber-800">Terms not set</span> : formatMoney(s.seller_cents, s.currency)}</td>
                    <td>{saleStatusLabel(s)}{s.needs_attention && <span className="block text-xs text-amber-800">{s.needs_attention}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
