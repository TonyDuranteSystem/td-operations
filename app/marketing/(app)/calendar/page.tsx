import Link from 'next/link'
import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { listMembers } from '@/lib/marketing/members'
import { loadCalendarData } from '@/lib/marketing/calendar-read'
import { buildAgenda, romeZoneName, type CalItem } from '@/lib/marketing/calendar'
import { loadLeadActivity } from '@/lib/marketing/note-read'
import { canSeeNotes } from '@/lib/marketing/lead-privacy'
import { personName } from '@/lib/marketing/setter-note'

export const dynamic = 'force-dynamic'

const WINDOWS = [14, 30, 60, 90]

/**
 * TD Marketing — the Calendar (dev job 9aec66fa, build step 5): the call backs by day. A person sees HER OWN call backs (the ones she set, or the ones on leads she picked); a person who may
 * see what the team did sees everyone's, with a picker. Decided on the server: a setter who types another person's id gets her own list. No phone numbers here; a lead's name opens the lead.
 */
export default async function MarketingCalendar({ searchParams }: { searchParams: Promise<{ who?: string; days?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const perms = g.ctx.permissions
  const seesAll = hasPermission(perms, 'team.activity')
  const seesOwn = hasPermission(perms, 'leads.worklist') || hasPermission(perms, 'leads.pick')
  if (!seesAll && !seesOwn) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">You do not have access to the Calendar. Ask your team owner.</p></main>
  }
  const sp = await searchParams
  const db = leadDb()
  const teamId = g.ctx.team.id
  const members = (await listMembers(teamId)).filter(m => m.status !== 'removed' && m.email)
  // Antonio looking in as a role that sees only its own: he has no calls of his own, so he is shown everyone's (he may see them all) with a line saying so
  const previewAll = !seesAll && !!g.ctx.viewAs
  const who = seesAll && sp.who && members.some(m => m.user_id === sp.who) ? sp.who : seesAll || previewAll ? 'all' : g.ctx.user.id
  const days = WINDOWS.includes(Number(sp.days)) ? Number(sp.days) : 14
  const now = new Date()
  const data = await loadCalendarData(db, teamId)
  const agenda = buildAgenda({ leads: data.leads, events: data.events, members: members.map(m => ({ user_id: m.user_id, email: m.email, status: m.status })), ownerId: who, now, days, appointments: data.appointments })
  // a line of the setter's note under each call back, for people who may read the team's notes
  const shown = [...agenda.late, ...agenda.days.flatMap(d => d.items)]
  const notes = canSeeNotes(perms) && shown.length > 0 ? (await loadLeadActivity(db, shown.map(i => i.leadId))).notes : null
  const href = (n: { who?: string; days?: number }) => {
    const q = new URLSearchParams()
    const w = n.who ?? (who === 'all' ? '' : who)
    if (seesAll && w) q.set('who', w)
    const dd = n.days ?? days
    if (dd !== 14) q.set('days', String(dd))
    const t = q.toString()
    return t ? `/marketing/calendar?${t}` : '/marketing/calendar'
  }
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-600'}`
  const due = agenda.days.reduce((n, d) => n + d.items.length, 0)
  const lateCount = agenda.late.length + agenda.lateMore
  const total = due + agenda.late.length
  const row = (it: CalItem) => (
    <li key={`${it.leadId}-${it.kind}`}>
      <Link href={`/marketing/leads?lead=${it.leadId}`} className={`grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-3 rounded-lg border bg-white px-3 py-2.5 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-900 ${it.late ? 'border-red-300' : ''}`} data-testid="cal-item">
        <span className="font-mono text-sm font-medium tabular-nums">{it.time}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{it.name}{it.kind === 'appointment' && <span className="ml-2 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-normal text-sky-800">Call with the seller</span>}</span>
          <span className="block truncate text-xs text-slate-500">
            {it.late && <span className="font-medium text-red-700">{it.dateLabel} · {it.lateBy} · </span>}
            {[it.ad, seesAll || previewAll ? (it.setBy ? `set by ${it.setBy}${it.setByMember ? '' : ' (not on the team)'}` : 'who set it is not recorded') : null].filter(Boolean).join(' · ')}
          </span>
          {notes?.get(it.leadId)?.text && <span className="mt-0.5 line-clamp-2 block break-words text-xs text-slate-700">{notes?.get(it.leadId)?.text}</span>}
        </span>
      </Link>
    </li>
  )
  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">Calendar</h1><p className="text-sm text-slate-500" data-testid="cal-sub">Call backs and booked calls, by day. {seesAll ? (who === 'all' ? 'Call backs for everyone' : `Call backs for ${personName(members.find(m => m.user_id === who)?.email)}`) : 'Your call backs'} · {due} due in the next {days} days{lateCount > 0 ? `, ${lateCount} late` : ''}</p></div>
        {seesAll && members.length > 0 && (
          <nav aria-label="Whose calendar" className="flex flex-wrap items-center gap-2" data-testid="cal-picker">
            <span className="text-xs text-slate-500">Whose:</span>
            <Link href={href({ who: '' })} className={chip(who === 'all')} aria-current={who === 'all' ? 'true' : undefined}>Everyone</Link>
            {members.map(m => <Link key={m.user_id} href={href({ who: m.user_id })} className={chip(who === m.user_id)} aria-current={who === m.user_id ? 'true' : undefined}>{personName(m.email)}</Link>)}
          </nav>
        )}
      </div>
      {previewAll && <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="cal-preview">You are viewing as a role that sees only its own call backs. Here is everyone&apos;s, because you may see them all; a real person would see only hers.</p>}
      <p className="text-sm text-slate-600" data-testid="cal-help">Times are Rome time ({romeZoneName(now)}). A row opens the lead; to change a time, open the lead and press <b className="font-medium">Call back later</b>.</p>
      {data.truncated && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">Showing the first call backs only; some later ones are not listed.</p>}
      {total === 0 && <div className="rounded-xl border border-dashed p-6 text-sm text-slate-600" data-testid="cal-empty">{seesAll && who !== 'all' ? 'This person has no call backs set' : 'No call backs set'} for the next {days} days. Nothing is due. To add one, <Link href="/marketing/leads" className="underline">open a lead</Link>, press Call back later, and pick a day and time.</div>}
      {agenda.late.length > 0 && (
        <section aria-label="Late call backs" data-testid="cal-late">
          <h2 className="mb-1.5 text-sm font-medium text-red-700">Late · {lateCount}</h2>
          <ul className="space-y-1.5">{agenda.late.map(row)}</ul>
          {agenda.lateMore > 0 && <p className="mt-1.5 text-xs text-slate-500">…and {agenda.lateMore} more, less overdue than these.</p>}
        </section>
      )}
      {agenda.days.map(d => (
        <section key={d.key} aria-label={d.label} data-testid="cal-day" data-day={d.key}>
          <h2 className="mb-1.5 text-sm font-medium text-slate-700">{d.label} · {d.items.length}</h2>
          <ul className="space-y-1.5">{d.items.map(row)}</ul>
        </section>
      ))}
      <p className="text-sm text-slate-600">
        {agenda.beyond > 0 && <>{agenda.beyond} more later. </>}
        {WINDOWS.filter(w => w > days).slice(0, 1).map(w => <Link key={w} href={href({ days: w })} className="underline" data-testid="cal-more">Show {w} days</Link>)}
        {days > 14 && <> · <Link href={href({ days: 14 })} className="underline">Back to 14 days</Link></>}
      </p>
    </div>
  )
}
