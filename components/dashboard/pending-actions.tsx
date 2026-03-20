'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, XCircle, BrainCircuit, Loader2 } from 'lucide-react'

interface AgentDecision {
  id: string
  situation: string
  action_taken: string
  tools_used: string[] | null
  account_id: string | null
  contact_id: string | null
  task_id: string | null
  approved: boolean | null
  created_at: string
}

export function PendingActions() {
  const [decisions, setDecisions] = useState<AgentDecision[]>([])
  const [loading, setLoading] = useState(true)
  const [actioning, setActioning] = useState<string | null>(null)

  const fetchDecisions = useCallback(async () => {
    try {
      const res = await fetch('/api/agent-decisions?status=pending&limit=10')
      if (!res.ok) return
      const data = await res.json()
      setDecisions(data.decisions ?? [])
    } catch {
      // Silently fail — widget is non-critical
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDecisions()
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchDecisions, 30_000)
    return () => clearInterval(interval)
  }, [fetchDecisions])

  async function handleAction(id: string, approved: boolean) {
    setActioning(id)
    try {
      const res = await fetch('/api/agent-decisions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, approved }),
      })
      if (res.ok) {
        // Remove from list immediately
        setDecisions(prev => prev.filter(d => d.id !== id))
      }
    } catch {
      // Silently fail
    } finally {
      setActioning(null)
    }
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-5 animate-pulse">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          AI Pending Actions
        </div>
        <div className="space-y-3">
          <div className="h-4 bg-zinc-100 rounded w-3/4" />
          <div className="h-4 bg-zinc-100 rounded w-1/2" />
        </div>
      </div>
    )
  }

  if (decisions.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          AI Pending Actions
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <BrainCircuit className="h-8 w-8 mb-2 text-zinc-300" />
          <p className="text-sm">No pending actions</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          AI Pending Actions
        </h3>
        <span className="text-xs text-muted-foreground">{decisions.length} pending</span>
      </div>
      <div className="space-y-2">
        {decisions.map(decision => (
          <div
            key={decision.id}
            className="bg-violet-50 rounded-lg p-3 text-sm"
          >
            <p className="font-medium text-zinc-800 line-clamp-2 mb-1">
              {decision.situation}
            </p>
            <p className="text-xs text-zinc-600 line-clamp-2 mb-2">
              {decision.action_taken}
            </p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {timeAgo(decision.created_at)}
              </span>
              <div className="flex gap-1.5">
                <button
                  onClick={() => handleAction(decision.id, true)}
                  disabled={actioning === decision.id}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors disabled:opacity-50"
                >
                  {actioning === decision.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" />
                  )}
                  Approve
                </button>
                <button
                  onClick={() => handleAction(decision.id, false)}
                  disabled={actioning === decision.id}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 transition-colors disabled:opacity-50"
                >
                  {actioning === decision.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )}
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
