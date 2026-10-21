import { resolveMarketingContext } from '@/lib/marketing/guard'
import { modulesFor } from '@/lib/marketing/workspace'
import { roleLabel } from '@/lib/marketing/permission-labels'
import { SignOutButton } from './sign-out-button'
import { WorkspaceNav } from './workspace-nav'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the workspace frame for the team (dev job 9aec66fa): a sidebar with the screens this person's permissions open, the team name, who he is,
 * and sign out; the screen on the right. Built for a computer. A person who cannot come in gets the page's own message instead of the frame.
 */
export default async function MarketingAppLayout({ children }: { children: React.ReactNode }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) return <>{children}</>
  const { ctx } = g
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-4 border-r bg-white p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">TD Marketing</p>
          <p className="truncate font-semibold">{ctx.team.name}</p>
        </div>
        <WorkspaceNav items={modulesFor(ctx.permissions)} />
        <div className="mt-auto space-y-2 text-sm">
          <p className="truncate text-slate-500" title={ctx.user.email ?? ''}>{ctx.user.email}</p>
          <p className="text-xs text-slate-400">{ctx.role === 'owner' ? 'Team owner' : roleLabel(ctx.membership.bundle)}</p>
          <SignOutButton />
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
