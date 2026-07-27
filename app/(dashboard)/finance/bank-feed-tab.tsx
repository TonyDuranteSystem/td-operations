'use client'

import { useState, useCallback, useEffect, useTransition, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import {
  Landmark, RefreshCw, Plus, Link2, Ban, X,
  Loader2, ArrowRight, CheckCircle2, AlertCircle, AlertTriangle,
  Search, Building2, User, Trash2, Check, RotateCw, Copy, Undo2,
} from 'lucide-react'
import { matchBankFeedToInvoices, ignoreBankFeed, deleteDuplicateBankFeed, restoreBankFeed } from './actions'
import { invoicePartyName } from '@/lib/finance/invoice-party'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { VALID_SERVICE_TYPES } from '@/lib/operations/service-types'

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
  review_metadata?: unknown
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
  account_id: string | null
  accounts: { company_name: string } | { company_name: string }[] | null
  contact_id?: string | null
  contacts?: { full_name: string | null } | { full_name: string | null }[] | null
}

interface Props {
  bankFeeds: BankFeedRecord[]
  openInvoices: OpenInvoice[]
  totalCount: number
  isAdmin?: boolean
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
  stripe: 'Stripe',
}

const SOURCE_COLORS: Record<string, string> = {
  relay: 'bg-blue-100 text-blue-700',
  mercury: 'bg-indigo-100 text-indigo-700',
  banking_circle: 'bg-purple-100 text-purple-700',
  qb_deposit: 'bg-emerald-100 text-emerald-700',
  airwallex_email: 'bg-orange-100 text-orange-700',
  airwallex_api: 'bg-orange-100 text-orange-700',
  manual: 'bg-zinc-100 text-zinc-700',
  stripe: 'bg-violet-100 text-violet-700',
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
  needs_review: 'bg-amber-100 text-amber-800',
  activation_crashed: 'bg-red-100 text-red-700',
  // 'duplicate' had NO colour and NO tab — so a row flagged duplicate fell through to
  // the "ignored" renderer and became invisible. That is how a genuine $50 client
  // payment disappeared for days. It is now purple, filterable, and restorable.
  duplicate: 'bg-purple-100 text-purple-700',
}

type FilterTab = 'all' | 'unmatched' | 'needs_review' | 'activation_crashed' | 'matched' | 'ignored' | 'duplicate'

// ── Helpers ──

/**
 * Did Stripe tell us this money went back to the client?
 *
 * The matcher records this on the feed when it re-checks a charge before settling. It
 * must be surfaced, not buried: a refunded charge otherwise sits in the review queue
 * looking exactly like a payment waiting to be confirmed.
 */
function isRefundedOrDisputed(feed: BankFeedRecord): boolean {
  const meta = feed.review_metadata
  if (!meta || typeof meta !== 'object') return false
  return (meta as { refunded_or_disputed?: unknown }).refunded_or_disputed === true
}

/**
 * Was this transaction linked to an invoice WITHOUT any money being applied?
 *
 * The invoice was already settled through another channel, so the link exists purely for
 * the audit trail. The confidence badge alone cannot tell you this — a `retroactive` or
 * `manual` link looks the same whether money moved or not — so the fact is recorded in
 * review_metadata and shown explicitly.
 */
function isAuditLink(feed: BankFeedRecord): boolean {
  const meta = feed.review_metadata
  if (!meta || typeof meta !== 'object') return false
  return (meta as { audit_link?: unknown }).audit_link === true
}

function auditLinkNote(feed: BankFeedRecord): string | null {
  const meta = feed.review_metadata
  if (!meta || typeof meta !== 'object') return null
  const note = (meta as { note?: unknown }).note
  return typeof note === 'string' ? note : null
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

function BanksSummary({ activeSource, onSourceFilter, isAdmin = false }: { activeSource: string[] | null; onSourceFilter: (sources: string[] | null) => void; isAdmin?: boolean }) {
  const router = useRouter()
  const [connections, setConnections] = useState<PlaidConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncingAllBanks, setSyncingAllBanks] = useState(false)

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

  // PR C: triggers the same sync + match + activate chain that runs every
  // 15 min via cron. Used when staff don't want to wait for the next tick.
  const handleSyncAllBanks = async () => {
    setSyncingAllBanks(true)
    try {
      const res = await fetch('/api/crm/admin-actions/sync-bank-feeds-now', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        toast.error(data.error || `Sync failed (${res.status})`)
        return
      }
      const mercuryAdded = typeof data?.mercury?.added === 'number' ? data.mercury.added : 0
      const airwallexAdded = typeof data?.airwallex?.added === 'number' ? data.airwallex.added : 0
      const matched = typeof data?.match?.auto_activated === 'number' ? data.match.auto_activated : 0
      const needsReview = typeof data?.match?.needs_review === 'number' ? data.match.needs_review : 0
      const crashed = typeof data?.match?.activation_crashed === 'number' ? data.match.activation_crashed : 0
      toast.success(
        `Synced. Mercury +${mercuryAdded}, Airwallex +${airwallexAdded}, matched ${matched}, ${needsReview} need review, ${crashed} crashed.`,
      )
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Sync failed — please try again.')
    } finally {
      setSyncingAllBanks(false)
    }
  }

  // Relay is hidden from the Connected Banks UI per request — it still syncs
  // transactions in the background; we just don't surface its card or balance.
  const visibleConnections = connections.filter(
    conn => !((conn.institution_name ?? conn.bank_name ?? '').toLowerCase().includes('relay'))
  )
  const totalBalance = visibleConnections.reduce((sum, conn) =>
    sum + (conn.accounts ?? []).reduce((s, a) => s + (a.balances.current ?? 0), 0), 0
  )
  const totalAccounts = visibleConnections.reduce((sum, conn) => sum + (conn.accounts ?? []).length, 0)

  return (
    <div className="border-b pb-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Landmark className="h-5 w-5 text-blue-600" />
          <div>
            <h3 className="text-sm font-semibold">Connected Banks</h3>
            {!loading && visibleConnections.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {visibleConnections.length} bank{visibleConnections.length !== 1 ? 's' : ''} &middot; {totalAccounts} account{totalAccounts !== 1 ? 's' : ''}{isAdmin ? ` \u00B7 ${formatCurrency(totalBalance)}` : ''}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSyncAllBanks}
            disabled={syncingAllBanks}
            title="Pulls latest transactions from Mercury + Airwallex and runs auto-match + auto-activate. Same chain that runs every 15 min."
            className="flex items-center gap-1.5 bg-blue-600 text-white rounded px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {syncingAllBanks ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync All Banks Now
          </button>
          <button
            onClick={handleSync}
            disabled={syncing || loading}
            className="flex items-center gap-1.5 border rounded px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
            Refresh
          </button>
          <ConnectBankButton onSuccess={fetchConnections} />
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading bank connections...</p>
      ) : visibleConnections.length === 0 ? (
        <div className="border-2 border-dashed rounded-lg p-6 text-center">
          <p className="text-sm text-muted-foreground font-medium">No bank accounts connected</p>
          <p className="text-xs text-muted-foreground mt-1">Connect Chase, Relay, Mercury, or First Citizens above</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {visibleConnections.map(conn => {
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
                      {isAdmin
                        ? (acc.balances.current != null ? formatCurrency(acc.balances.current, acc.balances.iso_currency_code) : '—')
                        : '••••'}
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

// Result shape from /api/accounts/search-for-feed-match
type FeedMatchResult =
  | { type: 'account'; id: string; name: string; status: string | null; contact_name?: string | null }
  | { type: 'contact'; id: string; name: string; email?: string | null }

// Existing-service shape returned from /api/feed/target-services
interface TargetServiceDelivery {
  id: string
  service_type: string
  service_name: string
  stage: string | null
  status: string
  start_date: string | null
}

interface CandidateInfo {
  invoice_number: string | null
  company_name: string
  amount: number
  amount_currency: string | null
  confidence: string | null
}

function UnmatchedRow({
  feed, openInvoices, isMatching, onStartMatch, onCancelMatch, candidateInfo,
}: {
  feed: BankFeedRecord
  openInvoices: OpenInvoice[]
  isMatching: boolean
  onStartMatch: () => void
  onCancelMatch: () => void
  candidateInfo?: CandidateInfo | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [candidateBusy, setCandidateBusy] = useState<null | 'confirm' | 'reject'>(null)
  const amount = Number(feed.amount)

  async function callAdminEndpoint(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        return { ok: false, error: data.error || `Request failed (${res.status})` }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
    }
  }

  const handleConfirmCandidate = async () => {
    if (!feed.matched_payment_id) {
      toast.error('No candidate payment to confirm')
      return
    }
    setCandidateBusy('confirm')
    const r = await callAdminEndpoint('/api/crm/admin-actions/bank-feed-confirm-match', {
      feed_id: feed.id,
      payment_id: feed.matched_payment_id,
    })
    setCandidateBusy(null)
    if (!r.ok) {
      toast.error(r.error ?? 'Confirm failed')
      return
    }
    toast.success('Match confirmed — invoice marked paid')
    router.refresh()
  }

  const handleRejectCandidate = async () => {
    setCandidateBusy('reject')
    const r = await callAdminEndpoint('/api/crm/admin-actions/bank-feed-reject-match', {
      feed_id: feed.id,
    })
    setCandidateBusy(null)
    if (!r.ok) {
      toast.error(r.error ?? 'Reject failed')
      return
    }
    toast.success('Candidate rejected — click the link icon to pick a different invoice or create one')
    router.refresh()
  }

  // Client/contact search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FeedMatchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)

  // Create-from-feed modal state (Bank-feed Tier B redesign 2026-05-05)
  // Two branches: attach payment to an existing active SD, or create a new
  // backfilled SD from a strict service_type picker.
  const [createForResult, setCreateForResult] = useState<FeedMatchResult | null>(null)
  const [createDescription, setCreateDescription] = useState('')
  const [createServiceType, setCreateServiceType] = useState('')
  const [createSelectedSdId, setCreateSelectedSdId] = useState<string | null>(null)
  const [targetServices, setTargetServices] = useState<TargetServiceDelivery[]>([])
  const [loadingTargetServices, setLoadingTargetServices] = useState(false)
  const [createSubmitting, setCreateSubmitting] = useState(false)

  // Debounced search — fires when user types 2+ chars
  useEffect(() => {
    if (!isMatching) return
    const q = searchQuery.trim()
    if (q.length < 2) { setSearchResults([]); return }
    const t = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const res = await fetch(`/api/accounts/search-for-feed-match?q=${encodeURIComponent(q)}`)
        const d = await res.json()
        if (res.ok) setSearchResults(d.results ?? [])
      } catch { /* ignore — empty list */ }
      setSearchLoading(false)
    }, 250)
    return () => clearTimeout(t)
  }, [searchQuery, isMatching])

  // ── Multi-invoice selection (one wire that pays several companies' invoices) ──
  // Clicking an invoice adds it to a selection tray that PERSISTS as you search
  // different clients, so you can pick e.g. Partner Alliance's invoice AND Morgan
  // & Taylor's. The tray shows a running total vs the feed amount; "Match" settles
  // each selected invoice for its own balance.
  const invoiceApplied = (inv: OpenInvoice) =>
    inv.invoice_status === 'Partial'
      ? Number(inv.amount_due ?? inv.total ?? 0)
      : Number(inv.total ?? inv.amount ?? 0)
  const [selected, setSelected] = useState<Map<string, { id: string; invoice_number: string | null; appliedAmount: number; currency: string | null; party: string }>>(new Map())
  const toggleSelect = (inv: OpenInvoice) => {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(inv.id)) next.delete(inv.id)
      else next.set(inv.id, { id: inv.id, invoice_number: inv.invoice_number, appliedAmount: invoiceApplied(inv), currency: inv.amount_currency, party: invoicePartyName(inv) })
      return next
    })
  }
  const removeSelect = (id: string) => setSelected(prev => { const next = new Map(prev); next.delete(id); return next })
  const selectedArr = Array.from(selected.values())
  const selectedTotal = selectedArr.reduce((sum, x) => sum + x.appliedAmount, 0)
  // Waterfall preview (matches the backend): the wire is applied in selection
  // order, each invoice gets min(remaining wire, its balance). Map preserves
  // insertion = selection order, so this mirrors what manualMatchMulti will do.
  const EPS = 0.005
  let _remaining = amount
  const selectedPreview = selectedArr.map(s => {
    const willApply = Math.max(Math.min(_remaining, s.appliedAmount), 0)
    _remaining -= willApply
    const willStatus: 'Paid' | 'Partial' | 'Unpaid' =
      willApply >= s.appliedAmount - EPS ? 'Paid' : willApply > EPS ? 'Partial' : 'Unpaid'
    return { ...s, willApply, willStatus }
  })
  const shortfall = Math.max(selectedTotal - amount, 0) // wire < owed → stays as debt
  const leftover = Math.max(amount - selectedTotal, 0) // wire > owed → unallocated surplus
  const handleMatchSelected = () => {
    const ids = selectedArr.map(s => s.id)
    if (ids.length === 0) return
    startTransition(async () => {
      try {
        const result = await matchBankFeedToInvoices(feed.id, ids)
        if (!result.success) throw new Error(result.error)
        toast.success(`Transaction matched to ${ids.length} invoice${ids.length > 1 ? 's' : ''}`)
        onCancelMatch()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Match failed')
      }
    })
  }

  const openCreateModal = async (r: FeedMatchResult) => {
    setCreateForResult(r)
    setCreateDescription('')
    setCreateServiceType('')
    setCreateSelectedSdId(null)
    setTargetServices([])
    // Fetch existing active SDs on this target so the user can attach the
    // payment to one of them instead of creating a duplicate "Delivered" SD.
    setLoadingTargetServices(true)
    try {
      const param = r.type === 'account' ? `account_id=${r.id}` : `contact_id=${r.id}`
      const res = await fetch(`/api/feed/target-services?${param}`)
      if (res.ok) {
        const d = await res.json()
        const services: TargetServiceDelivery[] = d.services ?? []
        setTargetServices(services)
        // If exactly one open SD exists, pre-select it for one-click confirm.
        if (services.length === 1) {
          setCreateSelectedSdId(services[0].id)
        }
      }
    } catch {
      // Lookup is best-effort; user can still use the create-new path
    }
    setLoadingTargetServices(false)
  }
  const closeCreateModal = () => {
    if (createSubmitting) return
    setCreateForResult(null)
    setCreateDescription('')
    setCreateServiceType('')
    setCreateSelectedSdId(null)
    setTargetServices([])
  }

  // Picking an existing SD switches to "attach" mode and clears the
  // create-new fields (mutually exclusive — submit decides which branch
  // to call based on which side is filled).
  const handleSelectExistingSd = (sdId: string) => {
    setCreateSelectedSdId(prev => (prev === sdId ? null : sdId))
    setCreateServiceType('')
  }
  // Typing in either create-new field clears any attach selection.
  const handleCreateServiceTypeChange = (value: string) => {
    setCreateServiceType(value)
    if (value) setCreateSelectedSdId(null)
  }
  const handleCreateDescriptionChange = (value: string) => {
    setCreateDescription(value)
    if (value && createSelectedSdId) setCreateSelectedSdId(null)
  }

  const submitCreate = async () => {
    if (!createForResult) return
    const isAttach = !!createSelectedSdId
    const description = createDescription.trim()
    const serviceType = createServiceType.trim()

    if (!isAttach) {
      if (!serviceType) {
        toast.error('Pick a service type, or attach to an existing service above')
        return
      }
      if (!VALID_SERVICE_TYPES.includes(serviceType as (typeof VALID_SERVICE_TYPES)[number])) {
        toast.error('Invalid service type — pick from the list')
        return
      }
    }

    setCreateSubmitting(true)
    try {
      const body: Record<string, string> = { feed_id: feed.id }
      if (createForResult.type === 'account') {
        body.account_id = createForResult.id
      } else {
        body.contact_id = createForResult.id
      }
      if (isAttach) {
        body.service_delivery_id = createSelectedSdId!
      } else {
        body.service_type = serviceType
        body.service_name = description || serviceType
      }
      const res = await fetch('/api/feed/create-from-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error ?? `Request failed (${res.status})`)
      if (d.warning) toast.warning(d.warning)
      else if (isAttach) toast.success(`Invoice ${d.invoice_number ?? ''} created and attached`)
      else toast.success(`Invoice ${d.invoice_number ?? ''} created and feed matched`)
      closeCreateModal()
      onCancelMatch()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Create failed')
    } finally {
      setCreateSubmitting(false)
    }
  }

  const [ignoreOpen, setIgnoreOpen] = useState(false)
  const handleIgnore = () => setIgnoreOpen(true)

  const handleIgnoreConfirm = async () => {
    const result = await ignoreBankFeed(feed.id)
    if (!result.success) return { success: false, error: result.error || 'Failed to ignore' }
    return { success: true, message: 'Transaction ignored' }
  }

  // Suggest matching invoices — smart ranking: name match first, then amount match
  const senderLower = (feed.sender_name || '').toLowerCase()
  const memoLower = (feed.memo || '').toLowerCase()
  const feedTextLower = `${senderLower} ${memoLower}`

  const suggestions = openInvoices
    .filter(inv => {
      const invCurrency = inv.amount_currency || 'USD'
      if (invCurrency !== feed.currency) return false
      const invAmount = inv.invoice_status === 'Partial'
        ? Number(inv.amount_due ?? inv.total ?? 0)
        : Number(inv.total ?? inv.amount ?? 0)
      const diff = Math.abs(invAmount - amount)
      // Wider tolerance (20%) to catch more candidates; scoring handles ranking
      return diff <= Math.max(invAmount * 0.2, 50)
    })
    .map(inv => {
      const invAmount = inv.invoice_status === 'Partial' ? Number(inv.amount_due ?? inv.total ?? 0) : Number(inv.total ?? inv.amount ?? 0)
      const diff = Math.abs(invAmount - amount)
      const companyName = (getCompanyName(inv.accounts) || '').toLowerCase()
      // Check if company name appears in sender/memo
      const companyWords = companyName.split(/\s+/).filter(w => w.length > 3 && !['llc','inc','ltd','consulting','services','international'].includes(w))
      const nameMatch = companyWords.length > 0 && companyWords.some(w => feedTextLower.includes(w))
      // Check if invoice number appears in memo
      const invNum = (inv.invoice_number || '').toLowerCase()
      const invRefMatch = invNum && feedTextLower.includes(invNum)
      // Score: inv ref > name match > amount-only
      const score = (invRefMatch ? 200 : 0) + (nameMatch ? 100 : 0) + (diff < 1 ? 50 : 0) + (1000 / (diff + 1))
      return { ...inv, score, nameMatch, invRefMatch }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

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
        <span className={cn(
          'text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0',
          candidateInfo ? STATUS_COLORS.needs_review : STATUS_COLORS.unmatched,
        )}>
          {candidateInfo ? 'needs review' : 'unmatched'}
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

      {/* REFUNDED / DISPUTED — the money is gone. This must be impossible to miss.
          A refunded charge lands in the review queue looking like any other candidate;
          without this, staff see the ordinary amber "confirm this match" banner and one
          click books money the client already has back. The server also refuses it, but
          the person deserves to know BEFORE they click, not after. */}
      {isRefundedOrDisputed(feed) && (
        <div className="px-4 pb-3">
          <div className="border-2 border-red-400 bg-red-50 rounded-md p-3">
            <div className="flex items-start gap-2 text-xs text-red-900">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>
                <span className="font-bold">REFUNDED OR DISPUTED — do not match.</span>{' '}
                Stripe says this payment went back to the client. It is not our money and
                must not be applied to an invoice.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Auto-matched candidate banner — shown only when feed.status='needs_review' */}
      {candidateInfo && (
        <div className="px-4 pb-3">
          <div className="border border-amber-300 bg-amber-50 rounded-md p-3 space-y-2">
            <div className="flex items-start gap-2 text-xs text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <p>
                <span className="font-semibold">Auto-matched candidate:</span>{' '}
                <span className="font-mono">{candidateInfo.invoice_number ?? '—'}</span>
                {' '}for <span className="font-medium">{candidateInfo.company_name}</span>
                {' '}({formatCurrency(candidateInfo.amount, candidateInfo.amount_currency)}
                {candidateInfo.confidence ? `, confidence: ${candidateInfo.confidence}` : ''})
                — please verify.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleConfirmCandidate}
                disabled={candidateBusy !== null}
                className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {candidateBusy === 'confirm' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Confirm this match
              </button>
              <button
                onClick={handleRejectCandidate}
                disabled={candidateBusy !== null}
                className="flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-zinc-300 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                {candidateBusy === 'reject' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                Reject candidate
              </button>
              <span className="text-[11px] text-muted-foreground ml-1">
                Or click the link icon (↗) above to pick a different invoice or create a new one.
              </span>
            </div>
          </div>
        </div>
      )}

      {isMatching && (
        <div className="px-4 pb-3 pt-1 space-y-3">
          {/* ── Search by client/contact ─────────────────────────── */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Search by company or person:</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="e.g. Invictus, Mario Rossi…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              {searchLoading && (
                <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </div>
            {searchQuery.trim().length >= 2 && searchResults.length === 0 && !searchLoading && (
              <p className="text-xs text-muted-foreground mt-1.5">No matches.</p>
            )}
            {searchResults.length > 0 && (
              <div className="mt-1.5 space-y-1 max-h-56 overflow-y-auto">
                {searchResults.map(r => {
                  // Account results → invoices linked to that account. Contact
                  // results → invoices scoped directly to that person (formation
                  // clients pay as an individual before their LLC exists, so the
                  // invoice carries contact_id with account_id null). Strictly
                  // filter by the matched id so we never surface another party's
                  // invoice.
                  const matchingInvoices = r.type === 'account'
                    ? openInvoices.filter(inv => inv.account_id === r.id)
                    : openInvoices.filter(inv => inv.contact_id === r.id)
                  return (
                    <div key={`${r.type}-${r.id}`} className="border rounded-md overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 text-xs">
                        {r.type === 'account' ? (
                          <Building2 className="h-3 w-3 text-blue-600 shrink-0" />
                        ) : (
                          <User className="h-3 w-3 text-purple-600 shrink-0" />
                        )}
                        <span className="font-medium truncate flex-1">{r.name}</span>
                        {r.type === 'account' && r.contact_name && (
                          <span className="text-[10px] text-muted-foreground truncate">via {r.contact_name}</span>
                        )}
                        <button
                          type="button"
                          onClick={() => openCreateModal(r)}
                          className="text-[11px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
                        >
                          + Create invoice from this feed
                        </button>
                      </div>
                      {matchingInvoices.length > 0 && (
                        <div className="divide-y">
                          {matchingInvoices.map(inv => {
                            const invAmount = Number(inv.total ?? inv.amount ?? 0)
                            return (
                              <button
                                key={inv.id}
                                type="button"
                                onClick={() => toggleSelect(inv)}
                                disabled={isPending}
                                className={cn("w-full flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-blue-50 disabled:opacity-50", selected.has(inv.id) && "bg-blue-100")}
                              >
                                {selected.has(inv.id) ? <CheckCircle2 className="h-3 w-3 text-blue-600 shrink-0" /> : <span className="h-3 w-3 rounded-sm border border-zinc-300 shrink-0" />}
                                <span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span>
                                <span className="truncate flex-1 text-left">{inv.description ?? ''}</span>
                                <span className="font-medium">{formatCurrency(invAmount, inv.amount_currency)}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="border-t pt-2">
            <p className="text-xs text-muted-foreground mb-2">Or pick from suggestions by amount:</p>
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
                    onClick={() => toggleSelect(inv)}
                    disabled={isPending}
                    className={cn("w-full flex items-center gap-3 px-3 py-2 text-xs rounded-lg border hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-50", selected.has(inv.id) && "bg-blue-100 border-blue-300")}
                  >
                    {selected.has(inv.id) ? <CheckCircle2 className="h-3 w-3 text-blue-600 shrink-0" /> : <span className="h-3 w-3 rounded-sm border border-zinc-300 shrink-0" />}
                    <span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span>
                    <span className="truncate flex-1">{invoicePartyName(inv)}</span>
                    {inv.invoice_status === 'Partial' && (
                      <span className="text-[10px] bg-orange-100 text-orange-700 px-1 py-0.5 rounded">Partial</span>
                    )}
                    {inv.invoice_status === 'Paid' && (
                      <span className="text-[10px] bg-green-100 text-green-700 px-1 py-0.5 rounded">Paid</span>
                    )}
                    <span className="font-medium">{formatCurrency(invAmount, inv.amount_currency)}</span>
                    {inv.invRefMatch ? (
                      <span className="text-emerald-600 font-medium">INV ref</span>
                    ) : inv.nameMatch ? (
                      <span className="text-emerald-600">name</span>
                    ) : diff < 1 ? (
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
                Show all {openInvoices.length} invoices
              </summary>
              <div className="mt-1 space-y-1 max-h-48 overflow-y-auto">
                {openInvoices
                  .filter(inv => !suggestions.some(s => s.id === inv.id))
                  .map(inv => (
                    <button
                      key={inv.id}
                      onClick={() => toggleSelect(inv)}
                      disabled={isPending}
                      className={cn("w-full flex items-center gap-3 px-3 py-2 text-xs rounded-lg border hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-50", selected.has(inv.id) && "bg-blue-100 border-blue-300")}
                    >
                      {selected.has(inv.id) ? <CheckCircle2 className="h-3 w-3 text-blue-600 shrink-0" /> : <span className="h-3 w-3 rounded-sm border border-zinc-300 shrink-0" />}
                      <span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span>
                      <span className="truncate flex-1">{invoicePartyName(inv)}</span>
                      <span className="font-medium">{formatCurrency(Number(inv.total ?? inv.amount), inv.amount_currency)}</span>
                    </button>
                  ))}
              </div>
            </details>
          )}
          </div>

          {/* Selection tray — one feed → several invoices (persists across searches) */}
          {selected.size > 0 && (
            <div className="sticky bottom-0 -mx-4 border-t bg-white px-4 pt-2">
              <div className="rounded-md border border-blue-300 bg-blue-50 p-2 space-y-1.5">
                <p className="text-xs font-semibold text-blue-900">Selected to match ({selected.size}) — applied in this order:</p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {selectedPreview.map(s => (
                    <div key={s.id} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-blue-600">{s.invoice_number ?? '—'}</span>
                      <span className="truncate flex-1">{s.party}</span>
                      <span className={cn(
                        "rounded px-1 text-[10px] font-medium",
                        s.willStatus === 'Paid' ? "bg-green-100 text-green-700"
                          : s.willStatus === 'Partial' ? "bg-amber-100 text-amber-700"
                          : "bg-zinc-100 text-zinc-500",
                      )}>{s.willStatus}</span>
                      <span className="font-medium tabular-nums">
                        {formatCurrency(s.willApply, s.currency)}
                        {s.willApply < s.appliedAmount - EPS && (
                          <span className="text-zinc-400"> / {formatCurrency(s.appliedAmount, s.currency)}</span>
                        )}
                      </span>
                      <button type="button" onClick={() => removeSelect(s.id)} className="p-0.5 rounded hover:bg-blue-100 text-blue-500" title="Remove">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-blue-200 pt-1 text-xs">
                  <span className="text-blue-900">Owed selected / wire</span>
                  <span className="font-semibold tabular-nums text-blue-900">
                    {formatCurrency(selectedTotal, feed.currency)} / {formatCurrency(amount, feed.currency)}
                  </span>
                </div>
                {shortfall > EPS && (
                  <p className="text-[11px] text-amber-700">
                    ⚠ The wire covers {formatCurrency(amount, feed.currency)} of {formatCurrency(selectedTotal, feed.currency)} owed. It&apos;s applied top-to-bottom; {formatCurrency(shortfall, feed.currency)} stays as an outstanding balance (debt) on the invoice(s) the wire didn&apos;t reach.
                  </p>
                )}
                {leftover > EPS && (
                  <p className="text-[11px] text-amber-700">
                    ⚠ The wire is {formatCurrency(leftover, feed.currency)} more than the selected invoices owe. Every selected invoice will be fully paid; the extra {formatCurrency(leftover, feed.currency)} is left unallocated.
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleMatchSelected}
                  disabled={isPending}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Match {selected.size} invoice{selected.size > 1 ? 's' : ''}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create-from-feed modal — Tier B target-agnostic redesign 2026-05-05 */}
      {createForResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={closeCreateModal}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">
                Create invoice from this feed
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                Target:{' '}
                <span className="font-medium">
                  {createForResult.type === 'account' ? '🏢' : '👤'} {createForResult.name}
                </span>
              </p>
            </div>

            <div className="bg-zinc-50 rounded p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-zinc-500">Date</span>
                <span className="font-medium tabular-nums">{formatDate(feed.transaction_date)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Amount</span>
                <span className="font-medium tabular-nums">{formatCurrency(amount, feed.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Sender</span>
                <span className="font-medium truncate ml-2">{feed.sender_name ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Source</span>
                <span className="font-medium">{feed.source}</span>
              </div>
            </div>

            {/* Branch A — attach to existing active SD ─────────────── */}
            {loadingTargetServices ? (
              <div className="text-xs text-zinc-500 flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Looking up existing services…
              </div>
            ) : targetServices.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-zinc-700">
                  Attach payment to an existing service this client is currently working on:
                </p>
                <div className="space-y-1">
                  {targetServices.map(sd => {
                    const selected = createSelectedSdId === sd.id
                    return (
                      <button
                        key={sd.id}
                        type="button"
                        onClick={() => handleSelectExistingSd(sd.id)}
                        disabled={createSubmitting}
                        className={cn(
                          'w-full text-left px-3 py-2 text-xs border rounded-md flex items-center gap-2 transition-colors disabled:opacity-50',
                          selected
                            ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200'
                            : 'border-zinc-200 hover:border-emerald-300 hover:bg-emerald-50/30',
                        )}
                      >
                        <span className="font-medium truncate flex-1">{sd.service_name}</span>
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wide">{sd.service_type}</span>
                        {sd.stage && (
                          <span className="text-[10px] bg-zinc-100 text-zinc-700 px-1.5 py-0.5 rounded">
                            {sd.stage}
                          </span>
                        )}
                        {selected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="text-xs text-zinc-500 flex items-center gap-1.5">
                <AlertCircle className="h-3 w-3" />
                No active services on this client. Record a one-off below.
              </div>
            )}

            {/* Branch B — create a new backfilled SD ────────────────── */}
            <div className="border-t pt-3 space-y-2">
              <p className="text-xs font-medium text-zinc-700">
                {targetServices.length > 0 ? 'Or record a new one-off / past service:' : 'Record service for this payment:'}
              </p>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">
                  Service type
                </label>
                <select
                  value={createServiceType}
                  onChange={e => handleCreateServiceTypeChange(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  disabled={createSubmitting}
                >
                  <option value="">— pick a service type —</option>
                  {VALID_SERVICE_TYPES.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">
                  Description (optional)
                </label>
                <input
                  value={createDescription}
                  onChange={e => handleCreateDescriptionChange(e.target.value)}
                  placeholder={createServiceType ? `e.g. ${createServiceType} 2025` : 'Short description for the invoice line'}
                  className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={createSubmitting}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={closeCreateModal}
                disabled={createSubmitting}
                className="px-3 py-1.5 text-xs rounded-md border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitCreate}
                disabled={createSubmitting || (!createSelectedSdId && !createServiceType.trim())}
                className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {createSubmitting && <Loader2 className="h-3 w-3 animate-spin" />}
                {createSelectedSdId ? 'Attach payment' : 'Create invoice'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDestructiveDialog
        open={ignoreOpen}
        onClose={() => setIgnoreOpen(false)}
        title="Ignore Transaction"
        description="Mark this bank feed row as ignored?"
        severity="amber"
        staticPreview={{
          affected: { bank_feed: 1 },
          items: [
            {
              label: `${SOURCE_LABELS[feed.source] ?? feed.source} — ${formatCurrency(feed.amount, feed.currency)}`,
              details: [formatDate(feed.transaction_date), feed.sender_name ?? ''].filter(Boolean),
            },
          ],
          warnings: [
            'Ignored feeds are hidden from reconciliation and will not match new invoices.',
          ],
        }}
        confirmLabel="Ignore"
        onConfirm={handleIgnoreConfirm}
      />
    </div>
  )
}

function MatchedRow({ feed, canDeleteDuplicate = false }: { feed: BankFeedRecord; canDeleteDuplicate?: boolean }) {
  const payment = feed.payments
  // Plaid-Mercury duplicate cleanup. Only enabled when:
  //   - this row is source='mercury' (Plaid)
  //   - it's matched
  //   - a same-day same-amount same-currency mercury_api twin exists AND is
  //     matched to the SAME payment
  // The parent component computes eligibility from the full bank-feed array
  // and passes the flag in via canDeleteDuplicate.
  const [confirmOpen, setConfirmOpen] = useState(false)
  const handleDeleteConfirm = async () => {
    const result = await deleteDuplicateBankFeed(feed.id)
    if (!result.success) return { success: false, error: result.error || 'Failed to delete duplicate' }
    return { success: true, message: 'Plaid duplicate deleted' }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b last:border-b-0">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
        {SOURCE_LABELS[feed.source] ?? feed.source}
      </span>
      <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
      <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
      <span className="text-xs text-muted-foreground truncate">{feed.sender_name || '—'}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
      {payment?.invoice_number && feed.matched_payment_id ? (
        <a
          href={`/api/invoices/${feed.matched_payment_id}/pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-blue-600 hover:underline shrink-0"
          title="Open invoice PDF"
        >
          {payment.invoice_number}
        </a>
      ) : (
        <span className="font-mono text-xs text-blue-600 shrink-0">{payment?.invoice_number ?? '—'}</span>
      )}
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
      {/* An audit link is NOT a payment. The invoice was already settled through another
          channel (its own Stripe webhook, or a human marking it paid), and this transaction
          is attached purely for the record — no money was applied. Without this, a matched
          row where nothing moved looks identical to one where it did. */}
      {isAuditLink(feed) && (
        <span
          className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 bg-slate-100 text-slate-600 border border-slate-200"
          title={auditLinkNote(feed) ?? 'Linked for the audit trail — no money applied.'}
        >
          audit link · no money applied
        </span>
      )}
      {canDeleteDuplicate && (
        <>
          <button
            onClick={() => setConfirmOpen(true)}
            title="Delete this Plaid duplicate — Mercury API twin already matched to the same invoice"
            className="p-1 rounded hover:bg-red-50 text-red-500 shrink-0"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <ConfirmDestructiveDialog
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Delete Plaid duplicate"
            description="The same wire is also recorded via the Mercury API and already matched to the same invoice. Deleting the Plaid copy keeps your books clean. The invoice and the Mercury API match are not affected."
            severity="amber"
            staticPreview={{
              affected: { bank_feed: 1 },
              items: [
                {
                  label: `${SOURCE_LABELS[feed.source] ?? feed.source} — ${formatCurrency(feed.amount, feed.currency)}`,
                  details: [formatDate(feed.transaction_date), feed.sender_name ?? ''].filter(Boolean),
                },
              ],
              warnings: [
                'The Mercury API row remains as the canonical record of this wire.',
              ],
            }}
            confirmLabel="Delete Plaid duplicate"
            onConfirm={handleDeleteConfirm}
          />
        </>
      )}
    </div>
  )
}

function CrashedRow({ feed }: { feed: BankFeedRecord }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const payment = feed.payments
  const meta = (feed.review_metadata ?? {}) as Record<string, unknown>
  const activationError = typeof meta.activation_error === 'string' ? meta.activation_error : null

  const handleRetry = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/crm/admin-actions/bank-feed-retry-activation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feed_id: feed.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        toast.error(data.error || `Retry failed (${res.status})`)
        return
      }
      toast.success('Activation succeeded')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
          {SOURCE_LABELS[feed.source] ?? feed.source}
        </span>
        <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
        <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
        <span className="text-xs text-muted-foreground truncate">{feed.sender_name || '—'}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-mono text-xs text-blue-600 shrink-0">{payment?.invoice_number ?? '—'}</span>
        <span className="text-xs truncate flex-1">{getCompanyName(payment?.accounts)}</span>
        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', STATUS_COLORS.activation_crashed)}>
          activation crashed
        </span>
        <button
          onClick={handleRetry}
          disabled={busy}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-50 hover:bg-red-100 text-red-700 disabled:opacity-50 shrink-0"
          title="Retry activation"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
          Retry
        </button>
      </div>
      <div className="px-4 pb-3">
        <div className="border border-red-300 bg-red-50 rounded-md px-3 py-2 flex items-start gap-2 text-xs text-red-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <p>
            <span className="font-semibold">Auto-activation failed:</span>{' '}
            {activationError ?? 'No error message recorded.'}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * A transaction the system flagged as a duplicate.
 *
 * These used to be invisible — no tab, no colour, no count — so they rendered as
 * "ignored" and nobody noticed when a REAL client payment was flagged by mistake
 * (the old dedup rule treated two same-day, same-amount payments from one cardholder
 * as one payment). The rule is gone, but the rows it created still exist, and any
 * future flag must be visible and reversible. Restore puts the money back in the
 * queue to be matched.
 */
function DuplicateRow({ feed }: { feed: BankFeedRecord }) {
  const [isPending, startTransition] = useTransition()

  const handleRestore = () => {
    startTransition(async () => {
      const result = await restoreBankFeed(feed.id)
      if (!result.success) {
        toast.error(result.error || 'Could not restore this transaction.')
        return
      }
      toast.success('Restored — the transaction is back in the queue to be matched.')
    })
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b last:border-b-0">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
        {SOURCE_LABELS[feed.source] ?? feed.source}
      </span>
      <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
      <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
      <span className="text-xs truncate flex-1">{feed.sender_name || '—'}</span>
      <span className="text-xs text-muted-foreground truncate max-w-[200px]">{feed.memo || ''}</span>
      <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', STATUS_COLORS.duplicate)}>
        duplicate
      </span>
      <button
        onClick={handleRestore}
        disabled={isPending}
        title="Not a duplicate — put this payment back in the queue"
        className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-purple-200 text-purple-700 hover:bg-purple-50 disabled:opacity-50 shrink-0"
      >
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
        Restore
      </button>
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

export function BankFeedTab({ bankFeeds, openInvoices, totalCount, isAdmin = false }: Props) {
  const [filter, setFilter] = useState<FilterTab>('all')
  const [sourceFilter, setSourceFilter] = useState<string[] | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchingFeed, setMatchingFeed] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [highlightFeedId, setHighlightFeedId] = useState<string | null>(null)
  const pageSize = 50

  // Plaid-Mercury duplicate eligibility — set of Plaid (mercury) feed IDs that
  // have a matched mercury_api twin pointing at the same payment. Used by
  // MatchedRow to surface a one-click "Delete Plaid duplicate" cleanup.
  const eligibleForDeleteDuplicate = useMemo(() => {
    const mercuryApiByKey = new Map<string, BankFeedRecord>()
    for (const f of bankFeeds) {
      if (f.source === 'mercury_api' && f.status === 'matched' && f.matched_payment_id) {
        const key = `${f.transaction_date}|${f.amount}|${f.currency}|${f.matched_payment_id}`
        mercuryApiByKey.set(key, f)
      }
    }
    const eligible = new Set<string>()
    for (const f of bankFeeds) {
      if (f.source !== 'mercury' || f.status !== 'matched' || !f.matched_payment_id) continue
      const key = `${f.transaction_date}|${f.amount}|${f.currency}|${f.matched_payment_id}`
      if (mercuryApiByKey.has(key)) eligible.add(f.id)
    }
    return eligible
  }, [bankFeeds])

  // Deep-link from audit panel: ?feed=<uuid> opens this tab scrolled to the feed.
  // Sets source filter from feed.source + search by amount + scrolls + 3s highlight.
  const searchParams = useSearchParams()
  const deepLinkFeedId = searchParams.get('feed')
  useEffect(() => {
    if (!deepLinkFeedId) return
    const feed = bankFeeds.find(f => f.id === deepLinkFeedId)
    if (!feed) {
      toast.info('Feed not in current list — try Sync Now')
      return
    }
    setFilter('all')
    setSourceFilter([feed.source])
    setSearchQuery(String(Number(feed.amount)))
    setPage(0)
    setHighlightFeedId(feed.id)
    const t1 = setTimeout(() => {
      const el = document.getElementById(`bank-feed-row-${feed.id}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
    const t2 = setTimeout(() => setHighlightFeedId(null), 3000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [deepLinkFeedId, bankFeeds])

  // Filter and search
  const filtered = useMemo(() => {
    let items = bankFeeds

    // The Bank Feed is for CLIENT INVOICE PAYMENTS ONLY (Antonio, 2026-07-27). A feed marked
    // `owner_ledger` is TD's own money — a Stripe payout, a bank reward, money TD spent — and
    // it already lives in My Finances, where the company's accounting is done. It is removed
    // here for EVERYONE: staff reconciling invoices should not wade through it, and it is not
    // their business. This is not the invisible-`duplicate` failure — the money has a visible
    // home (My Finances); it is only absent from the screen it never belonged on.
    items = items.filter(f => f.status !== 'owner_ledger')

    // Hide outgoing transactions for non-admin users
    if (!isAdmin) {
      items = items.filter(f => f.status !== 'outgoing')
    }

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
  }, [bankFeeds, filter, sourceFilter, searchQuery, isAdmin])

  // Paginate
  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const totalPages = Math.ceil(filtered.length / pageSize)

  // Counts by status
  const counts = useMemo(() => ({
    all: bankFeeds.length,
    unmatched: bankFeeds.filter(f => f.status === 'unmatched').length,
    needs_review: bankFeeds.filter(f => f.status === 'needs_review').length,
    activation_crashed: bankFeeds.filter(f => f.status === 'activation_crashed').length,
    matched: bankFeeds.filter(f => f.status === 'matched').length,
    ignored: bankFeeds.filter(f => f.status === 'ignored').length,
    duplicate: bankFeeds.filter(f => f.status === 'duplicate').length,
  }), [bankFeeds])

  // Build a lookup so needs_review rows can show the candidate invoice
  // banner using the same openInvoices data already in scope.
  const openInvoiceById = useMemo(() => {
    const map = new Map<string, OpenInvoice>()
    for (const inv of openInvoices) map.set(inv.id, inv)
    return map
  }, [openInvoices])

  return (
    <div className="p-6 space-y-4 overflow-y-auto h-full">
      {/* Connected banks summary */}
      <BanksSummary activeSource={sourceFilter} onSourceFilter={(s) => { setSourceFilter(s); setPage(0) }} isAdmin={isAdmin} />

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
        <div className="flex gap-1 flex-wrap">
          {(['all', 'unmatched', 'needs_review', 'activation_crashed', 'matched', 'ignored', 'duplicate'] as FilterTab[]).map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(0) }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors',
                filter === f
                  ? f === 'unmatched' ? 'bg-amber-100 text-amber-700'
                    : f === 'needs_review' ? 'bg-amber-100 text-amber-800'
                    : f === 'activation_crashed' ? 'bg-red-100 text-red-700'
                    : f === 'matched' ? 'bg-emerald-100 text-emerald-700'
                    : f === 'ignored' ? 'bg-zinc-200 text-zinc-700'
                    : f === 'duplicate' ? 'bg-purple-100 text-purple-700'
                    : 'bg-blue-100 text-blue-700'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {f === 'unmatched' && <AlertCircle className="h-3 w-3" />}
              {f === 'needs_review' && <AlertTriangle className="h-3 w-3" />}
              {f === 'activation_crashed' && <AlertTriangle className="h-3 w-3" />}
              {f === 'matched' && <CheckCircle2 className="h-3 w-3" />}
              {f === 'duplicate' && <Copy className="h-3 w-3" />}
              {f === 'needs_review' ? 'Needs Review' :
               f === 'activation_crashed' ? 'Crashed' :
               f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
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
            // needs_review = an auto-matched candidate awaiting Confirm/Reject.
            // Reuses UnmatchedRow's manual-picker so admin can also pick a
            // different invoice instead.
            let candidateInfo: CandidateInfo | null = null
            if (feed.status === 'needs_review' && feed.matched_payment_id) {
              const inv = openInvoiceById.get(feed.matched_payment_id)
              if (inv) {
                const invAmount = inv.invoice_status === 'Partial'
                  ? Number(inv.amount_due ?? inv.total ?? 0)
                  : Number(inv.total ?? inv.amount ?? 0)
                candidateInfo = {
                  invoice_number: inv.invoice_number,
                  company_name: getCompanyName(inv.accounts),
                  amount: invAmount,
                  amount_currency: inv.amount_currency,
                  confidence: feed.match_confidence,
                }
              } else if (feed.payments) {
                // Fallback: payment may not be in the open-invoice set anymore.
                candidateInfo = {
                  invoice_number: feed.payments.invoice_number,
                  company_name: getCompanyName(feed.payments.accounts),
                  amount: Number(feed.amount),
                  amount_currency: feed.currency,
                  confidence: feed.match_confidence,
                }
              }
            }

            const inner = feed.status === 'unmatched' || feed.status === 'needs_review' ? (
              <UnmatchedRow
                feed={feed}
                openInvoices={openInvoices}
                isMatching={matchingFeed === feed.id}
                onStartMatch={() => setMatchingFeed(feed.id)}
                onCancelMatch={() => setMatchingFeed(null)}
                candidateInfo={candidateInfo}
              />
            ) : feed.status === 'activation_crashed' ? (
              <CrashedRow feed={feed} />
            ) : feed.status === 'matched' ? (
              <MatchedRow feed={feed} canDeleteDuplicate={eligibleForDeleteDuplicate.has(feed.id)} />
            ) : feed.status === 'duplicate' ? (
              <DuplicateRow feed={feed} />
            ) : (
              <IgnoredRow feed={feed} />
            )
            return (
              <div
                key={feed.id}
                id={`bank-feed-row-${feed.id}`}
                className={cn(
                  'transition-shadow',
                  highlightFeedId === feed.id && 'ring-2 ring-amber-400 ring-inset rounded'
                )}
              >
                {inner}
              </div>
            )
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
