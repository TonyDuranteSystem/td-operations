import { canSeePhone } from '@/lib/marketing/lead-privacy'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { listTeamSales } from '@/lib/marketing/sales-server'
import { formatMoney, payoutTotals, saleStatusLabel, sellerPaidInOtherCurrency, totalsByCurrency } from '@/lib/marketing/sales'
import { formatWhen } from '@/lib/marketing/lead-view'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Money (the team's view; dev job 9aec66fa): the sales of this team, the person's share of each, and what has been paid out to the
 * seller's company. The team owner sees the whole team's sales; a member with the Money permission sees only the sales he made himself.
 * Every total is per currency. Team-scoped by the guard.
 */
export default async function MarketingMoney() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const lang = getLang()
  const t = makeT(lang)
  if (!hasPermission(g.ctx.permissions, 'money.read')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to Money. Ask your team owner.')}</p></main>
  }
  const db = leadDb()
  const teamId = g.ctx.team.id
  const sales = await listTeamSales(db, teamId, g.ctx.role === 'owner' ? {} : { mineUserId: g.ctx.user.id })
  const [kinds, payoutCurrency, leadsRes] = await Promise.all([
    getMarketingSetting('sale_kinds', teamId) as Promise<{ key: string; label: string }[]>,
    getMarketingSetting('seller_payout_currency', teamId) as Promise<string>,
    sales.length ? db.from('marketing_leads').select('id, full_name, email, phone').eq('team_id', teamId).in('id', Array.from(new Set(sales.map(s => s.lead_id)))) : Promise.resolve({ data: [] }),
  ])
  const names = new Map(((leadsRes.data ?? []) as { id: string; full_name: string | null; email: string | null; phone: string | null }[]).map(l => [l.id, l.full_name || l.email || (canSeePhone(g.ctx.permissions) ? l.phone : null) || t('Unnamed lead')]))
  const totalsList = totalsByCurrency(sales, new Date(), payoutCurrency)
  const payout = payoutTotals(sales, payoutCurrency)
  const card = 'rounded-xl border bg-white p-5'
  return (
    <div className="space-y-5 p-6">
      <div><h1 className="text-2xl font-semibold">{t('Money')}</h1>
        <p className="text-sm text-slate-500">{g.ctx.role === 'owner' ? t('Every sale of your team') : t('The sales you made')}{t('. Each amount is in its own currency; nothing is added across currencies.')}</p></div>

      {totalsList.length === 0 ? <p className={`${card} text-sm text-slate-600`}>{t('No sales yet. When you make a payment link from a lead and the client pays, it appears here by itself.')}</p> : (
        <div className="grid gap-4 lg:grid-cols-2" aria-label={t('Totals')}>
          {totalsList.map(tt => (
            <section key={tt.currency} className={card} aria-label={t('Totals in {currency}', { currency: tt.currency })}>
              <h2 className="text-sm font-semibold text-slate-600">{tt.currency}</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><dt className="text-slate-500">{t('Sold (paid)')}</dt><dd className="text-xl font-semibold">{formatMoney(tt.receivedCents, tt.currency)}</dd></div>
                {!sellerPaidInOtherCurrency(tt.currency, payoutCurrency) && <>
                  <div><dt className="text-slate-500">{t('Your share')}</dt><dd className="text-xl font-semibold">{formatMoney(tt.sellerCents, tt.currency)}</dd></div>
                  <div><dt className="text-slate-500">{t('Paid to your company')}</dt><dd className="font-medium">{formatMoney(tt.paidOutCents, tt.currency)}</dd></div>
                  <div><dt className="text-slate-500">{t('Still to come')}</dt><dd className="font-medium">{formatMoney(tt.owedToSellerCents, tt.currency)}</dd></div>
                </>}
              </dl>
              {tt.unsetCount > 0 && <p className="mt-3 text-xs text-amber-800">{t(tt.unsetCount === 1 ? '{n} sale paid but the split is not set yet. Antonio sets it; it is not in “Your share” until then.' : '{n} sales paid but the split is not set yet. Antonio sets it; it is not in “Your share” until then.', { n: tt.unsetCount })}</p>}
              {tt.openLinks > 0 && <p className="mt-1 text-xs text-slate-500">{t(tt.openLinks === 1 ? '{n} link sent, not paid yet.' : '{n} links sent, not paid yet.', { n: tt.openLinks })}</p>}
              {tt.refundedCount > 0 && <p className="mt-1 text-xs text-slate-500">{t(tt.refundedCount === 1 ? '{n} refunded sale (not counted).' : '{n} refunded sales (not counted).', { n: tt.refundedCount })}</p>}
            </section>
          ))}
          {payout && (
            <section className={card} aria-label={t('Your share in {currency}', { currency: payout.currency })}>
              <h2 className="text-sm font-semibold text-slate-600">{t('Your share, to invoice in {currency}', { currency: payout.currency })}</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><dt className="text-slate-500">{t('Your share')}</dt><dd className="text-xl font-semibold">{formatMoney(payout.sellerCents, payout.currency)}</dd></div>
                <div><dt className="text-slate-500">{t('Still to invoice')}</dt><dd className="text-xl font-semibold">{formatMoney(payout.owedCents, payout.currency)}</dd></div>
                <div><dt className="text-slate-500">{t('Paid to your company')}</dt><dd className="font-medium">{formatMoney(payout.paidOutCents, payout.currency)}</dd></div>
              </dl>
              <p className="mt-3 text-xs text-slate-500">{t('Invoice this amount in {currency}: the same number as your share, with no exchange rate.', { currency: payout.currency })}</p>
            </section>
          )}
        </div>
      )}

      {sales.length > 0 && (
        <section className={card} aria-label={t('Sales')}>
          <h2 className="text-sm font-semibold text-slate-600">{t('Sales')}</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-4">{t('Date')}</th><th className="pr-4">{t('Lead')}</th><th className="pr-4">{t('Kind')}</th><th className="pr-4">{t('Amount')}</th><th className="pr-4">{t('Your share')}</th><th>{t('Status')}</th></tr></thead>
              <tbody className="divide-y">
                {sales.map(s => (
                  <tr key={s.id}>
                    <td className="py-2 pr-4 text-slate-500">{formatWhen(s.paid_at ?? s.created_at, 'Europe/Rome', localeFor(lang))}</td>
                    <td className="pr-4">{names.get(s.lead_id) ?? t('Lead')}</td>
                    <td className="pr-4">{t(kinds.find(k => k.key === s.kind)?.label ?? s.kind)}</td>
                    <td className="pr-4 font-medium">{formatMoney(s.amount_cents, s.currency)}</td>
                    <td className="pr-4">{s.status === 'refunded' ? '—' : s.seller_cents === null ? <span className="text-amber-800">{t('Terms not set')}</span> : formatMoney(s.seller_cents, sellerPaidInOtherCurrency(s.currency, payoutCurrency) ? payoutCurrency : s.currency)}</td>
                    <td>{t(saleStatusLabel(s))}{s.needs_attention && <span className="block text-xs text-amber-800">{s.needs_attention}</span>}</td>
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
