import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { listNewsFor } from '@/lib/marketing/news-server'
import { linkTargets, newsText } from '@/lib/marketing/news'
import { NewsFeed } from '@/components/marketing/news-feed'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/** TD Marketing — What's New (dev job 9aec66fa, Addendum H): the news Antonio posted for this person's audience, newest first. Opening the page marks the new ones as read. */
export default async function MarketingNews() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const lang = getLang()
  const t = makeT(lang)
  const labels = new Map(linkTargets().map(m => [m.key, m.label]))
  const items = (await listNewsFor(g.ctx)).map(n => ({
    id: n.id, ...newsText(n, lang), href: n.href, linkLabel: n.link_key && labels.get(n.link_key) ? t(labels.get(n.link_key) as string) : null,
    unread: n.unread, postedAt: n.posted_at, edited: !!n.edited_at,
  }))
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6 pb-20" data-testid="news-page">
      <div><h1 className="text-2xl font-semibold">{t("What's New")}</h1><p className="mt-1 text-sm text-slate-500">{t('Important news and new features, posted by Antonio.')}</p></div>
      <NewsFeed items={items} locale={localeFor(lang)} />
    </div>
  )
}
