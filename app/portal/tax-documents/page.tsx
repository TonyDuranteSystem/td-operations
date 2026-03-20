export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalTaxReturns } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { FileText, Upload, CheckCircle2, Clock, AlertCircle, CalendarClock, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t, getLocale } from '@/lib/portal/i18n'
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

  const locale = getLocale(user)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('taxDocs.title', locale)}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('taxDocs.subtitle', locale)}</p>
      </div>

      {/* Tax Return Status Cards */}
      {taxReturns.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            {t('taxDocs.returnStatus', locale)}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {taxReturns.map(tr => {
              const isOverdue = tr.deadline && new Date(tr.deadline) < new Date() && tr.status !== 'Filed' && tr.status !== 'Complete'
              const statusColor = tr.status === 'Filed' || tr.status === 'Complete'
                ? 'bg-emerald-100 text-emerald-700'
                : isOverdue ? 'bg-red-100 text-red-700'
                : 'bg-amber-100 text-amber-700'
              const StatusIcon = tr.status === 'Filed' || tr.status === 'Complete'
                ? CheckCircle2 : isOverdue ? AlertCircle : Clock
              return (
                <div key={tr.id} className="bg-white rounded-xl border shadow-sm p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center">
                        <span className="text-sm font-bold text-indigo-600">{tr.tax_year}</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{tr.return_type}</p>
                        <span className={cn('text-[10px] px-2 py-0.5 rounded-full', statusColor)}>
                          {tr.status}
                        </span>
                      </div>
                    </div>
                    <StatusIcon className={cn('h-5 w-5',
                      tr.status === 'Filed' || tr.status === 'Complete' ? 'text-emerald-500' :
                      isOverdue ? 'text-red-500' : 'text-amber-500'
                    )} />
                  </div>
                  <div className="space-y-1.5 text-xs text-zinc-600">
                    {tr.deadline && (
                      <div className="flex items-center gap-2">
                        <CalendarClock className="h-3.5 w-3.5 text-zinc-400" />
                        <span>{t('taxDocs.deadline', locale)}: {format(parseISO(tr.deadline), 'MMM d, yyyy')}</span>
                      </div>
                    )}
                    {tr.extension_filed && tr.extension_deadline && (
                      <div className="flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-blue-400" />
                        <span>{t('taxDocs.extension', locale)}: {format(parseISO(tr.extension_deadline), 'MMM d, yyyy')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Upload Section */}
      <TaxDocumentUpload accountId={selectedAccountId} taxYears={taxYears} />

      {/* Previously Uploaded */}
      <div className="bg-white rounded-xl border shadow-sm p-6">
        <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide mb-4">{t('taxDocs.previouslyUploaded', locale)}</h2>
        {(!uploadedDocs || uploadedDocs.length === 0) ? (
          <div className="text-center py-8">
            <FileText className="h-10 w-10 text-zinc-200 mx-auto mb-2" />
            <p className="text-sm text-zinc-400">{t('taxDocs.noUploads', locale)}</p>
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
