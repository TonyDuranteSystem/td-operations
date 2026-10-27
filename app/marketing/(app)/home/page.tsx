import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { loadOwnerHome } from '@/lib/marketing/home-server'
import { OwnerHomePanels } from '@/components/marketing/owner-home-panels'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Home (dev job 9aec66fa; Antonio, 27 Oct 2026: "where should I see my dashboard, to see, check, answer messages"): the workspace's first screen for the owner. Four numbers, then the same
 * panels the CRM's Marketing page shows (messages for him, what is waiting on Rocco, today's calls). Every line opens the lead or the chat it is about.
 */
export default async function MarketingHome() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.pick')) redirect('/marketing/leads')
  const lang = getLang()
  const t = makeT(lang)
  const { model: m, truncated, chatAny } = await loadOwnerHome(g.ctx, new Date(), t('Unnamed lead'))
  const num = 'rounded-xl bg-slate-50 p-4'
  return (
    <div className="space-y-4 p-6 pb-20" data-testid="owner-home">
      <div><h1 className="text-2xl font-semibold">{t('Home')}</h1><p className="mt-1 text-sm text-slate-500">{t('What needs you right now.')}</p></div>
      {truncated && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Some older leads or activity are not counted below because there is too much of it to read at once. Tell Antonio.')}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="home-numbers">
        <div className={num}><p className="text-xs text-slate-500">{t('New leads today')}</p><p className="text-2xl font-semibold" data-testid="home-new-today">{m.numbers.newToday}</p></div>
        <div className={num}><p className="text-xs text-slate-500">{t('With Rocco')}</p><p className="text-2xl font-semibold" data-testid="home-with-seller">{m.numbers.withSeller}</p></div>
        <div className={num}><p className="text-xs text-slate-500">{t('Links sent today')}</p><p className="text-2xl font-semibold" data-testid="home-links-today">{m.numbers.linksToday}</p></div>
        <div className={num}><p className="text-xs text-slate-500">{t('Paid today')}</p><p className="text-2xl font-semibold" data-testid="home-paid-today">{m.numbers.paidToday}</p></div>
      </div>
      <OwnerHomePanels model={m} mode="workspace" t={t} locale={localeFor(lang)} chatAny={chatAny} />
    </div>
  )
}
