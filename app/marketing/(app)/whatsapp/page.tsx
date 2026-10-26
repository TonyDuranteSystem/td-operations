import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { leadDb } from '@/lib/marketing/meta-leads/service'
import { loadTeamEvents } from '@/lib/marketing/events-read'
import { whatsappDay } from '@/lib/marketing/whatsapp-web'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'
import { WhatsAppOpen } from '@/components/marketing/whatsapp-open'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — WhatsApp (dev job 9aec66fa): the stop-gap. WhatsApp does not allow its page inside ours, so each person keeps WhatsApp Web in its own window, linked once to his phone.
 * Nothing is sent by the system; the lead window's WhatsApp button opens that window on the lead's chat. This page explains it and shows the person's own numbers for today.
 */
export default async function MarketingWhatsApp() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const t = makeT(getLang())
  if (!hasPermission(g.ctx.permissions, 'whatsapp')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to WhatsApp. Ask your team owner.')}</p></main>
  }
  const now = new Date()
  const { events, truncated } = await loadTeamEvents(leadDb(), g.ctx.team.id, { kinds: ['whatsapp'], since: new Date(now.getTime() - 48 * 3600 * 1000) })
  const day = whatsappDay(events, g.ctx.user.email ?? '', now)
  const tile = 'rounded-xl border bg-white p-5'
  return (
    <div className="max-w-3xl space-y-5 p-6 pb-20">
      <div><h1 className="text-2xl font-semibold">{t('WhatsApp')}</h1><p className="text-sm text-slate-500">{t('WhatsApp Web, in its own window beside the workspace. Nothing is sent by the system: you press Send yourself.')}</p></div>
      <section className={tile} data-testid="wa-how">
        <h2 className="text-sm font-semibold text-slate-600">{t('How it works')}</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
          <li>{t('Press Open WhatsApp Web. It opens in its own window: keep it beside the workspace.')}</li>
          <li>{t('First time only: on your phone open WhatsApp > Linked devices > scan the QR code on the screen.')}</li>
          <li>{t('On any lead press WhatsApp: that lead\'s chat opens with the message ready. You press Send.')}</li>
        </ol>
        <WhatsAppOpen />
      </section>
      <section className={tile} data-testid="wa-numbers">
        <h2 className="text-sm font-semibold text-slate-600">{t('Your numbers today')}</h2>
        {truncated && <p role="status" className="mt-2 text-xs text-amber-800">{t('Some older records are not included in these numbers because there are too many.')}</p>}
        <dl className="mt-2 grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">{t('Leads you opened in WhatsApp today')}</dt><dd className="text-3xl font-semibold" data-testid="wa-opened">{day.opened}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('Of those, you confirmed sent')}</dt><dd className="text-3xl font-semibold" data-testid="wa-sent">{day.sent}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-slate-500">{t('Your team owner sees everyone\'s in the team activity.')}</p>
      </section>
      <section className={tile} data-testid="wa-habits">
        <h2 className="text-sm font-semibold text-slate-600">{t('Good habits (shown, not enforced)')}</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>{t('One person at a time, by hand: normal WhatsApp use')}</li>
          <li>{t('Not the same text to many strangers in a row')}</li>
          <li>{t('If someone says "stop", note it on the lead and stop')}</li>
        </ul>
      </section>
    </div>
  )
}
