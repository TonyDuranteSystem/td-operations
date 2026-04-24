import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getInvoiceArchive } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { DocumentList } from '@/components/portal/document-list'
import { DocumentUploadButton } from '@/components/portal/document-upload-button'
import { CorrespondenceList } from '@/components/portal/correspondence-list'
import { t, getLocale } from '@/lib/portal/i18n'
import { FileText, Mail } from 'lucide-react'
import { InvoiceArchive } from '@/components/portal/invoice-archive'

export const dynamic = 'force-dynamic'

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

  const locale = getLocale(user)

  // Fetch regular documents: account-based OR contact-based, filtered by portal_visible
  let documents: Array<{
    id: string; file_name: string; document_type_name: string | null
    category: number | null; drive_file_id: string | null
    processed_at: string | null; created_at: string | null
  }> | null = null

  if (selectedAccountId) {
    const { data } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at')
      .eq('account_id', selectedAccountId)
      .eq('portal_visible', true)
      .or(`contact_id.eq.${contactId},contact_id.is.null`)
      .order('created_at', { ascending: false })
      .limit(100)
    documents = data
  } else {
    // Contact-only clients (ITIN, no LLC) — show their personal documents
    const { data } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at')
      .eq('contact_id', contactId)
      .eq('portal_visible', true)
      .order('created_at', { ascending: false })
      .limit(100)
    documents = data
  }

  // Fetch correspondence (contact-centric: direct + all linked accounts)
  const accountIds = accounts.map(a => a.id)
  const orFilter = [
    `contact_id.eq.${contactId}`,
    accountIds.length > 0 ? `account_id.in.(${accountIds.join(',')})` : null,
  ].filter(Boolean).join(',')

  const { data: correspondence } = await supabaseAdmin
    .from('client_correspondence')
    .select('id, file_name, description, drive_file_url, read_at, created_at, account_id')
    .or(orFilter)
    .order('created_at', { ascending: false })

  const unreadCount = (correspondence ?? []).filter(c => !c.read_at).length

  // Fetch invoice archive documents
  const invoiceArchive = selectedAccountId ? await getInvoiceArchive(selectedAccountId) : []

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('documents.title', locale)}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('documents.subtitle', locale)}</p>
        </div>
        {selectedAccountId && <DocumentUploadButton accountId={selectedAccountId} />}
      </div>

      {/* Correspondence section — shown only if there is any */}
      {(correspondence && correspondence.length > 0) && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b bg-zinc-50">
            <Mail className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-semibold text-zinc-800">Correspondence</span>
            {unreadCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                {unreadCount} new
              </span>
            )}
          </div>
          <CorrespondenceList items={correspondence} />
        </div>
      )}

      {/* Invoice Archive — organized by year/month */}
      {invoiceArchive.length > 0 && (
        <InvoiceArchive items={invoiceArchive} />
      )}

      {/* Regular documents */}
      {(!documents || documents.length === 0) ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <FileText className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('documents.noDocuments', locale)}</h3>
          <p className="text-sm text-zinc-500">{t('documents.noDocumentsDesc', locale)}</p>
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
