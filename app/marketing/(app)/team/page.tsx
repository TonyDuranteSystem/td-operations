import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { cleanPermissions, effectivePermissions, hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listMembers, listOpenInvites } from '@/lib/marketing/members'
import { grantablePermissions } from '@/lib/marketing/permission-labels'
import { TeamManager } from '@/components/marketing/team-manager'
import { TeamTimes } from '@/components/marketing/team-times'
import { loadPrefsAndTakers } from '@/lib/marketing/time-prefs-server'
import { checkShare, googleApi, isWorkMailbox } from '@/lib/marketing/gcal'
import { personName } from '@/lib/marketing/setter-note'
import { TourPreviewBox } from '@/components/marketing/tour'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/** TD Marketing — the Team page (dev job 9aec66fa, Slice 2b): who is on the team, what each can do, invite, pause, remove. Owner, or a member who holds "manage the team". */
export default async function MarketingTeam() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const t = makeT(getLang())
  if (!hasPermission(g.ctx.permissions, 'team.manage')) {
    return (
      <main className="mx-auto max-w-xl px-4 py-10">
        <Link href="/marketing" className="text-sm text-slate-500">{t('← Back')}</Link>
        <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You cannot manage the team. Ask your team owner.')}</p>
      </main>
    )
  }
  const teamId = g.ctx.team.id
  const [members, invites, bundles] = await Promise.all([
    listMembers(teamId), listOpenInvites(teamId), getMarketingSetting('permission_bundles', teamId) as Promise<Record<string, string[]>>,
  ])
  // time zones and calendars (Addendum K): Antonio's section. The share of each personal calendar is asked of Google every time the page opens (the "Check again" button reloads it).
  const times = g.ctx.admin === true ? await loadPrefsAndTakers(teamId) : null
  const share = times ? (await Promise.all(times.takers.map(async tk => (await checkShare(googleApi, tk.email, times.prefs.personalCalendars[tk.userId] ?? [])).map(r => ({ userId: tk.userId, id: r.id, state: r.state }))))).flat() : []
  const roles = Object.entries(bundles).map(([key, perms]) => ({ key, permissions: cleanPermissions(perms) }))
  const grantable: string[] = grantablePermissions(g.ctx.role === 'owner', g.ctx.permissions)
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/marketing" className="text-sm text-slate-500">← {g.ctx.team.name}</Link>
      <h1 className="mt-2 text-2xl font-semibold">{t('Team')}</h1>
      <TeamManager
        me={g.ctx.user.id}
        iAmOwner={g.ctx.role === 'owner'}
        roles={roles}
        grantable={grantable}
        members={members.filter(m => m.status !== 'removed').map(m => ({
          userId: m.user_id, email: m.email, role: m.member_role, bundle: m.bundle,
          permissions: effectivePermissions({ memberRole: m.member_role, bundle: m.bundle, bundles, extra: m.permissions }), status: m.status as 'active' | 'paused',
          joinedAt: m.joined_at, lastSignInAt: m.last_sign_in_at,
        }))}
        invites={invites.map(i => ({ id: i.id, email: i.email_lower, role: i.member_role, bundle: i.bundle, permissions: i.permissions ?? [], expiresAt: i.expires_at, sentBy: i.created_by, emailedAt: i.emailed_at ?? null }))}
      />
      {times && (
        <div className="mt-6">
          <TeamTimes
            teamId={teamId} adminEmail={g.ctx.user.email ?? null} adminLabel={personName(g.ctx.user.email ?? '')} prefs={times.prefs} share={share}
            members={members.filter(m => m.status !== 'removed').map(m => ({ userId: m.user_id, email: m.email, role: m.member_role, status: m.status, isAdmin: m.is_admin === true, workMailbox: isWorkMailbox(m.email) }))}
          />
        </div>
      )}
      <TourPreviewBox />
    </main>
  )
}
