'use client'

import { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { saveListAmount } from '@/app/(dashboard)/accounts/list-actions'
import { formatMoney, type ListAmountField } from '@/lib/crm-lists/amounts'
import { parseAmountInput, formatNumber } from '@/lib/signed-contracts/amount-input'
import type { InstallmentChip as InstallmentChipData } from '@/lib/billing/installment-invoices'
import { InstallmentChip } from './chips'
import type { SavedAmount } from './use-amount-overrides'

/**
 * One editable money cell (1st Inst, 2nd Inst or Setup fee). Click the amount, type, press Enter to save (Esc to cancel).
 * A Closed / Cancelled / Offboarding company shows the amount greyed with a lock and cannot be edited (the server refuses too).
 * The cell sits inside a clickable row, so everything interactive carries `data-no-nav`.
 */
export function AmountCell({
  accountId,
  field,
  amount,
  currency,
  locked,
  updatedAt,
  chip,
  emptyLabel = 'no amount saved',
  onSaved,
}: {
  accountId: string
  field: ListAmountField
  amount: number | null
  currency: string | null
  locked: boolean
  updatedAt: string
  /** Paid / Pending / Overdue / Not invoiced for this year. Not shown for the setup fee or when there is no amount. */
  chip?: InstallmentChipData
  /** What an empty amount says (the setup fee column uses a plain dash). */
  emptyLabel?: string
  onSaved: (saved: SavedAmount) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const label = amount != null ? formatMoney(amount, currency) : emptyLabel

  function start() {
    if (locked || saving) return
    setDraft(amount != null ? String(amount) : '')
    setEditing(true)
  }

  function cancel() {
    if (!saving) setEditing(false)
  }

  async function commit() {
    if (saving) return
    // Nothing changed: just close.
    const typed = parseAmountInput(draft)
    if (typed.kind === 'ok' && amount != null && typed.value === amount) {
      setEditing(false)
      return
    }
    if (draft.trim() === '' && amount == null) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      const res = await saveListAmount(accountId, field, draft, updatedAt)
      if (!res.success) {
        toast.error(res.error || 'Could not save. Please try again.')
        return
      }
      toast.success('Saved. Every screen now shows the new amount.')
      setEditing(false)
      onSaved({ accountId, field, amount: res.amount ?? null, updatedAt: res.updatedAt })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    const parsed = draft.trim() === '' ? null : parseAmountInput(draft)
    // Show how a typed value was understood ("1.250" -> 1,250) whenever it is not already the plain number.
    const readAs = parsed && parsed.kind === 'ok' && draft.trim() !== String(parsed.value) ? formatNumber(parsed.value) : null
    return (
      <div className="min-w-0" data-no-nav>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={draft}
            disabled={saving}
            aria-label="Amount"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
            className="w-[84px] rounded-md border-2 border-blue-600 bg-white px-2 py-0.5 text-sm font-semibold tabular-nums focus:outline-none"
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => void commit()}
            className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {saving ? '…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={cancel}
            className="rounded border px-2 py-0.5 text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
          >
            Esc
          </button>
        </div>
        {parsed && parsed.kind === 'refused' && <p className="mt-0.5 text-[11px] text-red-600">{parsed.error}</p>}
        {readAs && <p className="mt-0.5 text-[11px] text-muted-foreground">Read as {readAs}</p>}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5" data-no-nav>
      {amount == null ? (
        locked ? (
          <span className="text-xs text-muted-foreground">{label}</span>
        ) : (
          <button type="button" onClick={start} className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-zinc-900">
            {label}
          </button>
        )
      ) : locked ? (
        <>
          <span className="text-sm font-semibold tabular-nums">{label}</span>
          <Lock className="h-3 w-3 shrink-0 text-zinc-500" aria-label="Locked" />
        </>
      ) : (
        <button
          type="button"
          onClick={start}
          className={cn('text-sm font-semibold tabular-nums underline decoration-dotted decoration-zinc-400 underline-offset-2 hover:decoration-zinc-900')}
        >
          {label}
        </button>
      )}
      {chip && amount != null && <InstallmentChip chip={chip} />}
    </div>
  )
}
