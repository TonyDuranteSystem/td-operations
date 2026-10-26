import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { visibleMailboxes } from '@/lib/marketing/inbox/mailboxes'
import { teamMailboxes, viewerOf } from '@/lib/marketing/inbox/access'
import { InboxApp } from '@/components/marketing/inbox/inbox-app'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — the Inbox (dev job 9aec66fa). Shows only the mailboxes THIS person may open (Antonio adds addresses in CRM > Marketing > Settings; the person it belongs to and the people Antonio ticked see it).
 * `?address=…&thread=…` opens a thread straight (the "Copy link" button); an address the person may not open is simply ignored.
 */
export default async function MarketingInbox({ searchParams }: { searchParams: Promise<{ address?: string; thread?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const t = makeT(getLang())
  if (!hasPermission(g.ctx.permissions, 'inbox')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the Inbox. Ask your team owner.')}</p></main>
  }
  const mine = visibleMailboxes(await teamMailboxes(g.ctx.team.id), viewerOf(g.ctx))
  if (mine.length === 0) {
    return (
      <div className="p-6"><h1 className="text-2xl font-semibold">{t('Inbox')}</h1>
        <p className="mt-4 max-w-xl rounded-xl border border-dashed p-5 text-sm text-slate-600" data-testid="inbox-none">{t('No mailbox is set up for you yet. Antonio adds one in CRM > Marketing > Settings.')}</p></div>
    )
  }
  const sp = await searchParams
  return <InboxApp initialBoxes={mine.map(b => b.address)} startAddress={typeof sp.address === 'string' ? sp.address : undefined} startThread={typeof sp.thread === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(sp.thread) ? sp.thread : undefined} />
}
