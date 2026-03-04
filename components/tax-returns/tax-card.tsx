'use client'

import { Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO } from 'date-fns'
import type { TaxReturn } from '@/lib/types'

const TYPE_COLORS: Record<string, string> = {
  MMLLC: 'bg-indigo-100 text-indigo-700',
  SMLLC: 'bg-blue-100 text-blue-700',
  Corp: 'bg-violet-100 text-violet-700',
  LSE: 'bg-zinc-100 text-zinc-700',
}

const STATUS_SHORT: Record<string, string> = {
  'Payment Pending': 'Pagamento',
  'Paid - Need Deal': 'Need Deal',
  'Deal Created - Need Link': 'Need Link',
  'Link Sent - Awaiting Data': 'Attesa Dati',
  'Data Received': 'Dati OK',
  'Sent to India': 'India',
  'Extension Filed': 'Extension',
  'TR Completed - Awaiting Signature': 'Firma',
  'TR Filed': 'Completato',
}

function getDeadlineInfo(deadline: string, today: string) {
  const due = parseISO(deadline)
  const now = parseISO(today)
  const diff = differenceInDays(due, now)
  if (diff < 0) return { text: `Scaduto ${Math.abs(diff)}g`, urgent: true }
  if (diff === 0) return { text: 'Scade oggi', urgent: true }
  if (diff <= 7) return { text: `${diff}g`, urgent: true }
  if (diff <= 30) return { text: `${diff}g`, urgent: false }
  return { text: `${diff}g`, urgent: false }
}

function isFollowUp(tr: TaxReturn, today: string): boolean {
  const updated = parseISO(tr.updated_at)
  const now = parseISO(today)
  return differenceInDays(now, updated) >= 5
}

export function TaxCard({ taxReturn: tr, today }: { taxReturn: TaxReturn; today: string }) {
  const deadlineInfo = getDeadlineInfo(tr.deadline, today)
  const followUp = isFollowUp(tr, today)

  return (
    <div
      className={cn(
        'bg-white rounded-lg border p-3 text-sm',
        deadlineInfo.urgent && 'border-red-200 bg-red-50/50'
      )}
    >
      {/* Top: type badge + status */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', TYPE_COLORS[tr.return_type] ?? 'bg-zinc-100')}>
          {tr.return_type}
        </span>
        <div className="flex items-center gap-1">
          {followUp && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
              FOLLOW UP
            </span>
          )}
          {deadlineInfo.urgent && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700">
              {deadlineInfo.text}
            </span>
          )}
        </div>
      </div>

      {/* Company name */}
      <p className="font-medium text-sm leading-snug truncate">{tr.company_name}</p>
      {tr.client_name && (
        <p className="text-xs text-muted-foreground truncate">{tr.client_name}</p>
      )}

      {/* Bottom: deadline + status */}
      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {tr.deadline}
          {!deadlineInfo.urgent && ` (${deadlineInfo.text})`}
        </span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
          {STATUS_SHORT[tr.status] ?? tr.status}
        </span>
      </div>
    </div>
  )
}
