/**
 * Approvals — TD STAFF only. A phone-friendly list of actions the assistant has
 * proposed (queued to approval_queue) and is waiting on Antonio to approve or reject.
 * Tapping Approve flips the proposal to 'approved'; the async executor then runs it.
 *
 * Gate: staff = a Supabase user whose app_metadata.role !== 'client' (same staff
 * distinction as lib/portal/team/gate.ts). Clients/teammates see "not available".
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { ApprovalsList, type AgentProposal } from '@/components/portal/approvals-list'

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <NotAvailable />
  const role = (user.app_metadata as Record<string, unknown> | undefined)?.role
  if (role === 'client') return <NotAvailable />

  const { data } = await supabaseAdmin
    .from('approval_queue')
    .select('id, tool_name, params, rationale, created_at, expires_at')
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(100)

  const proposals = (data ?? []) as unknown as AgentProposal[]

  return (
    <div className="max-w-3xl mx-auto px-4 lg:px-8 py-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Approvals</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Actions the assistant proposed — approve to let it run, or reject.
        </p>
      </div>
      <ApprovalsList initial={proposals} />
    </div>
  )
}

function NotAvailable() {
  return (
    <div className="max-w-2xl mx-auto px-4 lg:px-8 py-16 text-center">
      <h1 className="text-lg font-semibold text-zinc-900">Approvals</h1>
      <p className="text-sm text-zinc-500 mt-2">This page is only available to the Tony Durante team.</p>
    </div>
  )
}
