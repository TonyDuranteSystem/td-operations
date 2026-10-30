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
import { isSetterOnly } from '@/lib/marketing/lead-chat'
import { setterActorsOf } from '@/lib/marketing/setter-view'
import { contactChips, EMPTY_CONTACT } from '@/lib/marketing/contact-state'
import type { BoardCard } from '@/lib/marketing/board'
import type { SellerResultStages } from '@/lib/marketing/settings-schema'
import { sellerOf } from '@/lib/marketing/lead-actions'
import { LeadBoard } from '@/components/marketing/lead-board'
import { unreadDetailByLead } from '@/lib/marketing/lead-chat-server'
import { loadViewerZone } from '@/lib/marketing/time-prefs-server'

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
  const sellerStages = (await getMarketingSetting('seller_result_stages', teamId)) as SellerResultStages
  const paidStages = Object.values((await getMarketingSetting('sale_kind_stages', teamId)) as Record<string, string>)
  const res = await listTeamLeadsCapped(db, teamId, 500, { order: 'newest' })
  // the seller's results can sit for months (a lead "not ready now" until next spring): they must not fall off the newest-500 window, so each is also read on its own
  const longLivedStages = Array.from(new Set([...Object.values(sellerOf({ sellerStages })), ...paidStages]))
  const longLived = await Promise.all(longLivedStages.map(stage => listTeamLeadsCapped(db, teamId, 500, { stage, order: 'newest' })))
  const seenIds = new Set(res.rows.map(r => r.id))
  const extra = longLived.flatMap(r => r.rows).filter(r => !seenIds.has(r.id) && seenIds.add(r.id))
  const leads = withoutPhone([...res.rows, ...extra], g.ctx.permissions)
  const seesNotes = canSeeNotes(g.ctx.permissions)
  // the chat: my unread numbers on the cards (only for people who may chat)
  const chatOn = hasPermission(g.ctx.permissions, 'chat')
  const unread = chatOn ? await unreadDetailByLead(g.ctx) : new Map<string, { n: number; from: 'setter' | 'owner' }>()
  // a setter reads only what setters wrote under a card (never the seller's or Antonio's notes)
  const onlyBy = isSetterOnly(g.ctx.permissions) ? await setterActorsOf(g.ctx.team.id) : undefined
  const activity = leads.length > 0 ? await loadLeadActivity(db, leads.map(l => l.id), onlyBy) : null
  const zone = await loadViewerZone(g.ctx)
  const fw = (iso: string | null | undefined) => formatWhen(iso, zone, localeFor(lang))
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
      chips: [...contactChips(contact, iso => fw(iso), t), ...(l.status === sellerStages.not_ready && l.callback_at ? [{ key: 'come-back', text: t('Come back {when}', { when: fw(l.callback_at) }), tone: 'info' as const }] : [])],
      pickedText: l.claimed_by === null ? t('Not picked') : l.claimed_by === userId ? t('Picked by you') : t('Picked by {name}', { name: l.claimed_by_label ?? t('a team member') }),
      note: seesNotes ? activity?.notes.get(l.id)?.text ?? null : null,
      ad: l.ad_name,
      existingClient: clientFlagText(l.existing_client) !== null,
      handedOver: contact.handedOverAt !== null,
      unread: unread.get(l.id)?.n ?? 0,
      incomingFrom: unread.get(l.id)?.from ?? null,
    }
  })
  return (
    <div className="space-y-4 p-6 pb-20">
      <div><h1 className="text-2xl font-semibold">{t('Board')}</h1><p className="mt-1 text-sm text-slate-500">{t('Click a lead to open it in a window. You can keep up to three open.')}</p></div>
      <LeadBoard cards={cards} truncated={res.truncated} />
    </div>
  )
}
