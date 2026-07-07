import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getPortalAccounts, getPortalAccountDetail } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { User, Building2, Landmark, CreditCard, ShieldCheck } from 'lucide-react'
import { t, getLocale } from '@/lib/portal/i18n'
import Link from 'next/link'
import { LogoUpload } from '@/components/portal/logo-upload'
import { BankAccounts } from '@/components/portal/bank-accounts'
import { PaymentLinks } from '@/components/portal/payment-links'
import { ProfileEditor } from '@/components/portal/profile-editor'
import { LanguageSwitcher } from '@/components/portal/language-switcher'

export default async function PortalProfilePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single()

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  const account = selectedAccountId ? await getPortalAccountDetail(selectedAccountId) : null
  const locale = getLocale(user)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('profile.title', locale)}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('profile.subtitle', locale)}</p>
      </div>

      {/* Personal Info */}
      <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <User className="h-5 w-5 text-blue-600" />
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.personalInfo', locale)}</h2>
        </div>
        <ProfileEditor
          contactId={contactId}
          initialData={{
            first_name: contact?.first_name ?? '',
            last_name: contact?.last_name ?? '',
            email: contact?.email ?? '',
            phone: contact?.phone ?? '',
            language: contact?.language ?? '',
            citizenship: contact?.citizenship ?? '',
            address_line1: contact?.address_line1 ?? '',
            address_city: contact?.address_city ?? '',
            address_state: contact?.address_state ?? '',
            address_zip: contact?.address_zip ?? '',
            address_country: contact?.address_country ?? '',
          }}
        />
      </div>

      {/* Identity & Tax — shown once the contact has an ITIN on file (stamped
          by the ITIN-approval finalize). Client request via Luca (2026-07-07):
          let clients look up their ITIN without opening the CP565 letter. */}
      {contact?.itin_number && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.identityTax', locale)}</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <InfoField label={t('profile.itinNumber', locale)} value={contact.itin_number} />
            <InfoField label={t('profile.itinIssueDate', locale)} value={contact.itin_issue_date ?? '—'} />
            <InfoField label={t('profile.itinRenewalDate', locale)} value={contact.itin_renewal_date ?? '—'} />
          </div>
          <p className="text-xs text-zinc-400">{t('profile.itinLetterNote', locale)}</p>
        </div>
      )}

      {/* Company Info */}
      {account && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.companyInfo', locale)}</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <InfoField label={t('profile.companyName', locale)} value={account.company_name ?? '\u2014'} />
            <InfoField label={t('dashboard.entityType', locale)} value={account.entity_type ?? '\u2014'} />
            <InfoField label={t('dashboard.state', locale)} value={account.state_of_formation ?? '\u2014'} />
            <InfoField label={t('dashboard.ein', locale)} value={account.ein_number || '\u2014'} />
            <InfoField label={t('dashboard.formationDate', locale)} value={account.formation_date ?? '\u2014'} />
            <InfoField label={t('profile.filingId', locale)} value={account.filing_id ?? '\u2014'} />
            {account.physical_address && (
              <div className="sm:col-span-2">
                <InfoField label={t('profile.address', locale)} value={account.physical_address} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Company Logo */}
      {account && selectedAccountId && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.invoiceLogo', locale)}</h2>
          </div>
          <LogoUpload accountId={selectedAccountId} currentUrl={(account as Record<string, unknown>).invoice_logo_url as string | null} />
        </div>
      )}

      {/* Bank Accounts */}
      {account && selectedAccountId && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.bankDetails', locale)}</h2>
          </div>
          <BankAccounts accountId={selectedAccountId} />
        </div>
      )}

      {/* Payment Links */}
      {account && selectedAccountId && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.paymentGateway', locale)}</h2>
          </div>
          <PaymentLinks accountId={selectedAccountId} />
        </div>
      )}

      {/* Actions */}
      <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className="text-sm font-semibold text-zinc-900 uppercase tracking-wide mb-1">{t('settings.language', locale)}</p>
            <LanguageSwitcher />
          </div>
          <Link
            href="/portal/settings"
            className="px-4 py-2.5 text-sm border rounded-lg hover:bg-zinc-50 transition-colors self-end"
          >
            {t('profile.changePassword', locale)}
          </Link>
        </div>
      </div>

      <p className="text-xs text-zinc-400">
        <Link href="/portal/chat" className="hover:text-blue-600 underline underline-offset-2">
          {t('profile.contactTeam', locale)}
        </Link>
      </p>
    </div>
  )
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-0.5">{label}</p>
      <p className="font-medium text-zinc-900">{value}</p>
    </div>
  )
}
