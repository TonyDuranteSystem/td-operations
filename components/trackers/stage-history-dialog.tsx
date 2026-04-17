'use client'

/**
 * P3.4 #4 — stage history viewer for a service delivery.
 *
 * Opens from a tracker card's "History" link. Fetches the SD's
 * stage_history via getDeliveryStageHistory, renders a newest-first
 * timeline of each transition: from → to, when, by whom, optional notes.
 */

import { useState, useEffect, useCallback } from 'react'
import { X, Loader2, Clock, ArrowRight, User as UserIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getDeliveryStageHistory } from '@/app/(dashboard)/trackers/[serviceType]/actions'
import { formatRelativeTime, type StageHistoryEntry } from '@/lib/stage-history-helpers'

interface Props {
  open: boolean
  onClose: () => void
  deliveryId: string
  deliveryLabel: string
}

export function StageHistoryDialog({ open, onClose, deliveryId, deliveryLabel }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<StageHistoryEntry[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getDeliveryStageHistory(deliveryId)
      if (res.success) {
        setEntries(res.entries)
      } else {
        setError(res.error ?? 'Failed to load history')
        setEntries([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [deliveryId])

  useEffect(() => {
    if (open) {
      load()
    } else {
      setEntries([])
      setError(null)
    }
  }, [open, load])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label={`Stage history for ${deliveryLabel}`}
      >
        <div className="flex items-start justify-between px-5 py-3 border-b">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4" /> Stage History
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{deliveryLabel}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-100" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading…
            </div>
          )}

          {error && !loading && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="text-center py-10 text-sm text-zinc-500">
              No stage transitions recorded yet.
            </div>
          )}

          {!loading && !error && entries.length > 0 && (
            <ol className="space-y-3">
              {entries.map((e, i) => (
                <li
                  key={`${e.advanced_at ?? 'no-ts'}-${i}`}
                  className={cn(
                    'rounded-lg border bg-white p-3',
                    i === 0 && 'border-blue-200 bg-blue-50/40',
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {e.from_stage ? (
                      <>
                        <span className="text-zinc-500">{e.from_stage}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                        <span>{e.to_stage}</span>
                      </>
                    ) : (
                      <>
                        <span className="text-zinc-400 italic">initial</span>
                        <ArrowRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                        <span>{e.to_stage}</span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatRelativeTime(e.advanced_at)}
                    </span>
                    {e.actor && (
                      <span className="flex items-center gap-1">
                        <UserIcon className="h-3 w-3" />
                        {e.actor}
                      </span>
                    )}
                  </div>

                  {e.notes && (
                    <p className="mt-2 text-xs text-zinc-600 whitespace-pre-wrap">{e.notes}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
