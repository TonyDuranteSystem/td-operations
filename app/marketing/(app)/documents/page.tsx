import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { canManageDocuments, canReadDocuments } from '@/lib/marketing/documents-rules'
import { DocumentsBrowser } from '@/components/marketing/documents-browser'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'

export const dynamic = 'force-dynamic'

/** TD Marketing — Documents (dev job 9aec66fa): the team's documents, kept in Business › Marketing of the firm storage. */
export default async function MarketingDocuments() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  if (!canReadDocuments(g.ctx.permissions)) {
    const t = makeT(getLang())
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the documents. Ask your team owner.')}</p></main>
  }
  return <DocumentsBrowser canManage={canManageDocuments(g.ctx.permissions)} />
}
