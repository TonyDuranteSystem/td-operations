import { LangProvider } from '@/components/marketing/lang-provider'
import { hasPermission } from '@/lib/marketing/permissions'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'
import { getTeamLead, leadTimeline } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { loadPaymentLinkView } from '@/lib/marketing/sales-server'
import { personName } from '@/lib/marketing/setter-note'
import type { StageOption } from '@/lib/marketing/lead-view'
import { FrameChangeNotifier } from '@/components/marketing/frame-change-notifier'
import { ThemeSync } from '@/components/marketing/theme-sync'
import { LeadWindowTabs } from '@/components/marketing/lead-window-tabs'
import { laneButtons, unreadLanesOfLead } from '@/lib/marketing/lead-chat-server'
import { resolveBoardRole } from '@/lib/marketing/board'
import { loadTimeView } from '@/lib/marketing/time-prefs-server'
import { LeadPane } from '../../(app)/_lead-pane'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * TD Marketing — one lead on its own bare page, to be shown inside a floating window on the board (dev job 9aec66fa, Addendum G). No menu, no frame: just the lead's page.
 * Same guard as every marketing page; the lead is read for the guard's team only, so another team's lead id finds nothing.
 */
export default async function MarketingLeadWindow({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; role?: string }> }) {
  const lang = getLang()
  const t = makeT(lang)
  const { id } = await params
  const sp = await searchParams
  const g = await resolveMarketingContext()
  const note = (text: string) => <LangProvider lang={lang}><main className="p-5"><p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">{text}</p></main></LangProvider>
  if (g.ok === false) return note(t('Sign in again to see this lead.'))
  if (!hasPermission(g.ctx.permissions, 'leads.read')) return note(t('You do not have access to the leads. Ask your team owner.'))
  if (!UUID.test(id)) return note(t('This lead could not be found.'))
  const db = leadDb()
  const teamId = g.ctx.team.id
  const [stages, reasons, checklist, lead] = await Promise.all([
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOption[]>,
    getMarketingSetting('not_in_target_reasons', teamId) as Promise<StageOption[]>,
    getMarketingSetting('qualification_checklist', teamId) as Promise<string[]>,
    getTeamLead(db, teamId, id),
  ])
  if (!lead) return note(t('This lead could not be found.'))
  const [events, time] = await Promise.all([leadTimeline(db, lead.id), loadTimeView(g.ctx)])
  const paymentLink = hasPermission(g.ctx.permissions, 'payment_links.create') ? { leadId: lead.id, ...(await loadPaymentLinkView(db, { teamId, userId: g.ctx.user.id }, lead.id)) } : undefined
  const chatOn = hasPermission(g.ctx.permissions, 'chat')
  // the chats this person has on the lead (one or two) and her unread number in each
  const [buttons, unreadLanes] = chatOn ? await Promise.all([laneButtons(g.ctx), unreadLanesOfLead(g.ctx, lead.id)]) : [[], { owners: 0, setter: 0 }]
  const lanes = buttons.map(b => ({ lane: b.lane, label: b.label, unread: unreadLanes[b.lane] }))
  return (
    <LangProvider lang={lang}>
      <ThemeSync />
      <FrameChangeNotifier />
      <LeadWindowTabs leadId={lead.id} chatOn={chatOn} initialTab={sp.tab ?? 'lead'} lanes={lanes}>
        <LeadPane role={resolveBoardRole(g.ctx.permissions, sp.role)} lead={lead} events={events} stages={stages} reasons={reasons} checklist={checklist} permissions={g.ctx.permissions} isOwner={g.ctx.role === 'owner'} myId={g.ctx.user.id} myName={personName(g.ctx.user.email ?? '')} viewingAs={!!g.ctx.viewAs} paymentLink={paymentLink} time={time} />
      </LeadWindowTabs>
    </LangProvider>
  )
}
