import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getPortalAccounts, getPortalAccountDetail } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { User, Building2 } from 'lucide-react'
import Link from 'next/link'

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

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Profile</h1>
        <p className="text-zinc-500 text-sm mt-1">Your personal and company information</p>
      </div>

      {/* Personal Info */}
      <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <User className="h-5 w-5 text-blue-600" />
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Personal Information</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <InfoField label="Full Name" value={contact?.full_name ?? '\u2014'} />
          <InfoField label="Email" value={contact?.email ?? '\u2014'} />
          <InfoField label="Phone" value={contact?.phone ?? '\u2014'} />
          <InfoField label="Language" value={contact?.language ?? '\u2014'} />
          <InfoField label="Citizenship" value={contact?.citizenship ?? '\u2014'} />
          <InfoField label="Residency" value={contact?.residency ?? '\u2014'} />
        </div>
      </div>

      {/* Company Info */}
      {account && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Company Information</h2>
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
        To update your information, please contact the Tony Durante team via the Chat section.
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
