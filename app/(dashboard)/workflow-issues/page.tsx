import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import {
  getWorkflowIssues,
  dispatchOutcomeLabel,
  dispatchSourceLabel,
  dispatchSeverity,
} from '@/lib/operations/workflow-issues'

export const dynamic = 'force-dynamic'

function ageLabel(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return iso
  }
}

export default async function WorkflowIssuesPage({
  searchParams,
}: {
  searchParams: { account?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    redirect('/')
  }

  const accountId = searchParams.account
  const issues = await getWorkflowIssues({ accountId })

  // When filtered to one account, surface its name from the first row.
  const filterName = accountId ? (issues.find(i => i.account_name)?.account_name ?? null) : null

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workflow issues</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Automations that should have started a task but didn&apos;t — no matching workflow, an
          ambiguous match, or a failure. Successful runs are not shown.
        </p>
        {accountId && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              Filtered to {filterName ?? 'this account'}
            </span>
            <Link href="/workflow-issues" className="text-blue-600 hover:underline">Clear filter</Link>
          </div>
        )}
      </div>

      {issues.length === 0 ? (
        <div className="rounded-lg border bg-white p-10 text-center">
          <p className="text-sm text-zinc-700 font-medium">No workflow issues</p>
          <p className="text-xs text-muted-foreground mt-1">
            Every automation dispatch is matching and running cleanly.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-white divide-y">
          {issues.map(issue => {
            const severity = dispatchSeverity(issue.outcome)
            const toneClass = severity === 'warn'
              ? 'bg-amber-100 text-amber-700'
              : 'bg-red-100 text-red-700'
            const candidates = Array.isArray(issue.candidates) ? issue.candidates : []
            return (
              <div key={issue.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${toneClass}`}>
                        {dispatchOutcomeLabel(issue.outcome)}
                      </span>
                      <span className="text-xs text-zinc-500">{dispatchSourceLabel(issue.trigger_source)}</span>
                      {issue.event_descriptor && (
                        <span className="text-xs font-mono text-zinc-500 truncate">{issue.event_descriptor}</span>
                      )}
                    </div>
                    <div className="mt-1 text-sm text-zinc-800">
                      {issue.account_id ? (
                        <Link href={`/accounts/${issue.account_id}`} className="text-blue-600 hover:underline">
                          {issue.account_name ?? 'View account'}
                        </Link>
                      ) : (
                        <span className="text-zinc-400">No client attached</span>
                      )}
                      {issue.matched_workflow_slug && (
                        <span className="text-zinc-500"> · {issue.matched_workflow_slug}</span>
                      )}
                    </div>
                    {candidates.length > 0 && (
                      <div className="mt-0.5 text-xs text-zinc-500">Candidates: {candidates.join(', ')}</div>
                    )}
                  </div>
                  <span className="text-xs text-zinc-400 shrink-0">{ageLabel(issue.created_at)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
