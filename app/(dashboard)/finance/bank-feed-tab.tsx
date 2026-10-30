'use client'

import { useState, useCallback, useEffect, useTransition, useMemo, useRef } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { readContestedCandidates, readContestedTotal, type ContestedCandidate } from '@/lib/finance/feed-vocabulary'
import { contestedInvoiceFacts, formatCalendarDate, type ContestedInvoiceDetail } from '@/lib/finance/contested-invoice-detail'
import { recordOnlyLinkNote } from '@/lib/finance/match-selection'
import { parseFeedView, writeFeedView } from '@/lib/finance/bank-feed-view-state'
import {
  summarizeInvoice,
  summaryInputFromPayerInvoice,
  summaryInputFromOpenInvoice,
  summaryInputFromMatchedPayment,
  type InvoiceSummaryInput,
} from '@/lib/finance/invoice-summary'
import type { PayerInvoice, PayerInvoicesResult, PayerCompanyInfo } from '@/lib/finance/payer-invoices'
import {
  SAME_AMOUNT_CAUTION,
  SAME_AMOUNT_DAYS,
  SAME_AMOUNT_WIDER_DAYS,
  dayOffsetText,
  dropAlreadyShown,
  sameAmountEmptyText,
  sameAmountHeadline,
  sameAmountTiedText,
  type SameAmountPaidResult,
} from '@/lib/finance/same-amount-labels'
import { summarizeMultiLink, MAX_LINKED_INVOICES, otherMultiLinkedInvoices } from '@/lib/finance/multi-invoice-link'
import { evaluateNameEvidence } from '@/lib/finance/feed-signals'
import { toast } from 'sonner'
import {
  Landmark, RefreshCw, Plus, Link2, Ban, X,
  Loader2, ArrowRight, CheckCircle2, AlertCircle, AlertTriangle,
  Search, Building2, User, Trash2, Check, RotateCw, Copy, Undo2, StickyNote,
} from 'lucide-react'
import { matchBankFeedToInvoices, ignoreBankFeed, deleteDuplicateBankFeed, restoreBankFeed, claimBankFeedForOwner } from './actions'
import { invoicePartyName } from '@/lib/finance/invoice-party'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { VALID_SERVICE_TYPES } from '@/lib/operations/service-types'
import { PaymentInvestigationPanel, readStoredInvestigation } from './payment-investigation'
import { prefillPersonName, validateNewPerson } from '@/lib/finance/new-person'
import { existingTargetFromWho, type ExistingTarget, type InvestigationWho } from '@/lib/finance/feed-investigation'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { InvoiceNoteDot } from '@/components/shared/invoice-note-dot'

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
  /** The real bank name from the source My Finances row, for a feed created by
   *  "send to Finance" (sendOwnerTransactionToFinance) — these always carry
   *  source:'manual' (guessFeedSource only recognizes 5 specific banks by
   *  name), which otherwise loses which bank it actually was. Null for a feed
   *  that never came from My Finances, or a genuinely bank-unknown manual entry. */
  source_bank_name?: string | null
  /** Live details (description, amount, paid date) of each invoice in a "more than one invoice fits"
   *  box, keyed by invoice id, so the person can choose without leaving the screen. */
  contested_details?: Record<string, ContestedInvoiceDetail>
  payments?: {
    invoice_number: string | null
    description: string | null
    account_id: string
    total: number | null
    amount_paid: number | null
    invoice_status: string | null
    notes: string | null
    accounts: { company_name: string } | null
    /** An invoice written to a PERSON (no company) carries the person here — 73 on production. */
    contact_id?: string | null
    contacts?: { full_name: string | null } | { full_name: string | null }[] | null
  } | null
}

/** Closed Paid while collecting less than the invoiced total — a write-off,
 * not an ordinary full payment. Mirrors the identical, live-verified-safe
 * check in all-invoices-tab.tsx (no other flow leaves a Paid invoice short
 * of its own total, so this comparison alone is an unambiguous signal). */
function isWrittenOffPayment(payment: BankFeedRecord['payments']): boolean {
  if (!payment) return false
  // amount_paid != null matters: Number(null) is 0 in JS, which would wrongly
  // flag an old invoice that never had amount_paid populated at all as a
  // write-off. Caught live in production the day this shipped.
  return payment.invoice_status === 'Paid' && payment.amount_paid != null && Number(payment.total) > 0 && Number(payment.amount_paid) < Number(payment.total)
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
  /** The owner: the only one who can run "What is this payment?" (it reads the owner's mailbox). */
  isOwner?: boolean
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
  revolut: 'Revolut',
  chase: 'Chase',
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
  revolut: 'bg-sky-100 text-sky-700',
  chase: 'bg-cyan-100 text-cyan-700',
}

/** The badge text for a feed row — the real bank name when we have one
 *  (a transaction sent over from My Finances), otherwise the generic
 *  source label ("Manual", "Mercury", etc). Single source of truth for
 *  all 5 row-render sites below, so a future source type only needs
 *  updating here. */
function sourceLabel(feed: Pick<BankFeedRecord, 'source' | 'source_bank_name'>): string {
  return feed.source_bank_name?.trim() || SOURCE_LABELS[feed.source] || feed.source
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

/**
 * Is this transaction parked because SEVERAL invoices were equally plausible?
 *
 * ⛔ WHY THIS MUST BE ON THE SCREEN (2026-07-29). The guard that stopped the wrong-client
 * auto-match parks the transaction and pins the top-scoring candidate. Without this block the
 * row looks EXACTLY like an ordinary suggestion — one pinned invoice behind a green "Confirm
 * this match" — and in the real incident the pinned candidate was the WRONG company. That
 * would move the mistake from the machine to the person, which is not a fix.
 */
function contestedCandidates(feed: BankFeedRecord): ContestedCandidate[] {
  return readContestedCandidates(feed.review_metadata)
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
    try {
      const res = await fetch('/api/plaid/create-link-token', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not start the bank connection.')
        return
      }
      setLinkToken(data.link_token)
    } finally {
      setLoading(false)
    }
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

function BanksSummary({ activeSource, onSourceFilter, isAdmin = false, syncBlocked = false }: { activeSource: string[] | null; onSourceFilter: (sources: string[] | null) => void; isAdmin?: boolean; syncBlocked?: boolean }) {
  const router = useRouter()
  const [connections, setConnections] = useState<PlaidConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncingAllBanks, setSyncingAllBanks] = useState(false)
  const [forbidden, setForbidden] = useState(false)

  const fetchConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/plaid/accounts')
      if (res.status === 401 || res.status === 403) {
        setForbidden(true)
        setConnections([])
        return
      }
      setForbidden(false)
      const data = await res.json().catch(() => ({}))
      setConnections(data.connections ?? [])
    } catch {
      // Plaid may not be configured yet
    } finally {
      setLoading(false)
    }
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

  // Relay and Revolut are hidden from the Connected Banks UI per Antonio's request —
  // both still sync transactions in the background; we just don't surface their account
  // summary cards or balances on this screen.
  const HIDDEN_BANKS = ['relay', 'revolut']
  const visibleConnections = connections.filter(
    conn => !HIDDEN_BANKS.some(b => (conn.institution_name ?? conn.bank_name ?? '').toLowerCase().includes(b))
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
          <FastTooltip
            label={
              syncBlocked
                ? "Blocked while a \"Link with a note\" box is open on this page — finish or cancel it first."
                : "Pulls latest transactions from Mercury + Airwallex and runs auto-match + auto-activate. Same chain that runs every 15 min."
            }
          >
            <button
              onClick={handleSyncAllBanks}
              disabled={syncingAllBanks || syncBlocked}
              aria-label={
                syncBlocked
                  ? "Blocked while a \"Link with a note\" box is open on this page — finish or cancel it first."
                  : "Pulls latest transactions from Mercury + Airwallex and runs auto-match + auto-activate. Same chain that runs every 15 min."
              }
              className="flex items-center gap-1.5 bg-blue-600 text-white rounded px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {syncingAllBanks ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync All Banks Now
            </button>
          </FastTooltip>
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
      ) : forbidden ? (
        <div className="border-2 border-dashed rounded-lg p-6 text-center">
          <p className="text-sm text-muted-foreground font-medium">Bank accounts are connected, but you don&apos;t have permission to view their status here.</p>
          <p className="text-xs text-muted-foreground mt-1">Ask Antonio for access if you need to manage bank connections.</p>
        </div>
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
  // A person who hasn't become a client yet (e.g. paid for a strategy call
  // but never signed/paid for a real service) — paid-call target only.
  | { type: 'lead'; id: string; name: string; email?: string | null }
  // Someone who paid and is NOT in the CRM at all (not a client, not a lead): the server creates a plain
  // person when the invoice is created. `id` is a placeholder — there is no record yet.
  | { type: 'new_person'; id: string; name: string; email?: string | null }

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
  /** What the hover card on the proposed invoice's number shows (client, what it is for, amount, status). */
  summary?: InvoiceSummaryInput
}

/**
 * "Mine →" — Antonio claims a deposit for My Finances, by hand.
 *
 * The mirror of the "This is for a client →" button over there. The cautious rule keeps
 * anything that COULD be a client payment in Finance; when he looks at a row and knows it is
 * his own money (a bank reward with a wrong auto-match pinned on it, say), this is the
 * one-click override. Rendered only for admins — and the server action re-checks the role,
 * because button visibility is not a security boundary.
 */
function ClaimForOwnerButton({ feedId }: { feedId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const handleClaim = async () => {
    setBusy(true)
    try {
      const result = await claimBankFeedForOwner(feedId)
      if (!result.success) throw new Error(result.error || 'Could not move it to My Finances.')
      toast.success('Moved to My Finances')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not move it to My Finances.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <FastTooltip label="This is TD's own money, not a client payment — move it to My Finances">
      <button
        onClick={handleClaim}
        disabled={busy}
        className="rounded border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700 hover:bg-purple-100 disabled:opacity-50 shrink-0"
        aria-label="This is TD's own money, not a client payment — move it to My Finances"
      >
        {busy ? 'Moving…' : 'Mine →'}
      </button>
    </FastTooltip>
  )
}

/**
 * An invoice number that shows a short summary on hover — client, what it is for, amount, status —
 * so a person can tell whose invoice it is without opening it.
 */
function InvoiceNumberTip({ summary, hint, children }: { summary: InvoiceSummaryInput; hint?: string; children: React.ReactNode }) {
  const s = summarizeInvoice(summary)
  return (
    <FastTooltip
      label={undefined}
      align="left"
      card={
        <div className="space-y-0.5">
          <p className="font-mono text-[11px] font-semibold">{s.title}</p>
          {s.lines.map(l => (
            <p key={l.label}><span className="text-zinc-400">{l.label}: </span>{l.value}</p>
          ))}
          {hint && <p className="pt-0.5 text-zinc-400">{hint}</p>}
        </div>
      }
    >
      {children}
    </FastTooltip>
  )
}

/** One invoice in a "who paid" list: tick it to add it to the selection. */
function PayerInvoiceRow({ inv, checked, onToggle, disabled, showParty, note }: {
  inv: PayerInvoice
  checked: boolean
  onToggle: () => void
  disabled: boolean
  showParty: boolean
  /** A short muted word before the paid badge, e.g. "same day" or "2 days before". */
  note?: string
}) {
  const shown = inv.paid ? inv.total : (inv.balance ?? inv.total)
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn('w-full flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-blue-50 disabled:opacity-50', checked && 'bg-blue-100')}
    >
      {checked ? <CheckCircle2 className="h-3 w-3 text-blue-600 shrink-0" /> : <span className="h-3 w-3 rounded-sm border border-zinc-300 shrink-0" />}
      <InvoiceNumberTip summary={summaryInputFromPayerInvoice(inv)}><span className="font-mono text-blue-600 shrink-0">{inv.invoice_number ?? '—'}</span></InvoiceNumberTip>
      {showParty && <span className="text-muted-foreground truncate max-w-[140px] shrink-0">{inv.party}</span>}
      <span className="truncate flex-1 text-left">{inv.description ?? inv.installment ?? ''}</span>
      {inv.claimed_by_other && (
        <span className="text-[10px] px-1 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 shrink-0" title="Another bank payment is already linked to this invoice">
          linked to another payment
        </span>
      )}
      {note && <span className="text-[10px] text-muted-foreground shrink-0">{note}</span>}
      {inv.paid ? (
        <span className="text-[10px] px-1 py-0.5 rounded bg-green-100 text-green-700 shrink-0">
          {inv.paid_date ? `paid ${formatCalendarDate(inv.paid_date)}` : 'paid'}
        </span>
      ) : (
        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">{inv.status_label ?? 'unpaid'}</span>
      )}
      <span className="font-medium tabular-nums shrink-0">{formatCurrency(shown, inv.currency)}</span>
    </button>
  )
}

function UnmatchedRow({
  feed, openInvoices, isMatching, onStartMatch, onCancelMatch, candidateInfo, isAdmin = false, isOwner = false,
  onNoteLinkOpenChange,
}: {
  feed: BankFeedRecord
  openInvoices: OpenInvoice[]
  isMatching: boolean
  onStartMatch: () => void
  onCancelMatch: () => void
  candidateInfo?: CandidateInfo | null
  isAdmin?: boolean
  isOwner?: boolean
  onNoteLinkOpenChange?: (feedId: string, open: boolean) => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [candidateBusy, setCandidateBusy] = useState<null | 'confirm' | 'reject'>(null)
  const amount = Number(feed.amount)
  // Bug-hunter, 2026-09-11: "Match to invoice" has no inline check either — the
  // real protection is server-side, at settlement time (manualMatch calls
  // isChargeRefundedNow before crediting a Stripe row) — but linkFeedTransactionToInvoice
  // has no equivalent, and this row's own button is offered unconditionally
  // regardless of source. The red banner below already exists for a feed a
  // prior automatic pass has flagged; this reuses that same signal to keep
  // "Link with a note" from being the one path with no warning at all.
  const refundedOrDisputed = isRefundedOrDisputed(feed)
  // Several invoices fitted this payment equally well — see the block below the row.
  const contested = contestedCandidates(feed)
  // On a real book an amount-only tie can be dozens of invoices; only a sample is recorded.
  const contestedTotal = readContestedTotal(feed.review_metadata)

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
  // WS-A: this transaction was a PAID STRATEGY CALL the system could not tie to
  // anyone (client paid under a different address). Person targets only.
  const [createPaidCall, setCreatePaidCall] = useState(false)
  const [paidCallRevenueOnly, setPaidCallRevenueOnly] = useState(false)
  // The payer is not in the CRM: the "create a new person" card (name from the payment, email optional).
  const [newPersonOpen, setNewPersonOpen] = useState(false)
  const [newPersonName, setNewPersonName] = useState('')
  const [newPersonEmail, setNewPersonEmail] = useState('')
  // "Write the AI's story on the invoice note" — only meaningful once the payment has an investigation.
  const [saveStory, setSaveStory] = useState(true)
  const storedInvestigation = readStoredInvestigation(feed.review_metadata)
  // Who the AI identified. The panel keeps it current (a fresh run, a re-run); starting from what is stored means
  // the first paint already agrees with it.
  const [aiWho, setAiWho] = useState<InvestigationWho | null>(() => storedInvestigation?.who ?? null)
  const openNewPerson = (name?: string) => {
    setNewPersonName((name && name.trim()) || prefillPersonName(feed.sender_name))
    setNewPersonOpen(true)
  }
  const continueWithNewPerson = () => {
    const checked = validateNewPerson({ full_name: newPersonName, email: newPersonEmail })
    if (checked.ok === false) { toast.error(checked.error); return }
    void openCreateModal({ type: 'new_person', id: 'new', name: checked.value.full_name, email: checked.value.email })
  }

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
  type SelectedEntry = {
    id: string
    invoice_number: string | null
    appliedAmount: number
    currency: string | null
    party: string
    /** Already paid: linking records the payment against it, no money moves. */
    paid: boolean
    paidDate: string | null
  }
  const [selected, setSelected] = useState<Map<string, SelectedEntry>>(new Map())
  const toggleSelect = (inv: OpenInvoice) => {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(inv.id)) next.delete(inv.id)
      else next.set(inv.id, { id: inv.id, invoice_number: inv.invoice_number, appliedAmount: invoiceApplied(inv), currency: inv.amount_currency, party: invoicePartyName(inv), paid: false, paidDate: null })
      return next
    })
  }
  // An invoice from the "who paid" list. An already-paid one counts for its own total (it is only
  // linked for the record). An unpaid one the page also holds is selected exactly as the plain
  // lists select it, so every list agrees on what is owed.
  const toggleSelectPayerInvoice = (pi: PayerInvoice) => {
    const known = !pi.paid ? openInvoices.find(o => o.id === pi.id) : undefined
    if (known) { toggleSelect(known); return }
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(pi.id)) next.delete(pi.id)
      else next.set(pi.id, {
        id: pi.id,
        invoice_number: pi.invoice_number,
        appliedAmount: Number((pi.paid ? pi.total : (pi.balance ?? pi.total)) ?? 0),
        currency: pi.currency,
        party: pi.party,
        paid: pi.paid,
        paidDate: pi.paid_date,
      })
      return next
    })
  }
  const removeSelect = (id: string) => setSelected(prev => { const next = new Map(prev); next.delete(id); return next })
  const selectedArr = Array.from(selected.values())
  const paidSelected = selectedArr.filter(s => s.paid)
  const openSelected = selectedArr.filter(s => !s.paid)
  // One payment is either applied to unpaid invoices or linked to paid ones — not both at once.
  const mixedSelection = paidSelected.length > 0 && openSelected.length > 0
  const recordOnlyMode = paidSelected.length > 0 && openSelected.length === 0
  const selectedTotal = openSelected.reduce((sum, x) => sum + x.appliedAmount, 0)
  // Waterfall preview (matches the backend): the wire is applied in selection
  // order, each invoice gets min(remaining wire, its balance). Map preserves
  // insertion = selection order, so this mirrors what manualMatchMulti will do.
  const EPS = 0.005
  let _remaining = amount
  const selectedPreview = openSelected.map(s => {
    const willApply = Math.max(Math.min(_remaining, s.appliedAmount), 0)
    _remaining -= willApply
    const willStatus: 'Paid' | 'Partial' | 'Unpaid' =
      willApply >= s.appliedAmount - EPS ? 'Paid' : willApply > EPS ? 'Partial' : 'Unpaid'
    return { ...s, willApply, willStatus }
  })
  const shortfall = Math.max(selectedTotal - amount, 0) // wire < owed → stays as debt
  const leftover = Math.max(amount - selectedTotal, 0) // wire > owed → unallocated surplus
  // Already-paid invoices linked for the record: how they add up against the payment.
  const paidSummary = summarizeMultiLink(amount, paidSelected.map(s => s.appliedAmount))
  const [recordNote, setRecordNote] = useState('')
  const recordNotePlaceholder = recordOnlyLinkNote(feed)
  const handleMatchSelected = () => {
    const ids = selectedArr.map(s => s.id)
    if (ids.length === 0 || mixedSelection) return
    startTransition(async () => {
      try {
        const result = await matchBankFeedToInvoices(feed.id, ids, recordNote, saveStory)
        if (!result.success) throw new Error(result.error)
        const applied = result.data?.count ?? ids.length
        if (result.data?.recordOnly) {
          toast.success(`Payment linked to ${ids.length} already-paid invoice${ids.length > 1 ? 's' : ''} — no money moved`)
        } else if (applied < ids.length) {
          // The payment ran out, or an invoice was already closed: say what really happened.
          toast.warning(`Payment applied to ${applied} of the ${ids.length} invoices you ticked. The rest were not reached — the payment ran out or they were already paid.`)
        } else {
          toast.success(`Transaction matched to ${ids.length} invoice${ids.length > 1 ? 's' : ''}`)
        }
        if (result.data?.story) toast.info(result.data.story)
        onCancelMatch()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Match failed')
      }
    })
  }

  // ── "Who paid" — the invoices of the company this payment most likely belongs to ──
  // Read when the popup opens: the company the billing email belongs to in the CRM, and the
  // companies earlier payments from the same sender were linked to, with every invoice (paid and
  // unpaid), and any set of them that adds up to this payment exactly. Suggestions only.
  const [payerData, setPayerData] = useState<PayerInvoicesResult | null>(null)
  const [payerLoading, setPayerLoading] = useState(false)
  const [payerError, setPayerError] = useState<string | null>(null)
  useEffect(() => {
    if (!isMatching) return
    let cancelled = false
    setPayerLoading(true)
    setPayerError(null)
    fetch(`/api/finance/payer-invoices?feed_id=${encodeURIComponent(feed.id)}`)
      .then(async res => {
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d.error || `Could not look up who paid (${res.status})`)
        if (!cancelled) setPayerData(d)
      })
      .catch(err => {
        if (!cancelled) {
          setPayerData(null)
          setPayerError(err instanceof Error && err.message ? err.message : 'Could not look up who paid.')
        }
      })
      .finally(() => { if (!cancelled) setPayerLoading(false) })
    return () => { cancelled = true }
  }, [isMatching, feed.id])

  // ── Already-paid invoices of exactly this amount — whoever they belong to ──
  // Read when the popup opens, within 3 days of the payment; "Look wider" asks for 30. Plain invoice data, no AI:
  // it works when nobody knows who paid. Suggestions only — ticking a row joins the same "link for the record"
  // selection as the other lists.
  const [sameAmount, setSameAmount] = useState<{ state: 'loading' | 'ready' | 'error'; days: number; data: SameAmountPaidResult | null }>(
    { state: 'loading', days: SAME_AMOUNT_DAYS, data: null },
  )
  const sameAmountRun = useRef(0)
  const loadSameAmount = (days: number) => {
    const run = ++sameAmountRun.current
    setSameAmount(prev => ({ state: 'loading', days, data: days === prev.days ? prev.data : null }))
    fetch(`/api/finance/same-amount-paid?feed_id=${encodeURIComponent(feed.id)}&days=${days}`)
      .then(async res => {
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d.error || `Could not look for paid invoices of this amount (${res.status})`)
        if (run === sameAmountRun.current) setSameAmount({ state: 'ready', days, data: d as SameAmountPaidResult })
      })
      .catch(() => { if (run === sameAmountRun.current) setSameAmount({ state: 'error', days, data: null }) })
  }
  useEffect(() => {
    if (!isMatching) {
      sameAmountRun.current++
      // A closed popup forgets what it loaded. Returning the same object when nothing changed keeps every row of a
      // long list from re-rendering just because it mounted.
      setSameAmount(prev => (prev.state === 'loading' && prev.days === SAME_AMOUNT_DAYS && prev.data === null ? prev : { state: 'loading', days: SAME_AMOUNT_DAYS, data: null }))
      return
    }
    // Every new load (another payment, the wider look) or a closed popup bumps the counter, so a late answer for an
    // earlier one is ignored.
    loadSameAmount(SAME_AMOUNT_DAYS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMatching, feed.id])

  // Paid invoices of a company the person searched for, loaded on demand (the page only holds
  // the unpaid ones).
  const [paidByResult, setPaidByResult] = useState<Record<string, { state: 'loading' | 'ready' | 'error'; invoices: PayerInvoice[]; error?: string }>>({})
  const loadPaidFor = async (r: FeedMatchResult) => {
    if (r.type === 'lead') return
    const key = `${r.type}-${r.id}`
    setPaidByResult(prev => ({ ...prev, [key]: { state: 'loading', invoices: [] } }))
    try {
      const param = r.type === 'account' ? `account_id=${r.id}` : `contact_id=${r.id}`
      const res = await fetch(`/api/finance/payer-invoices?feed_id=${encodeURIComponent(feed.id)}&${param}`)
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not load the paid invoices.')
      setPaidByResult(prev => ({ ...prev, [key]: { state: 'ready', invoices: ((d.invoices ?? []) as PayerInvoice[]).filter(i => i.paid) } }))
    } catch (err) {
      setPaidByResult(prev => ({ ...prev, [key]: { state: 'error', invoices: [], error: err instanceof Error && err.message ? err.message : 'Could not load the paid invoices.' } }))
    }
  }

  // A closed popup forgets what it loaded, so the next opening reads fresh invoices.
  useEffect(() => {
    if (isMatching) return
    setPaidByResult({})
    setRecordNote('')
  }, [isMatching])

  // The AI named invoices (a paid one among them, which the page does not hold): load them from the same source
  // the "who paid" box uses and select them exactly as a click on their row would. Nothing is linked here.
  const selectSuggestedInvoices = async (ids: string[]) => {
    const missing = ids.filter(id => !openInvoices.some(o => o.id === id))
    for (const id of ids) {
      const inv = openInvoices.find(o => o.id === id)
      if (inv && !selected.has(inv.id)) toggleSelect(inv)
    }
    if (missing.length === 0) return
    const pool = new Map<string, PayerInvoice>([...(sameAmount.data?.invoices ?? []), ...(payerData?.invoices ?? [])].map(i => [i.id, i]))
    const params = [
      aiWho?.account_id ? `account_id=${aiWho.account_id}` : null,
      aiWho?.contact_id ? `contact_id=${aiWho.contact_id}` : null,
    ].filter((p): p is string => !!p)
    for (const param of params) {
      if (missing.every(id => pool.has(id))) break
      try {
        const res = await fetch(`/api/finance/payer-invoices?feed_id=${encodeURIComponent(feed.id)}&${param}`)
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d.error || 'Could not load the suggested invoice.')
        for (const pi of (d.invoices ?? []) as PayerInvoice[]) pool.set(pi.id, pi)
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Could not load the suggested invoice.')
        return
      }
    }
    let picked = 0
    let notFound = 0
    for (const id of missing) {
      const pi = pool.get(id)
      if (!pi) { notFound++; continue }
      if (pi.claimed_by_other) {
        toast.error(`${pi.invoice_number ?? 'That invoice'} is already linked to another transaction, so it cannot be linked to this one.`)
        continue
      }
      if (!selected.has(pi.id)) toggleSelectPayerInvoice(pi)
      picked++
    }
    if (notFound > 0) toast.error('The suggested invoice could not be loaded here. Search for the company by name to find it.')
    if (picked > 0) toast.success(`Invoice selected: see the box further down, then press the link button.`)
  }
  // The AI found the payer in the CRM: the same step as picking them in the search box and pressing "Create invoice".
  const createInvoiceForExisting = (t: ExistingTarget) => {
    if (t.type === 'account') void openCreateModal({ type: 'account', id: t.id, name: t.name, status: null })
    else if (t.type === 'contact') void openCreateModal({ type: 'contact', id: t.id, name: t.name })
    else void openCreateModal({ type: 'lead', id: t.id, name: t.name })
  }
  // A payer the system already knows must never be offered as "not in the CRM": who the AI identified, or the
  // companies earlier payments from this sender were linked to.
  const payerKnown = !!existingTargetFromWho(aiWho) || (payerData?.companies?.length ?? 0) > 0

  const selectCombo = (ids: string[]) => {
    const byId = new Map((payerData?.invoices ?? []).map(i => [i.id, i]))
    for (const id of ids) {
      const pi = byId.get(id)
      if (pi && !selected.has(id)) toggleSelectPayerInvoice(pi)
    }
  }
  const payerReason = (c: PayerCompanyInfo): string => {
    const parts: string[] = []
    if (c.source === 'email') parts.push('the email on this payment belongs to a contact of this company in the CRM')
    if (c.times_linked > 0) {
      parts.push(`${c.times_linked} earlier payment${c.times_linked === 1 ? '' : 's'} from this sender ${c.times_linked === 1 ? 'was' : 'were'} linked here${c.last_linked ? ` (last ${formatCalendarDate(c.last_linked)})` : ''}`)
    }
    return parts.join(' · ')
  }

  const openCreateModal = async (r: FeedMatchResult) => {
    setCreateForResult(r)
    setCreateDescription('')
    setCreateServiceType('')
    setCreateSelectedSdId(null)
    setTargetServices([])
    // A lead has no service deliveries to attach to or create — the paid-call
    // checkbox is the only action available, so there's nothing to look up.
    if (r.type === 'lead') {
      setCreatePaidCall(true)
      return
    }
    // A person who does not exist yet has no services to attach to: only "record a service" applies.
    if (r.type === 'new_person') return
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
    // The busy guard runs FIRST. Clearing these before it meant a backdrop click
    // during a failing submit silently unticked "paid strategy call", and the
    // retry booked a service delivery + invoice instead of revenue + credit.
    if (createSubmitting) return
    setCreatePaidCall(false)
    setPaidCallRevenueOnly(false)
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
    const isPaidCall = createPaidCall && (createForResult.type === 'contact' || createForResult.type === 'lead')
    const isAttach = !isPaidCall && !!createSelectedSdId
    const description = createDescription.trim()
    const serviceType = createServiceType.trim()

    // A lead has no invoices/services of its own — the paid-call checkbox is
    // the only valid action, matching the server's own guard.
    if (createForResult.type === 'lead' && !isPaidCall) {
      toast.error('A lead can only be used to record a paid strategy call.')
      return
    }

    if (!isPaidCall && !isAttach) {
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
      // Typed `unknown`, not `string`: the paid-call flags are BOOLEANS. Sending
      // them as the text "true" made the server's check fail silently and fall
      // through to demanding a service type.
      const body: Record<string, unknown> = { feed_id: feed.id }
      if (createForResult.type === 'account') {
        body.account_id = createForResult.id
      } else if (createForResult.type === 'lead') {
        body.lead_id = createForResult.id
      } else if (createForResult.type === 'new_person') {
        body.new_contact = { full_name: createForResult.name, email: createForResult.email ?? '' }
      } else {
        body.contact_id = createForResult.id
      }
      if (storedInvestigation) body.save_story = saveStory
      if (isPaidCall) {
        body.paid_call = true
        body.paid_call_revenue_only = paidCallRevenueOnly
      } else if (isAttach) {
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
      else if (isPaidCall) toast.success(
        paidCallRevenueOnly
          ? `Paid call recorded as revenue — ${d.invoice_number ?? ''}. Nothing is deductible.`
          : `Paid call recorded — ${d.invoice_number ?? ''}. The credit will appear on their next offer.`,
      )
      else if (isAttach) toast.success(`Invoice ${d.invoice_number ?? ''} created and attached`)
      else toast.success(`Invoice ${d.invoice_number ?? ''} created and feed matched`)
      if (typeof d.story === 'string' && d.story) toast.info(d.story)
      closeCreateModal()
      setNewPersonOpen(false)
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

  // ── Link with a note — Antonio's own design (2026-09-11): pick ONE invoice,
  // write a note explaining what happened, and optionally write off whatever's
  // left so the invoice closes even though this transaction didn't cover it in
  // full (a settlement paid at less than the invoice's full total is the case
  // this exists for). Deliberately a separate, isolated action from "Match to
  // invoice" above — that flow has no concept of a note or a partial
  // settlement, and folding one into its multi-invoice waterfall logic risked
  // breaking a large, working feature. Posts to /api/finance/link-transaction.
  const [noteLinkOpen, setNoteLinkOpen] = useState(false)
  const [noteLinkQuery, setNoteLinkQuery] = useState('')
  const [noteLinkInvoiceId, setNoteLinkInvoiceId] = useState<string | null>(null)
  const [noteLinkNote, setNoteLinkNote] = useState('')
  const [noteLinkWriteOff, setNoteLinkWriteOff] = useState(false)
  const [noteLinkSubmitting, setNoteLinkSubmitting] = useState(false)
  // Already-paid invoices, searched separately from `openInvoices` (which
  // deliberately excludes them) — for connecting a transaction to an invoice
  // that was already marked paid some other way. See
  // lib/finance/owner-transaction-link.ts's isPaidInvoice branch: picking one
  // of these creates an audit-trail link, not a real payment. On-demand only
  // (Antonio: "no limit at all" on reach, but never loaded until searched).
  const [noteLinkPaidResults, setNoteLinkPaidResults] = useState<OpenInvoice[]>([])
  const [noteLinkPaidLoading, setNoteLinkPaidLoading] = useState(false)
  const [noteLinkPaidError, setNoteLinkPaidError] = useState<string | null>(null)
  // The first already-paid invoice picked, kept as a snapshot (the paid search results are replaced
  // by every new search, so looking it up there again would lose it), and the OTHER already-paid
  // invoices this same payment also settled — one payment can pay several invoices
  // (lib/finance/multi-invoice-link.ts). Audit-only: no money moves.
  const [noteLinkPicked, setNoteLinkPicked] = useState<OpenInvoice | null>(null)
  const [noteLinkExtras, setNoteLinkExtras] = useState<OpenInvoice[]>([])
  const [noteLinkExtraQuery, setNoteLinkExtraQuery] = useState('')

  const closeNoteLink = () => {
    if (noteLinkSubmitting) return
    setNoteLinkOpen(false)
    setNoteLinkQuery('')
    setNoteLinkInvoiceId(null)
    setNoteLinkNote('')
    setNoteLinkWriteOff(false)
    setNoteLinkPaidResults([])
    setNoteLinkPaidError(null)
    setNoteLinkPicked(null)
    setNoteLinkExtras([])
    setNoteLinkExtraQuery('')
  }

  // Reports open/closed to the parent so it can disable "Sync All Banks Now"
  // while this box is open. The cleanup fires on every change AND on real
  // unmount, so if this row disappears out from under an open box (the exact
  // failure being guarded against) the parent still hears "closed" and never
  // gets stuck with the sync button disabled forever.
  useEffect(() => {
    onNoteLinkOpenChange?.(feed.id, noteLinkOpen)
    return () => onNoteLinkOpenChange?.(feed.id, false)
  }, [noteLinkOpen, feed.id, onNoteLinkOpenChange])

  const noteLinkQueryLower = noteLinkQuery.trim().toLowerCase()
  // While no invoice is picked the main box searches; once one is picked the "also paid" box does.
  const noteLinkSearchTerm = (noteLinkInvoiceId ? noteLinkExtraQuery : noteLinkQuery).trim().toLowerCase()
  // Unlike `suggestions` below (amount-tolerance gated), this searches ALL open
  // invoices — the whole point of this popup is linking a payment that does
  // NOT match an invoice's amount (that's what "write off the difference" is for).
  const noteLinkCandidates = (
    noteLinkQueryLower.length === 0
      ? openInvoices
      : openInvoices.filter(inv =>
          invoicePartyName(inv).toLowerCase().includes(noteLinkQueryLower) ||
          (inv.invoice_number ?? '').toLowerCase().includes(noteLinkQueryLower),
        )
  ).slice(0, 20)

  // Same query, also searched against already-Paid invoices — debounced and
  // gated at 2 chars to match the endpoint's own floor, so this never fires
  // while the box is empty. Cancels its own stale response via the `cancelled`
  // flag, same pattern as any other debounced-search effect in this codebase.
  useEffect(() => {
    if (!noteLinkOpen || noteLinkSearchTerm.length < 2) {
      setNoteLinkPaidResults([])
      setNoteLinkPaidError(null)
      return
    }
    let cancelled = false
    setNoteLinkPaidLoading(true)
    const timer = setTimeout(() => {
      fetch(`/api/finance/search-paid-invoices?q=${encodeURIComponent(noteLinkSearchTerm)}`)
        .then(async res => {
          const d = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(d.error || `Search failed (${res.status})`)
          if (!cancelled) { setNoteLinkPaidResults(d.invoices ?? []); setNoteLinkPaidError(null) }
        })
        .catch(err => {
          if (!cancelled) {
            setNoteLinkPaidResults([])
            setNoteLinkPaidError(err instanceof Error && err.message ? err.message : 'Search failed — try again.')
          }
        })
        .finally(() => { if (!cancelled) setNoteLinkPaidLoading(false) })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [noteLinkOpen, noteLinkSearchTerm])

  const noteLinkSelected = openInvoices.find(inv => inv.id === noteLinkInvoiceId)
    ?? (noteLinkPicked?.id === noteLinkInvoiceId ? noteLinkPicked : null)
    ?? noteLinkPaidResults.find(inv => inv.id === noteLinkInvoiceId)
    ?? null
  // Selected but not in the open list → it came from the paid search. Governs
  // which explanation/UI shows below (an audit-link has no balance to write
  // off — the invoice is already closed).
  const noteLinkSelectedIsPaidPick = noteLinkSelected != null && !openInvoices.some(inv => inv.id === noteLinkInvoiceId)
  const noteLinkSelectedDue = noteLinkSelected
    ? Number(noteLinkSelected.amount_due ?? noteLinkSelected.total ?? noteLinkSelected.amount ?? 0)
    : 0
  // Several already-paid invoices for this one payment: how they add up against it.
  const noteLinkAllPaid = noteLinkSelected != null && noteLinkSelectedIsPaidPick ? [noteLinkSelected, ...noteLinkExtras] : []
  const noteLinkSummary = summarizeMultiLink(
    amount,
    noteLinkAllPaid.map(inv => Number(inv.total ?? inv.amount ?? 0)),
  )

  const submitNoteLink = async () => {
    if (!noteLinkInvoiceId) { toast.error('Pick which invoice this pays first'); return }
    if (!noteLinkNote.trim()) { toast.error('Write a note explaining this'); return }
    setNoteLinkSubmitting(true)
    try {
      const res = await fetch('/api/finance/link-transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feed_id: feed.id,
          ...(noteLinkExtras.length > 0
            ? { payment_ids: [noteLinkInvoiceId, ...noteLinkExtras.map(inv => inv.id)] }
            : { payment_id: noteLinkInvoiceId }),
          note: noteLinkNote.trim(),
          write_off_remaining: noteLinkWriteOff,
          ...(storedInvestigation ? { save_story: saveStory } : {}),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.ok === false) throw new Error(d.error || `Request failed (${res.status})`)
      // Read the server's own auditLink flag, not this component's pre-submit guess
      // (noteLinkSelectedIsPaidPick) — that guess is derived from props that can go
      // stale between opening this popup and submitting it (the invoice's real status
      // may have changed elsewhere in the meantime), and the server always re-reads
      // the invoice fresh at the moment it decides which branch actually ran.
      if (d.multi === true) {
        const numbers = Array.isArray(d.invoiceNumbers) ? d.invoiceNumbers.join(', ') : 'the invoices'
        const diff = Number(d.difference ?? 0)
        toast.success(
          `Linked ${numbers} to this payment for the record — they were already paid, no money applied.` +
            (Math.abs(diff) >= 0.005 ? ` The invoices add up to ${formatCurrency(Number(d.linkedTotal ?? 0), feed.currency)}, ${formatCurrency(Math.abs(diff), feed.currency)} ${diff > 0 ? 'less' : 'more'} than the payment.` : ''),
        )
      } else toast.success(
        d.auditLink === true
          ? `Linked to ${d.invoiceNumber ?? 'the invoice'} for the record — it was already paid, no money applied.`
          : d.newStatus === 'Paid'
            ? `Linked to ${d.invoiceNumber ?? 'the invoice'} — closed as paid.`
            : `Linked to ${d.invoiceNumber ?? 'the invoice'}.`,
      )
      if (typeof d.story === 'string' && d.story) toast.info(d.story)
      closeNoteLink()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not link this transaction.')
    } finally {
      setNoteLinkSubmitting(false)
    }
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
      const companyName = (getCompanyName(inv.accounts) || '')
      // ⛔ THE SAME NAME RULE THE SERVER USES (2026-07-29). This had its own THIRD copy of the
      // logic — a shorter stop-word list and a SUBSTRING test — so on the very transaction the
      // server had just refused to settle, this screen would badge BOTH companies with a green
      // "name" match, ranked by a rule the server had stopped trusting. Sending a human to a
      // screen that repeats the machine's mistake is not a fix.
      const nameEvidence = evaluateNameEvidence(companyName, [feedTextLower])
      const nameMatch = nameEvidence.sufficient
      const namePartial = nameEvidence.weak
      // Check if invoice number appears in memo
      const invNum = (inv.invoice_number || '').toLowerCase()
      const invRefMatch = invNum && feedTextLower.includes(invNum)
      // Score: inv ref > name match > amount-only
      // A partial name hit is real but weak evidence — it ranks above amount-only and well
      // below a covered name, instead of being scored identically to it.
      const score =
        (invRefMatch ? 200 : 0) + (nameMatch ? 100 : namePartial ? 25 : 0) + (diff < 1 ? 50 : 0) + (1000 / (diff + 1))
      return { ...inv, score, nameMatch, namePartial, invRefMatch }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
          {sourceLabel(feed)}
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
          {!isMatching && !noteLinkOpen ? (
            <>
              {isAdmin && <ClaimForOwnerButton feedId={feed.id} />}
              <FastTooltip label="Match to invoice">
                <button onClick={onStartMatch} className="p-1 rounded hover:bg-blue-50 text-blue-500" aria-label="Match to invoice" disabled={isPending}>
                  <Link2 className="h-4 w-4" />
                </button>
              </FastTooltip>
              <FastTooltip label={refundedOrDisputed ? 'Refunded or disputed — this money is not real, do not link it' : 'Link with a note — pick invoice, explain, write off if needed'}>
                <button
                  onClick={() => setNoteLinkOpen(true)}
                  className="p-1 rounded hover:bg-teal-50 text-teal-600 disabled:opacity-40 disabled:hover:bg-transparent"
                  aria-label="Link with a note"
                  disabled={isPending || refundedOrDisputed}
                >
                  <StickyNote className="h-4 w-4" />
                </button>
              </FastTooltip>
              <FastTooltip label="Ignore">
                <button onClick={handleIgnore} className="p-1 rounded hover:bg-zinc-100 text-zinc-400" aria-label="Ignore" disabled={isPending}>
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                </button>
              </FastTooltip>
            </>
          ) : (
            <FastTooltip label="Cancel">
              <button onClick={isMatching ? onCancelMatch : closeNoteLink} className="p-1 rounded hover:bg-zinc-100 text-zinc-500" aria-label="Cancel">
                <X className="h-4 w-4" />
              </button>
            </FastTooltip>
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

      {/* CONTESTED — several invoices fitted equally well, so nothing was applied. This block
          must come BEFORE the ordinary candidate banner: the pinned candidate below is only the
          first of the tied set, and in the incident that produced this guard it was the wrong
          company. Stacks vertically so it stays readable on a ~380px phone. */}
      {contested.length > 1 && (
        <div className="px-4 pb-3">
          <div className="border-2 border-orange-400 bg-orange-50 rounded-md p-3 space-y-2">
            <div className="flex items-start gap-2 text-xs text-orange-900">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>
                <span className="font-bold">
                  {contestedTotal > contested.length
                    ? `${contestedTotal} INVOICES FIT THIS PAYMENT EQUALLY WELL.`
                    : 'MORE THAN ONE INVOICE FITS THIS PAYMENT.'}
                </span>{' '}
                Nothing has been applied. The evidence on this transaction cannot say which of
                these it settles — choose deliberately, or leave it if you are not sure.
                {contestedTotal > contested.length && ` Showing ${contested.length} of ${contestedTotal}.`}
              </p>
            </div>
            <ul className="space-y-1">
              {contested.map((c) => {
                const detail = feed.contested_details?.[c.payment_id]
                const facts = detail ? contestedInvoiceFacts(detail) : null
                return (
                  <li
                    key={c.payment_id}
                    className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 text-xs bg-white border border-orange-200 rounded px-2 py-1.5"
                  >
                    <span className="font-mono font-medium">{c.invoice_number ?? 'no number'}</span>
                    <span className="font-medium text-zinc-800">{c.client_name ?? 'unknown client'}</span>
                    {facts && (
                      <span className="text-zinc-700">
                        {[facts.what, facts.amount, facts.state].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground sm:ml-auto">
                      equally scored ({c.confidence})
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="text-[11px] text-orange-900">
              To pick the right invoice, click the green note icon above (&quot;Link with a note&quot;) — it
              finds paid and open invoices. If the payment carries an invoice number, that is the
              only thing that can settle this for certain.
            </p>
          </div>
        </div>
      )}

      {/* Auto-matched candidate banner — shown only when feed.status='needs_review' */}
      {candidateInfo && contested.length <= 1 && (
        <div className="px-4 pb-3">
          <div className="border border-amber-300 bg-amber-50 rounded-md p-3 space-y-2">
            <div className="flex items-start gap-2 text-xs text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <p>
                <span className="font-semibold">Auto-matched candidate:</span>{' '}
                {candidateInfo.summary ? (
                  <InvoiceNumberTip summary={candidateInfo.summary}>
                    <span className="font-mono">{candidateInfo.invoice_number ?? '—'}</span>
                  </InvoiceNumberTip>
                ) : (
                  <span className="font-mono">{candidateInfo.invoice_number ?? '—'}</span>
                )}
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
          {/* ── What is this payment? — an AI reads the CRM and both mailboxes (owner runs it) ── */}
          <PaymentInvestigationPanel
            feedId={feed.id}
            stored={storedInvestigation}
            isOwner={isOwner}
            knownInvoices={openInvoices}
            saveStory={saveStory}
            onSaveStoryChange={setSaveStory}
            onCreateNewPerson={openNewPerson}
            onCreateInvoiceForExisting={createInvoiceForExisting}
            onSelectInvoices={selectSuggestedInvoices}
            onResolved={setAiWho}
          />

          {/* ── From who paid ────────────────────────────────────────
              The company the billing email belongs to in the CRM, and the companies earlier payments
              from this sender were linked to — every invoice (paid and unpaid) and any set that adds
              up to this payment exactly. Suggestions only: nothing here links by itself. */}
          {(payerLoading || payerError || (payerData?.companies?.length ?? 0) > 0) && (
            <div className="rounded-md border border-blue-200 bg-blue-50/40 p-2.5 space-y-2">
              <p className="text-xs font-semibold text-blue-900">From who paid</p>
              {payerLoading && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Looking up who paid…
                </p>
              )}
              {payerError && <p className="text-xs text-amber-700">{payerError}</p>}
              {(payerData?.companies ?? []).map(c => (
                <p key={`${c.kind}-${c.id}`} className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-zinc-800">{c.name}</span>
                  {payerReason(c) ? ` — ${payerReason(c)}` : ''}
                </p>
              ))}
              {(payerData?.companies?.length ?? 0) > 1 && (
                <p className="text-[11px] text-amber-700">More than one company fits — check each invoice is the right company&apos;s before linking.</p>
              )}
              {(payerData?.combos ?? []).map(combo => {
                const byId = new Map((payerData?.invoices ?? []).map(i => [i.id, i]))
                const members = combo.ids.map(id => byId.get(id)).filter((i): i is PayerInvoice => !!i)
                if (members.length !== combo.ids.length) return null
                const allSelected = members.every(m => selected.has(m.id))
                return (
                  <button
                    key={combo.ids.join('|')}
                    type="button"
                    onClick={() => selectCombo(combo.ids)}
                    disabled={isPending || allSelected}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-left disabled:opacity-60"
                  >
                    <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    <span className="font-mono text-blue-700 flex items-center gap-1">
                      {members.map((m, i) => (
                        <span key={m.id} className="flex items-center gap-1">
                          {i > 0 && <span>+</span>}
                          <InvoiceNumberTip summary={summaryInputFromPayerInvoice(m)}>
                            <span>{m.invoice_number ?? 'no number'}</span>
                          </InvoiceNumberTip>
                        </span>
                      ))}
                    </span>
                    <span className="flex-1 text-emerald-800">
                      {members.length === 1 ? 'is exactly' : 'add up to exactly'} {formatCurrency(combo.total, feed.currency)}
                      {combo.dates_match ? ' — paid around the date of this payment' : ''}
                    </span>
                    <span className="font-medium text-emerald-700 shrink-0">{allSelected ? 'Selected' : 'Select these'}</span>
                  </button>
                )
              })}
              {(payerData?.invoices?.length ?? 0) > 0 && (
                <div className="border rounded-md bg-white divide-y max-h-56 overflow-y-auto">
                  {(payerData?.invoices ?? []).map(inv => (
                    <PayerInvoiceRow
                      key={inv.id}
                      inv={inv}
                      checked={selected.has(inv.id)}
                      onToggle={() => toggleSelectPayerInvoice(inv)}
                      disabled={isPending}
                      showParty={(payerData?.companies?.length ?? 0) > 1}
                    />
                  ))}
                </div>
              )}
              {payerData?.truncated && (
                <p className="text-[11px] text-muted-foreground">Showing the most recent invoices — search below to find older ones.</p>
              )}
            </div>
          )}

          {/* ── Already-paid invoices of exactly this amount ───────────
              Whoever they belong to: this works when nobody knows who paid. Paid within 3 days of the payment (a
              link widens it to 30), no OTHER bank payment tied to them. Only the amount and the date match, so the
              box says it is not proof — nothing here links by itself, and ticking a row joins the same "link for the
              record" selection as the lists above. Hidden when everything it found is already listed above. */}
          {(() => {
            const data = sameAmount.data
            if (sameAmount.state === 'error') {
              return <p className="text-[11px] text-muted-foreground">Could not look for already-paid invoices of this amount just now.</p>
            }
            if (sameAmount.state === 'loading' && !data) {
              return sameAmount.days > SAME_AMOUNT_DAYS ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Looking wider…
                </p>
              ) : null
            }
            if (!data || !data.ok || data.searched === false) return null
            const days = data.days ?? sameAmount.days
            const amountText = formatCurrency(amount, feed.currency)
            const shown = dropAlreadyShown(data.invoices ?? [], new Set((payerData?.invoices ?? []).map(i => i.id)), candidateInfo?.invoice_number)
            const hiddenElsewhere = (data.invoices?.length ?? 0) - shown.length
            if (hiddenElsewhere > 0 && shown.length === 0) return null
            const found = Math.max((data.found ?? 0) - hiddenElsewhere, 0)
            const tied = sameAmountTiedText(data.already_tied ?? 0)
            const lookWider = days < SAME_AMOUNT_WIDER_DAYS ? (
              <button type="button" onClick={() => loadSameAmount(SAME_AMOUNT_WIDER_DAYS)} className="text-[11px] text-blue-700 hover:underline">
                Look wider ({SAME_AMOUNT_WIDER_DAYS} days)
              </button>
            ) : null
            if (shown.length === 0) {
              return (
                <p className="text-[11px] text-muted-foreground" data-testid="same-amount-empty">
                  {sameAmountEmptyText(days, amountText)} {tied && <>{tied} </>}{lookWider}
                </p>
              )
            }
            return (
              <div className="rounded-md border border-emerald-200 bg-emerald-50/30 p-2.5 space-y-2" data-testid="same-amount-paid-box">
                <p className="text-xs font-semibold text-emerald-900">{sameAmountHeadline(found, days, amountText)}</p>
                <div className="border rounded-md bg-white divide-y max-h-56 overflow-y-auto">
                  {shown.map(inv => (
                    <PayerInvoiceRow
                      key={inv.id}
                      inv={inv}
                      checked={selected.has(inv.id)}
                      onToggle={() => toggleSelectPayerInvoice(inv)}
                      disabled={isPending}
                      showParty
                      note={dayOffsetText(inv.days_from_payment)}
                    />
                  ))}
                </div>
                {found > shown.length && (
                  <p className="text-[11px] text-muted-foreground">and {found - shown.length} more not shown — search by company or person below to narrow it down.</p>
                )}
                {tied && <p className="text-[11px] text-muted-foreground">{tied}</p>}
                <p className="text-[11px] text-muted-foreground">{SAME_AMOUNT_CAUTION}</p>
                {lookWider}
              </div>
            )
          })()}

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
                  // A lead has no invoices of its own yet — it's not a
                  // matchable target, only a paid-call recording target.
                  const matchingInvoices = r.type === 'account'
                    ? openInvoices.filter(inv => inv.account_id === r.id)
                    : r.type === 'contact'
                      ? openInvoices.filter(inv => inv.contact_id === r.id)
                      : []
                  return (
                    <div key={`${r.type}-${r.id}`} className="border rounded-md overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 text-xs">
                        {r.type === 'account' ? (
                          <Building2 className="h-3 w-3 text-blue-600 shrink-0" />
                        ) : (
                          <User className={cn("h-3 w-3 shrink-0", r.type === 'lead' ? "text-amber-600" : "text-purple-600")} />
                        )}
                        <span className="font-medium truncate flex-1">{r.name}</span>
                        {r.type === 'account' && r.contact_name && (
                          <span className="text-[10px] text-muted-foreground truncate">via {r.contact_name}</span>
                        )}
                        {r.type === 'lead' && (
                          <span className="text-[10px] bg-amber-100 text-amber-700 px-1 py-0.5 rounded shrink-0">Lead — not a client yet</span>
                        )}
                        <button
                          type="button"
                          onClick={() => openCreateModal(r)}
                          className="text-[11px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
                        >
                          {r.type === 'lead' ? '+ Record paid call' : '+ Create invoice from this feed'}
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
                                <InvoiceNumberTip summary={summaryInputFromOpenInvoice(inv, invoicePartyName(inv))}><span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span></InvoiceNumberTip>
                                <span className="truncate flex-1 text-left">{inv.description ?? ''}</span>
                                <span className="font-medium">{formatCurrency(invAmount, inv.amount_currency)}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {r.type !== 'lead' && (() => {
                        const paidState = paidByResult[`${r.type}-${r.id}`]
                        return (
                          <div className="border-t px-3 py-1.5">
                            {!paidState ? (
                              <button type="button" onClick={() => loadPaidFor(r)} className="text-[11px] text-blue-600 hover:underline">
                                Show already-paid invoices
                              </button>
                            ) : paidState.state === 'loading' ? (
                              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                                <Loader2 className="h-3 w-3 animate-spin" /> Loading paid invoices…
                              </p>
                            ) : paidState.state === 'error' ? (
                              <p className="text-[11px] text-red-600">{paidState.error}</p>
                            ) : paidState.invoices.length === 0 ? (
                              <p className="text-[11px] text-muted-foreground">No already-paid invoices.</p>
                            ) : (
                              <div className="divide-y -mx-3">
                                {paidState.invoices.map(inv => (
                                  <PayerInvoiceRow
                                    key={inv.id}
                                    inv={inv}
                                    checked={selected.has(inv.id)}
                                    onToggle={() => toggleSelectPayerInvoice(inv)}
                                    disabled={isPending}
                                    showParty={false}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── Payer not in the CRM: create a plain person + invoice ──────────────────────────
              Antonio, 2026-10-30: "I want a system that I can invoice for someone that is not a client,
              that is not a lead." The search above can only find who already exists. */}
          {!newPersonOpen && payerKnown ? (
            // The payer is already in the CRM (the AI found them, or earlier payments from this sender went to
            // them): the big "new person" prompt would contradict that. It stays one click away for the rare
            // case where the CRM match is someone else with the same name.
            <p className="text-[11px] text-zinc-500 px-1" data-testid="not-them-link">
              Not them?{' '}
              <button type="button" onClick={() => openNewPerson()} className="underline hover:text-zinc-800">
                The payer is someone who is not in the CRM
              </button>
            </p>
          ) : !newPersonOpen ? (
            <div className={cn(
              'rounded-md px-3 py-2 text-xs flex items-center gap-2',
              searchQuery.trim().length >= 2 && searchResults.length === 0 && !searchLoading ? 'border border-emerald-300 bg-emerald-50' : 'border border-dashed border-zinc-300',
            )}>
              <span className="text-zinc-700 flex-1">
                {searchQuery.trim().length >= 2 && searchResults.length === 0 && !searchLoading
                  ? 'Nobody found. Is the payer someone who is not in the CRM?'
                  : 'The payer is not in the CRM (not a client, not a lead)?'}
              </span>
              <button
                type="button"
                onClick={() => openNewPerson()}
                className="text-[11px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
              >
                Create a new person + invoice
              </button>
            </div>
          ) : (
            <div className="rounded-md border border-emerald-300 bg-emerald-50/50 p-3 space-y-2" data-testid="new-person-card">
              <p className="text-xs font-semibold text-emerald-900">New person for this payment</p>
              <p className="text-[11px] text-zinc-600">
                Created as a plain contact: not a client, not a lead, no portal access, nothing emailed. If they are already in the CRM you will be told who.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Name</label>
                  <input
                    value={newPersonName}
                    onChange={e => setNewPersonName(e.target.value)}
                    placeholder="First and last name"
                    className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Email (optional)</label>
                  <input
                    value={newPersonEmail}
                    onChange={e => setNewPersonEmail(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setNewPersonOpen(false)} className="px-3 py-1.5 text-xs rounded-md border border-zinc-200 text-zinc-700 hover:bg-zinc-50">
                  Cancel
                </button>
                <button type="button" onClick={continueWithNewPerson} className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
                  Continue
                </button>
              </div>
            </div>
          )}

          <div className="border-t pt-2">
            <p className="text-xs text-muted-foreground mb-2">Invoices with a similar amount. Amount only: nothing here says they belong to this payer, so check before picking:</p>
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
                    <InvoiceNumberTip summary={summaryInputFromOpenInvoice(inv, invoicePartyName(inv))}><span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span></InvoiceNumberTip>
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
                    ) : inv.namePartial ? (
                      // Amber, and it says PARTIAL: half a company name is a hint, not proof of
                      // who paid. A green "name" badge here is what made the wrong company look
                      // confirmed on the screen the server had just refused to settle.
                      <span className="text-amber-600">partial name</span>
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
                      <InvoiceNumberTip summary={summaryInputFromOpenInvoice(inv, invoicePartyName(inv))}><span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span></InvoiceNumberTip>
                      <span className="truncate flex-1">{invoicePartyName(inv)}</span>
                      <span className="font-medium">{formatCurrency(Number(inv.total ?? inv.amount), inv.amount_currency)}</span>
                    </button>
                  ))}
              </div>
            </details>
          )}
          </div>

          {/* Selection tray — one payment → several invoices (persists across searches).
              Unpaid invoices: the payment is applied to them. Already-paid invoices: the payment is
              only linked to them for the record. One payment does one or the other, not both. */}
          {selected.size > 0 && (
            <div className="sticky bottom-0 -mx-4 border-t bg-white px-4 pt-2">
              <div className="rounded-md border border-blue-300 bg-blue-50 p-2 space-y-1.5">
                {mixedSelection ? (
                  <>
                    <p className="text-xs font-semibold text-blue-900">Selected ({selected.size})</p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {selectedArr.map(s => (
                        <div key={s.id} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-blue-600">{s.invoice_number ?? '—'}</span>
                          <span className="truncate flex-1">{s.party}</span>
                          <span className={cn('rounded px-1 text-[10px] font-medium', s.paid ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700')}>
                            {s.paid ? 'already paid' : 'unpaid'}
                          </span>
                      <FastTooltip label="Remove">
                        <button type="button" onClick={() => removeSelect(s.id)} className="p-0.5 rounded hover:bg-blue-100 text-blue-500" aria-label="Remove">
                          <X className="h-3 w-3" />
                        </button>
                      </FastTooltip>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-amber-700">
                      ⚠ You ticked invoices that are already paid together with invoices that are still owed. One payment can&apos;t do both at once.
                      Keep only the already-paid ones to link this payment to them for the record (no money moves), or only the unpaid ones to apply the payment to them.
                    </p>
                  </>
                ) : recordOnlyMode ? (
                  <>
                    <p className="text-xs font-semibold text-blue-900">
                      Link this payment to {paidSelected.length === 1 ? 'this already-paid invoice' : `${paidSelected.length} already-paid invoices`} — for the record, no money moves
                    </p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {paidSelected.map(s => (
                        <div key={s.id} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-blue-600">{s.invoice_number ?? '—'}</span>
                          <span className="truncate flex-1">{s.party}</span>
                          <span className="text-[10px] text-green-700">{s.paidDate ? `paid ${formatCalendarDate(s.paidDate)}` : 'paid'}</span>
                          <span className="font-medium tabular-nums">{formatCurrency(s.appliedAmount, s.currency)}</span>
                      <FastTooltip label="Remove">
                        <button type="button" onClick={() => removeSelect(s.id)} className="p-0.5 rounded hover:bg-blue-100 text-blue-500" aria-label="Remove">
                          <X className="h-3 w-3" />
                        </button>
                      </FastTooltip>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between border-t border-blue-200 pt-1 text-xs">
                      <span className="text-blue-900">Invoices total / payment</span>
                      <span className={cn('font-semibold tabular-nums', paidSummary.matches ? 'text-emerald-700' : 'text-amber-700')}>
                        {formatCurrency(paidSummary.linkedTotal, feed.currency)} / {formatCurrency(amount, feed.currency)}
                      </span>
                    </div>
                    {!paidSummary.matches && paidSelected.length > 1 && (
                      <p className="text-[11px] text-amber-700">
                        ⚠ These invoices add up to {formatCurrency(Math.abs(paidSummary.difference), feed.currency)} {paidSummary.difference > 0 ? 'less' : 'more'} than the payment. You can still link them — the invoices are not changed, they only get a note.
                      </p>
                    )}
                    {paidSelected.length > MAX_LINKED_INVOICES && (
                      <p className="text-[11px] text-red-600">A payment can be linked to at most {MAX_LINKED_INVOICES} invoices at once.</p>
                    )}
                    {paidSelected.length > 1 && (
                      <input
                        type="text"
                        value={recordNote}
                        onChange={e => setRecordNote(e.target.value)}
                        placeholder={recordNotePlaceholder}
                        aria-label="Note added to each invoice (optional)"
                        className="w-full px-2 py-1 text-xs border rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                      />
                    )}
                    <button
                      type="button"
                      onClick={handleMatchSelected}
                      disabled={isPending || paidSelected.length > MAX_LINKED_INVOICES}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      {paidSelected.length === 1 ? 'Link to this paid invoice' : `Link to ${paidSelected.length} paid invoices`}
                    </button>
                  </>
                ) : (
                  <>
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
                      <FastTooltip label="Remove">
                        <button type="button" onClick={() => removeSelect(s.id)} className="p-0.5 rounded hover:bg-blue-100 text-blue-500" aria-label="Remove">
                          <X className="h-3 w-3" />
                        </button>
                      </FastTooltip>
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
                  </>
                )}
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
              {createForResult.type === 'new_person' && (
                <p className="text-[11px] text-zinc-500 mt-1">
                  New person, not in the CRM yet. They are created as a plain contact (not a client, not a lead) when you press Create invoice. Nothing is emailed to them.
                </p>
              )}
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

            {/* Branch A — attach to existing active SD. Never for a lead: they
                have no services yet by definition, and the only valid action
                for a lead target is the paid-call checkbox below. */}
            {createForResult?.type !== 'lead' && createForResult?.type !== 'new_person' && (loadingTargetServices ? (
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
            ))}

            {/* Branch C — WS-A: this was a PAID STRATEGY CALL ─────────
                For a PERSON — a contact, or a lead who hasn't become a
                client yet: the credit is person-scoped by design, so a
                company's renewal can never eat someone's call fee. */}
            {(createForResult?.type === 'contact' || createForResult?.type === 'lead') && (
              <div className="border-t pt-3 space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createPaidCall}
                    onChange={e => setCreatePaidCall(e.target.checked)}
                    // A lead has nothing else this modal can do — locked on
                    // rather than letting the user uncheck into a dead end.
                    disabled={createSubmitting || createForResult?.type === 'lead'}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-zinc-800">
                    This was a <strong>paid strategy call</strong>
                    <span className="block text-[11px] text-zinc-500">
                      {createForResult?.type === 'lead'
                        ? "Records the revenue and gives them a credit toward their next purchase — they stay a lead until they actually sign and pay for a real service."
                        : "Records the revenue and gives them a credit toward their next purchase — the same as when the system recognises the booking itself."}
                    </span>
                  </span>
                </label>
                {createPaidCall && (
                  <div className="ml-6 space-y-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={paidCallRevenueOnly}
                        onChange={e => setPaidCallRevenueOnly(e.target.checked)}
                        disabled={createSubmitting}
                        className="mt-0.5"
                      />
                      <span className="text-xs text-amber-900">
                        They will <strong>not</strong> be buying — keep it as revenue only
                        <span className="block text-[11px] text-amber-800">
                          The call still shows in their history, but nothing is deductible.
                        </span>
                      </span>
                    </label>
                    <p className="text-[11px] text-amber-800">
                      You are naming this person yourself — nothing else confirms it. If it is the
                      wrong person they get credit they did not pay for. Cancel the credit note to undo.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Branch B — create a new backfilled SD ──────────────────
                Hidden for a paid call: it is not a service, so asking for a
                service type is both wrong and (as Antonio hit) confusing. */}
            <div className={`border-t pt-3 space-y-2 ${createPaidCall ? 'hidden' : ''}`}>
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
                  {/* "Annual Renewal" stays in VALID_SERVICE_TYPES (it mirrors
                      the DB constraint, for historical rows) but is retired
                      as a real deliverable (R106) — the backend now refuses
                      to create one, so don't offer a choice that always fails
                      (2026-08-27, dev job bb48eba1). */}
                  {VALID_SERVICE_TYPES.filter(t => t !== 'Annual Renewal').map(t => (
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
                disabled={createSubmitting || (!createPaidCall && !createSelectedSdId && !createServiceType.trim())}
                className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {createSubmitting && <Loader2 className="h-3 w-3 animate-spin" />}
                {createSelectedSdId ? 'Attach payment' : 'Create invoice'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* "Link with a note" popup — Antonio: pick the invoice, check the
          transaction, write the note, write off the difference. Lives here in
          Finance, not in My Finances — the owner-side button there only sends
          the transaction over; this is where it actually gets tied to an
          invoice. */}
      {noteLinkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeNoteLink}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">Link with a note</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                {formatCurrency(amount, feed.currency)} from {feed.sender_name || 'this transaction'} on {formatDate(feed.transaction_date)}
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Invoice</label>
              {noteLinkSelected ? (
                <div className={cn(
                  'flex items-center gap-2 border rounded-md px-3 py-2 text-xs',
                  noteLinkSelectedIsPaidPick ? 'border-amber-300 bg-amber-50' : 'border-blue-300 bg-blue-50',
                )}>
                  <span className={cn('font-mono', noteLinkSelectedIsPaidPick ? 'text-amber-700' : 'text-blue-700')}>{noteLinkSelected.invoice_number ?? '—'}</span>
                  <span className="truncate flex-1">{invoicePartyName(noteLinkSelected)}</span>
                  {noteLinkSelectedIsPaidPick ? (
                    <>
                      <span className="font-medium">{formatCurrency(noteLinkSelected.total ?? noteLinkSelected.amount, noteLinkSelected.amount_currency)}</span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">Paid</span>
                    </>
                  ) : (
                    <span className="font-medium">{formatCurrency(noteLinkSelectedDue, noteLinkSelected.amount_currency)} due</span>
                  )}
                  <FastTooltip label="Change invoice">
                    <button
                      type="button"
                      onClick={() => { setNoteLinkInvoiceId(null); setNoteLinkWriteOff(false); setNoteLinkPicked(null); setNoteLinkExtras([]); setNoteLinkExtraQuery('') }}
                      disabled={noteLinkSubmitting}
                      className={cn('p-0.5 rounded', noteLinkSelectedIsPaidPick ? 'hover:bg-amber-100 text-amber-500' : 'hover:bg-blue-100 text-blue-500')}
                      aria-label="Change invoice"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </FastTooltip>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      autoFocus
                      placeholder="Invoice number or client name…"
                      value={noteLinkQuery}
                      onChange={e => setNoteLinkQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                  </div>
                  <div className="mt-1.5 space-y-1 max-h-48 overflow-y-auto">
                    {noteLinkCandidates.length === 0 && noteLinkPaidResults.length === 0 && !noteLinkPaidLoading && !noteLinkPaidError ? (
                      <p className="text-xs text-muted-foreground px-1 py-1">No invoices match.</p>
                    ) : (
                      <>
                        {noteLinkCandidates.map(inv => {
                          const due = Number(inv.amount_due ?? inv.total ?? inv.amount ?? 0)
                          return (
                            <button
                              key={inv.id}
                              type="button"
                              onClick={() => setNoteLinkInvoiceId(inv.id)}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border hover:bg-blue-50 hover:border-blue-200 transition-colors"
                            >
                              <InvoiceNumberTip summary={summaryInputFromOpenInvoice(inv, invoicePartyName(inv))}><span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span></InvoiceNumberTip>
                              <span className="truncate flex-1 text-left">{invoicePartyName(inv)}</span>
                              {inv.invoice_status === 'Partial' && (
                                <span className="text-[10px] bg-orange-100 text-orange-700 px-1 py-0.5 rounded">Partial</span>
                              )}
                              <span className="font-medium">{formatCurrency(due, inv.amount_currency)}</span>
                            </button>
                          )
                        })}
                        {noteLinkQueryLower.length >= 2 && (noteLinkPaidResults.length > 0 || noteLinkPaidLoading || noteLinkPaidError) && (
                          <>
                            <p className="text-[10px] text-muted-foreground px-1 pt-1.5 uppercase tracking-wide">
                              Already paid — link for the record only
                            </p>
                            {noteLinkPaidLoading && noteLinkPaidResults.length === 0 && (
                              <p className="text-xs text-muted-foreground px-1 py-1 flex items-center gap-1.5">
                                <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                              </p>
                            )}
                            {noteLinkPaidError && !noteLinkPaidLoading && (
                              <p className="text-xs text-red-600 px-1 py-1">{noteLinkPaidError}</p>
                            )}
                            {noteLinkPaidResults.map(inv => (
                              <button
                                key={inv.id}
                                type="button"
                                onClick={() => { setNoteLinkInvoiceId(inv.id); setNoteLinkPicked(inv); setNoteLinkExtras([]); setNoteLinkExtraQuery('') }}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border hover:bg-amber-50 hover:border-amber-200 transition-colors"
                              >
                                <InvoiceNumberTip summary={summaryInputFromOpenInvoice(inv, invoicePartyName(inv))}><span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span></InvoiceNumberTip>
                                <span className="truncate flex-1 text-left">{invoicePartyName(inv)}</span>
                                <span className="font-medium">{formatCurrency(inv.total ?? inv.amount, inv.amount_currency)}</span>
                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">Paid</span>
                              </button>
                            ))}
                          </>
                        )}
                      </>
                    )}
                  </div>
                  {noteLinkQueryLower.length === 0 && openInvoices.length > noteLinkCandidates.length && (
                    <p className="text-[11px] text-muted-foreground">Showing {noteLinkCandidates.length} of {openInvoices.length} — type to narrow.</p>
                  )}
                </>
              )}

              {/* One payment can pay SEVERAL invoices. Once an already-paid invoice is picked, more can be
                  added here, with a running total against the payment. Audit-only: no money moves. */}
              {noteLinkSelected && noteLinkSelectedIsPaidPick && (
                <div className="mt-2 space-y-1.5">
                  {noteLinkExtras.map(inv => (
                    <div key={inv.id} className="flex items-center gap-2 border border-amber-300 bg-amber-50 rounded-md px-3 py-1.5 text-xs">
                      <span className="font-mono text-amber-700">{inv.invoice_number ?? '—'}</span>
                      <span className="truncate flex-1">{invoicePartyName(inv)}</span>
                      <span className="font-medium">{formatCurrency(inv.total ?? inv.amount, inv.amount_currency)}</span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">Paid</span>
                      <FastTooltip label="Remove this invoice">
                        <button
                          type="button"
                          onClick={() => setNoteLinkExtras(list => list.filter(x => x.id !== inv.id))}
                          disabled={noteLinkSubmitting}
                          className="p-0.5 rounded hover:bg-amber-100 text-amber-500"
                          aria-label="Remove this invoice"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </FastTooltip>
                    </div>
                  ))}

                  <p className={cn(
                    'text-xs rounded-md px-3 py-1.5 border',
                    noteLinkSummary.matches ? 'text-green-800 bg-green-50 border-green-200' : 'text-amber-900 bg-amber-50 border-amber-200',
                  )}>
                    {noteLinkSummary.matches
                      ? `Payment ${formatCurrency(amount, feed.currency)} = ${noteLinkAllPaid.length === 1 ? 'this invoice' : `${noteLinkAllPaid.length} invoices`} ${formatCurrency(noteLinkSummary.linkedTotal, feed.currency)}. Everything this payment covers is accounted for.`
                      : noteLinkSummary.difference > 0
                        ? `Payment ${formatCurrency(amount, feed.currency)} · ${noteLinkAllPaid.length === 1 ? 'this invoice' : `${noteLinkAllPaid.length} invoices`} ${formatCurrency(noteLinkSummary.linkedTotal, feed.currency)} · ${formatCurrency(noteLinkSummary.difference, feed.currency)} of the payment is not accounted for yet. If it also paid another invoice, add it below — or link as it is.`
                        : `The ${noteLinkAllPaid.length} invoices add up to ${formatCurrency(noteLinkSummary.linkedTotal, feed.currency)}, which is ${formatCurrency(Math.abs(noteLinkSummary.difference), feed.currency)} more than the payment ${formatCurrency(amount, feed.currency)}.`}
                  </p>

                  {noteLinkAllPaid.length < MAX_LINKED_INVOICES && (
                    <div className="space-y-1">
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <input
                          type="text"
                          placeholder="Did it also pay another invoice? Add it — number or client name…"
                          value={noteLinkExtraQuery}
                          onChange={e => setNoteLinkExtraQuery(e.target.value)}
                          disabled={noteLinkSubmitting}
                          className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                      </div>
                      {noteLinkSearchTerm.length >= 2 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {noteLinkPaidLoading && noteLinkPaidResults.length === 0 && (
                            <p className="text-xs text-muted-foreground px-1 py-1 flex items-center gap-1.5">
                              <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                            </p>
                          )}
                          {noteLinkPaidError && !noteLinkPaidLoading && (
                            <p className="text-xs text-red-600 px-1 py-1">{noteLinkPaidError}</p>
                          )}
                          {noteLinkPaidResults
                            .filter(inv => !noteLinkAllPaid.some(x => x.id === inv.id))
                            .map(inv => (
                              <button
                                key={inv.id}
                                type="button"
                                onClick={() => { setNoteLinkExtras(list => [...list, inv]); setNoteLinkExtraQuery('') }}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border hover:bg-amber-50 hover:border-amber-200 transition-colors"
                              >
                                <InvoiceNumberTip summary={summaryInputFromOpenInvoice(inv, invoicePartyName(inv))}><span className="font-mono text-blue-600">{inv.invoice_number ?? '—'}</span></InvoiceNumberTip>
                                <span className="truncate flex-1 text-left">{invoicePartyName(inv)}</span>
                                <span className="font-medium">{formatCurrency(inv.total ?? inv.amount, inv.amount_currency)}</span>
                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">Paid</span>
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Note</label>
              <textarea
                value={noteLinkNote}
                onChange={e => setNoteLinkNote(e.target.value)}
                placeholder="What happened — e.g. settlement agreed at $600 to close the $1,200 invoice, case closed."
                rows={3}
                disabled={noteLinkSubmitting}
                className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {noteLinkSelectedIsPaidPick ? (
              <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{noteLinkExtras.length > 0 ? 'These invoices are already paid. Linking connects this transaction to all of them for the record' : 'This invoice is already paid. Linking connects this transaction to it for the record'} — no money moves, no balance changes.</span>
              </div>
            ) : (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={noteLinkWriteOff}
                  onChange={e => setNoteLinkWriteOff(e.target.checked)}
                  disabled={noteLinkSubmitting}
                  className="mt-0.5"
                />
                <span className="text-sm text-zinc-800">
                  This closes the invoice — write off the rest
                  <span className="block text-[11px] text-zinc-500">
                    {noteLinkSelected && noteLinkSelectedDue > amount
                      ? `Marks it Paid; the remaining ${formatCurrency(noteLinkSelectedDue - amount, noteLinkSelected.amount_currency)} is written off, not left owing.`
                      : 'Marks the invoice Paid instead of leaving any remaining balance due.'}
                  </span>
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={closeNoteLink} disabled={noteLinkSubmitting} className="px-3 py-1.5 text-xs rounded-md border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={submitNoteLink}
                disabled={noteLinkSubmitting || !noteLinkInvoiceId || !noteLinkNote.trim()}
                className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {noteLinkSubmitting && <Loader2 className="h-3 w-3 animate-spin" />}
                {noteLinkExtras.length > 0 ? `Link to ${noteLinkExtras.length + 1} invoices` : 'Link transaction'}
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
              label: `${sourceLabel(feed)} — ${formatCurrency(feed.amount, feed.currency)}`,
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
  const otherLinkedInvoices = otherMultiLinkedInvoices(feed.review_metadata, feed.matched_payment_id)
  const handleDeleteConfirm = async () => {
    const result = await deleteDuplicateBankFeed(feed.id)
    if (!result.success) return { success: false, error: result.error || 'Failed to delete duplicate' }
    return { success: true, message: 'Plaid duplicate deleted' }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b last:border-b-0">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
        {sourceLabel(feed)}
      </span>
      <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
      <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
      <span className="text-xs text-muted-foreground truncate">{feed.sender_name || '—'}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
      {payment?.invoice_number && feed.matched_payment_id ? (
        <InvoiceNumberTip summary={summaryInputFromMatchedPayment(payment, feed.currency)} hint="Click to open the invoice PDF">
          <a
            href={`/api/invoices/${feed.matched_payment_id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-blue-600 hover:underline shrink-0"
            aria-label="Open invoice PDF"
          >
            {payment.invoice_number}
          </a>
        </InvoiceNumberTip>
      ) : payment ? (
        <InvoiceNumberTip summary={summaryInputFromMatchedPayment(payment, feed.currency)}>
          <span className="font-mono text-xs text-blue-600 shrink-0">{payment.invoice_number ?? '—'}</span>
        </InvoiceNumberTip>
      ) : (
        <span className="font-mono text-xs text-blue-600 shrink-0">—</span>
      )}
      {/* One payment linked to several already-paid invoices: the row points at the first, so
          the others are named here — otherwise the row looks like it covers one invoice only. */}
      {otherLinkedInvoices.length > 0 && (
        <FastTooltip label={`This payment also covers ${otherLinkedInvoices.map(o => `${o.invoice_number ?? 'an invoice'}${o.total != null ? ` (${formatCurrency(o.total, feed.currency)})` : ''}`).join(', ')}`}>
          <span className="font-mono text-xs text-blue-600 shrink-0">
            {otherLinkedInvoices.map(o => `+ ${o.invoice_number ?? 'invoice'}`).join(' ')}
          </span>
        </FastTooltip>
      )}
      <span className="text-xs truncate">{payment ? invoicePartyName(payment) : ''}</span>
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
      {isWrittenOffPayment(payment) && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 bg-amber-100 text-amber-700">
          Written Off
        </span>
      )}
      <InvoiceNoteDot note={payment?.notes} />
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
          <FastTooltip label="Delete this Plaid duplicate — Mercury API twin already matched to the same invoice">
            <button
              onClick={() => setConfirmOpen(true)}
              aria-label="Delete this Plaid duplicate — Mercury API twin already matched to the same invoice"
              className="p-1 rounded hover:bg-red-50 text-red-500 shrink-0"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </FastTooltip>
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
                  label: `${sourceLabel(feed)} — ${formatCurrency(feed.amount, feed.currency)}`,
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
          {sourceLabel(feed)}
        </span>
        <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
        <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
        <span className="text-xs text-muted-foreground truncate">{feed.sender_name || '—'}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-mono text-xs text-blue-600 shrink-0">{payment?.invoice_number ?? '—'}</span>
        <span className="text-xs truncate flex-1">{payment ? invoicePartyName(payment) : ''}</span>
        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', STATUS_COLORS.activation_crashed)}>
          activation crashed
        </span>
        <FastTooltip label="Retry activation">
          <button
            onClick={handleRetry}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-50 hover:bg-red-100 text-red-700 disabled:opacity-50 shrink-0"
            aria-label="Retry activation"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
            Retry
          </button>
        </FastTooltip>
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
        {sourceLabel(feed)}
      </span>
      <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
      <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
      <span className="text-xs truncate flex-1">{feed.sender_name || '—'}</span>
      <span className="text-xs text-muted-foreground truncate max-w-[200px]">{feed.memo || ''}</span>
      <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', STATUS_COLORS.duplicate)}>
        duplicate
      </span>
      <FastTooltip label="Not a duplicate — put this payment back in the queue">
        <button
          onClick={handleRestore}
          disabled={isPending}
          aria-label="Not a duplicate — put this payment back in the queue"
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-purple-200 text-purple-700 hover:bg-purple-50 disabled:opacity-50 shrink-0"
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
          Restore
        </button>
      </FastTooltip>
    </div>
  )
}

function IgnoredRow({ feed, isAdmin = false }: { feed: BankFeedRecord; isAdmin?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b last:border-b-0 opacity-60">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', SOURCE_COLORS[feed.source] ?? 'bg-zinc-100')}>
        {sourceLabel(feed)}
      </span>
      <span className="text-xs text-muted-foreground w-24 shrink-0">{formatDate(feed.transaction_date)}</span>
      <span className="font-semibold w-24 shrink-0">{formatCurrency(feed.amount, feed.currency)}</span>
      <span className="text-xs truncate flex-1">{feed.sender_name || '—'}</span>
      <span className="text-xs text-muted-foreground truncate max-w-[200px]">{feed.memo || ''}</span>
      <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', STATUS_COLORS.ignored)}>
        ignored
      </span>
      {/* An ignored row is often TD's own money dismissed by hand before My Finances existed
          — the claim button gives it a real home instead of limbo. */}
      {isAdmin && <ClaimForOwnerButton feedId={feed.id} />}
    </div>
  )
}

// ── Main Component ──

/** Prev / Next with the "Showing a–b of n" line. Shown above AND below the list. */
function FeedPager({ page, pageSize, total, totalPages, onPage }: {
  page: number
  pageSize: number
  total: number
  totalPages: number
  onPage: (next: number) => void
}) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>
        Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      <div className="flex gap-1">
        <button
          onClick={() => onPage(Math.max(0, page - 1))}
          disabled={page === 0}
          className="px-2 py-1 border rounded hover:bg-muted disabled:opacity-50"
        >
          Prev
        </button>
        <button
          onClick={() => onPage(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          className="px-2 py-1 border rounded hover:bg-muted disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  )
}

export function BankFeedTab({ bankFeeds, openInvoices, totalCount, isAdmin = false, isOwner = false }: Props) {
  // Where the person is in the list (filter tab, page, search, source) lives in the page address too, so a
  // browser refresh puts them back where they were instead of on "All", page 1.
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const initialView = useMemo(() => parseFeedView(searchParams), []) // eslint-disable-line react-hooks/exhaustive-deps -- read once, on first render
  const [filter, setFilter] = useState<FilterTab>(initialView.filter)
  const [sourceFilter, setSourceFilter] = useState<string[] | null>(initialView.sources)
  const [searchQuery, setSearchQuery] = useState(initialView.search)
  const [matchingFeed, setMatchingFeed] = useState<string | null>(null)
  const [page, setPage] = useState(initialView.page)
  const [highlightFeedId, setHighlightFeedId] = useState<string | null>(null)
  const pageSize = 50

  // Bug-hunter, 2026-09-13: "Sync All Banks Now" reruns matching over every
  // pre-existing unmatched feed and can settle the exact one a staffer has a
  // "Link with a note" box open on, unmounting UnmatchedRow and silently
  // wiping the typed note. Tracked here (not in UnmatchedRow alone) so the
  // sync button can be disabled while any row's box is open. Uses a Set
  // (not a single feed id) because more than one row's box could in theory
  // be open at once.
  const [feedsWithNoteLinkOpen, setFeedsWithNoteLinkOpen] = useState<Set<string>>(new Set())
  const handleNoteLinkOpenChange = useCallback((feedId: string, open: boolean) => {
    setFeedsWithNoteLinkOpen(prev => {
      const alreadySet = prev.has(feedId)
      if (open === alreadySet) return prev
      const next = new Set(prev)
      if (open) next.add(feedId)
      else next.delete(feedId)
      return next
    })
  }, [])

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
  const deepLinkFeedId = searchParams.get('feed')
  // Handled ONCE per link: this effect also depends on `bankFeeds`, which changes on every data refresh
  // (after Confirm / Reject / Match), and used to reset the filter, search and page each time.
  const handledDeepLink = useRef<string | null>(null)
  useEffect(() => {
    if (!deepLinkFeedId) return
    if (handledDeepLink.current === deepLinkFeedId) return
    const feed = bankFeeds.find(f => f.id === deepLinkFeedId)
    if (!feed) {
      toast.info('Feed not in current list — try Sync Now')
      return
    }
    handledDeepLink.current = deepLinkFeedId
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

  // A saved page number can be past the end once rows have moved (matched, ignored, …): step back to the
  // last page rather than showing an empty list.
  useEffect(() => {
    if (page > 0 && page >= totalPages) setPage(Math.max(0, totalPages - 1))
  }, [page, totalPages])

  // Keep the address in step with the list. `replaceState`, not `router.replace`: the Finance page is a
  // server page that loads up to 1,000 feed rows, and re-running it on every keystroke would be heavy.
  useEffect(() => {
    const current = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : ''
    const next = writeFeedView(current, { filter, page, search: searchQuery, sources: sourceFilter })
    if (next === current) return
    window.history.replaceState(window.history.state, '', next ? `${pathname}?${next}` : pathname)
  }, [filter, page, searchQuery, sourceFilter, pathname])

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
      <BanksSummary
        activeSource={sourceFilter}
        onSourceFilter={(s) => { setSourceFilter(s); setPage(0) }}
        isAdmin={isAdmin}
        syncBlocked={feedsWithNoteLinkOpen.size > 0}
      />

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

      <FeedPager page={page} pageSize={pageSize} total={filtered.length} totalPages={totalPages} onPage={setPage} />

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
                  company_name: invoicePartyName(inv),
                  amount: invAmount,
                  amount_currency: inv.amount_currency,
                  confidence: feed.match_confidence,
                  summary: summaryInputFromOpenInvoice(inv, invoicePartyName(inv)),
                }
              } else if (feed.payments) {
                // Fallback: payment may not be in the open-invoice set anymore.
                candidateInfo = {
                  invoice_number: feed.payments.invoice_number,
                  company_name: invoicePartyName(feed.payments),
                  amount: Number(feed.amount),
                  amount_currency: feed.currency,
                  confidence: feed.match_confidence,
                  summary: summaryInputFromMatchedPayment(feed.payments, feed.currency),
                }
              }
            }

            // Bug-hunter, 2026-09-13 (second pass): disabling "Sync All Banks
            // Now" only blocks ONE of several doors to the same failure — five
            // other actions on this page (Ignore/Match/Claim/Restore/Delete-
            // duplicate on any OTHER row) refresh the whole page's data too,
            // and the 15-min background cron can settle this exact feed with
            // no button click at all. Guarding at the render decision instead
            // of at every trigger closes all of them at once: a row whose
            // note-link box is open keeps rendering as UnmatchedRow no matter
            // what its freshly-fetched status says, until the box itself is
            // closed. The server still re-checks the feed's real status at
            // submit time and refuses if something else already settled it
            // (lib/finance/owner-transaction-link.ts) — this only protects the
            // in-progress typing from disappearing, not the money.
            const keepShowingAsUnmatched = feedsWithNoteLinkOpen.has(feed.id)
            const inner = feed.status === 'unmatched' || feed.status === 'needs_review' || keepShowingAsUnmatched ? (
              <UnmatchedRow
                feed={feed}
                openInvoices={openInvoices}
                isMatching={matchingFeed === feed.id}
                onStartMatch={() => setMatchingFeed(feed.id)}
                onCancelMatch={() => setMatchingFeed(null)}
                candidateInfo={candidateInfo}
                isAdmin={isAdmin}
                isOwner={isOwner}
                onNoteLinkOpenChange={handleNoteLinkOpenChange}
              />
            ) : feed.status === 'activation_crashed' ? (
              <CrashedRow feed={feed} />
            ) : feed.status === 'matched' ? (
              <MatchedRow feed={feed} canDeleteDuplicate={eligibleForDeleteDuplicate.has(feed.id)} />
            ) : feed.status === 'duplicate' ? (
              <DuplicateRow feed={feed} />
            ) : (
              <IgnoredRow feed={feed} isAdmin={isAdmin} />
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

      {/* Pagination (also above the list) */}
      <FeedPager page={page} pageSize={pageSize} total={filtered.length} totalPages={totalPages} onPage={setPage} />
    </div>
  )
}
