import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getPortalAccounts, getPortalAccountDetail } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { User, Building2, Landmark, CreditCard } from 'lucide-react'
import { t, getLocale } from '@/lib/portal/i18n'
import Link from 'next/link'
import { LogoUpload } from '@/components/portal/logo-upload'
import { BankDetailsForm } from '@/components/portal/bank-details-form'
import { PaymentSettings } from '@/components/portal/payment-settings'
import { ProfileEditor } from '@/components/portal/profile-editor'

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
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t('profile.title', locale)}</h1>
        <p className="text-zinc-500 text-sm mt-1">{t('profile.subtitle', locale)}</p>
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
            full_name: contact?.full_name ?? '',
            email: contact?.email ?? '',
            phone: contact?.phone ?? '',
            language: contact?.language ?? '',
            citizenship: contact?.citizenship ?? '',
            residency: contact?.residency ?? '',
          }}
        />
      </div>

      {/* Company Info */}
      {account && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.companyInfo', locale)}</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <InfoField label="Company Name" value={account.company_name ?? '\u2014'} />
            <InfoField label="Entity Type" value={account.entity_type ?? '\u2014'} />
            <InfoField label="State" value={account.state_of_formation ?? '\u2014'} />
            <InfoField label="EIN" value={account.ein_number ? `**-***${account.ein_number.replace(/\D/g, '').slice(-4)}` : '\u2014'} />
            <InfoField label="Formation Date" value={account.formation_date ?? '\u2014'} />
            <InfoField label="Filing ID" value={account.filing_id ?? '\u2014'} />
            {account.physical_address && (
              <div className="sm:col-span-2">
                <InfoField label="Address" value={account.physical_address} />
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
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Invoice Logo</h2>
          </div>
          <LogoUpload accountId={selectedAccountId} currentUrl={(account as Record<string, unknown>).invoice_logo_url as string | null} />
        </div>
      )}

      {/* Bank Details */}
      {account && selectedAccountId && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Bank Details</h2>
          </div>
          <BankDetailsForm accountId={selectedAccountId} initialData={(account as Record<string, unknown>).bank_details as Record<string, string> | null} />
        </div>
      )}

      {/* Payment Gateway */}
      {account && selectedAccountId && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Payment Gateway</h2>
          </div>
          <PaymentSettings
            accountId={selectedAccountId}
            currentGateway={(account as Record<string, unknown>).payment_gateway as string | null}
            currentLink={(account as Record<string, unknown>).payment_link as string | null}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <Link
          href="/portal/settings"
          className="px-4 py-2.5 text-sm border rounded-lg hover:bg-zinc-50 transition-colors"
        >
          Change Password
        </Link>
      </div>

      <p className="text-xs text-zinc-400">
        {t('profile.contactTeam', locale)}
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
