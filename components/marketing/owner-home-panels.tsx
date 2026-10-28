import Link from 'next/link'
import { LeadLink } from '@/components/marketing/lead-link'
import type { HomeModel, WaitingGroup } from '@/lib/marketing/home'
import { personName } from '@/lib/marketing/setter-note'
import { romeTime } from '@/lib/marketing/calendar'
import { formatWhen } from '@/lib/marketing/lead-view'
import type { TFn } from '@/lib/marketing/i18n'
import { RemindBox, ReplyBox } from '@/components/marketing/owner-home-actions'

/**
 * The owner's Home panels (TD Marketing, dev job 9aec66fa): the messages waiting for him, what is waiting on Rocco, and today's calls. Shown in the workspace's Home (every lead opens in a window on
 * top of the screen) and on the CRM's Marketing page (a plain link into the workspace, which opens the lead or the chat there). The CRM page is in English; the workspace follows the person's language.
 */
type PanelProps = { model: HomeModel; mode: 'workspace' | 'crm'; t: TFn; locale: string; chatAny: boolean }
const card = 'rounded-xl border bg-white p-5'

/** inside the workspace a lead opens in a window; from the CRM it is a link into the workspace that opens the lead (or its chat) there, under Antonio's own menu */
function leadLink(mode: 'workspace' | 'crm', id: string, name: string, className: string, children: React.ReactNode, o: { chat?: boolean; testId?: string } = {}) {
  return mode === 'workspace'
    ? <LeadLink leadId={id} name={name} tab={o.chat ? 'chat' : undefined} className={className} testId={o.testId}>{children}</LeadLink>
    : <Link href={`/marketing/board?${o.chat ? 'chat' : 'open'}=${id}`} className={className} data-testid={o.testId}>{children}</Link>
}

/** The messages waiting for him. In the CRM each one has a reply box (answer without leaving the page). */
export function MessagesPanel({ model: m, mode, t, chatAny }: Pick<PanelProps, 'model' | 'mode' | 't' | 'chatAny'>) {
  const lead = (id: string, name: string, className: string, children: React.ReactNode, o: { chat?: boolean; testId?: string } = {}) => leadLink(mode, id, name, className, children, o)
  if (!chatAny) return null
  return (
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
            const cls = 'flex items-center justify-between gap-3 py-2'
            return (
              <li key={x.key}>
                {x.kind === 'lead' ? lead(x.id, x.title, cls, inner, { chat: true, testId: 'home-message' }) : <Link href={`/marketing/chat?thread=${x.id}`} className={cls} data-testid="home-message">{inner}</Link>}
                {mode === 'crm' && <ReplyBox url={x.kind === 'lead' ? `/api/marketing/chat/${x.id}/messages` : `/api/marketing/team-chat/${x.id}/messages`} />}
              </li>
            )
          })}
          {m.messagesTotal > m.messages.length && <li className="py-2 text-xs text-slate-500"><Link href="/marketing/chat" className="underline">{t('…and {n} more, in Chat.', { n: m.messagesTotal - m.messages.length })}</Link></li>}
        </ul>
      )}
    </section>
  )
}

/** What is waiting on Rocco. In the CRM a payment link that nobody paid has a "Send reminder" (a private message to the person who has the lead). */
export function WaitingPanel({ model: m, mode, t }: Pick<PanelProps, 'model' | 'mode' | 't'>) {
  const waitingText = (k: WaitingGroup['key'], n: number) => k === 'link_unpaid' ? t('Link sent, no payment for over {h} hours: {n}', { h: 48, n }) : k === 'paid_no_booking' ? t('Paid, booking link not sent: {n}', { n }) : t('New lead untouched for over a day: {n}', { n })
  return (
    <section className={card} aria-label={t('Waiting on Rocco')} data-testid="home-waiting">
      <h2 className="text-sm font-semibold text-slate-600">{t('Waiting on Rocco ({n})', { n: m.waitingTotal })}</h2>
      <ul className="mt-2 space-y-3 text-sm">
        {m.waiting.map(w => (
          <li key={w.key} data-testid={`home-waiting-${w.key}`}>
            <p className={w.count === 0 ? 'text-slate-400' : 'text-slate-700'}>{waitingText(w.key, w.count)}</p>
            {w.leads.length > 0 && <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">{w.leads.map(l => <span key={l.id} className="inline-flex flex-wrap items-center gap-2">{leadLink(mode, l.id, l.name, 'underline', l.name)}{mode === 'crm' && w.key === 'link_unpaid' && <RemindBox leadId={l.id} name={l.name} />}</span>)}{w.count > w.leads.length && <span className="text-slate-500">{t('…and {n} more.', { n: w.count - w.leads.length })}</span>}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Today's booked calls. */
export function CallsPanel({ model: m, mode, t, locale }: Pick<PanelProps, 'model' | 'mode' | 't' | 'locale'>) {
  return (
    <section className={card} aria-label={t('Calls today')} data-testid="home-calls">
      <h2 className="text-sm font-semibold text-slate-600">{t('Calls today ({n})', { n: m.callsToday.length })}</h2>
      {m.callsToday.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('No calls booked today.')}</p> : (
        <ul className="mt-2 divide-y">
          {m.callsToday.map(c => (
            <li key={c.leadId}>{leadLink(mode, c.leadId, c.name, 'flex items-center justify-between gap-3 py-2 text-sm', <><span className="min-w-0 truncate"><b className="font-medium">{romeTime(c.at)}</b> {c.name}</span><span className="shrink-0 text-xs text-slate-500" title={formatWhen(c.at, 'Europe/Rome', locale)}>{t('booked by {name}', { name: personName(c.actor) })}</span></>)}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The three panels together, as the workspace's Home shows them (messages full width, then waiting and calls side by side). */
export function OwnerHomePanels(p: PanelProps) {
  return (
    <>
      <MessagesPanel model={p.model} mode={p.mode} t={p.t} chatAny={p.chatAny} />
      <div className="grid gap-4 md:grid-cols-2">
        <WaitingPanel model={p.model} mode={p.mode} t={p.t} />
        <CallsPanel model={p.model} mode={p.mode} t={p.t} locale={p.locale} />
      </div>
    </>
  )
}
