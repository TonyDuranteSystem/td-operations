'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { X, Building2, Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { daysInStage, TAX_BOARD_ASSIGNEES, type BoardCard } from '@/lib/tax/tax-board'
import { assignTaxBoardCard } from '@/app/(dashboard)/tax-returns/board-actions'

/**
 * Tax Board card detail drawer (Slice 7a). Read-only summary + assignee
 * picker (the one low-risk write). Stage advance / review actions arrive in
 * 7b on top of this same panel.
 */
export function TaxCardDetail({
  card,
  columnLabel,
  staleDays,
  nowIso,
  onClose,
}: {
  card: BoardCard
  columnLabel: string
  staleDays: number | null
  nowIso: string
  onClose: () => void
}) {
  const router = useRouter()
  const [assignee, setAssignee] = useState<string | null>(card.assignedTo)
  const [isPending, startTransition] = useTransition()

  const days = daysInStage(card.stageEnteredAt, new Date(nowIso))

  function setAssign(next: string | null) {
    if (next === assignee) return
    const prev = assignee
    setAssignee(next)
    startTransition(async () => {
      const res = await assignTaxBoardCard(card.sdId, next)
      if (res.success) {
        toast.success(`Assigned to ${next ?? 'Unassigned'}`)
        router.refresh()
      } else {
        setAssignee(prev)
        toast.error(res.error ?? 'Failed to update assignee')
      }
    })
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Tax Return
          </h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* Company */}
          <div>
            {card.accountId ? (
              <Link
                href={`/accounts/${card.accountId}`}
                className="flex items-center gap-2 text-lg font-semibold text-zinc-800 hover:text-blue-600 hover:underline"
              >
                <Building2 className="h-4 w-4 text-zinc-400" />
                {card.companyName ?? 'Unknown company'}
              </Link>
            ) : (
              <span className="flex items-center gap-2 text-lg font-semibold text-zinc-800">
                <Building2 className="h-4 w-4 text-zinc-400" />
                {card.companyName ?? 'Unknown company'}
              </span>
            )}
          </div>

          {/* Facts */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Fact label="Stage" value={columnLabel} />
            <Fact label="Days in stage" value={days === null ? '—' : `${days}d${staleDays && days >= staleDays ? ' ⚠️' : ''}`} />
            <Fact label="Return type" value={card.returnType ?? '—'} />
            <Fact label="Tax year" value={card.taxYear ? String(card.taxYear) : '—'} />
            <Fact label="Entity" value={card.entityType ?? '—'} />
            <Fact label="Deadline" value={card.deadline ?? '—'} />
            <Fact
              label="Payment"
              value={card.paid ? 'Paid' : 'Unpaid'}
              valueClass={card.paid ? 'text-emerald-600' : 'text-amber-600'}
            />
            <Fact
              label="Extension"
              value={card.extensionFiled ? 'Filed' : 'No'}
              valueClass={card.extensionFiled ? 'text-purple-600' : 'text-zinc-500'}
            />
            {card.reviewStatus && (
              <Fact label="Review" value={card.reviewStatus.replace(/_/g, ' ')} />
            )}
          </dl>

          {/* Assignee */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
              Assignee {isPending && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
            </p>
            <div className="flex flex-wrap gap-2">
              <AssigneeChip label="Unassigned" active={assignee === null} onClick={() => setAssign(null)} disabled={isPending} />
              {TAX_BOARD_ASSIGNEES.map(name => (
                <AssigneeChip
                  key={name}
                  label={name}
                  active={assignee === name}
                  onClick={() => setAssign(name)}
                  disabled={isPending}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function Fact({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</dt>
      <dd className={cn('mt-0.5 font-medium text-zinc-700', valueClass)}>{value}</dd>
    </div>
  )
}

function AssigneeChip({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string
  active: boolean
  onClick: () => void
  disabled: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-60',
        active ? 'bg-zinc-800 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
      )}
    >
      {active && <Check className="h-3 w-3" />}
      {label}
    </button>
  )
}
