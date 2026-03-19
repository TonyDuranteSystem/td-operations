import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalTaxReturns } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { FileText, Upload } from 'lucide-react'
import { TaxDocumentUpload } from '@/components/portal/tax-document-upload'
import { format, parseISO } from 'date-fns'

export default async function TaxDocumentsPage() {
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

  // Fetch tax returns for year dropdown
  const taxReturns = await getPortalTaxReturns(selectedAccountId)
  const taxYears = Array.from(new Set(taxReturns.map(tr => tr.tax_year).filter(Boolean))).sort((a, b) => b - a)
  const currentYear = new Date().getFullYear()
  if (!taxYears.includes(currentYear)) taxYears.unshift(currentYear)

  // Fetch previously uploaded tax documents
  const { data: uploadedDocs } = await supabaseAdmin
    .from('documents')
    .select('id, file_name, document_type_name, created_at')
    .eq('account_id', selectedAccountId)
    .eq('category', 3) // Tax
    .order('created_at', { ascending: false })
    .limit(50)

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Tax Documents</h1>
        <p className="text-zinc-500 text-sm mt-1">Upload receipts, bank statements, and income records for your tax return.</p>
      </div>

      {/* Upload Section */}
      <TaxDocumentUpload accountId={selectedAccountId} taxYears={taxYears} />

      {/* Previously Uploaded */}
      <div className="bg-white rounded-xl border shadow-sm p-6">
        <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide mb-4">Previously Uploaded</h2>
        {(!uploadedDocs || uploadedDocs.length === 0) ? (
          <div className="text-center py-8">
            <FileText className="h-10 w-10 text-zinc-200 mx-auto mb-2" />
            <p className="text-sm text-zinc-400">No tax documents uploaded yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {uploadedDocs.map(doc => (
              <div key={doc.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-zinc-50">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-4 w-4 text-amber-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">{doc.file_name}</p>
                    <p className="text-xs text-zinc-400">{doc.document_type_name}</p>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 shrink-0">
                  {doc.created_at ? format(parseISO(doc.created_at), 'MMM d, yyyy') : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
