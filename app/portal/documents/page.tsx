import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { DocumentList } from '@/components/portal/document-list'
import { FileText } from 'lucide-react'

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Company',
  2: 'Contacts',
  3: 'Tax',
  4: 'Banking',
  5: 'Correspondence',
}

export default async function PortalDocumentsPage() {
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

  const { data: documents } = await supabaseAdmin
    .from('documents')
    .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at')
    .eq('account_id', selectedAccountId)
    .order('created_at', { ascending: false })
    .limit(100)

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Documents</h1>
        <p className="text-zinc-500 text-sm mt-1">View and download your company documents</p>
      </div>

      {(!documents || documents.length === 0) ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <FileText className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">No documents yet</h3>
          <p className="text-sm text-zinc-500">Documents will appear here as they are uploaded to your account.</p>
        </div>
      ) : (
        <DocumentList
          documents={documents}
          categoryLabels={CATEGORY_LABELS}
        />
      )}
    </div>
  )
}
