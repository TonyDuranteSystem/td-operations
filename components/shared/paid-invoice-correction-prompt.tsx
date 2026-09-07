'use client'

/**
 * Shown instead of a plain save whenever staff change the amount on an
 * invoice that's already marked Paid — an ambiguous action that can mean a
 * few genuinely different things. Shared by Finance's own Edit dialog and
 * the Account page's Edit dialog (dev job ef5da377), design approved by
 * Antonio against a working mockup before this was built.
 */

import { useState } from 'react'
import { Percent, Plus, PenLine, Loader2 } from 'lucide-react'

export type CorrectionPath = 'partial_payment' | 'new_charge' | 'typo'

interface PaidInvoiceCorrectionPromptProps {
  invoiceLabel: string
  currency: string
  oldTotal: number
  newTotal: number
  currentAmountPaid: number
  onChoose: (path: CorrectionPath) => void
  onCancel: () => void
  isPending?: boolean
}

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount)
}

const OPTIONS: Array<{
  path: CorrectionPath
  title: string
  description: string
  icon: typeof Percent
  iconClass: string
  confirmLabel: string
}> = [
  {
    path: 'partial_payment',
    title: 'The client only paid part of it',
    description: "It shouldn't have been marked fully paid. Reopen it and show what's still owed.",
    icon: Percent,
    iconClass: 'bg-amber-50 text-amber-600',
    confirmLabel: 'Reopen as Partial',
  },
  {
    path: 'new_charge',
    title: "There's a new charge on top",
    description: 'The original payment was correct. Leave this one alone and start a new invoice for the difference.',
    icon: Plus,
    iconClass: 'bg-indigo-50 text-indigo-600',
    confirmLabel: 'Save & start new invoice',
  },
  {
    path: 'typo',
    title: 'Just fixing a typo',
    description: "The client really paid what's on file. Only the number here was wrong — the payment itself doesn't change.",
    icon: PenLine,
    iconClass: 'bg-zinc-100 text-zinc-600',
    confirmLabel: 'Just fix the number',
  },
]

export function PaidInvoiceCorrectionPrompt({
  invoiceLabel,
  currency,
  oldTotal,
  newTotal,
  currentAmountPaid,
  onChoose,
  onCancel,
  isPending = false,
}: PaidInvoiceCorrectionPromptProps) {
  const [selected, setSelected] = useState<CorrectionPath | null>(null)
  const difference = newTotal - oldTotal
  const stillOwed = Math.max(newTotal - currentAmountPaid, 0)

  const selectedOption = OPTIONS.find(o => o.path === selected)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-3 py-2.5 bg-zinc-50 border rounded-lg text-sm">
        <span className="text-muted-foreground font-medium">Amount</span>
        <span className="font-semibold tabular-nums">
          <span className="text-xs text-zinc-400 line-through mr-2">{formatMoney(oldTotal, currency)}</span>
          {formatMoney(newTotal, currency)}
        </span>
      </div>

      <div>
        <h3 className="font-semibold text-sm mb-1">
          {invoiceLabel} is already marked Paid — what&apos;s actually happening?
        </h3>
        <p className="text-xs text-muted-foreground">
          Changing the total on a paid invoice can mean different things. Pick the one that matches reality.
        </p>
      </div>

      <div className="space-y-2">
        {OPTIONS.map(opt => {
          const Icon = opt.icon
          const isSelected = selected === opt.path
          // A "new charge" only makes sense when the corrected number is
          // HIGHER than before — a decrease or no-change means the total was
          // mistyped, not that money is owed on top. Disabled rather than
          // just blocked on confirm (found live 2026-09-07, second
          // bug-hunter pass: picking this for a decrease created a
          // negative-total Draft mislabeled as a credit note).
          // "Partial payment" only makes sense when the corrected total is
          // still MORE than what's already been paid — otherwise there's
          // nothing left owing to reopen as Partial. Disabled for the same
          // reason (found live 2026-09-07, full council review: picking
          // this for a decrease left the invoice Paid with amount_paid
          // silently exceeding the new total).
          const disabled =
            (opt.path === 'new_charge' && difference <= 0) ||
            (opt.path === 'partial_payment' && newTotal <= currentAmountPaid)
          return (
            <button
              key={opt.path}
              type="button"
              disabled={disabled}
              onClick={() => setSelected(opt.path)}
              className={`w-full flex items-start gap-3 text-left p-3 rounded-lg border transition-colors ${
                disabled
                  ? 'border-zinc-100 opacity-50 cursor-not-allowed'
                  : isSelected ? 'border-zinc-900 ring-1 ring-zinc-900' : 'border-zinc-200 hover:border-zinc-300'
              }`}
            >
              <span className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${opt.iconClass}`}>
                <Icon className="w-4 h-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{opt.title}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  {disabled
                    ? opt.path === 'partial_payment'
                      ? "Doesn't apply — the corrected amount doesn't exceed what's already been paid."
                      : "Doesn't apply — the corrected amount isn't higher than before."
                    : opt.description}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {selected === 'partial_payment' && (
        <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900">
          <p className="font-semibold uppercase tracking-wide text-[10px] text-amber-700 mb-1">If you choose this</p>
          <p>
            The invoice reopens as <strong>Partial</strong> — {formatMoney(currentAmountPaid, currency)} already paid,{' '}
            <strong>{formatMoney(stillOwed, currency)} still due</strong>. It goes back on the reminder list.
          </p>
        </div>
      )}
      {selected === 'new_charge' && (
        <div className="p-3 rounded-lg border border-indigo-200 bg-indigo-50 text-xs text-indigo-900">
          <p className="font-semibold uppercase tracking-wide text-[10px] text-indigo-700 mb-1">If you choose this</p>
          <p>
            {invoiceLabel} stays exactly as it was — <strong>still Paid, still {formatMoney(oldTotal, currency)}</strong>. A new
            Draft invoice is started for the <strong>{formatMoney(difference, currency)}</strong> difference, ready to send separately.
          </p>
        </div>
      )}
      {selected === 'typo' && (
        <div className="p-3 rounded-lg border border-zinc-200 bg-zinc-50 text-xs text-zinc-700">
          <p className="font-semibold uppercase tracking-wide text-[10px] text-zinc-500 mb-1">If you choose this</p>
          <p>
            Only the number on the invoice changes, to <strong>{formatMoney(newTotal, currency)}</strong>. Status stays{' '}
            <strong>Paid</strong> — nothing about the real payment is touched.
          </p>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="flex-1 px-4 py-2 text-sm rounded-lg border hover:bg-zinc-50 disabled:opacity-50"
        >
          Cancel, don&apos;t change anything
        </button>
        <button
          type="button"
          disabled={!selected || isPending}
          onClick={() => selected && onChoose(selected)}
          className="flex-1 px-4 py-2 text-sm rounded-lg bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {selectedOption?.confirmLabel ?? 'Choose an option above'}
        </button>
      </div>
    </div>
  )
}
