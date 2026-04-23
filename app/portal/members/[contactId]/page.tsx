export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalMembers } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { User, Mail, Phone, MapPin, Globe, Calendar, Shield, ChevronLeft } from 'lucide-react'
import Link from 'next/link'

export default async function MemberDetailPage({ params }: { params: { contactId: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id

  if (!selectedAccountId) redirect('/portal')

  // Get all members for this account and find the requested one
  const members = await getPortalMembers(selectedAccountId)
  const member = members.find(m => m.contact_id === params.contactId)

  // Security: only allow viewing members of accounts the logged-in user belongs to
  if (!member) notFound()

  function formatDate(d: string | null) {
    if (!d) return null
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  }

  function buildAddress(m: typeof member) {
    if (!m) return null
    const parts = [m.address_line1, m.address_city, m.address_state, m.address_country].filter(Boolean)
    return parts.length > 0 ? parts.join(', ') : null
  }

  const address = buildAddress(member)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
      {/* Back */}
      <Link href="/portal" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700">
        <ChevronLeft className="h-4 w-4" />
        Back to Overview
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl border shadow-sm p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-blue-100 text-blue-700 text-xl font-semibold flex items-center justify-center shrink-0">
              {member.first_name?.[0]}{member.last_name?.[0]}
            </div>
            <div>
              <h1 className="text-xl font-semibold text-zinc-900">{member.first_name} {member.last_name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 capitalize">{member.role}</span>
                {member.is_primary && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">Primary Contact</span>
                )}
                {member.ownership_pct != null && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">{member.ownership_pct}% ownership</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Contact Info */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b bg-zinc-50">
          <User className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-semibold text-zinc-800">Contact Information</span>
        </div>
        <div className="divide-y">
          {member.email && (
            <div className="flex items-center gap-3 px-5 py-3.5">
              <Mail className="h-4 w-4 text-zinc-400 shrink-0" />
              <div>
                <p className="text-[11px] text-zinc-400 uppercase tracking-wide font-medium mb-0.5">Email</p>
                <a href={`mailto:${member.email}`} className="text-sm text-blue-700 hover:underline">{member.email}</a>
              </div>
            </div>
          )}
          {member.phone && (
            <div className="flex items-center gap-3 px-5 py-3.5">
              <Phone className="h-4 w-4 text-zinc-400 shrink-0" />
              <div>
                <p className="text-[11px] text-zinc-400 uppercase tracking-wide font-medium mb-0.5">Phone</p>
                <a href={`tel:${member.phone}`} className="text-sm text-zinc-700 hover:text-zinc-900">{member.phone}</a>
              </div>
            </div>
          )}
          {address && (
            <div className="flex items-start gap-3 px-5 py-3.5">
              <MapPin className="h-4 w-4 text-zinc-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-[11px] text-zinc-400 uppercase tracking-wide font-medium mb-0.5">Address</p>
                <p className="text-sm text-zinc-700">{address}</p>
              </div>
            </div>
          )}
          {member.citizenship && (
            <div className="flex items-center gap-3 px-5 py-3.5">
              <Globe className="h-4 w-4 text-zinc-400 shrink-0" />
              <div>
                <p className="text-[11px] text-zinc-400 uppercase tracking-wide font-medium mb-0.5">Citizenship</p>
                <p className="text-sm text-zinc-700">{member.citizenship}</p>
              </div>
            </div>
          )}
          {member.date_of_birth && (
            <div className="flex items-center gap-3 px-5 py-3.5">
              <Calendar className="h-4 w-4 text-zinc-400 shrink-0" />
              <div>
                <p className="text-[11px] text-zinc-400 uppercase tracking-wide font-medium mb-0.5">Date of Birth</p>
                <p className="text-sm text-zinc-700">{formatDate(member.date_of_birth)}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Empty state if no info */}
      {!member.email && !member.phone && !address && !member.citizenship && !member.date_of_birth && (
        <div className="bg-white rounded-xl border shadow-sm p-10 text-center">
          <Shield className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">No additional contact details on file.</p>
        </div>
      )}
    </div>
  )
}
