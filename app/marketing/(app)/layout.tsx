import { SupabaseIncidentBar } from '@/components/infra/supabase-incident-bar'
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
import { frameFor } from '@/lib/marketing/frame'
import { OwnerNav } from '@/components/marketing/owner-nav'
import { MessageVoice, VoiceSwitch } from '@/components/marketing/message-voice'
import { LangProvider } from '@/components/marketing/lang-provider'
import { LangSwitch } from '@/components/marketing/lang-switch'
import { AppYouButton } from '@/components/app-mode/app-you-button'
import { MarketingPushBanner } from '@/components/marketing/push-banner'
import { MARKETING_PERMISSIONS, hasPermission } from '@/lib/marketing/permissions'
import { LeadWindowsHost } from '@/components/marketing/lead-windows-host'
import { LeadSearch } from '@/components/marketing/lead-search'
import { ThemeSwitch } from '@/components/marketing/theme-switch'
import { getTheme } from '@/lib/marketing/theme-server'
import { availableBoardRoles, boardRole } from '@/lib/marketing/board'
import { marketingChatUnread } from '@/lib/marketing/menu-unread'
import { NewsStrip } from '@/components/marketing/news-strip'
import { draftCount, listNewsFor, type NewsItem } from '@/lib/marketing/news-server'
import { newsText } from '@/lib/marketing/news'
import { TourButton, TourProvider } from '@/components/marketing/tour'
import { PREVIEW_TOURS, resolveTour, tourKeyFor, type ResolvedStep, type TourKey } from '@/lib/marketing/tour'
import { tourSeen } from '@/lib/marketing/tour-seen'
import { getLang } from '@/lib/marketing/lang'
import { loadLayoutTime } from '@/lib/marketing/time-prefs-server'
import { SellerBanner } from '@/components/marketing/lead-clocks'
import { ZoneReporter } from '@/components/marketing/zone-reporter'
import { makeT, tAccessLabel } from '@/lib/marketing/i18n'
import { getAppMode } from '@/lib/app-mode/server'

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
  // Antonio on his own login gets HIS frame (his own menu on every Marketing screen), never Rocco's; "View as" and everybody else get the team's frame (lib/marketing/frame.ts holds the rule).
  // He posts the news, so he has no strip and no unread news; the red number on What's New is, for him, the drafts waiting for his OK
  const ownerLogin = frameFor({ admin: fromCrm, viewAs: !!ctx.viewAs }) === 'owner'
  const [chatUnread, seen, news, drafts, layoutTime] = await Promise.all([
    marketingChatUnread(ctx),
    ctx.viewAs || ownSteps.length === 0 ? Promise.resolve(true) : tourSeen(ctx.user.id, ctx.team.id, tourKey),
    ownerLogin ? Promise.resolve([] as NewsItem[]) : listNewsFor(ctx),
    ownerLogin ? draftCount() : Promise.resolve(0),
    loadLayoutTime(ctx),
  ])
  const unreadNews = news.filter(n => n.unread)
  const autoStart = !ctx.viewAs && !ownerLogin && ownSteps.length > 0 && !seen
  const previews: Partial<Record<TourKey, ResolvedStep[]>> | null = ctx.role === 'owner' && hasPermission(ctx.permissions, 'team.manage')
    ? Object.fromEntries(PREVIEW_TOURS.map(k => [k, resolveTour(k, MARKETING_PERMISSIONS, lang)])) : null
  const nav = modulesFor(ctx.permissions).map(m => (m.key === 'chat' ? { ...m, badge: chatUnread } : m.key === 'news' ? { ...m, badge: ownerLogin ? drafts : unreadNews.length } : m))
  // Inside the TD Social phone app (dev job 2072bc3e, Step 1b) Marketing is the Chat and nothing else: no side menu (the app has its
  // own tabs), a slim top bar with the language switch, the Supabase notice as one line, and the page takes the whole screen. The tour,
  // the sound switch, the notification strip, the news strip and the lead search stay out (the app owns alerts). The leads' own
  // windows open full screen (components/marketing/lead-windows-host.tsx). The "Viewing as" notice stays (one line, with its way out). The app-mode
  // marker itself is put on by app/marketing/layout.tsx (it must also cover the lead page, which sits outside this layout). The computer layout below is unchanged.
  if (getAppMode()) {
    return (
      <LangProvider lang={lang}>
        <TourProvider own={{ key: tourKey, steps: ownSteps }} previews={null} autoStart={false} recordable={false}>
          <div className="flex h-screen flex-col bg-white">
            <div className="app-marketing-top flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
              <p className="min-w-0 truncate text-base font-semibold" data-testid="app-marketing-title">TD Marketing</p>
              <div className="flex items-center gap-2"><LangSwitch /><AppYouButton /></div>
            </div>
            {/* "View as" is a safety notice, not decoration: Antonio sees the team's Marketing as its owner, and what he does is recorded under his own email. It stays in the app, as one line with the way out. */}
            {ctx.viewAs && (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-1 text-sm text-amber-900" role="status" data-testid="app-view-as">
                <span className="min-w-0 truncate font-semibold">{t('Viewing as')}: {ctx.viewAs.label.charAt(0).toUpperCase() + ctx.viewAs.label.slice(1)}</span>
                <ExitViewButton />
              </div>
            )}
            <SupabaseIncidentBar audience="staff" />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <LeadWindowsHost defaultRole={boardRole(ctx.permissions)} roles={availableBoardRoles(ctx.permissions)} chatOn={chatOn} pollOn={chatAny}>
                <ZoneReporter knownZone={layoutTime.selfZone} />
                {children}
              </LeadWindowsHost>
            </div>
          </div>
        </TourProvider>
      </LangProvider>
    )
  }
  return (
    <LangProvider lang={lang}>
    <TourProvider own={{ key: tourKey, steps: ownSteps }} previews={previews} autoStart={autoStart} recordable={!ctx.viewAs}>
    <MessageVoice wakeText={ownerLogin ? undefined : t('Sound is on. Click anywhere on this page to start it.')} />
    <div>
      {ctx.viewAs && (
        <div className="flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900" role="status">
          <span>{t('Viewing as {who}. You are Antonio: nothing is blocked, what you do is recorded under your own email, and anything personal (messages, chats) is yours, not theirs.', { who: ctx.viewAs.label })}</span>
          <ExitViewButton />
        </div>
      )}
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-white p-4" data-testid={ownerLogin ? 'frame-owner' : 'frame-team'}>
        <div>
          {fromCrm && !ownerLogin && <Link href="/marketing-leads" className="mb-3 block rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50" data-testid="back-to-crm">&#9666; {t('Back to Marketing')}</Link>}
          {ownerLogin && <Link href="/marketing-leads" className="mb-2 inline-block text-xs text-slate-500 underline" data-testid="back-to-home">&#9666; Home</Link>}
          <p className="text-xs uppercase tracking-wide text-slate-400">TD Marketing</p>
          <p className="truncate font-semibold">{ownerLogin ? 'Owner' : ctx.team.name}</p>
          {ctx.viewAs && <p className="mt-1.5 inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900" data-testid="view-as-chip">{t('Viewing as')}: {ctx.viewAs.label.charAt(0).toUpperCase() + ctx.viewAs.label.slice(1)}</p>}
        </div>

        {ownerLogin ? <OwnerNav badges={{ messages: chatUnread, news: drafts }} /> : <WorkspaceNav items={nav} />}
        <div className="mt-auto space-y-2 text-sm">
          {!ownerLogin && <TourButton />}
          <p className="truncate text-slate-500" title={ctx.user.email ?? ''}>{ctx.user.email}</p>
          <p className="text-xs text-slate-400">{ownerLogin ? 'Business owner' : ctx.role === 'owner' ? t('Team owner') : tAccessLabel(t, accessLabel(ctx.permissions, bundlesSetting))}</p>
          <VoiceSwitch label={ownerLogin ? 'Sound' : t('Sound')} onText={ownerLogin ? 'On' : t('On')} offText={ownerLogin ? 'Off' : t('Off')} />
          <ThemeSwitch initial={getTheme()} />
          <LangSwitch />
          <SignOutButton />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <LeadWindowsHost defaultRole={boardRole(ctx.permissions)} roles={availableBoardRoles(ctx.permissions)} chatOn={chatOn} pollOn={chatAny}>
          <SupabaseIncidentBar audience="staff" />
          <ZoneReporter knownZone={layoutTime.selfZone} />
          {layoutTime.banner.length > 0 && <SellerBanner clocks={layoutTime.banner} nowIso={new Date().toISOString()} liveYou={!ctx.viewAs} />}
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
