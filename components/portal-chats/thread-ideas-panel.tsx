'use client'

/**
 * ThreadIdeasPanel — the "Idea request" tab in /portal-chats for one client thread (dev job 1a23f5f1).
 * Feature ideas the client wrote in the box at the bottom of Customers & Invoices. A blue dot on the tab shows
 * unhandled ones; ticking one handled removes it from the count (unticking brings it back).
 */

import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lightbulb, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const API = '/api/crm/admin-actions/feature-ideas'

interface ApiIdea {
  id: string
  idea: string
  created_at: string
  handled_at: string | null
  handled_by: string | null
}

export function ThreadIdeasPanel({ accountId, contactId }: { accountId: string | null; contactId: string | null }) {
  const qc = useQueryClient()
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scopeKey = accountId ?? contactId
  const param = accountId ? `account_id=${accountId}` : contactId ? `contact_id=${contactId}` : null

  const { data: ideas, isLoading } = useQuery<ApiIdea[]>({
    queryKey: ['thread-feature-ideas', scopeKey],
    queryFn: () => fetch(`${API}?list=true&${param}`).then(r => r.json()).then((d: { ideas?: ApiIdea[] }) => d.ideas || []),
    enabled: !!param,
    refetchInterval: 30_000,
  })

  const toggle = useCallback(async (idea: ApiIdea) => {
    setTogglingId(idea.id)
    setError(null)
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idea.id, handled: !idea.handled_at }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not update this idea.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this idea.')
    } finally {
      await qc.invalidateQueries({ queryKey: ['thread-feature-ideas'] })
      await qc.invalidateQueries({ queryKey: ['portal-chat-feature-idea-counts'] })
      setTogglingId(null)
    }
  }, [qc])

  if (!param) {
    return <div className="flex items-center justify-center py-6"><p className="text-sm text-zinc-400">Select a conversation</p></div>
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="ideas-panel">
      <div className="px-4 py-2 bg-blue-50/60 border-b border-blue-100 flex items-center gap-1.5 shrink-0">
        <Lightbulb className="h-3.5 w-3.5 text-blue-500" />
        <span className="text-xs font-medium text-blue-700">Idea request — what this client would like us to build</span>
      </div>
      {error && <p className="px-4 py-2 text-xs text-red-600">{error}</p>}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>
        ) : !ideas || ideas.length === 0 ? (
          <p className="text-sm text-zinc-400 text-center py-6">No ideas from this client yet.</p>
        ) : (
          ideas.map(i => (
            <div key={i.id} className={cn('rounded-lg border bg-white p-3 flex items-start gap-3', !i.handled_at && 'border-blue-200 bg-blue-50/30')}>
              <button
                onClick={() => toggle(i)}
                disabled={togglingId === i.id}
                aria-label={i.handled_at ? 'Mark as not handled' : 'Mark as handled'}
                className={cn('mt-0.5 h-5 w-5 shrink-0 rounded border flex items-center justify-center', i.handled_at ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-zinc-300 hover:border-blue-500')}
              >
                {togglingId === i.id ? <Loader2 className="h-3 w-3 animate-spin" /> : i.handled_at ? <Check className="h-3 w-3" /> : null}
              </button>
              <div className="min-w-0">
                <p className="text-sm text-zinc-900 whitespace-pre-wrap break-words">{i.idea}</p>
                <p className="text-[11px] text-zinc-400 mt-1">
                  {new Date(i.created_at).toLocaleString()}
                  {i.handled_at ? ` · handled${i.handled_by ? ` by ${i.handled_by}` : ''}` : ''}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
