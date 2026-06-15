import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { DEFAULT_IRS_FAX_NUMBER } from '@/lib/fax/faxage'
import { FaxForm, type RecentDocument } from './fax-form'

export const dynamic = 'force-dynamic'

export default async function FaxToolPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect('/')

  // Recent documents that have a stored file we can fax (Drive-backed).
  const { data: docs } = await supabaseAdmin
    .from('documents')
    .select('id, file_name, account_name, created_at')
    .not('drive_file_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50)

  const recentDocuments: RecentDocument[] = (docs ?? []).map((d) => ({
    id: d.id as string,
    file_name: (d.file_name as string | null) ?? 'Untitled document',
    account_name: (d.account_name as string | null) ?? null,
    created_at: (d.created_at as string | null) ?? null,
  }))

  const irsNumber = process.env.FAXAGE_IRS_NUMBER || DEFAULT_IRS_FAX_NUMBER

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Send a Fax</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Send a document by fax via Faxage. Enter the recipient fax number, attach a file or pick a recent document, and send.
        </p>
      </div>
      <Suspense fallback={<div className="rounded-xl border bg-white p-6 text-sm text-muted-foreground">Loading…</div>}>
        <FaxForm recentDocuments={recentDocuments} irsNumber={irsNumber} />
      </Suspense>
    </div>
  )
}
