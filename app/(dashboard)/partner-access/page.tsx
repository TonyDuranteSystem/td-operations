import { Shield, FileText } from 'lucide-react'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { formatDistanceToNow } from 'date-fns'

export const dynamic = 'force-dynamic'

/**
 * /partner-access — staff view of the partner access audit (job 5f534ed9).
 * Every partner page load, data API call and private-file grant, newest
 * first. File grants (passport/ID documents) are visually flagged. Staff-only
 * by the dashboard middleware rules (clients are bounced, partners confined
 * to /collab and can never reach this).
 */

interface AccessRow {
  id: string
  created_at: string
  partner_id: string
  surface: string
  method: string | null
  path: string | null
  resource: string | null
  detail: Record<string, unknown>
  ip: string | null
}

const SURFACE_LABELS: Record<string, string> = {
  collab_page: 'Opened collaboration page',
  projects_list: 'Listed assigned projects',
  project_brief: 'Opened a project brief',
  file_signed: '📄 FILE ACCESS GRANTED',
  project_status_change: 'Changed a project status',
  chat_read: 'Read chat messages',
  chat_send: 'Sent a chat message',
  chat_upload: 'Uploaded a chat file',
}

export default async function PartnerAccessPage() {
  // partner_access_log is absent from the generated DB types (regen blocked
  // by the schema-drift decision) — established cast precedent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('partner_access_log')
    .select('id, created_at, partner_id, surface, method, path, resource, detail, ip')
    .order('created_at', { ascending: false })
    .limit(300)
  const rows: AccessRow[] = data ?? []

  // Resolve partner names in one pass.
  const partnerIds = Array.from(new Set(rows.map(r => r.partner_id)))
  const names = new Map<string, string>()
  if (partnerIds.length > 0) {
    const { data: partners } = await supabaseAdmin
      .from('client_partners')
      .select('id, partner_name')
      .in('id', partnerIds)
    for (const p of partners ?? []) names.set(p.id, p.partner_name ?? p.id.slice(0, 8))
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6 flex items-center gap-3">
        <Shield className="h-6 w-6 text-red-600" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Partner Access Log</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Everything partner logins touch — file grants flagged. Latest 300 events.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center text-muted-foreground text-sm">
          No partner activity recorded yet.
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="border-b bg-zinc-50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5">Partner</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map(r => {
                const isFile = r.surface === 'file_signed'
                return (
                  <tr key={r.id} className={isFile ? 'bg-amber-50' : ''}>
                    <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-2 text-xs font-medium">
                      {names.get(r.partner_id) ?? r.partner_id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <span className={isFile ? 'font-semibold text-amber-800' : ''}>
                        {SURFACE_LABELS[r.surface] ?? r.surface}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground max-w-[320px] truncate">
                      {isFile ? (
                        <span className="inline-flex items-center gap-1">
                          <FileText className="h-3 w-3 shrink-0" />
                          {r.resource}
                        </span>
                      ) : (
                        [
                          typeof r.detail?.enrollment_id === 'string' ? `project ${String(r.detail.enrollment_id).slice(0, 8)}` : null,
                          typeof r.detail?.file_name === 'string' ? String(r.detail.file_name) : null,
                          typeof r.detail?.new_status === 'string' ? `→ ${String(r.detail.new_status)}` : null,
                          typeof r.detail?.messages === 'number' ? `${String(r.detail.messages)} messages` : null,
                          typeof r.detail?.projects === 'number' ? `${String(r.detail.projects)} projects` : null,
                          r.ip,
                        ].filter(Boolean).join(' · ')
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
