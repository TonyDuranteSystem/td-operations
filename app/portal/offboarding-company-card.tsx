'use client'

import Link from 'next/link'
import { Building2, MessageCircle } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

/**
 * What a client sees on the portal home when every company they have is being OFFBOARDED (dev job 31dfd3a6).
 *
 * An offboarding company is hidden from the portal (getPortalAccounts lists only Active / Suspended), so the client had no company
 * at all and the page fell back to the new-client screen — "Thank you for your payment! Complete your setup so we can start working
 * on your services" — for a client who is leaving. This says what is true instead, and offers the one thing that still makes sense:
 * the chat. No "Request a Service" button (the client is leaving), unlike the closed-company card it is modelled on.
 */
export function OffboardingCompanyCard({ companyNames, stop = false }: { companyNames: string[]; stop?: boolean }) {
  const { t } = useLocale()
  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-4" data-testid="offboarding-company-notice">
      {companyNames.map((name) => (
        <div key={name} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-zinc-100 p-3 text-zinc-600">
              <Building2 className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-zinc-900">{t('offboardingCompany.title')}</h1>
              <p className="mt-2 text-sm text-zinc-600">{t(stop ? 'offboardingCompany.stopBody' : 'offboardingCompany.body').replace('{company}', name)}</p>
              {/* The "stop" screen (offboarded login that never set a password, lib/portal/offboarded-only-login.ts) has no menu and no
                  other page, so no Chat button: the text gives the support address instead. */}
              {!stop && (
                <div className="mt-4 flex flex-wrap gap-3">
                  <Link href="/portal/chat" className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                    <MessageCircle className="h-4 w-4" />
                    {t('offboardingCompany.chat')}
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
