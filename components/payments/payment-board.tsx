'use client'

import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  Clock,
  CheckCircle2,
  Building2,
  DollarSign,
  Calendar,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO, format } from 'date-fns'
import Link from 'next/link'

interface PaymentItem {
  id: string
  account_id: string
  description: string | null
  amount: string | number
  amount_currency: string | null
  period: string | null
  year: number | null
  due_date: string | null
  paid_date: string | null
  status: string | null
  payment_method: string | null
  installment: string | null
  amount_paid: string | number | null
  amount_due: string | number | null
  followup_stage: string | null
  delay_approved_until: string | null
  company_name: string | null
  updated_at: string
}

interface PaymentBoardProps {
  overdue: PaymentItem[]
  upcoming: PaymentItem[]
  paid: PaymentItem[]
  stats: {
    overdueCount: number
    overdueTotal: number
    upcomingCount: number
    upcomingTotal: number
    paidCount: number
    paidTotal: number
  }
  activeTab: string
  today: string
}

const FOLLOWUP_COLORS: Record<string, string> = {
  'Day 7': 'bg-amber-100 text-amber-700',
  'Day 14': 'bg-orange-100 text-orange-700',
  'Day 21': 'bg-orange-100 text-orange-800',
  'Day 30': 'bg-red-100 text-red-700',
  'Day 45': 'bg-red-100 text-red-800',
  'Day 60': 'bg-red-200 text-red-900',
}

function formatCurrency(amount: string | number | null, currency?: string | null): string {
  if (amount == null) return '—'
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) return '—'
  const c = currency === 'EUR' ? '€' : '$'
  return `${c}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  try {
    return format(parseISO(d), 'dd/MM/yyyy')
  } catch {
    return d
  }
}

function getOverdueBucket(dueDate: string | null, today: string): { label: string; color: string } {
  if (!dueDate) return { label: 'N/D', color: 'bg-zinc-100 text-zinc-600' }
  const days = differenceInDays(parseISO(today), parseISO(dueDate))
  if (days <= 0) return { label: 'Non scaduto', color: 'bg-zinc-100 text-zinc-600' }
  if (days <= 7) return { label: `${days}g`, color: 'bg-amber-100 text-amber-700' }
  if (days <= 14) return { label: `${days}g`, color: 'bg-amber-200 text-amber-800' }
  if (days <= 30) return { label: `${days}g`, color: 'bg-orange-100 text-orange-700' }
  if (days <= 45) return { label: `${days}g`, color: 'bg-red-100 text-red-700' }
  return { label: `${days}g`, color: 'bg-red-200 text-red-900' }
}

export function PaymentBoard({ overdue, upcoming, paid, stats, activeTab, today }: PaymentBoardProps) {
  const router = useRouter()

  const tabs = [
    { key: 'scaduti', label: 'Scaduti', count: stats.overdueCount, icon: AlertCircle, color: 'text-red-600' },
    { key: 'arrivo', label: 'In Arrivo', count: stats.upcomingCount, icon: Clock, color: 'text-amber-600' },
    { key: 'pagati', label: 'Pagati', count: stats.paidCount, icon: CheckCircle2, color: 'text-emerald-600' },
  ]

  const currentPayments = activeTab === 'scaduti' ? overdue :
                          activeTab === 'arrivo' ? upcoming : paid

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="flex gap-3 flex-wrap">
        <div className="bg-white rounded-lg border p-4 flex-1 min-w-[140px]">
          <p className="text-2xl font-semibold text-red-600">{formatCurrency(stats.overdueTotal)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.overdueCount} pagamenti scaduti</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1 min-w-[140px]">
          <p className="text-2xl font-semibold text-amber-600">{formatCurrency(stats.upcomingTotal)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.upcomingCount} in arrivo</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1 min-w-[140px]">
          <p className="text-2xl font-semibold text-emerald-600">{formatCurrency(stats.paidTotal)}</p>
          <p className="text-xs text-muted-foreground mt-1">{stats.paidCount} pagati</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1 -mb-px">
          {tabs.map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                onClick={() => router.push(`/payments?tab=${tab.key}`)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                  activeTab === tab.key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-zinc-300'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 ml-1">
                  {tab.count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Payment list */}
      <div className="bg-white rounded-lg border overflow-hidden">
        {/* Header */}
        <div className="hidden md:grid md:grid-cols-[1fr,120px,100px,100px,90px,90px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <span>Descrizione</span>
          <span>Azienda</span>
          <span className="text-right">Importo</span>
          <span>Scadenza</span>
          <span>Stato</span>
          <span>Follow-up</span>
        </div>

        {currentPayments.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Nessun pagamento
          </div>
        ) : (
          currentPayments.map(p => {
            const bucket = activeTab === 'scaduti' ? getOverdueBucket(p.due_date, today) : null
            return (
              <div key={p.id} className={cn(
                'grid grid-cols-1 md:grid-cols-[1fr,120px,100px,100px,90px,90px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 items-center text-sm',
                activeTab === 'scaduti' && bucket && 'hover:bg-red-50/30'
              )}>
                {/* Description */}
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {p.description ?? (`${p.period ?? ''} ${p.year ?? ''}`.trim() || p.installment || '—')}
                  </p>
                  {p.installment && p.description && (
                    <p className="text-xs text-muted-foreground">{p.installment}</p>
                  )}
                </div>

                {/* Company */}
                <div className="hidden md:block">
                  {p.company_name ? (
                    <Link
                      href={`/accounts/${p.account_id}`}
                      className="text-xs text-muted-foreground hover:text-blue-600 truncate block"
                    >
                      {p.company_name}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>

                {/* Amount */}
                <p className="text-right font-medium hidden md:block">
                  {formatCurrency(p.amount_due ?? p.amount, p.amount_currency)}
                </p>

                {/* Due date */}
                <div className="hidden md:flex items-center gap-1">
                  {p.due_date ? (
                    <>
                      <Calendar className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs">{formatDate(p.due_date)}</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">N/D</span>
                  )}
                </div>

                {/* Overdue bucket / status */}
                <div className="hidden md:block">
                  {activeTab === 'scaduti' && bucket ? (
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', bucket.color)}>
                      {bucket.label}
                    </span>
                  ) : (
                    <span className={cn(
                      'text-xs px-1.5 py-0.5 rounded',
                      p.status === 'Paid' ? 'bg-emerald-100 text-emerald-700' :
                      p.status === 'Overdue' ? 'bg-red-100 text-red-700' :
                      'bg-amber-100 text-amber-700'
                    )}>
                      {p.status}
                    </span>
                  )}
                </div>

                {/* Follow-up stage */}
                <div className="hidden md:block">
                  {p.followup_stage ? (
                    <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', FOLLOWUP_COLORS[p.followup_stage] ?? 'bg-zinc-100')}>
                      {p.followup_stage}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
