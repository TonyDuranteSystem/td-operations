/**
 * Sign Documents Landing Page — Lists all pending documents for e-signature.
 *
 * Shows OA, Lease, SS-4, and more with their status. Each document links to its
 * dedicated signing page inside the portal. When all documents are signed,
 * shows a success state. The document assembly lives in the shared lib
 * (lib/portal/signable-documents.ts) so the Sign-tab "new" badge count can never
 * drift from this list.
 */

export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { getSignableDocuments } from '@/lib/portal/signable-documents'
import { SignDocumentsClient } from './sign-documents-client'

// Re-exported so ./sign-documents-client keeps importing the type from here.
export type { SignableDocument } from '@/lib/portal/signable-documents'

export default async function PortalSignPage({ searchParams }: { searchParams?: Promise<{ account?: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">Please log in to view your documents.</p>
      </div>
    )
  }

  const contactId = getClientContactId(user)
  if (!contactId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">No contact associated with your account.</p>
      </div>
    )
  }

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  // ?account= wins over the cookie. A client with more than one company reaches
  // this page from a notification about ONE of them; without it they land on
  // whichever company the switcher last left in the cookie — potentially a
  // "You have already signed" screen for the wrong company, right after being
  // told to sign. The id is only honoured if it is genuinely theirs (it is
  // matched against getPortalAccounts), so it cannot be used to reach another
  // client's company.
  const requestedAccountId = (await searchParams)?.account
  const selectedAccountId = accounts.length > 0
    ? (accounts.find(a => a.id === requestedAccountId)?.id
        ?? accounts.find(a => a.id === cookieAccountId)?.id
        ?? accounts[0].id)
    : ''

  if (!selectedAccountId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No company found.</p>
          <p className="text-zinc-400 text-sm">Your documents will appear here once your company is set up.</p>
        </div>
      </div>
    )
  }

  const documents = await getSignableDocuments({
    selectedAccountId,
    contactId,
    userEmail: user.email,
  })

  // Get company name from first available document or account
  const companyName = documents[0]?.companyName || accounts.find(a => a.id === selectedAccountId)?.company_name || ''

  return (
    <SignDocumentsClient
      documents={documents}
      companyName={companyName}
    />
  )
}
