'use client'

import { useState } from 'react'

export interface AgentProposal {
  id: string
  tool_name: string
  params: Record<string, unknown> | null
  rationale: string | null
  created_at: string
  expires_at: string
}

function relativeAge(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function ApprovalsList({ initial }: { initial: AgentProposal[] }) {
  const [proposals, setProposals] = useState<AgentProposal[]>(initial)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy((b) => ({ ...b, [id]: true }))
    setError(null)
    try {
      const res = await fetch('/api/portal/team/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not record your decision — please try again.')
      }
      setProposals((p) => p.filter((x) => x.id !== id))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Something went wrong — please try again.')
    } finally {
      setBusy((b) => ({ ...b, [id]: false }))
    }
  }

  if (proposals.length === 0) {
    return <p className="text-sm text-zinc-500 py-8 text-center">Nothing waiting for approval. 🎉</p>
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>
      )}
      <div className="bg-white rounded-xl border divide-y">
        {proposals.map((p) => (
          <div key={p.id} className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 break-words">{p.tool_name}</p>
                {p.rationale && <p className="text-sm text-zinc-600 mt-0.5">{p.rationale}</p>}
                <p className="text-[11px] text-zinc-400 mt-1">{relativeAge(p.created_at)}</p>
              </div>
            </div>
            {p.params && Object.keys(p.params).length > 0 && (
              <pre className="text-xs bg-zinc-50 border rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-words text-zinc-700">
                {JSON.stringify(p.params, null, 2)}
              </pre>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => decide(p.id, 'approve')}
                disabled={busy[p.id]}
                className="h-10 px-4 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {busy[p.id] ? '…' : 'Approve'}
              </button>
              <button
                onClick={() => decide(p.id, 'reject')}
                disabled={busy[p.id]}
                className="h-10 px-4 rounded-lg bg-white border border-zinc-300 text-zinc-700 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
