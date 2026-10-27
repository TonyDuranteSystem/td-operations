import Link from 'next/link'
import { redirect } from 'next/navigation'
import { LeadLink } from '@/components/marketing/lead-link'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getMarketingSetting } from '@/lib/marketing/settings'
import { listTeamLeadsCapped } from '@/lib/marketing/leads-read'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { romeStartOfMonth, type StageOpt } from '@/lib/marketing/master-view'
import { loadTeamEvents } from '@/lib/marketing/events-read'
import { loadCalendarData } from '@/lib/marketing/calendar-read'
import { listConversations } from '@/lib/marketing/lead-chat-server'
import { listThreads } from '@/lib/marketing/team-chat-server'
import { isInvolved } from '@/lib/marketing/lead-chat'
import { homeModel, type HomeLead, type WaitingGroup } from '@/lib/marketing/home'
import { personName } from '@/lib/marketing/setter-note'
import { romeTime } from '@/lib/marketing/calendar'
import { formatWhen } from '@/lib/marketing/lead-view'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Home (dev job 9aec66fa; Antonio, 27 Oct 2026: "where should I see my dashboard, to see, check, answer messages"): the owner's first screen. Four numbers, the messages waiting
 * for him (chats about leads, direct messages and groups), what is waiting on Rocco, and today's booked calls. Every line opens the lead or the chat it is about.
 */
export default async function MarketingHome() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!hasPermission(g.ctx.permissions, 'leads.pick')) redirect('/marketing/leads')
  const lang = getLang()
  const t = makeT(lang)
  const perms = g.ctx.permissions
  const db = leadDb()
  const teamId = g.ctx.team.id
  const now = new Date()
  const chatAny = hasPermission(perms, 'chat')
  const leadChat = chatAny && hasPermission(perms, 'leads.read') && isInvolved(perms)
  const [leadsRes, stages, ev, cal, conversations, threads] = await Promise.all([
    listTeamLeadsCapped(db, teamId, 2000),
    getMarketingSetting('pipeline_stages', teamId) as Promise<StageOpt[]>,
    loadTeamEvents(db, teamId, { since: romeStartOfMonth(now), kinds: ['payment_link_created', 'payment_received'] }),
    loadCalendarData(db, teamId),
    leadChat ? listConversations(g.ctx) : Promise.resolve([]),
    chatAny ? listThreads(g.ctx).then(s => s.threads) : Promise.resolve([]),
  ])
  const m = homeModel({
    leads: leadsRes.rows as unknown as HomeLead[], events: ev.events, conversations, threads,
    calls: cal.appointments.map(a => ({ lead: a.lead, at: a.at, actor: a.actor })),
    now, firstStage: stages[0]?.key, unnamed: t('Unnamed lead'),
  })
  const card = 'rounded-xl border bg-white p-5'
  const num = 'rounded-xl bg-slate-50 p-4'
  const waitingText = (k: WaitingGroup['key'], n: number) => k === 'link_unpaid' ? t('Link sent, no payment for over {h} hours: {n}', { h: 48, n }) : k === 'paid_no_booking' ? t('Paid, booking link not sent: {n}', { n }) : t('New lead untouched for over a day: {n}', { n })

  return (
    <div className="space-y-4 p-6 pb-20" data-testid="owner-home">
      <div><h1 className="text-2xl font-semibold">{t('Home')}</h1><p className="mt-1 text-sm text-slate-500">{t('What needs you right now.')}</p></div>
      {(leadsRes.truncated || ev.truncated) && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Some older leads or activity are not counted below because there is too much of it to read at once. Tell Antonio.')}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="home-numbers">
        <div className={num}><p className="text-xs text-slate-500">{t('New leads today')}</p><p className="text-2xl font-semibold" data-testid="home-new-today">{m.numbers.newToday}</p></div>
        <div className={num}><p className="text-xs text-slate-500">{t('With Rocco')}</p><p className="text-2xl font-semibold" data-testid="home-with-seller">{m.numbers.withSeller}</p></div>
        <div className={num}><p className="text-xs text-slate-500">{t('Links sent today')}</p><p className="text-2xl font-semibold" data-testid="home-links-today">{m.numbers.linksToday}</p></div>
        <div className={num}><p className="text-xs text-slate-500">{t('Paid today')}</p><p className="text-2xl font-semibold" data-testid="home-paid-today">{m.numbers.paidToday}</p></div>
      </div>

      {chatAny && (
        <section className={card} aria-label={t('Messages for you')} data-testid="home-messages">
          <h2 className="text-sm font-semibold text-slate-600">{t('Messages for you ({n})', { n: m.messagesTotal })}</h2>
          {m.messages.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('No new messages.')}</p> : (
            <ul className="mt-2 divide-y">
              {m.messages.map(x => {
                const inner = (
                  <>
                    <span className="min-w-0"><span className="block truncate"><b className="font-medium">{x.by || t('Someone')}</b>{x.kind === 'lead' ? <> {t('on a lead:')} <b className="font-medium">{x.title}</b></> : x.title ? <> {t('in the chat')} {x.title}</> : null}{x.mentioned && <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-900">@</span>}</span><span className="block truncate text-xs text-slate-500">{x.text}</span></span>
                    <span className="shrink-0 text-sm text-red-700">{x.kind === 'lead' || x.mentioned ? t('Answer') : t('Open')}</span>
                  </>
                )
                return (
                  <li key={x.key}>
                    {x.kind === 'lead'
                      ? <LeadLink leadId={x.id} name={x.title} tab="chat" className="flex items-center justify-between gap-3 py-2" testId="home-message">{inner}</LeadLink>
                      : <Link href={`/marketing/chat?thread=${x.id}`} className="flex items-center justify-between gap-3 py-2" data-testid="home-message">{inner}</Link>}
                  </li>
                )
              })}
              {m.messagesTotal > m.messages.length && <li className="py-2 text-xs text-slate-500"><Link href="/marketing/chat" className="underline">{t('…and {n} more, in Chat.', { n: m.messagesTotal - m.messages.length })}</Link></li>}
            </ul>
          )}
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card} aria-label={t('Waiting on Rocco')} data-testid="home-waiting">
          <h2 className="text-sm font-semibold text-slate-600">{t('Waiting on Rocco ({n})', { n: m.waitingTotal })}</h2>
          <ul className="mt-2 space-y-3 text-sm">
            {m.waiting.map(w => (
              <li key={w.key} data-testid={`home-waiting-${w.key}`}>
                <p className={w.count === 0 ? 'text-slate-400' : 'text-slate-700'}>{waitingText(w.key, w.count)}</p>
                {w.leads.length > 0 && <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">{w.leads.map(l => <LeadLink key={l.id} leadId={l.id} name={l.name} className="underline">{l.name}</LeadLink>)}{w.count > w.leads.length && <span className="text-slate-500">{t('…and {n} more.', { n: w.count - w.leads.length })}</span>}</p>}
              </li>
            ))}
          </ul>
        </section>
        <section className={card} aria-label={t('Calls today')} data-testid="home-calls">
          <h2 className="text-sm font-semibold text-slate-600">{t('Calls today ({n})', { n: m.callsToday.length })}</h2>
          {m.callsToday.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('No calls booked today.')}</p> : (
            <ul className="mt-2 divide-y">
              {m.callsToday.map(c => (
                <li key={c.leadId}><LeadLink leadId={c.leadId} name={c.name} className="flex items-center justify-between gap-3 py-2 text-sm"><span className="min-w-0 truncate"><b className="font-medium">{romeTime(c.at)}</b> {c.name}</span><span className="shrink-0 text-xs text-slate-500" title={formatWhen(c.at, 'Europe/Rome', localeFor(lang))}>{t('booked by {name}', { name: personName(c.actor) })}</span></LeadLink></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
