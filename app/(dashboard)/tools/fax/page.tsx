import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { FaxForm } from './fax-form'

export const dynamic = 'force-dynamic'

export default async function FaxToolPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect('/')

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Send a Fax</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Send a document by fax via Faxage. Enter the recipient fax number, attach a file, and send.
        </p>
      </div>
      <Suspense fallback={<div className="rounded-xl border bg-white p-6 text-sm text-muted-foreground">Loading…</div>}>
        <FaxForm />
      </Suspense>
    </div>
  )
}
