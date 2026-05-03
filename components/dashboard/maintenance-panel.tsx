'use client'

import { useState } from 'react'
import { Wrench, Loader2, AlertTriangle, Banknote } from 'lucide-react'

type Result =
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

export function MaintenancePanel() {
  const [airwallexLoading, setAirwallexLoading] = useState(false)
  const [airwallexResult, setAirwallexResult] = useState<Result | null>(null)

  const handleAirwallexBackfill = async () => {
    setAirwallexLoading(true)
    setAirwallexResult(null)
    try {
      const res = await fetch('/api/admin/airwallex-backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '2026-01-01' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAirwallexResult({ kind: 'error', message: data.error || 'Backfill failed' })
      } else {
        setAirwallexResult({
          kind: 'ok',
          message: `Backfilled ${data.from} → ${data.to}: added ${data.added}, skipped ${data.skipped}, errors ${data.errors}`,
        })
      }
    } catch (err) {
      setAirwallexResult({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setAirwallexLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-blue-200 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Wrench className="h-4 w-4 text-blue-600" />
        <h3 className="text-xs font-medium text-blue-700 uppercase tracking-wide">
          Maintenance
        </h3>
        <span className="ml-auto text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">
          ADMIN
        </span>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs text-muted-foreground mb-2">
            One-off operational triggers. These run against the live system —
            re-using them later is safe (idempotent on `external_id`).
          </p>

          <button
            onClick={handleAirwallexBackfill}
            disabled={airwallexLoading}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {airwallexLoading
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Banknote className="h-3.5 w-3.5" />}
            Backfill Airwallex deposits (since Jan 1)
          </button>

          {airwallexResult && (
            <div className={`mt-2 text-xs p-2.5 rounded-md whitespace-pre-wrap max-h-40 overflow-y-auto ${
              airwallexResult.kind === 'error'
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            }`}>
              {airwallexResult.message}
            </div>
          )}
        </div>

        <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
          <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
          <span>Backfill writes to td_bank_feeds via upsert on external_id — re-running won&apos;t duplicate rows.</span>
        </div>
      </div>
    </div>
  )
}
