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
import { hasPermission } from '@/lib/marketing/permissions'
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
  return (
    <LangProvider lang={lang}>
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
          <p className="text-xs uppercase tracking-wide text-slate-400">TD Marketing</p>
          <p className="truncate font-semibold">{ctx.team.name}</p>
        </div>

        <WorkspaceNav items={modulesFor(ctx.permissions)} />
        <div className="mt-auto space-y-2 text-sm">
          <p className="truncate text-slate-500" title={ctx.user.email ?? ''}>{ctx.user.email}</p>
          <p className="text-xs text-slate-400">{ctx.role === 'owner' ? t('Team owner') : tAccessLabel(t, accessLabel(ctx.permissions, bundlesSetting))}</p>
          <LangSwitch />
          <SignOutButton />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {hasPermission(ctx.permissions, 'chat') && <MarketingPushBanner />}
        {children}
      </div>
    </div>
    </div>
    </LangProvider>
  )
}
