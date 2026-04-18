'use client'

import { useTransition } from 'react'
import { Clock, Check, X as XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { toggleTaxReturnField } from '@/app/(dashboard)/tax-returns/actions'
import { TaxRowActions } from '@/components/tax-returns/tax-row-actions'
import type { TaxReturn } from '@/lib/types'

const TYPE_COLORS: Record<string, string> = {
  MMLLC: 'bg-indigo-100 text-indigo-700',
  SMLLC: 'bg-blue-100 text-blue-700',
  Corp: 'bg-violet-100 text-violet-700',
  LSE: 'bg-zinc-100 text-zinc-700',
}

const STATUS_SHORT: Record<string, string> = {
  'Payment Pending': 'Payment',
  'Link Sent - Awaiting Data': 'Awaiting Data',
  'Data Received': 'Data OK',
  'Sent to India': 'India',
  'Extension Filed': 'Extension',
  'TR Completed - Awaiting Signature': 'Signature',
  'TR Filed': 'Completed',
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

function ToggleChip({
  label,
  checked,
  onToggle,
  disabled,
}: {
  label: string
  checked: boolean
  onToggle: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      disabled={disabled}
      className={cn(
        'flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors',
        checked
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200',
        disabled && 'opacity-50'
      )}
    >
      {checked ? <Check className="h-2.5 w-2.5" /> : <XIcon className="h-2.5 w-2.5" />}
      {label}
    </button>
  )
}

export function TaxCard({
  taxReturn: tr,
  today,
  onEdit,
}: {
  taxReturn: TaxReturn
  today: string
  onEdit?: (tr: TaxReturn) => void
}) {
  const deadlineInfo = getDeadlineInfo(tr.deadline, today)
  const followUp = isFollowUp(tr, today)
  const [isPending, startTransition] = useTransition()

  const handleToggle = (field: string, currentValue: boolean | null) => {
    startTransition(async () => {
      const result = await toggleTaxReturnField(tr.id, field, !(currentValue ?? false), tr.updated_at)
      if (!result.success) {
        toast.error(result.error ?? 'Errore aggiornamento')
      }
    })
  }

  return (
    <div
      onClick={() => onEdit?.(tr)}
      className={cn(
        'bg-white rounded-lg border p-3 text-sm transition-shadow',
        deadlineInfo.urgent && 'border-red-200 bg-red-50/50',
        onEdit && 'cursor-pointer hover:shadow-md'
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

      {/* Quick toggle chips + row actions */}
      <div className="flex items-center gap-1.5 mt-2">
        <ToggleChip
          label="Paid"
          checked={tr.paid ?? false}
          onToggle={() => handleToggle('paid', tr.paid)}
          disabled={isPending}
        />
        <ToggleChip
          label="Data"
          checked={tr.data_received ?? false}
          onToggle={() => handleToggle('data_received', tr.data_received)}
          disabled={isPending}
        />
        <ToggleChip
          label="India"
          checked={tr.sent_to_india ?? false}
          onToggle={() => handleToggle('sent_to_india', tr.sent_to_india)}
          disabled={isPending}
        />
        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <TaxRowActions taxReturn={tr} />
        </div>
      </div>

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
