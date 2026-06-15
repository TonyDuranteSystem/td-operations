import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, Send } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { FaxHistoryTable, type FaxHistoryRow } from './history-table'

export const dynamic = 'force-dynamic'

export default async function FaxHistoryPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect('/')

  // Sent faxes are recorded in action_log at send time (action_type='fax_sent').
  // record_id holds the viewable documents.id — the selected doc for a
  // document-source fax, or (since the upload-persistence change) the doc created
  // from an uploaded file. It is NULL only for legacy uploads sent before that
  // change, which have no stored file to link to.
  const { data: logs } = await supabaseAdmin
    .from('action_log')
    .select('id, created_at, summary, details, record_id')
    .eq('action_type', 'fax_sent')
    .order('created_at', { ascending: false })
    .limit(200)

  const rows: FaxHistoryRow[] = (logs ?? []).map((l) => {
    const d = (l.details ?? {}) as Record<string, unknown>
    const source = (d.source as string | null) ?? null
    // Link "View Document" whenever a document was recorded (both sources now).
    const documentId = l.record_id ? (l.record_id as string) : null
    // Persisted live status (written by the status route on a prior Check
    // Status). When present we show it on load instead of the button.
    const fs = (d.fax_status ?? null) as {
      status?: string; pages?: string | null; xmit_time?: string | null; complete_time?: string | null
    } | null
    const savedStatus = fs && fs.status
      ? {
          status: fs.status as 'delivered' | 'pending' | 'failed' | 'unknown',
          pages: fs.pages ?? null,
          xmitTime: fs.xmit_time ?? null,
          completeTime: fs.complete_time ?? null,
        }
      : null
    return {
      id: l.id as string,
      createdAt: (l.created_at as string | null) ?? null,
      faxno: (d.faxno as string | null) ?? '—',
      recipName: (d.recip_name as string | null) ?? null,
      reason: (d.reason as string | null) ?? null,
      fileName: (d.file_name as string | null) ?? 'document.pdf',
      jobId: (d.job_id as string | null) ?? null,
      source,
      documentId,
      savedStatus,
    }
  })

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/tools/fax"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-zinc-700 mb-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Send a Fax
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Fax History</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Faxes sent via Faxage. Click <span className="font-medium">Check status</span> for live delivery
            confirmation, or <span className="font-medium">Receipt</span> to download the transmittal page.
          </p>
        </div>
        <Link
          href="/tools/fax"
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 shrink-0"
        >
          <Send className="h-4 w-4" /> Send a Fax
        </Link>
      </div>

      <FaxHistoryTable rows={rows} />
    </div>
  )
}
