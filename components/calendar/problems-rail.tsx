'use client'

/**
 * Problems rail — the Compliance Truth Calendar's flag surface
 * (plan 89c951a7, Antonio's ruling: no error emails — a blinking flag on the
 * calendar that Luca clicks to see the problem, the explanation, and the
 * system's proposed solution, with a one-click fix where the fix is safe).
 *
 * DECOUPLED from the year the grid is showing: a 2025 stale record shows
 * here while the grid displays 2027. Urgent problems (overdue / unpaid hold)
 * blink; hygiene problems (missing dates) sit in a collapsed counter.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Lock,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RenewalFixProposal } from '@/lib/operations/renewal-problem-proposals'

interface ProblemsRailProps {
  proposals: RenewalFixProposal[]
}

const OBLIGATION_LABEL: Record<RenewalFixProposal['obligation'], string> = {
  ra_renewal: 'RA Renewal',
  annual_report: 'Annual Report',
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  overdue: { label: 'Overdue', className: 'bg-red-100 text-red-700' },
  on_hold_unpaid: { label: 'On hold — unpaid', className: 'bg-orange-100 text-orange-700' },
  missing_data: { label: 'Missing data', className: 'bg-amber-100 text-amber-800' },
}

function ProblemCard({ proposal }: { proposal: RenewalFixProposal }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [applying, setApplying] = useState(false)
  const badge = STATUS_BADGE[proposal.status] ?? { label: proposal.status, className: 'bg-zinc-100 text-zinc-600' }

  async function applyFix() {
    if (!proposal.autoFix || applying) return
    // The 'confirm' tier promises a judgment step — enforce it in the UI,
    // not just in prose (architect finding): staff must re-read the card's
    // reasoning and explicitly confirm before the write happens.
    if (proposal.tier === 'confirm') {
      const ok = window.confirm(
        `${proposal.companyName}\n\n${proposal.details}\n\nApply this fix?`,
      )
      if (!ok) return
    }
    setApplying(true)
    try {
      const res = await fetch('/api/calendar/fix-renewal-problem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: proposal.accountId,
          obligation: proposal.obligation,
          action: proposal.action,
          auto_fix: proposal.autoFix,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Fix could not be applied — refresh and try again.')
      }
      toast.success(`${proposal.companyName}: ${data.applied}`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Fix could not be applied.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="border rounded-md bg-white">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
        )}
        <span className="font-medium truncate">{proposal.companyName}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 shrink-0">
          {OBLIGATION_LABEL[proposal.obligation]}
        </span>
        <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0', badge.className)}>
          {badge.label}
        </span>
        <span className="hidden sm:inline text-xs text-muted-foreground truncate flex-1">
          {proposal.summary}
        </span>
        {proposal.tier === 'antonio_only' && (
          <Lock className="h-3.5 w-3.5 text-orange-500 shrink-0" aria-label="Antonio decides" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t bg-zinc-50/50 space-y-3">
          <p className="text-sm text-zinc-700 whitespace-pre-line">{proposal.details}</p>
          <div className="flex flex-wrap items-center gap-2">
            {proposal.autoFix && (
              <button
                type="button"
                onClick={applyFix}
                disabled={applying}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50"
              >
                {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                Fix record → {proposal.autoFix.to}
              </button>
            )}
            {proposal.tier === 'antonio_only' && (
              <span className="inline-flex items-center gap-1 text-xs text-orange-700 bg-orange-100 px-2 py-1 rounded-full">
                <Lock className="h-3 w-3" /> Antonio decides — money
              </span>
            )}
            <a
              href={`/accounts/${proposal.accountId}`}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              Open account <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

export function ProblemsRail({ proposals }: ProblemsRailProps) {
  const urgent = proposals.filter(p => p.status === 'overdue' || p.status === 'on_hold_unpaid')
  const hygiene = proposals.filter(p => p.status === 'missing_data')
  const [showHygiene, setShowHygiene] = useState(false)

  if (proposals.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-800">
        All companies check out — no renewal problems detected.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {urgent.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50/60 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-600" />
            </span>
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
            <h2 className="font-semibold text-sm text-red-800">
              {urgent.length} problem{urgent.length === 1 ? '' : 's'} need attention
            </h2>
          </div>
          <p className="text-xs text-red-700">
            Click a row to see what is wrong and the proposed solution. These stay here — whatever
            year the calendar shows — until the system verifies they are resolved.
          </p>
          <div className="space-y-1.5">
            {urgent.map(p => (
              <ProblemCard key={`${p.accountId}:${p.obligation}`} proposal={p} />
            ))}
          </div>
        </div>
      )}

      {hygiene.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          <button
            type="button"
            onClick={() => setShowHygiene(!showHygiene)}
            className="w-full flex items-center gap-2 text-left"
          >
            {showHygiene ? (
              <ChevronDown className="h-4 w-4 text-amber-600 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-amber-600 shrink-0" />
            )}
            <span className="text-sm font-medium text-amber-800">
              {hygiene.length} compan{hygiene.length === 1 ? 'y' : 'ies'} with missing renewal dates
            </span>
            <span className="text-xs text-amber-700 hidden sm:inline">
              — invisible to reminders until the record is fixed
            </span>
          </button>
          {showHygiene && (
            <div className="space-y-1.5 mt-2">
              {hygiene.map(p => (
                <ProblemCard key={`${p.accountId}:${p.obligation}`} proposal={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
