import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { isSecureAdmin } from '@/lib/auth'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { modulesFor } from '@/lib/marketing/workspace'
import { accessLabel, type Bundles } from '@/lib/marketing/access'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { SignOutButton } from './sign-out-button'
import { WorkspaceNav } from './workspace-nav'
import { ExitViewButton } from './exit-view-button'
import { LangProvider } from '@/components/marketing/lang-provider'
import { LangSwitch } from '@/components/marketing/lang-switch'
import { MarketingPushBanner } from '@/components/marketing/push-banner'
import { MARKETING_PERMISSIONS, hasPermission } from '@/lib/marketing/permissions'
import { LeadWindowsHost } from '@/components/marketing/lead-windows-host'
import { LeadSearch } from '@/components/marketing/lead-search'
import { ThemeSwitch } from '@/components/marketing/theme-switch'
import { getTheme } from '@/lib/marketing/theme-server'
import { availableBoardRoles, boardRole } from '@/lib/marketing/board'
import { marketingChatUnread } from '@/lib/marketing/menu-unread'
import { OwnerNav } from '@/components/marketing/owner-nav'
import { NewsStrip } from '@/components/marketing/news-strip'
import { draftCount, listNewsFor, type NewsItem } from '@/lib/marketing/news-server'
import { newsText } from '@/lib/marketing/news'
import { TourButton, TourProvider } from '@/components/marketing/tour'
import { PREVIEW_TOURS, resolveTour, tourKeyFor, type ResolvedStep, type TourKey } from '@/lib/marketing/tour'
import { tourSeen } from '@/lib/marketing/tour-seen'
import { getLang } from '@/lib/marketing/lang'
import { makeT, tAccessLabel } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the workspace frame for the team (dev job 9aec66fa): a sidebar with the screens this person's permissions open, the team name, who he is,
 * and sign out; the screen on the right. Built for a computer. A person who cannot come in gets the page's own message instead of the frame.
 */
export default async function MarketingAppLayout({ children }: { children: React.ReactNode }) {
  const g = await resolveMarketingContext()
  const lang = getLang()
  const t = makeT(lang)
  if (g.ok === false) return <LangProvider lang={lang}>{children}</LangProvider>
  const { ctx } = g
  const bundlesSetting = (await getMarketingSetting('permission_bundles', ctx.team.id)) as Bundles
  const chatAny = hasPermission(ctx.permissions, 'chat')
  const chatOn = chatAny && hasPermission(ctx.permissions, 'leads.read')
  // Antonio comes here from the CRM's Marketing tab (his own login or "View as"): one click takes him back
  const { data: { user: authUser } } = await createClient().auth.getUser()
  const fromCrm = !!authUser && isSecureAdmin(authUser)
  // the guided tour: the person's own (by his exact access), started by itself ONCE; the owner can also preview each role's tour from the Team screen. "View as" never records anything.
  const tourKey = tourKeyFor({ memberRole: ctx.viewAs && ctx.membership.bundle ? 'member' : ctx.role, permissions: ctx.permissions, bundles: bundlesSetting })
  const ownSteps = resolveTour(tourKey, ctx.permissions, lang)
  // the two reads are independent: run them together so the tour costs the page no extra wait
  // Antonio (his own login, not "View as") gets HIS menu around these screens, so he never has to go into Rocco's dashboard to reach one; he posts the news, so he has no strip and no unread news
  const ownerMode = fromCrm && !ctx.viewAs
  const [chatUnread, seen, news, drafts] = await Promise.all([
    marketingChatUnread(ctx),
    ctx.viewAs || ownSteps.length === 0 ? Promise.resolve(true) : tourSeen(ctx.user.id, ctx.team.id, tourKey),
    ownerMode ? Promise.resolve([] as NewsItem[]) : listNewsFor(ctx),
    ownerMode ? draftCount() : Promise.resolve(0),
  ])
  const unreadNews = news.filter(n => n.unread)
  const autoStart = !ctx.viewAs && ownSteps.length > 0 && !seen
  const previews: Partial<Record<TourKey, ResolvedStep[]>> | null = ctx.role === 'owner' && hasPermission(ctx.permissions, 'team.manage')
    ? Object.fromEntries(PREVIEW_TOURS.map(k => [k, resolveTour(k, MARKETING_PERMISSIONS, lang)])) : null
  const nav = modulesFor(ctx.permissions).map(m => (m.key === 'chat' || m.key === 'home' ? { ...m, badge: chatUnread } : m.key === 'news' ? { ...m, badge: unreadNews.length } : m))
  return (
    <LangProvider lang={lang}>
    <TourProvider own={{ key: tourKey, steps: ownSteps }} previews={previews} autoStart={autoStart} recordable={!ctx.viewAs}>
    <div>
      {ctx.viewAs && (
        <div className="flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900" role="status">
          <span>{t('Viewing as {who}. You are Antonio: nothing is blocked, and what you do is recorded under your own email.', { who: ctx.viewAs.label })}</span>
          <ExitViewButton />
        </div>
      )}
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-4 border-r bg-white p-4">
        <div>
          {fromCrm && <Link href="/marketing-leads" className="mb-2 inline-block text-xs text-slate-500 underline" data-testid="back-to-crm">&#9666; {t('Back to the CRM')}</Link>}
          <p className="text-xs uppercase tracking-wide text-slate-400">TD Marketing</p>
          <p className="truncate font-semibold">{ctx.team.name}</p>
        </div>

        {ownerMode ? <OwnerNav badges={{ messages: chatUnread, news: drafts }} /> : <WorkspaceNav items={nav} />}
        <div className="mt-auto space-y-2 text-sm">
          <TourButton />
          <p className="truncate text-slate-500" title={ctx.user.email ?? ''}>{ctx.user.email}</p>
          <p className="text-xs text-slate-400">{ctx.role === 'owner' ? t('Team owner') : tAccessLabel(t, accessLabel(ctx.permissions, bundlesSetting))}</p>
          <ThemeSwitch initial={getTheme()} />
          <LangSwitch />
          <SignOutButton />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <LeadWindowsHost defaultRole={boardRole(ctx.permissions)} roles={availableBoardRoles(ctx.permissions)} chatOn={chatOn} pollOn={chatAny}>
          {unreadNews.length > 0 && <NewsStrip title={newsText(unreadNews[0], lang).title} more={unreadNews.length - 1} t={t} />}
          {hasPermission(ctx.permissions, 'chat') && <MarketingPushBanner />}
          {hasPermission(ctx.permissions, 'leads.read') && <div className="flex items-center gap-3 border-b bg-white px-6 py-2"><LeadSearch /></div>}
          {children}
        </LeadWindowsHost>
      </div>
    </div>
    </div>
    </TourProvider>
    </LangProvider>
  )
}
