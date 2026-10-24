import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'
import { listTeamLeadsCapped } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { clientFlagText, formatWhen, stageLabel, type StageOption } from '@/lib/marketing/lead-view'
import { canSeeNotes, withoutPhone } from '@/lib/marketing/lead-privacy'
import { loadLeadActivity } from '@/lib/marketing/note-read'
import { contactChips, EMPTY_CONTACT } from '@/lib/marketing/contact-state'
import type { BoardCard } from '@/lib/marketing/board'
import { LeadBoard } from '@/components/marketing/lead-board'
import { unreadByLead } from '@/lib/marketing/lead-chat-server'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the lead board (dev job 9aec66fa, Addendum G): the team's leads as columns for the setter or for the seller, with a Cards and a List view; a click opens the
 * lead in a floating window (components/marketing/lead-board.tsx). The team id comes from the guard and is in every query. Phone numbers and the team's notes are left out of the
 * page for people who may not see them (the same rules as the Leads page).
 */
export default async function MarketingBoard() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const lang = getLang()
  const t = makeT(lang)
  if (!hasPermission(g.ctx.permissions, 'leads.read')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the leads. Ask your team owner.')}</p></main>
  }
  const db = leadDb()
  const teamId = g.ctx.team.id
  const userId = g.ctx.user.id
  const stages = (await getMarketingSetting('pipeline_stages', teamId)) as StageOption[]
  const res = await listTeamLeadsCapped(db, teamId, 500, { order: 'newest' })
  const leads = withoutPhone(res.rows, g.ctx.permissions)
  const seesNotes = canSeeNotes(g.ctx.permissions)
  // the chat: my unread numbers on the cards (only for people who may chat)
  const chatOn = hasPermission(g.ctx.permissions, 'chat')
  const unread = chatOn ? await unreadByLead(g.ctx) : new Map<string, number>()
  const activity = leads.length > 0 ? await loadLeadActivity(db, leads.map(l => l.id)) : null
  const fw = (iso: string | null | undefined) => formatWhen(iso, 'Europe/Rome', localeFor(lang))
  const cards: BoardCard[] = leads.map(l => {
    const contact = activity?.contact.get(l.id) ?? EMPTY_CONTACT
    return {
      id: l.id,
      name: l.full_name || l.email || l.phone || t('Unnamed lead'),
      stage: l.status,
      stageLabel: stageLabel(stages, l.status),
      phone: l.phone,
      filledIn: fw(l.meta_created_time ?? l.received_at),
      apptAt: contact.appointmentAt,
      arrivedMs: new Date(l.meta_created_time ?? l.received_at).getTime(),
      chips: contactChips(contact, iso => fw(iso), t),
      pickedText: l.claimed_by === null ? t('Not picked') : l.claimed_by === userId ? t('Picked by you') : t('Picked by {name}', { name: l.claimed_by_label ?? t('a team member') }),
      note: seesNotes ? activity?.notes.get(l.id)?.text ?? null : null,
      ad: l.ad_name,
      existingClient: clientFlagText(l.existing_client) !== null,
      handedOver: contact.handedOverAt !== null,
      unread: unread.get(l.id) ?? 0,
    }
  })
  return (
    <div className="space-y-4 p-6 pb-20">
      <div><h1 className="text-2xl font-semibold">{t('Board')}</h1><p className="mt-1 text-sm text-slate-500">{t('Click a lead to open it in a window. You can keep up to three open.')}</p></div>
      <LeadBoard cards={cards} truncated={res.truncated} />
    </div>
  )
}
