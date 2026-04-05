'use client'

import { useState, useCallback, useEffect, useTransition, useMemo } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import {
  Landmark, RefreshCw, Plus, Link2, Ban, X,
  Loader2, ArrowRight, CheckCircle2, AlertCircle,
  Search,
} from 'lucide-react'
import { matchBankFeedToInvoice, ignoreBankFeed } from './actions'

// ── Types ──

interface PlaidAccount {
  account_id: string
  name: string
  mask: string | null
  type: string
  subtype: string | null
  balances: { current: number | null; available: number | null; iso_currency_code: string | null }
}

interface PlaidConnection {
  id: string
  bank_name: string
  institution_name: string
  accounts: PlaidAccount[]
  status: string
  last_synced_at: string | null
  created_at: string
}

export interface BankFeedRecord {
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
  matched_at: string | null
  payments?: {
    invoice_number: string | null
    description: string | null
    account_id: string
    accounts: { company_name: string } | null
  } | null
}

export interface OpenInvoice {
  id: string
  invoice_number: string | null
  description: string | null
  total: number | string | null
  amount: number | string | null
  amount_due: number | string | null
  amount_currency: string | null
  invoice_status: string | null
  account_id: string
  accounts: { company_name: string } | { company_name: string }[] | null
}

interface Props {
  bankFeeds: BankFeedRecord[]
  openInvoices: OpenInvoice[]
  totalCount: number
}

// ── Constants ──

const SOURCE_LABELS: Record<string, string> = {
  relay: 'Relay',
  mercury: 'Mercury',
  banking_circle: 'Banking Circle',
  qb_deposit: 'QB Deposit',
  airwallex_email: 'Airwallex',
  airwallex_api: 'Airwallex',
  manual: 'Manual',
}

const SOURCE_COLORS: Record<string, string> = {
  relay: 'bg-blue-100 text-blue-700',
  mercury: 'bg-indigo-100 text-indigo-700',
  banking_circle: 'bg-purple-100 text-purple-700',
  qb_deposit: 'bg-emerald-100 text-emerald-700',
  airwallex_email: 'bg-orange-100 text-orange-700',
  airwallex_api: 'bg-orange-100 text-orange-700',
  manual: 'bg-zinc-100 text-zinc-700',
}

// Map bank institution names to source filter values
const BANK_SOURCE_MAP: Record<string, string[]> = {
  relay: ['relay'],
  mercury: ['mercury'],
  airwallex: ['airwallex_email', 'airwallex_api'],
}

const STATUS_COLORS: Record<string, string> = {
  unmatched: 'bg-amber-100 text-amber-700',
  matched: 'bg-emerald-100 text-emerald-700',
  ignored: 'bg-zinc-100 text-zinc-500',
  partial: 'bg-orange-100 text-orange-700',
}

type FilterTab = 'all' | 'unmatched' | 'matched' | 'ignored'

// ── Helpers ──

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

// ── Connected Banks Summary ──

function ConnectBankButton({ onSuccess }: { onSuccess: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [bankName, setBankName] = useState('')
  const [loading, setLoading] = useState(false)

  const fetchLinkToken = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/plaid/create-link-token', { method: 'POST' })
    const data = await res.json()
    setLinkToken(data.link_token)
    setLoading(false)
  }, [])

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    onSuccess: async (publicToken) => {
      if (!bankName.trim()) {
        toast.error('Enter a bank name before connecting')
        return
      }
      const res = await fetch('/api/plaid/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token: publicToken, bank_name: bankName }),
      })
      if (res.ok) {
        toast.success('Bank connected successfully')
        setBankName('')
        setLinkToken(null)
        onSuccess()
      } else {
        toast.error('Failed to connect bank')
      }
    },
  })

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        placeholder="Bank name (e.g. Chase)"
        value={bankName}
        onChange={e => setBankName(e.target.value)}
        className="border rounded px-3 py-2 text-sm w-48"
      />
      {!linkToken ? (
        <button
          onClick={fetchLinkToken}
          disabled={loading || !bankName.trim()}
          className="flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {loading ? 'Loading...' : 'Connect Bank'}
        </button>
      ) : (
        <button
          onClick={() => open()}
          disabled={!ready}
          className="bg-green-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50"
        >
          Open Plaid
        </button>
      )}
    </div>
  )
}

function BanksSummary({ activeSource, onSourceFilter }: { activeSource: string[] | null; onSourceFilter: (sources: string[] | null) => void }) {
  const [connections, setConnections] = useState<PlaidConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const fetchConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/plaid/accounts')
      const data = await res.json()
      setConnections(data.connections ?? [])
    } catch {
      // Plaid may not be configured yet
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchConnections()
  }, [fetchConnections])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await fetchConnections()
      toast.success('Bank data refreshed')
    } catch {
      toast.error('Sync failed')
    }
    setSyncing(false)
  }

  const totalBalance = connections.reduce((sum, conn) =>
    sum + (conn.accounts ?? []).reduce((s, a) => s + (a.balances.current ?? 0), 0), 0
  )
  const totalAccounts = connections.reduce((sum, conn) => sum + (conn.accounts ?? []).length, 0)

  return (
    <div className="border-b pb-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Landmark className="h-5 w-5 text-blue-600" />
          <div>
            <h3 className="text-sm font-semibold">Connected Banks</h3>
            {!loading && connections.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {connections.length} bank{connections.length !== 1 ? 's' : ''} &middot; {totalAccounts} account{totalAccounts !== 1 ? 's' : ''} &middot; {formatCurrency(totalBalance)}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSync}
            disabled={syncing || loading}
            className="flex items-center gap-1.5 border rounded px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
            Sync Now
          </button>
          <ConnectBankButton onSuccess={fetchConnections} />
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading bank connections...</p>
      ) : connections.length === 0 ? (
        <div className="border-2 border-dashed rounded-lg p-6 text-center">
          <p className="text-sm text-muted-foreground font-medium">No bank accounts connected</p>
          <p className="text-xs text-muted-foreground mt-1">Connect Chase, Relay, Mercury, or First Citizens above</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {connections.map(conn => {
            const bankKey = (conn.institution_name ?? conn.bank_name ?? '').toLowerCase()
            const matchedSources = Object.entries(BANK_SOURCE_MAP).find(([key]) => bankKey.includes(key))?.[1] ?? null
            const isActive = activeSource && matchedSources && activeSource.join() === matchedSources.join()

            return (
            <div
              key={conn.id}
              onClick={() => {
                if (isActive) {
                  onSourceFilter(null)
                } else if (matchedSources) {
                  onSourceFilter(matchedSources)
                }
              }}
              className={cn(
                'border rounded-lg p-3 transition-colors',
                matchedSources ? 'cursor-pointer hover:border-blue-400' : '',
                isActive ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200' : ''
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{conn.institution_name ?? conn.bank_name}</span>
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Active</span>
              </div>
              <div className="space-y-1">
                {(conn.accounts ?? []).map(acc => (
                  <div key={acc.account_id} className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">{acc.name} •••• {acc.mask}</span>
                    <span className="font-medium">
                      {acc.balances.current != null
                        ? formatCurrency(acc.balances.current, acc.balances.iso_currency_code)
                        : '—'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Last synced: {conn.last_synced_at ? format(parseISO(conn.last_synced_at), 'MMM d, h:mm a') : 'Never'}
              </p>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Transaction Rows ──

function UnmatchedRow({
  feed, openInvoices, isMatching, onStartMatch, onCancelMatch,
}: {
  feed: BankFeedRecord
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
        const result = await matchBankFeedToInvoice(feed.id, paymentId)
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
        const result = await ignoreBankFeed(feed.id)
        if (!result.success) throw new Error(result.error)
        toast.success('Transaction ignored')
      } catch {
        toast.error('Failed to ignore')
      }
    })
  }

  // Suggest matching invoices (same currency, similar amount — 10% tolerance)
  const suggestions = openInvoices
    .filter(inv => {
      const invCurrency = inv.amount_currency || 'USD'
      if (invCurrency !== feed.currency) return false
      const invAmount = inv.invoice_status === 'Partial'
        ? Number(inv.amount_due ?? inv.total ?? 0)
        : Number(inv.total ?? inv.amount ?? 0)
      const diff = Math.abs(invAmount - amount)
      return diff <= invAmount * 0.1
    })
    .sort((a, b) => {
      const aAmt = a.invoice_status === 'Partial' ? Number(a.amount_due ?? a.total ?? 0) : Number(a.total ?? a.amount ?? 0)
      const bAmt = b.invoice_status === 'Partial' ? Number(b.amount_due ?? b.total ?? 0) : Number(b.total ?? b.amount ?? 0)
      return Math.abs(aAmt - amount) - Math.abs(bAmt - amount)
    })
    .slice(0, 5)

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
          {SOURCE_LABELS[feed.source] ?? feed.source}
        </span>
        <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
        <span className="font-semibold w-24 shrink-0">{formatCurrency(amount, feed.currency)}</span>
        <span className="text-xs truncate flex-1">{feed.sender_name || '—'}</span>
        <span className="text-xs text-muted-foreground truncate max-w-[200px]">{feed.memo || ''}</span>
        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', STATUS_COLORS.unmatched)}>
          unmatched
        </span>
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

      {isMatching && (
        <div className="px-4 pb-3 pt-1">
          <p className="text-xs text-muted-foreground mb-2">Select an invoice to match:</p>
          {suggestions.length === 0 ? (
            <p className="text-xs text-amber-600">No invoices with similar amount in {feed.currency}</p>
          ) : (
            <div className="space-y-1">
              {suggestions.map(inv => {
                const invAmount = inv.invoice_status === 'Partial'
                  ? Number(inv.amount_due ?? inv.total ?? 0)
                  : Number(inv.total ?? inv.amount ?? 0)
                const diff = Math.abs(invAmount - amount)
                return (
                  <button
                    key={inv.id}
                    onClick={() => handleMatch(inv.id)}
                    disabled={isPending}
                    className="w-full flex items-center gap-3 px-3 py-2 text-xs rounded-lg border hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-50"
                  >
                    <span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span>
                    <span className="truncate flex-1">{getCompanyName(inv.accounts)}</span>
                    {inv.invoice_status === 'Partial' && (
                      <span className="text-[10px] bg-orange-100 text-orange-700 px-1 py-0.5 rounded">Partial</span>
                    )}
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
          {openInvoices.length > suggestions.length && (
            <details className="mt-2">
              <summary className="text-xs text-blue-600 cursor-pointer hover:underline">
                Show all {openInvoices.length} open invoices
              </summary>
              <div className="mt-1 space-y-1 max-h-48 overflow-y-auto">
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
                      <span className="truncate flex-1">{getCompanyName(inv.accounts)}</span>
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

function MatchedRow({ feed }: { feed: BankFeedRecord }) {
  const payment = feed.payments
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b last:border-b-0">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
        {SOURCE_LABELS[feed.source] ?? feed.source}
      </span>
      <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
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
        feed.match_confidence === 'partial' ? 'bg-orange-100 text-orange-700' :
        feed.match_confidence === 'retroactive' ? 'bg-violet-100 text-violet-700' :
        'bg-amber-100 text-amber-700'
      )}>
        {feed.match_confidence ?? 'matched'}
      </span>
    </div>
  )
}

function IgnoredRow({ feed }: { feed: BankFeedRecord }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b last:border-b-0 opacity-60">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
        {SOURCE_LABELS[feed.source] ?? feed.source}
      </span>
      <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
      <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
      <span className="text-xs truncate flex-1">{feed.sender_name || '—'}</span>
      <span className="text-xs text-muted-foreground truncate max-w-[200px]">{feed.memo || ''}</span>
      <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', STATUS_COLORS.ignored)}>
        ignored
      </span>
    </div>
  )
}

// ── Main Component ──

export function BankFeedTab({ bankFeeds, openInvoices, totalCount }: Props) {
  const [filter, setFilter] = useState<FilterTab>('all')
  const [sourceFilter, setSourceFilter] = useState<string[] | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchingFeed, setMatchingFeed] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const pageSize = 50

  // Filter and search
  const filtered = useMemo(() => {
    let items = bankFeeds

    // Filter by bank source
    if (sourceFilter) {
      items = items.filter(f => sourceFilter.includes(f.source))
    }

    // Filter by status
    if (filter !== 'all') {
      items = items.filter(f => f.status === filter)
    }

    // Search by sender/memo/amount
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      items = items.filter(f =>
        (f.sender_name ?? '').toLowerCase().includes(q) ||
        (f.memo ?? '').toLowerCase().includes(q) ||
        (f.sender_reference ?? '').toLowerCase().includes(q) ||
        String(f.amount).includes(q)
      )
    }

    return items
  }, [bankFeeds, filter, sourceFilter, searchQuery])

  // Paginate
  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const totalPages = Math.ceil(filtered.length / pageSize)

  // Counts by status
  const counts = useMemo(() => ({
    all: bankFeeds.length,
    unmatched: bankFeeds.filter(f => f.status === 'unmatched').length,
    matched: bankFeeds.filter(f => f.status === 'matched').length,
    ignored: bankFeeds.filter(f => f.status === 'ignored').length,
  }), [bankFeeds])

  return (
    <div className="p-6 space-y-4 overflow-y-auto h-full">
      {/* Connected banks summary */}
      <BanksSummary activeSource={sourceFilter} onSourceFilter={(s) => { setSourceFilter(s); setPage(0) }} />

      {/* Stats cards */}
      <div className="flex gap-3">
        <div className="bg-white rounded-lg border p-4 flex-1">
          <p className="text-2xl font-semibold text-amber-600">{counts.unmatched}</p>
          <p className="text-xs text-muted-foreground mt-1">Unmatched</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1">
          <p className="text-2xl font-semibold text-emerald-600">{counts.matched}</p>
          <p className="text-xs text-muted-foreground mt-1">Matched</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1">
          <p className="text-2xl font-semibold text-zinc-500">{counts.ignored}</p>
          <p className="text-xs text-muted-foreground mt-1">Ignored</p>
        </div>
        <div className="bg-white rounded-lg border p-4 flex-1">
          <p className="text-2xl font-semibold text-blue-600">{totalCount}</p>
          <p className="text-xs text-muted-foreground mt-1">Total transactions</p>
        </div>
      </div>

      {/* Active source filter badge */}
      {sourceFilter && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Showing:</span>
          <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
            {sourceFilter.map(s => SOURCE_LABELS[s] ?? s).join(', ')}
          </span>
          <button onClick={() => setSourceFilter(null)} className="text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Filter bar + search */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1">
          {(['all', 'unmatched', 'matched', 'ignored'] as FilterTab[]).map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(0) }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors',
                filter === f
                  ? f === 'unmatched' ? 'bg-amber-100 text-amber-700'
                    : f === 'matched' ? 'bg-emerald-100 text-emerald-700'
                    : f === 'ignored' ? 'bg-zinc-200 text-zinc-700'
                    : 'bg-blue-100 text-blue-700'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {f === 'unmatched' && <AlertCircle className="h-3 w-3" />}
              {f === 'matched' && <CheckCircle2 className="h-3 w-3" />}
              {f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search sender, memo, amount..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setPage(0) }}
            className="border rounded pl-8 pr-3 py-1.5 text-xs w-64"
          />
        </div>
      </div>

      {/* Transaction list */}
      <div className="bg-white rounded-lg border overflow-hidden">
        {/* Header row */}
        <div className="flex items-center gap-3 px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase border-b bg-muted/30">
          <span className="w-16 shrink-0">Source</span>
          <span className="w-24 shrink-0">Date</span>
          <span className="w-24 shrink-0">Amount</span>
          <span className="flex-1">Sender</span>
          <span className="max-w-[200px]">Memo</span>
          <span className="w-16 shrink-0">Status</span>
          <span className="w-16 shrink-0">Actions</span>
        </div>

        {paginated.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {searchQuery ? 'No transactions match your search' : 'No transactions found'}
          </div>
        ) : (
          paginated.map(feed => {
            if (feed.status === 'unmatched') {
              return (
                <UnmatchedRow
                  key={feed.id}
                  feed={feed}
                  openInvoices={openInvoices}
                  isMatching={matchingFeed === feed.id}
                  onStartMatch={() => setMatchingFeed(feed.id)}
                  onCancelMatch={() => setMatchingFeed(null)}
                />
              )
            }
            if (feed.status === 'matched') {
              return <MatchedRow key={feed.id} feed={feed} />
            }
            return <IgnoredRow key={feed.id} feed={feed} />
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 border rounded hover:bg-muted disabled:opacity-50"
            >
              Prev
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 border rounded hover:bg-muted disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
