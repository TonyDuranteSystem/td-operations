import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { templateRows, type TeamTemplates } from '@/lib/marketing/templates'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'
import { TemplatesManager } from '@/components/marketing/templates-manager'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Templates (dev job 9aec66fa, round 2 step 4): the messages the team sends to leads. Everyone who works leads can read them (and uses them from the lead window); ONLY the team
 * owner can create, edit, reset or delete one (the same rule is enforced by POST /api/marketing/templates). Antonio under "View as" is the owner too.
 */
export default async function MarketingTemplates() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const t = makeT(getLang())
  if (!hasPermission(g.ctx.permissions, 'leads.mark')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the templates. Ask your team owner.')}</p></main>
  }
  const [legacy, custom] = await Promise.all([getMarketingSetting('message_templates', g.ctx.team.id), getMarketingSetting('team_templates', g.ctx.team.id)])
  const rows = templateRows(legacy as Record<string, string>, custom as TeamTemplates)
  return (
    <div className="space-y-4 p-6 pb-20">
      <div>
        <h1 className="text-2xl font-semibold">{t('Templates')}</h1>
        <p className="mt-1 text-sm text-slate-500">{t('The messages the team sends to leads. Everyone can use them from the lead window; the placeholders {name}, {setter} and {when} are filled in for each lead.')}</p>
      </div>
      <TemplatesManager rows={rows} canEdit={g.ctx.role === 'owner'} />
    </div>
  )
}
