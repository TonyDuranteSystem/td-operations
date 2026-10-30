import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { isSetterOnly } from '@/lib/marketing/lead-chat'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { listMembers } from '@/lib/marketing/members'
import { loadCalendarData } from '@/lib/marketing/calendar-read'
import { calendarItems } from '@/lib/marketing/calendar'
import { loadTimeView } from '@/lib/marketing/time-prefs-server'
import { utcOffsetText, zoneName } from '@/lib/marketing/zones'
import { CalendarViews } from '@/components/marketing/calendar-views'
import { personName } from '@/lib/marketing/setter-note'
import { getLang } from '@/lib/marketing/lang'
import { localeFor, makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the Calendar (dev job 9aec66fa): the call backs and the booked calls in four views (Day, Week, Month, Pipeline), with drag-to-move and a required reason. A person sees HER OWN
 * calls (the ones she set, or on leads she picked); a person who may see what the team did sees everyone's, with a picker. Decided on the server: a setter who types another person's id gets
 * her own list. Moving a call needs the right to mark leads (the same right that books one). No phone numbers here; a lead's name opens the lead in a window.
 */
export default async function MarketingCalendar({ searchParams }: { searchParams: Promise<{ who?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const lang = getLang()
  const t = makeT(lang)
  const perms = g.ctx.permissions
  const seesAll = hasPermission(perms, 'team.activity')
  const seesOwn = hasPermission(perms, 'leads.worklist') || hasPermission(perms, 'leads.pick')
  if (!seesAll && !seesOwn) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the Calendar. Ask your team owner.')}</p></main>
  }
  const sp = await searchParams
  const db = leadDb()
  const teamId = g.ctx.team.id
  const members = (await listMembers(teamId)).filter(m => m.status !== 'removed' && m.email)
  // Antonio looking in as a role that sees only its own: he has no calls of his own, so he is shown everyone's (he may see them all) with a line saying so
  const previewAll = !seesAll && !!g.ctx.viewAs
  const who = seesAll && sp.who && members.some(m => m.user_id === sp.who) ? sp.who : seesAll || previewAll ? 'all' : g.ctx.user.id
  const now = new Date()
  const [data, time] = await Promise.all([loadCalendarData(db, teamId), loadTimeView(g.ctx)])
  const { items: allItems, lateMore } = calendarItems({ leads: data.leads, events: data.events, members: members.map(m => ({ user_id: m.user_id, email: m.email, status: m.status })), ownerId: who, now, appointments: data.appointments, lang })
  // a setter is never told a call she booked ended in a payment: it is simply a call that is done
  const items = isSetterOnly(perms) ? allItems.map(i => (i.stage === 'paid' ? { ...i, stage: 'done' as const } : i)) : allItems
  const href = (w: string) => (w ? `/marketing/calendar?who=${encodeURIComponent(w)}` : '/marketing/calendar')
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-600'}`
  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">{t('Calendar')}</h1><p className="text-sm text-slate-500" data-testid="cal-sub">{t('Call backs and booked calls.')} {seesAll ? (who === 'all' ? t('Call backs for everyone') : t('Call backs for {name}', { name: personName(members.find(m => m.user_id === who)?.email) })) : t('Your call backs')} · {t('Times are {zone} time ({offset}).', { zone: zoneName(time.zone), offset: utcOffsetText(now, time.zone) })}</p></div>
        {seesAll && members.length > 0 && (
          <nav aria-label={t('Whose calendar')} className="flex flex-wrap items-center gap-2" data-testid="cal-picker">
            <span className="text-xs text-slate-500">{t('Whose:')}</span>
            <Link href={href('')} className={chip(who === 'all')} aria-current={who === 'all' ? 'true' : undefined}>{t('Everyone')}</Link>
            {members.map(m => <Link key={m.user_id} href={href(m.user_id)} className={chip(who === m.user_id)} aria-current={who === m.user_id ? 'true' : undefined}>{personName(m.email)}</Link>)}
          </nav>
        )}
      </div>
      {previewAll && <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="cal-preview">{t("You are viewing as a role that sees only its own call backs. As the team owner you are shown everyone's.")}</p>}
      {data.truncated && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Showing the first call backs only; some later ones are not listed.')}</p>}
      {items.length === 0 && <div className="rounded-xl border border-dashed p-6 text-sm text-slate-600" data-testid="cal-empty">{seesAll && who !== 'all' ? t('This person has no call backs set') : t('No call backs set')}{t('. Nothing is booked or due. To add one, ')}<Link href="/marketing/leads" className="underline">{t('open a lead')}</Link>{t(', press Call back later, and pick a day and time.')}</div>}
      <CalendarViews items={items} lateMore={lateMore} nowIso={now.toISOString()} canMove={hasPermission(perms, 'leads.mark')} told={g.ctx.viewAs === undefined} locale={localeFor(lang)} zone={time.zone} />
    </div>
  )
}
