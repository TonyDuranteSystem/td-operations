import { cn } from '@/lib/utils'
import { INSTALLMENT_CHIP_LABEL, type InstallmentChip as InstallmentChipData, type InstallmentChipKind } from '@/lib/billing/installment-invoices'

const CHIP_CLASS: Record<InstallmentChipKind, string> = {
  paid: 'bg-emerald-100 text-emerald-700',
  pending: 'bg-amber-100 text-amber-700',
  overdue: 'bg-red-100 text-red-700',
  waived: 'bg-zinc-100 text-zinc-500',
  refunded: 'bg-zinc-100 text-zinc-500',
  not_invoiced: 'bg-zinc-100 text-zinc-500',
  duplicate: 'bg-red-100 text-red-700',
}

/**
 * The small Paid / Pending / Overdue chip next to an installment amount (the chosen year's invoice). Nothing is drawn when no installment
 * invoice exists for that year: the amount is the agreed contract amount, and "Not invoiced" next to it read as if something were wrong.
 */
export function InstallmentChip({ chip }: { chip: InstallmentChipData }) {
  if (chip.kind === 'not_invoiced') return null
  const label = chip.kind === 'duplicate' ? `${chip.count} invoices` : INSTALLMENT_CHIP_LABEL[chip.kind]
  return (
    <span
      className={cn('whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold', CHIP_CLASS[chip.kind])}
      title={chip.kind === 'duplicate' ? 'More than one invoice exists for this installment this year. Open the Account page to resolve it.' : undefined}
    >
      {label}
    </span>
  )
}

const ENTITY_COLORS: Record<string, string> = {
  'Single Member LLC': 'bg-blue-100 text-blue-700',
  'Multi Member LLC': 'bg-indigo-100 text-indigo-700',
  'C-Corp Elected': 'bg-violet-100 text-violet-700',
}

const ENTITY_SHORT: Record<string, string> = {
  'Single Member LLC': 'SMLLC',
  'Multi Member LLC': 'MMLLC',
  'C-Corp Elected': 'Corp',
}

/** SMLLC / MMLLC / Corp chip. Nothing is drawn when the company type is empty. */
export function EntityChip({ entityType }: { entityType: string | null }) {
  if (!entityType) return <span className="text-xs text-muted-foreground">not set</span>
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', ENTITY_COLORS[entityType] ?? 'bg-zinc-100')}>
      {ENTITY_SHORT[entityType] ?? entityType}
    </span>
  )
}

const STATUS_COLORS: Record<string, string> = {
  Active: 'bg-emerald-100 text-emerald-700',
  Offboarding: 'bg-amber-100 text-amber-700',
  Suspended: 'bg-amber-100 text-amber-700',
  'Pending Formation': 'bg-blue-100 text-blue-700',
  Closed: 'bg-zinc-100 text-zinc-500',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

/** The company's status word. */
export function StatusChip({ status }: { status: string | null }) {
  if (!status) return null
  return <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', STATUS_COLORS[status] ?? 'bg-zinc-100 text-zinc-600')}>{status}</span>
}

/** "One-time" / "Partner" next to a company name (nothing for an ordinary Client). */
export function KindChip({ kind }: { kind: string | null }) {
  if (!kind || kind === 'Client') return null
  return <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-500">{kind === 'One-Time' ? 'One-time' : kind}</span>
}
