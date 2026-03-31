'use client'

import { useState, useTransition } from 'react'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import {
  CheckCircle2,
  AlertCircle,
  Link2,
  X,
  Loader2,
  ArrowRight,
  Ban,
} from 'lucide-react'
import { matchFeedToInvoice, ignoreFeed } from '@/app/(dashboard)/reconciliation/actions'

interface BankFeed {
  id: string
  source: string
  external_id: string | null
  transaction_date: string
  amount: number | string
  currency: string
  sender_name: string | null
  sender_reference: string | null
  memo: string | null
  matched_payment_id: string | null
  match_confidence: string | null
  status: string
  created_at: string
  // Joined payment data (for matched)
  payments?: {
    invoice_number: string | null
    description: string | null
    account_id: string
    accounts: { company_name: string } | null
  } | null
}

interface OpenInvoice {
  id: string
  invoice_number: string | null
  description: string | null
  total: number | string | null
  amount: number | string | null
  amount_currency: string | null
  invoice_status: string | null
  account_id: string
  accounts: { company_name: string } | { company_name: string }[] | null
}

interface Props {
  unmatched: BankFeed[]
  matched: BankFeed[]
  openInvoices: OpenInvoice[]
}

const SOURCE_LABELS: Record<string, string> = {
  relay: 'Relay',
  banking_circle: 'Banking Circle',
  qb_deposit: 'QB Deposit',
  airwallex_email: 'Airwallex',
  manual: 'Manual',
}

const SOURCE_COLORS: Record<string, string> = {
  relay: 'bg-blue-100 text-blue-700',
  banking_circle: 'bg-purple-100 text-purple-700',
  qb_deposit: 'bg-emerald-100 text-emerald-700',
  airwallex_email: 'bg-orange-100 text-orange-700',
  manual: 'bg-zinc-100 text-zinc-700',
}

function formatCurrency(amount: number | string | null, currency?: string | null): string {
  if (amount == null) return '—'
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) return '—'
  const c = currency === 'EUR' ? '€' : '$'
  return `${c}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCompanyName(accounts: any): string {
  if (!accounts) return '—'
  if (Array.isArray(accounts)) return accounts[0]?.company_name ?? '—'
  return accounts.company_name ?? '—'
}

export function ReconciliationBoard({ unmatched, matched, openInvoices }: Props) {
  const [tab, setTab] = useState<'unmatched' | 'matched'>('unmatched')
  const [matchingFeed, setMatchingFeed] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="flex gap-3">
        <div className="bg-white rounded-lg border p-4 flex-1">
          <p className="text-2xl font-semibold text-amber-600">{unmatched.length}</p>
          <p className="text-xs text-muted-foreground mt-1">Unmatched transactions</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1">
          <p className="text-2xl font-semibold text-emerald-600">{matched.length}</p>
          <p className="text-xs text-muted-foreground mt-1">Recently matched</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1">
          <p className="text-2xl font-semibold text-blue-600">{openInvoices.length}</p>
          <p className="text-xs text-muted-foreground mt-1">Open invoices</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b flex gap-1 -mb-px">
        <button
          onClick={() => setTab('unmatched')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
            tab === 'unmatched' ? 'border-amber-500 text-amber-600' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <AlertCircle className="h-4 w-4" /> Unmatched ({unmatched.length})
        </button>
        <button
          onClick={() => setTab('matched')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
            tab === 'matched' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <CheckCircle2 className="h-4 w-4" /> Matched ({matched.length})
        </button>
      </div>

      {/* Feed list */}
      <div className="bg-white rounded-lg border overflow-hidden">
        {tab === 'unmatched' ? (
          unmatched.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No unmatched transactions
            </div>
          ) : (
            unmatched.map(feed => (
              <UnmatchedRow
                key={feed.id}
                feed={feed}
                openInvoices={openInvoices}
                isMatching={matchingFeed === feed.id}
                onStartMatch={() => setMatchingFeed(feed.id)}
                onCancelMatch={() => setMatchingFeed(null)}
              />
            ))
          )
        ) : (
          matched.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No recent matches
            </div>
          ) : (
            matched.map(feed => (
              <MatchedRow key={feed.id} feed={feed} />
            ))
          )
        )}
      </div>
    </div>
  )
}

function UnmatchedRow({
  feed,
  openInvoices,
  isMatching,
  onStartMatch,
  onCancelMatch,
}: {
  feed: BankFeed
  openInvoices: OpenInvoice[]
  isMatching: boolean
  onStartMatch: () => void
  onCancelMatch: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const amount = Number(feed.amount)

  const handleMatch = (paymentId: string) => {
    startTransition(async () => {
      try {
        const result = await matchFeedToInvoice(feed.id, paymentId)
        if (!result.success) throw new Error(result.error)
        toast.success('Transaction matched to invoice')
        onCancelMatch()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Match failed')
      }
    })
  }

  const handleIgnore = () => {
    startTransition(async () => {
      try {
        await ignoreFeed(feed.id)
        toast.success('Transaction ignored')
      } catch {
        toast.error('Failed to ignore')
      }
    })
  }

  // Suggest matching invoices (same currency, similar amount)
  const suggestions = openInvoices
    .filter(inv => {
      const invCurrency = inv.amount_currency || 'USD'
      if (invCurrency !== feed.currency) return false
      const invAmount = Number(inv.total ?? inv.amount ?? 0)
      const diff = Math.abs(invAmount - amount)
      return diff <= invAmount * 0.1 // 10% tolerance for suggestions
    })
    .sort((a, b) => {
      const diffA = Math.abs(Number(a.total ?? a.amount ?? 0) - amount)
      const diffB = Math.abs(Number(b.total ?? b.amount ?? 0) - amount)
      return diffA - diffB
    })
    .slice(0, 5)

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        {/* Source badge */}
        <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
          {SOURCE_LABELS[feed.source] ?? feed.source}
        </span>
        {/* Date */}
        <span className="text-xs text-muted-foreground w-20 shrink-0">{formatDate(feed.transaction_date)}</span>
        {/* Amount */}
        <span className="font-semibold w-24 shrink-0">{formatCurrency(amount, feed.currency)}</span>
        {/* Sender */}
        <span className="text-xs text-muted-foreground truncate flex-1">{feed.sender_name || feed.memo || '—'}</span>
        {/* Suggested match */}
        {feed.matched_payment_id && feed.match_confidence === 'medium' && (
          <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">Possible match</span>
        )}
        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {!isMatching ? (
            <>
              <button onClick={onStartMatch} className="p-1 rounded hover:bg-blue-50 text-blue-500" title="Match to invoice" disabled={isPending}>
                <Link2 className="h-4 w-4" />
              </button>
              <button onClick={handleIgnore} className="p-1 rounded hover:bg-zinc-100 text-zinc-400" title="Ignore" disabled={isPending}>
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              </button>
            </>
          ) : (
            <button onClick={onCancelMatch} className="p-1 rounded hover:bg-zinc-100 text-zinc-500" title="Cancel">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Invoice picker (when matching) */}
      {isMatching && (
        <div className="px-4 pb-3 pt-1">
          <p className="text-xs text-muted-foreground mb-2">Select an invoice to match:</p>
          {suggestions.length === 0 ? (
            <p className="text-xs text-amber-600">No invoices with similar amount in {feed.currency}</p>
          ) : (
            <div className="space-y-1">
              {suggestions.map(inv => {
                const invAmount = Number(inv.total ?? inv.amount ?? 0)
                const diff = Math.abs(invAmount - amount)
                return (
                  <button
                    key={inv.id}
                    onClick={() => handleMatch(inv.id)}
                    disabled={isPending}
                    className="w-full flex items-center gap-3 px-3 py-2 text-xs rounded-lg border hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-50"
                  >
                    <span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span>
                    <span className="truncate flex-1">{getCompanyName(inv.accounts) ?? '—'}</span>
                    <span className="font-medium">{formatCurrency(invAmount, inv.amount_currency)}</span>
                    {diff < 1 ? (
                      <span className="text-emerald-600">exact</span>
                    ) : (
                      <span className="text-amber-600">±{formatCurrency(diff, inv.amount_currency)}</span>
                    )}
                    {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                  </button>
                )
              })}
            </div>
          )}
          {/* Show all open invoices button */}
          {openInvoices.length > suggestions.length && (
            <details className="mt-2">
              <summary className="text-xs text-blue-600 cursor-pointer hover:underline">
                Show all {openInvoices.length} open invoices
              </summary>
              <div className="mt-1 space-y-1">
                {openInvoices
                  .filter(inv => !suggestions.some(s => s.id === inv.id))
                  .map(inv => (
                    <button
                      key={inv.id}
                      onClick={() => handleMatch(inv.id)}
                      disabled={isPending}
                      className="w-full flex items-center gap-3 px-3 py-2 text-xs rounded-lg border hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-50"
                    >
                      <span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span>
                      <span className="truncate flex-1">{getCompanyName(inv.accounts) ?? '—'}</span>
                      <span className="font-medium">{formatCurrency(Number(inv.total ?? inv.amount), inv.amount_currency)}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    </button>
                  ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function MatchedRow({ feed }: { feed: BankFeed }) {
  const payment = feed.payments
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b last:border-b-0">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
        {SOURCE_LABELS[feed.source] ?? feed.source}
      </span>
      <span className="text-xs text-muted-foreground w-20 shrink-0">{formatDate(feed.transaction_date)}</span>
      <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
      <span className="text-xs text-muted-foreground truncate">{feed.sender_name || '—'}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
      <span className="font-mono text-xs text-blue-600 shrink-0">{payment?.invoice_number ?? '—'}</span>
      <span className="text-xs truncate">{getCompanyName(payment?.accounts)}</span>
      <span className={cn(
        'text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0',
        feed.match_confidence === 'exact' ? 'bg-emerald-100 text-emerald-700' :
        feed.match_confidence === 'high' ? 'bg-blue-100 text-blue-700' :
        feed.match_confidence === 'manual' ? 'bg-zinc-100 text-zinc-700' :
        'bg-amber-100 text-amber-700'
      )}>
        {feed.match_confidence}
      </span>
    </div>
  )
}
