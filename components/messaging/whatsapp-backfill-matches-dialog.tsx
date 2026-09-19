'use client'

/**
 * "Find matching clients" — a one-shot, staff-triggered sweep of every
 * unlinked WhatsApp conversation against the CRM (dev job f331cd43,
 * 2026-09-18). Antonio: "can now the system read all chats and check if the
 * current numbers belongs to active client and save them and update their
 * profile." Runs /api/inbox/whatsapp/backfill-matches on open, which links
 * every confident (single, exact full-number) match immediately and returns
 * a summary — this dialog just shows the result and lets Antonio resolve
 * any ambiguous ones (the same number really does exist on 2+ CRM records)
 * by picking which is right.
 */

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

interface AmbiguousCandidate {
  type: 'lead' | 'contact'
  id: string
  name: string
  phone: string | null
}
interface LinkedResult {
  groupId: string
  previousName: string | null
  matchedName: string
  matchedType: 'lead' | 'contact'
}
interface AmbiguousResult {
  groupId: string
  previousName: string | null
  candidates: AmbiguousCandidate[]
}

export function WhatsAppBackfillMatchesDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [linked, setLinked] = useState<LinkedResult[]>([])
  const [ambiguous, setAmbiguous] = useState<AmbiguousResult[]>([])
  const [resolving, setResolving] = useState<string | null>(null)
  const [ran, setRan] = useState(false)

  const run = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/inbox/whatsapp/backfill-matches', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not check for matches.')
      setLinked(json.linked ?? [])
      setAmbiguous(json.ambiguous ?? [])
      setRan(true)
      if ((json.linked ?? []).length > 0) {
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check for matches.')
    } finally {
      setLoading(false)
    }
  }

  // Run once, the moment the dialog opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately run-once-on-mount, `run` is stable enough for this dialog's lifetime
  useEffect(() => { run() }, [])

  const resolve = async (groupId: string, pick: AmbiguousCandidate) => {
    setResolving(groupId)
    try {
      const res = await fetch('/api/inbox/whatsapp-new/create-record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          pick.type === 'contact'
            ? { groupId, existingContactId: pick.id }
            : { groupId, existingLeadId: pick.id }
        ),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not link that conversation.')
      setAmbiguous((prev) => prev.filter((a) => a.groupId !== groupId))
      toast.success(`Linked to ${pick.name}`)
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not link that conversation.')
    } finally {
      setResolving(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto bg-white rounded-xl shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-white">
          <h2 className="text-sm font-semibold text-zinc-800">Find matching clients</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-500 py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking every WhatsApp number against the CRM…
            </div>
          )}

          {!loading && error && (
            <div className="text-sm text-red-600">{error}</div>
          )}

          {!loading && !error && ran && (
            <>
              <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md px-3 py-2">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {linked.length === 0
                    ? 'No new matches found — nothing to link.'
                    : `Linked ${linked.length} conversation${linked.length === 1 ? '' : 's'} to an existing client or lead.`}
                </span>
              </div>

              {linked.length > 0 && (
                <ul className="text-xs text-zinc-600 space-y-1">
                  {linked.map((l) => (
                    <li key={l.groupId}>
                      {l.previousName ?? l.groupId} → <span className="font-medium">{l.matchedName}</span>
                    </li>
                  ))}
                </ul>
              )}

              {ambiguous.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-3 py-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>
                      {ambiguous.length} number{ambiguous.length === 1 ? '' : 's'} match more than one person in the
                      CRM — pick which one is right, or leave it for later.
                    </span>
                  </div>
                  {ambiguous.map((a) => (
                    <div key={a.groupId} className="border rounded-md p-3 space-y-2">
                      <div className="text-sm font-medium text-zinc-800">{a.previousName ?? a.groupId}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {a.candidates.map((c) => (
                          <button
                            key={`${c.type}-${c.id}`}
                            onClick={() => resolve(a.groupId, c)}
                            disabled={resolving === a.groupId}
                            className="px-2.5 py-1 rounded-full text-xs font-medium border bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"
                          >
                            {c.name} <span className="text-zinc-400">({c.type})</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
