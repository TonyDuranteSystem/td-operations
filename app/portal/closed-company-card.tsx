'use client'

import Link from 'next/link'
import { Building2, MessageCircle, PlusCircle } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

/**
 * What a client sees on the portal home once the company they asked us to close IS closed.
 *
 * Before (Company Closure Part C, dev job a6bbea09): a closed company is hidden from the portal, the client then had no
 * company at all, and the page fell back to the new-client onboarding screen — "Thank you for your payment! Complete your setup
 * so we can start working on your services", with Review Proposal / Sign Contract / Make Payment steps — for a client whose
 * closure was finished. This says what is true instead: the company is closed, thank you, here is how to reach us.
 */
export function ClosedCompanyCard({ companyNames }: { companyNames: string[] }) {
  const { t } = useLocale()
  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-4">
      {companyNames.map((name) => (
        <div key={name} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-zinc-100 p-3 text-zinc-600">
              <Building2 className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-zinc-900">{t('closedCompany.title')}</h1>
              <p className="mt-2 text-sm text-zinc-600">{t('closedCompany.body').replace('{company}', name)}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link href="/portal/chat" className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  <MessageCircle className="h-4 w-4" />
                  {t('closedCompany.chat')}
                </Link>
                <Link href="/portal/services/request" className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
                  <PlusCircle className="h-4 w-4" />
                  {t('closedCompany.request')}
                </Link>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
