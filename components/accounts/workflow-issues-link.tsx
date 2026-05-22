'use client'

/**
 * Small account-header indicator: shows "N workflow issues" ONLY when this
 * account has open workflow dispatch problems, linking to the dedicated
 * /workflow-issues page filtered to this account. When there are none (the
 * normal case) it renders nothing — keeping the account page uncluttered.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { fetchAccountWorkflowIssueCount } from '@/app/(dashboard)/shared/workflow-issues-action'

export function WorkflowIssuesLink({ accountId }: { accountId: string }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let active = true
    fetchAccountWorkflowIssueCount(accountId)
      .then(c => { if (active) setCount(c) })
      .catch(() => {})
    return () => { active = false }
  }, [accountId])

  if (count <= 0) return null

  return (
    <Link
      href={`/workflow-issues?account=${accountId}`}
      className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-rose-100 text-rose-700 hover:bg-rose-200 transition-colors"
      title="This client has automation issues — view them"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {count} workflow {count === 1 ? 'issue' : 'issues'}
    </Link>
  )
}
