'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  User, Building2, Calendar, DollarSign, Briefcase, FileText,
  Flag, CheckCircle2, AlertCircle, ExternalLink, Loader2,
  Globe, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  Users, Search, UserPlus, MapPin,
} from 'lucide-react'
import { AddressPicker } from '@/components/shared/address-picker'
import { RAPicker } from '@/components/shared/ra-picker'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { type AccountRow, type ContactRow } from './audit-shell'
import { computeCompleteness, type CompletenessResult } from '@/lib/audit/completeness-rules'
import { computeBillingStatus, type BillingStatusResult, type BillingCheckStatus } from '@/lib/audit/billing-status'
import type { OrphanFeedMatch, MercuryDuplicate } from '@/lib/audit/bank-feed-cascade'
import { ignoreBankFeed, deleteDuplicateBankFeed } from '@/app/(dashboard)/finance/actions'

// ─── Types ────────────────────────────────────────────────

type MemberRow = {
  id: string
  full_name: string | null
  company_name: string | null
  ein: string | null
  email: string | null
  phone: string | null
  ownership_pct: number | null
  member_type: string | null
  is_primary: boolean | null
  is_signer: boolean | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
  contact_id: string | null
  representative_name: string | null
  representative_email: string | null
  representative_phone: string | null
  representative_address_street: string | null
  representative_address_city: string | null
  representative_address_state: string | null
  representative_address_zip: string | null
  representative_address_country: string | null
}

type AnnualAgreementRow = {
  id: string
  agreement_year: number
  status: string | null
  skip_january: boolean | null
  token: string | null
  created_at: string
}

type ServiceDeliveryRow = {
  id: string
  service_type: string
  service_name: string
  status: string | null
  stage: string | null
  start_date: string | null
  end_date: string | null
  notes: string | null
  amount: number | null
  amount_currency: string | null
  assigned_to: string | null
}

type TaxReturnRow = {
  id: string
  tax_year: number
  return_type: string
  status: string | null
  data_received: boolean | null
  data_received_date: string | null
  extension_filed: boolean | null
  extension_deadline: string | null
  deadline: string
  paid: boolean | null
  sent_to_india: boolean | null
  india_status: string | null
  notes: string | null
  link_sent: boolean | null
}

type SubmissionRow = {
  id: string
  tax_year: number
  status: string | null
  completed_at: string | null
  submitted_data: unknown
}

type PaymentRow = {
  id: string
  description: string | null
  amount: number
  amount_currency: string | null
  due_date: string | null
  paid_date: string | null
  status: string | null
  invoice_number: string | null
  invoice_status: string | null
  installment: string | null
  period: string | null
}

type ContactWithTier = {
  id: string
  full_name: string
  email: string
  portal_tier: string | null
}

type AccountData = {
  service_deliveries: ServiceDeliveryRow[]
  tax_returns: TaxReturnRow[]
  tax_return_submissions: SubmissionRow[]
  payments: PaymentRow[]
  portal_account: boolean | null
  portal_tier: string | null
  entity_type: string | null
  audit_sections: Record<string, boolean>
  members: MemberRow[]
  annual_agreements: AnnualAgreementRow[]
  auth_user_map: Record<string, boolean>
  auth_banned_map: Record<string, boolean>
  contacts_with_tier: ContactWithTier[]
  orphan_feeds: OrphanFeedMatch[]
  mercury_duplicates: MercuryDuplicate[]
}

type ServiceChoice = 'active' | 'not_active' | 'never_had' | null

// ─── Constants ────────────────────────────────────────────

const SERVICES = [
  { key: 'cmra', label: 'CMRA Mailing Address', serviceType: 'CMRA Mailing Address' },
  { key: 'state_ra', label: 'State RA Renewal', serviceType: 'State RA Renewal' },
  { key: 'state_annual_report', label: 'State Annual Report', serviceType: 'State Annual Report' },
  { key: 'tax_return', label: 'Tax Return', serviceType: 'Tax Return' },
  { key: 'itin', label: 'ITIN', serviceType: 'ITIN' },
  { key: 'ein_application', label: 'EIN Application', serviceType: 'EIN Application' },
  { key: 'company_formation', label: 'Company Formation', serviceType: 'Company Formation' },
  { key: 'client_onboarding', label: 'Client Onboarding', serviceType: 'Client Onboarding' },
  { key: 'banking_fintech', label: 'Banking Fintech', serviceType: 'Banking Fintech' },
  { key: 'banking_physical', label: 'Banking Physical', serviceType: 'Banking Physical' },
]

const TAX_STATUSES = [
  'Payment Pending',
  'Link Sent - Awaiting Data',
  'Data Received',
  'Sent to India',
  'Extension Filed',
  'TR Completed - Awaiting Signature',
  'TR Filed',
  'Paid - Not Started',
  'Activated - Need Link',
  'Not Invoiced',
  'Extension Requested',
]

const ACCOUNT_STATUSES = ['Active', 'Delinquent', 'Suspended', 'Offboarding', 'Cancelled', 'Closed']
const ACCOUNT_TYPES = ['Client', 'Partner', 'One-Time']
const ENTITY_TYPES = ['Single Member LLC', 'Multi Member LLC', 'C-Corp Elected'] as const

// ─── Helper components ────────────────────────────────────

function fmt(d: string | null) {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

function fmtAmt(amount: number, currency: string | null) {
  return `${currency ?? ''}${amount.toLocaleString()}`
}

function computeSeptemberRule(onboardingDate: string | null): { label: string; skip: boolean; yearNum: number | null } {
  if (!onboardingDate) return { label: '—', skip: false, yearNum: null }
  try {
    const d = parseISO(onboardingDate)
    const year = d.getFullYear()
    const month = d.getMonth() + 1
    const currentYear = new Date().getFullYear()
    const yearNum = currentYear - year + 1

    if (year >= currentYear) return { label: `Year 1 — skip January`, skip: true, yearNum: 1 }
    if (year === currentYear - 1 && month >= 9) return { label: `Year 2 — skip January (Sep rule)`, skip: true, yearNum: 2 }
    return { label: `Year ${yearNum} — January applies`, skip: false, yearNum }
  } catch {
    return { label: '—', skip: false, yearNum: null }
  }
}

function Field({
  label, value, onChange, type = 'text', hint, readOnly,
}: {
  label: string
  value: string
  onChange?: (v: string) => void
  type?: 'text' | 'date' | 'textarea'
  hint?: string
  readOnly?: boolean
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</label>
      {type === 'textarea' ? (
        <textarea
          value={value}
          onChange={e => onChange?.(e.target.value)}
          readOnly={readOnly}
          rows={3}
          className={cn(
            'w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none',
            readOnly && 'bg-zinc-50 text-zinc-600'
          )}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={e => onChange?.(e.target.value)}
          readOnly={readOnly}
          className={cn(
            'w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500',
            readOnly && 'bg-zinc-50 text-zinc-600'
          )}
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Section({ icon: Icon, title, children, badge, done, onToggleDone }: {
  icon: React.ElementType
  title: string
  children: React.ReactNode
  badge?: string
  done?: boolean
  onToggleDone?: () => void
}) {
  return (
    <div className={cn('bg-white rounded-lg border p-4 space-y-3', done && 'border-emerald-200')}>
      <div className="flex items-center gap-2 pb-2 border-b">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">{title}</h3>
        {badge && <span className="ml-1 text-xs text-muted-foreground">{badge}</span>}
        {onToggleDone !== undefined && (
          <button
            type="button"
            onClick={onToggleDone}
            className={cn(
              'ml-auto flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors',
              done
                ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50'
            )}
          >
            <CheckCircle2 className="h-3 w-3" />
            {done ? 'Done' : 'Mark done'}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function BillingCheckRow({
  status, label, context, paymentId, invoiceNumber,
}: {
  status: BillingCheckStatus
  label: string
  context: string
  paymentId?: string | null
  invoiceNumber?: string | null
}) {
  const badge = cn(
    'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0',
    status === 'ok'          && 'bg-emerald-100 text-emerald-700',
    status === 'missing'     && 'bg-amber-100 text-amber-700',
    status === 'not_yet_due' && 'bg-zinc-100 text-zinc-500',
    status === 'na'          && 'bg-zinc-100 text-zinc-400',
  )
  const badgeText =
    status === 'ok'          ? 'OK' :
    status === 'missing'     ? 'Missing' :
    status === 'not_yet_due' ? 'Not yet' :
    'N/A'

  // If the context contains the invoice number, replace that span with a link
  // to the staff PDF endpoint.
  const renderContext = (): React.ReactNode => {
    if (!context) return null
    if (paymentId && invoiceNumber && context.includes(invoiceNumber)) {
      const idx = context.indexOf(invoiceNumber)
      const before = context.slice(0, idx)
      const after = context.slice(idx + invoiceNumber.length)
      return (
        <span className="text-zinc-400 ml-1.5">
          {before}
          <a
            href={`/api/invoices/${paymentId}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline font-mono"
            title="Open invoice PDF"
          >
            {invoiceNumber}
          </a>
          {after}
        </span>
      )
    }
    return <span className="text-zinc-400 ml-1.5">{context}</span>
  }

  return (
    <div className="flex items-start gap-2 text-xs py-0.5">
      <span className={badge}>{badgeText}</span>
      <div className="min-w-0">
        <span className="font-medium text-zinc-700">{label}</span>
        {renderContext()}
      </div>
    </div>
  )
}

// Autocomplete suggestions for the Create-service modal — derived from the
// most-used service_type values in service_deliveries (sandbox query 2026-05-02).
const SERVICE_TYPE_SUGGESTIONS = [
  'State Annual Report',
  'CMRA Mailing Address',
  'State RA Renewal',
  'Tax Return',
  'Company Formation',
  'Annual Renewal',
  'EIN',
  'ITIN',
  'Banking Fintech',
  'Client Onboarding',
]

function FeedCleanupSubsection({
  accountId,
  orphanFeeds,
  mercuryDuplicates,
  loading,
  refetchDbData,
}: {
  accountId: string
  orphanFeeds: OrphanFeedMatch[]
  mercuryDuplicates: MercuryDuplicate[]
  loading: boolean
  refetchDbData: () => Promise<void>
}) {
  // Step 14 — Create-service modal state (must come before any early-return so
  // hook order is stable across renders.)
  const [createForFeed, setCreateForFeed] = useState<OrphanFeedMatch | null>(null)
  const [createServiceType, setCreateServiceType] = useState('')
  const [createServiceName, setCreateServiceName] = useState('')
  const [createSubmitting, setCreateSubmitting] = useState(false)

  if (loading) return null
  if (orphanFeeds.length === 0 && mercuryDuplicates.length === 0) return null

  const ruleColor = (confidence: 'high' | 'medium') =>
    confidence === 'high'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-amber-100 text-amber-700'

  const handleIgnore = async (feedId: string) => {
    const res = await ignoreBankFeed(feedId)
    if (!res.success) {
      toast.error(res.error ?? 'Failed to ignore bank feed')
      return
    }
    toast.success('Bank feed ignored')
    await refetchDbData()
  }

  const handleDeleteDuplicate = async (feedId: string) => {
    if (!window.confirm('Delete this Plaid duplicate? It is the redundant copy of a Mercury feed already in the system.')) {
      return
    }
    const res = await deleteDuplicateBankFeed(feedId)
    if (!res.success) {
      toast.error(res.error ?? 'Failed to delete duplicate')
      return
    }
    toast.success('Duplicate deleted')
    await refetchDbData()
  }

  const openCreateModal = (m: OrphanFeedMatch) => {
    setCreateForFeed(m)
    setCreateServiceType('')
    setCreateServiceName('')
  }

  const closeCreateModal = () => {
    if (createSubmitting) return
    setCreateForFeed(null)
    setCreateServiceType('')
    setCreateServiceName('')
  }

  const submitCreateService = async () => {
    if (!createForFeed) return
    const serviceType = createServiceType.trim()
    if (!serviceType) {
      toast.error('Pick or type a service type')
      return
    }
    const serviceName = createServiceName.trim() || serviceType
    setCreateSubmitting(true)
    try {
      const res = await fetch(`/api/clients/audit/${accountId}/create-service-from-feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feed_id: createForFeed.feed.id,
          service_type: serviceType,
          service_name: serviceName,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(d.error ?? `Request failed (${res.status})`)
      }
      if (d.warning) {
        toast.warning(d.warning)
      } else {
        toast.success(`Service + invoice ${d.invoice_number ?? ''} created`)
      }
      setCreateForFeed(null)
      setCreateServiceType('')
      setCreateServiceName('')
      await refetchDbData()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Create service failed')
    } finally {
      setCreateSubmitting(false)
    }
  }

  return (
    <div className="pt-3 mt-2 border-t space-y-4">
      <p className="text-xs font-semibold text-zinc-700 uppercase tracking-wide">
        Other paid services & feed cleanup
      </p>

      {orphanFeeds.length > 0 && (
        <div>
          <p className="text-xs text-zinc-500 mb-1.5">
            Unmatched bank deposits that look like they belong to this client ({orphanFeeds.length})
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-400 border-b">
                  <th className="text-left py-1 pr-2 font-medium">Date</th>
                  <th className="text-left py-1 pr-2 font-medium">Source</th>
                  <th className="text-left py-1 pr-2 font-medium">Sender / memo</th>
                  <th className="text-right py-1 pr-2 font-medium">Amount</th>
                  <th className="text-left py-1 pr-2 font-medium">Match</th>
                  <th className="text-right py-1 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orphanFeeds.map(o => (
                  <tr key={o.feed.id} className="border-b border-zinc-50 align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{fmt(o.feed.transaction_date)}</td>
                    <td className="py-1.5 pr-2 text-zinc-500">{o.feed.source}</td>
                    <td className="py-1.5 pr-2 max-w-[260px]">
                      <div className="truncate font-medium">{o.feed.sender_name ?? '—'}</div>
                      {o.feed.memo && (
                        <div className="truncate text-zinc-400">{o.feed.memo}</div>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                      {fmtAmt(o.feed.amount, o.feed.currency)}
                    </td>
                    <td className="py-1.5 pr-2">
                      <span
                        className={cn('px-1.5 py-0.5 rounded font-medium whitespace-nowrap', ruleColor(o.confidence))}
                        title={`Tier ${o.tier} • ${o.confidence.toUpperCase()} • evidence: ${o.match_evidence}`}
                      >
                        {o.rule_label}
                      </span>
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => openCreateModal(o)}
                        className="px-2 py-0.5 mr-1 rounded border border-blue-200 text-blue-700 hover:bg-blue-50"
                      >
                        Create service
                      </button>
                      <button
                        onClick={() => handleIgnore(o.feed.id)}
                        className="px-2 py-0.5 mr-1 rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                      >
                        Ignore
                      </button>
                      <a
                        href={`/finance?tab=bank&feed=${o.feed.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-0.5 rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 inline-block"
                      >
                        Open in matcher
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mercuryDuplicates.length > 0 && (
        <div>
          <p className="text-xs text-zinc-500 mb-1.5">
            Plaid-Mercury duplicates for this client ({mercuryDuplicates.length})
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-400 border-b">
                  <th className="text-left py-1 pr-2 font-medium">Date</th>
                  <th className="text-left py-1 pr-2 font-medium">Sender / memo</th>
                  <th className="text-right py-1 pr-2 font-medium">Amount</th>
                  <th className="text-left py-1 pr-2 font-medium">Attribution</th>
                  <th className="text-right py-1 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {mercuryDuplicates.map(d => (
                  <tr key={d.plaid_feed.id} className="border-b border-zinc-50 align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{fmt(d.plaid_feed.transaction_date)}</td>
                    <td className="py-1.5 pr-2 max-w-[260px]">
                      <div className="truncate font-medium">{d.plaid_feed.sender_name ?? '—'}</div>
                      {d.plaid_feed.memo && (
                        <div className="truncate text-zinc-400">{d.plaid_feed.memo}</div>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                      {fmtAmt(d.plaid_feed.amount, d.plaid_feed.currency)}
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className="text-zinc-500">
                        {d.attribution === 'matched' ? 'matched-payment' : 'cascade'}
                      </span>
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => handleDeleteDuplicate(d.plaid_feed.id)}
                        className="px-2 py-0.5 mr-1 rounded border border-red-200 text-red-700 hover:bg-red-50"
                      >
                        Delete duplicate
                      </button>
                      <a
                        href={`/finance?tab=bank&feed=${d.plaid_feed.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-0.5 rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 inline-block"
                      >
                        Open in matcher
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Step 14 — Create-service modal */}
      {createForFeed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={closeCreateModal}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">Create service from bank feed</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                Creates a Completed service delivery + a paid invoice, links the feed.
              </p>
            </div>

            <div className="bg-zinc-50 rounded p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-zinc-500">Date</span>
                <span className="font-medium tabular-nums">{fmt(createForFeed.feed.transaction_date)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Amount</span>
                <span className="font-medium tabular-nums">{fmtAmt(createForFeed.feed.amount, createForFeed.feed.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Sender</span>
                <span className="font-medium truncate ml-2">{createForFeed.feed.sender_name ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Source</span>
                <span className="font-medium">{createForFeed.feed.source}</span>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Service type</label>
              <input
                list="audit-service-type-suggestions"
                value={createServiceType}
                onChange={e => {
                  setCreateServiceType(e.target.value)
                  if (!createServiceName.trim()) setCreateServiceName(e.target.value)
                }}
                placeholder="Pick or type (e.g. Tax Return)"
                className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={createSubmitting}
              />
              <datalist id="audit-service-type-suggestions">
                {SERVICE_TYPE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
              </datalist>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Service name (invoice description)</label>
              <input
                value={createServiceName}
                onChange={e => setCreateServiceName(e.target.value)}
                placeholder="Defaults to service type"
                className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={createSubmitting}
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={closeCreateModal}
                disabled={createSubmitting}
                className="px-3 py-1.5 text-sm rounded border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitCreateService}
                disabled={createSubmitting || !createServiceType.trim()}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {createSubmitting ? 'Creating…' : 'Create service + invoice'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CompletenessChip({ label, result }: { label: string; result: CompletenessResult }) {
  const dotClass = cn(
    'inline-block w-2 h-2 rounded-full mr-1.5',
    result.status === 'red' && 'bg-red-500',
    result.status === 'yellow' && 'bg-amber-400',
    result.status === 'green' && 'bg-emerald-500',
  )
  const chipClass = cn(
    'flex items-center px-2.5 py-1 rounded-full border text-xs font-medium',
    result.status === 'red' && 'bg-red-50 border-red-200 text-red-700',
    result.status === 'yellow' && 'bg-amber-50 border-amber-200 text-amber-700',
    result.status === 'green' && 'bg-emerald-50 border-emerald-200 text-emerald-700',
  )

  const detail =
    result.status === 'green'
      ? 'Complete'
      : result.status === 'red'
      ? result.missing_critical.join(', ')
      : result.missing_warning.join(', ')

  const titleText = result.status === 'green' ? 'Complete' : detail

  return (
    <div className={chipClass} title={titleText}>
      <span className={dotClass} />
      <span className="mr-1 opacity-60">{label}:</span>
      {result.status === 'green' ? (
        <span>Complete</span>
      ) : (
        <span className="max-w-[220px] truncate">{detail}</span>
      )}
    </div>
  )
}


function ServiceRadio({
  label, value, onChange, sds,
}: {
  label: string
  value: ServiceChoice
  onChange: (v: ServiceChoice) => void
  sds: ServiceDeliveryRow[]
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="py-2 border-b border-zinc-100 last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{label}</span>
          {sds.length > 0 && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="ml-2 text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {sds.length} in DB
            </button>
          )}
          {sds.length === 0 && (
            <span className="ml-2 text-xs text-zinc-400 italic">No SD in DB</span>
          )}
          {sds.length > 0 && !expanded && (
            <p className="text-xs text-zinc-500 mt-0.5">
              {sds.map(sd => `${sd.status ?? '?'}${sd.stage ? ` / ${sd.stage}` : ''}`).join(' · ')}
            </p>
          )}
          {expanded && (
            <div className="mt-1.5 space-y-1 bg-zinc-50 rounded p-2">
              {sds.map(sd => (
                <div key={sd.id} className="text-xs flex items-center gap-1.5">
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-white shrink-0',
                    sd.status === 'Active' ? 'bg-emerald-500' :
                    sd.status === 'Completed' ? 'bg-blue-500' :
                    sd.status === 'Cancelled' ? 'bg-zinc-400' : 'bg-zinc-500'
                  )}>
                    {sd.status ?? '?'}
                  </span>
                  <span className="font-medium">{sd.service_name}</span>
                  {sd.stage && <span className="text-zinc-500">• {sd.stage}</span>}
                  {sd.start_date && <span className="text-zinc-400">from {fmt(sd.start_date)}</span>}
                  {sd.amount != null && <span className="text-zinc-500 ml-auto">{fmtAmt(sd.amount, sd.amount_currency)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          {(['active', 'not_active', 'never_had'] as ServiceChoice[]).map(opt => (
            <button
              key={opt}
              onClick={() => onChange(value === opt ? null : opt)}
              className={cn(
                'px-2 py-0.5 text-xs rounded-full border transition-colors',
                value === opt && opt === 'active' && 'bg-emerald-500 text-white border-emerald-500',
                value === opt && opt === 'not_active' && 'bg-zinc-600 text-white border-zinc-600',
                value === opt && opt === 'never_had' && 'bg-zinc-200 text-zinc-700 border-zinc-300',
                value !== opt && 'border-zinc-200 text-zinc-500 hover:bg-zinc-50',
              )}
            >
              {opt === 'active' ? 'Active' : opt === 'not_active' ? 'Not active' : 'Never'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Post-confirm modal ────────────────────────────────────

function PostConfirmPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4 space-y-4" onClick={e => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold text-base">Account confirmed</h3>
          <p className="text-sm text-muted-foreground mt-1">What would you like to do next?</p>
        </div>
        <div className="space-y-2">
          <p className="text-xs text-zinc-400 font-medium uppercase tracking-wide">Sandbox — no real emails sent</p>
          <button className="w-full text-left px-3 py-2.5 border rounded-lg text-sm hover:bg-zinc-50 transition-colors">
            📋 Send tax wizard link (sandbox only — logged, not sent)
          </button>
          <button className="w-full text-left px-3 py-2.5 border rounded-lg text-sm hover:bg-zinc-50 transition-colors">
            💳 Flag billing for review
          </button>
          <button className="w-full text-left px-3 py-2.5 border rounded-lg text-sm hover:bg-zinc-50 transition-colors">
            📝 Send member info form (sandbox only)
          </button>
          <button
            onClick={onClose}
            className="w-full text-left px-3 py-2.5 border rounded-lg text-sm hover:bg-zinc-50 transition-colors text-zinc-500"
          >
            Leave pending — continue to next client
          </button>
        </div>
        <button
          onClick={onClose}
          className="w-full py-2 bg-zinc-800 text-white rounded-lg text-sm font-medium hover:bg-zinc-700"
        >
          Continue to next
        </button>
      </div>
    </div>
  )
}

// ─── Main Panel ────────────────────────────────────────────

export function AuditPanel({
  account,
  reviewer,
  position,
  onUpdated,
  onNext,
  onPrev,
  hasPrev,
  hasNext,
}: {
  account: AccountRow
  reviewer: string
  position: { current: number; total: number }
  onUpdated: (updated: AccountRow) => void
  onNext: () => void
  onPrev: () => void
  hasPrev: boolean
  hasNext: boolean
}) {
  // ── Account fields ──
  const [accountType, setAccountType] = useState(account.account_type ?? '')
  const [entityType, setEntityType] = useState(account.entity_type ?? '')
  const [stateOfFormation, setStateOfFormation] = useState(account.state_of_formation ?? '')
  const [ein, setEin] = useState(account.ein_number ?? '')
  const [filingId, setFilingId] = useState(account.filing_id ?? '')
  const [address, setAddress] = useState(account.physical_address ?? '')
  const [formationDate, setFormationDate] = useState(account.formation_date ?? '')
  const [onboardingDate, setOnboardingDate] = useState(account.onboarding_date ?? '')
  const [inst1, setInst1] = useState(String(account.installment_1_amount ?? ''))
  const [inst2, setInst2] = useState(String(account.installment_2_amount ?? ''))
  const [currency, setCurrency] = useState(account.installment_1_currency ?? 'USD')
  const [setupAmount, setSetupAmount] = useState(String(account.setup_fee_amount ?? ''))
  const [setupInvoice, setSetupInvoice] = useState(account.setup_fee_invoice ?? '')
  const [setupDate, setSetupDate] = useState(account.setup_fee_date ?? '')
  const [status, setStatus] = useState(account.status ?? 'Active')
  const [notes, setNotes] = useState(account.notes ?? '')
  const [flagged, setFlagged] = useState(account.audit_flag ?? false)

  // ── Contact edits ──
  const [contactEdits, setContactEdits] = useState<Record<string, Partial<ContactRow>>>({})
  const [localContacts, setLocalContacts] = useState<ContactRow[]>(account.contacts)

  // ── Contact search / link / create ──
  const [contactSearch, setContactSearch] = useState('')
  const [contactResults, setContactResults] = useState<ContactRow[]>([])
  const [contactSearching, setContactSearching] = useState(false)
  const [showCreateContact, setShowCreateContact] = useState(false)
  const [linkingContact, setLinkingContact] = useState(false)
  const [newContact, setNewContact] = useState({ full_name: '', email: '', phone: '', language: '', citizenship: '' })
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Services human confirmation ──
  const [services, setServices] = useState<Record<string, ServiceChoice>>(
    Object.fromEntries(SERVICES.map(s => [s.key, null]))
  )

  // ── Section completion (audit_sections) ──
  const [sectionsDone, setSectionsDone] = useState<Record<string, boolean>>(
    account.audit_sections ?? {}
  )

  // ── Address registry — C5 ──
  const [legalAddressId, setLegalAddressId] = useState<string | null>(account.business_legal_address_id ?? null)
  const [legalVerified, setLegalVerified] = useState<boolean>(account.legal_link_verified ?? false)
  const [mailingAddressId, setMailingAddressId] = useState<string | null>(account.business_mailing_address_id ?? null)
  const [mailingVerified, setMailingVerified] = useState<boolean>(account.mailing_link_verified ?? false)
  const [raId, setRaId] = useState<string | null>(account.registered_agent_id ?? null)
  const [raVerified, setRaVerified] = useState<boolean>(account.ra_link_verified ?? false)
  const [raCounty, setRaCounty] = useState<string | null>(null)
  const [acctUpdatedAt, setAcctUpdatedAt] = useState<string>(account.updated_at ?? '')

  const refreshAddressData = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/audit/${account.id}`)
      if (!res.ok) return
      const d = await res.json().catch(() => ({}))
      setLegalAddressId(d.business_legal_address_id ?? null)
      setLegalVerified(d.legal_link_verified ?? false)
      setMailingAddressId(d.business_mailing_address_id ?? null)
      setMailingVerified(d.mailing_link_verified ?? false)
      setRaId(d.registered_agent_id ?? null)
      setRaVerified(d.ra_link_verified ?? false)
      setRaCounty(d.ra_county ?? null)
      if (d.updated_at) setAcctUpdatedAt(d.updated_at)
    } catch {
      // silent — stale values are acceptable; pickers show their own updates
    }
  }, [account.id])

  // Fetch RA county on mount for SS-4 readiness check (C6)
  useEffect(() => {
    if (account.registered_agent_id) refreshAddressData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Tax return edits ──
  const [taxEdits, setTaxEdits] = useState<Record<string, { status?: string; data_received?: boolean }>>({})

  // ── DB data ──
  const [dbData, setDbData] = useState<AccountData | null>(null)
  const [dbLoading, setDbLoading] = useState(true)

  // ── Completeness score (computed after DB data loads) ──
  const completeness = useMemo(() => {
    if (!dbData) return null
    const activeServiceTypes = dbData.service_deliveries
      .filter(sd => sd.status !== 'Cancelled')
      .map(sd => sd.service_type)
    const primaryContact = localContacts[0] ?? null

    return computeCompleteness(
      {
        entity_type: account.entity_type,
        ein_number: ein || null,
        state_of_formation: stateOfFormation || null,
        physical_address: address || null,
        onboarding_date: onboardingDate || null,
        account_type: accountType || null,
        registered_agent_id: raId,
        business_mailing_address_id: mailingAddressId,
        business_legal_address_id: legalAddressId,
      },
      primaryContact
        ? {
            full_name: primaryContact.full_name ?? null,
            email: primaryContact.email ?? null,
            itin_number: primaryContact.itin_number ?? null,
            citizenship: primaryContact.citizenship ?? null,
            date_of_birth: primaryContact.date_of_birth ?? null,
            passport_on_file: primaryContact.passport_on_file ?? null,
            address_line1: primaryContact.address_line1 ?? null,
          }
        : null,
      activeServiceTypes,
      [],
      [],
    )
  }, [dbData, localContacts, account.entity_type, ein, stateOfFormation, address, onboardingDate, accountType, raId, mailingAddressId, legalAddressId])

  // ── Billing status (computed after DB data loads) ──
  const billingStatus = useMemo((): BillingStatusResult | null => {
    if (!dbData) return null
    const now = new Date()
    return computeBillingStatus(
      {
        account_type: accountType || null,
        onboarding_date: onboardingDate || null,
        installment_2_amount: inst2 ? parseFloat(inst2) : null,
        installment_2_currency: currency,
      },
      dbData.payments,
      dbData.annual_agreements,
      now.getFullYear(),
      now.getMonth() + 1,
    )
  }, [dbData, accountType, onboardingDate, inst2, currency])

  // ── UI state ──
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [showPostConfirm, setShowPostConfirm] = useState(false)
  const [portalToggling, setPortalToggling] = useState(false)
  const [portalTierLocal, setPortalTierLocal] = useState<string | null>(null)

  useEffect(() => {
    setDbLoading(true)
    fetch(`/api/clients/audit/${account.id}/data`)
      .then(r => r.json())
      .then((d: AccountData) => {
        setDbData(d)
        if (d.audit_sections) setSectionsDone(d.audit_sections)
        setPortalTierLocal(d.portal_tier ?? null)
      })
      .catch(() => setDbData(null))
      .finally(() => setDbLoading(false))
  }, [account.id])

  function getContactValue(contact: ContactRow, field: keyof ContactRow): string {
    const edits = contactEdits[contact.id]
    if (edits && field in edits) return (edits[field] as string) ?? ''
    return (contact[field] as string) ?? ''
  }

  function setContactValue(contactId: string, field: keyof ContactRow, value: string) {
    setContactEdits(prev => ({
      ...prev,
      [contactId]: { ...(prev[contactId] ?? {}), [field]: value },
    }))
  }

  function handleContactSearchChange(q: string) {
    setContactSearch(q)
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    if (q.length < 2) { setContactResults([]); return }
    searchDebounce.current = setTimeout(async () => {
      setContactSearching(true)
      try {
        const res = await fetch(`/api/clients/audit/${account.id}/contacts?q=${encodeURIComponent(q)}`)
        const d = await res.json()
        setContactResults(d.contacts ?? [])
      } finally {
        setContactSearching(false)
      }
    }, 300)
  }

  async function handleLinkContact(contactId: string) {
    setLinkingContact(true)
    try {
      const res = await fetch(`/api/clients/audit/${account.id}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to link contact')
      setLocalContacts(prev => [...prev, d.contact])
      setContactSearch('')
      setContactResults([])
      toast.success(`Linked ${d.contact.full_name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to link contact')
    } finally {
      setLinkingContact(false)
    }
  }

  async function handleCreateContact() {
    if (!newContact.full_name.trim()) { toast.error('Full name is required'); return }
    setLinkingContact(true)
    try {
      const res = await fetch(`/api/clients/audit/${account.id}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newContact),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to create contact')
      setLocalContacts(prev => [...prev, d.contact])
      setNewContact({ full_name: '', email: '', phone: '', language: '', citizenship: '' })
      setShowCreateContact(false)
      toast.success(`Created and linked ${d.contact.full_name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create contact')
    } finally {
      setLinkingContact(false)
    }
  }

  async function handlePortalAccessToggle(action: 'activate' | 'deactivate', force = false) {
    const confirmMsg = action === 'deactivate'
      ? 'Block portal login? The auth user(s) for the linked contact(s) will be banned (sign-in disabled). Tier values, services, invoices, and documents are preserved exactly as they are. Contacts who also have access to other active accounts will be SKIPPED unless you confirm again.'
      : 'Restore portal login? The auth user(s) for the linked contact(s) will be un-banned. Their existing tier and data are unchanged.'
    if (!confirm(confirmMsg)) return
    setPortalToggling(true)
    try {
      const res = await fetch(`/api/clients/audit/${account.id}/portal-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, actor: reviewer, force }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to update portal access')

      // Re-fetch data so the UI reflects the new banned state — bypass any cache
      const dataRes = await fetch(`/api/clients/audit/${account.id}/data`, { cache: 'no-store' })
      const fresh: AccountData = await dataRes.json()
      setDbData(fresh)
      setPortalTierLocal(fresh.portal_tier ?? null)

      const skipped = d.skippedMultiAccount ?? []
      if (skipped.length > 0) {
        const proceed = confirm(`Skipped ${skipped.length} contact(s) with access to other active accounts:\n\n${skipped.join('\n')}\n\nForce-block them anyway? (will block login to ALL their accounts)`)
        if (proceed) {
          await handlePortalAccessToggle(action, true)
          return
        }
      }

      toast.success(action === 'activate' ? 'Portal login restored' : 'Portal login blocked')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setPortalToggling(false)
    }
  }

  function getSdsForService(serviceType: string): ServiceDeliveryRow[] {
    if (!dbData) return []
    return dbData.service_deliveries.filter(sd => sd.service_type === serviceType)
  }

  const septemberRule = computeSeptemberRule(onboardingDate)

  async function toggleSection(key: string) {
    const snapshot = { ...sectionsDone }
    const wasDone = snapshot[key] ?? false
    const next = { ...snapshot, [key]: !wasDone }
    setSectionsDone(next)
    try {
      const res = await fetch(`/api/clients/audit/${account.id}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: key, confirmed: !wasDone, audit_sections: next }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setSectionsDone(snapshot) // revert optimistic on API error
        toast.error(d.error || 'Failed to save section')
      } else {
        const d = await res.json().catch(() => ({}))
        // Sync from DB-confirmed state if available (detects silent write failures)
        if (d.saved) setSectionsDone(d.saved)
        toast.success(!wasDone ? `Section marked done` : `Section unmarked`)
      }
    } catch {
      setSectionsDone(snapshot) // revert optimistic on network error
      toast.error('Network error — section not saved')
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const contactsPayload = localContacts
        .filter(c => contactEdits[c.id])
        .map(c => {
          const edits = contactEdits[c.id]
          const normalized: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(edits)) {
            normalized[k] = v === '' ? null : v
          }
          return { id: c.id, ...normalized }
        })

      const res = await fetch(`/api/clients/audit/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: {
            account_type: accountType || null,
            entity_type: entityType || null,
            state_of_formation: stateOfFormation || null,
            ein_number: ein || null,
            filing_id: filingId || null,
            physical_address: address || null,
            formation_date: formationDate || null,
            onboarding_date: onboardingDate || null,
            installment_1_amount: inst1 ? parseFloat(inst1) : null,
            installment_1_currency: currency || null,
            installment_2_amount: inst2 ? parseFloat(inst2) : null,
            installment_2_currency: currency || null,
            setup_fee_amount: setupAmount ? parseFloat(setupAmount) : null,
            setup_fee_invoice: setupInvoice || null,
            setup_fee_date: setupDate || null,
            notes: notes || null,
            status: status || null,
            audit_flag: flagged,
          },
          contacts: contactsPayload.length > 0 ? contactsPayload : undefined,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Save failed')
      const updatedContacts = localContacts.map(c =>
        contactEdits[c.id] ? { ...c, ...contactEdits[c.id] } : c
      )
      toast.success('Saved')
      onUpdated({
        ...account,
        account_type: accountType || null,
        entity_type: (entityType || null) as typeof account.entity_type,
        state_of_formation: stateOfFormation || null,
        ein_number: ein || null,
        filing_id: filingId || null,
        physical_address: address || null,
        formation_date: formationDate || null,
        onboarding_date: onboardingDate || null,
        installment_1_amount: inst1 ? parseFloat(inst1) : null,
        installment_1_currency: (currency || null) as typeof account.installment_1_currency,
        installment_2_amount: inst2 ? parseFloat(inst2) : null,
        installment_2_currency: (currency || null) as typeof account.installment_2_currency,
        setup_fee_amount: setupAmount ? parseFloat(setupAmount) : null,
        setup_fee_invoice: setupInvoice || null,
        setup_fee_date: setupDate || null,
        notes: notes || null,
        status: (status || null) as typeof account.status,
        audit_flag: flagged,
        contacts: updatedContacts,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleConfirm() {
    setConfirming(true)
    try {
      const res = await fetch(`/api/clients/audit/${account.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          services,
          reviewed_by: reviewer,
          audit_sections: sectionsDone,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Failed')
      toast.success(`Confirmed by ${reviewer}`)
      const now = new Date().toISOString()
      onUpdated({
        ...account,
        audit_reviewed_at: now,
        audit_reviewed_by: reviewer,
        onboarding_date: onboardingDate || null,
        audit_flag: false,
        status,
        audit_sections: sectionsDone,
      })
      setShowPostConfirm(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to confirm')
    } finally {
      setConfirming(false)
    }
  }

  function handlePostConfirmClose() {
    setShowPostConfirm(false)
    if (hasNext) onNext()
  }

  async function handleFlag() {
    const next = !flagged
    setFlagged(next)
    await fetch(`/api/clients/audit/${account.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: { audit_flag: next } }),
    }).catch(() => null)
    onUpdated({ ...account, audit_flag: next })
    toast(next ? 'Flagged for follow-up' : 'Flag removed')
  }

  return (
    <>
      <div className="p-4 space-y-4 max-w-3xl mx-auto pb-24">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{account.company_name}</h2>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full',
                status === 'Active' && 'bg-emerald-100 text-emerald-700',
                status === 'Delinquent' && 'bg-red-100 text-red-700',
                status === 'Offboarding' && 'bg-amber-100 text-amber-700',
                status === 'Suspended' && 'bg-orange-100 text-orange-700',
                !['Active', 'Delinquent', 'Offboarding', 'Suspended'].includes(status) && 'bg-zinc-100 text-zinc-600',
              )}>
                {status}
              </span>
              <span className="text-xs text-zinc-400">{position.current} / {position.total}</span>
              {account.audit_reviewed_at && (
                <span className="text-xs text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  {account.audit_reviewed_by ?? reviewer} · {fmt(account.audit_reviewed_at)}
                </span>
              )}
              {!onboardingDate && (
                <span className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> Missing start date
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {account.drive_folder_id && (
              <a
                href={`https://drive.google.com/drive/folders/${account.drive_folder_id}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Drive
              </a>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-zinc-800 text-white rounded-md hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </button>
          </div>
        </div>

        {/* Completeness summary bar */}
        {dbLoading ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border rounded-lg text-xs text-zinc-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Computing completeness…
          </div>
        ) : completeness ? (
          <div className="flex flex-wrap gap-2">
            <CompletenessChip label="Contact" result={completeness.contact} />
            <CompletenessChip label="Account" result={completeness.account} />
          </div>
        ) : null}

        {/* S1 — Contact(s) */}
        <Section
          icon={localContacts.length > 1 ? Users : User}
          title={localContacts.length > 1 ? `Contacts (${localContacts.length})` : 'Contact'}
          badge={account.entity_type?.includes('Multi') || account.entity_type?.includes('MMLLC') ? 'MMLLC' : undefined}
          done={sectionsDone['contacts']}
          onToggleDone={() => toggleSection('contacts')}
        >
          {localContacts.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-amber-600 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" /> No contacts linked — search to link or create one
              </p>
            </div>
          )}
          {localContacts.map((c, idx) => {
            // Compute missing fields for the audit indicator
            const missing: string[] = []
            if (!getContactValue(c, 'email')) missing.push('email')
            if (!getContactValue(c, 'phone')) missing.push('phone')
            if (!getContactValue(c, 'date_of_birth')) missing.push('DOB')
            if (!getContactValue(c, 'citizenship')) missing.push('citizenship')
            if (!getContactValue(c, 'passport_number')) missing.push('passport')
            if (!getContactValue(c, 'address_line1')) missing.push('address')
            return (
              <div key={c.id} className={cn('space-y-3', idx > 0 && 'pt-3 border-t')}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  {localContacts.length > 1 ? (
                    <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Contact {idx + 1}</p>
                  ) : <span />}
                  {missing.length > 0 ? (
                    <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded inline-flex items-center gap-1.5">
                      <AlertCircle className="h-3 w-3" />
                      Missing: {missing.join(', ')}
                    </span>
                  ) : (
                    <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded inline-flex items-center gap-1.5">
                      <CheckCircle2 className="h-3 w-3" />
                      All required fields present
                    </span>
                  )}
                </div>

                {/* Identity */}
                <div>
                  <p className="text-xs text-zinc-400 uppercase tracking-wide mb-1.5">Identity</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Full name"
                      value={getContactValue(c, 'full_name')}
                      onChange={v => setContactValue(c.id, 'full_name', v)}
                    />
                    <Field
                      label="Date of birth"
                      type="date"
                      value={getContactValue(c, 'date_of_birth')}
                      onChange={v => setContactValue(c.id, 'date_of_birth', v)}
                    />
                    <Field
                      label="Citizenship"
                      value={getContactValue(c, 'citizenship')}
                      onChange={v => setContactValue(c.id, 'citizenship', v)}
                    />
                    <Field
                      label="Language"
                      value={getContactValue(c, 'language')}
                      onChange={v => setContactValue(c.id, 'language', v)}
                    />
                  </div>
                </div>

                {/* Contact channels */}
                <div>
                  <p className="text-xs text-zinc-400 uppercase tracking-wide mb-1.5">Contact</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Email"
                      value={getContactValue(c, 'email')}
                      onChange={v => setContactValue(c.id, 'email', v)}
                    />
                    <Field
                      label="Phone"
                      value={getContactValue(c, 'phone')}
                      onChange={v => setContactValue(c.id, 'phone', v)}
                    />
                  </div>
                </div>

                {/* Documents */}
                <div>
                  <p className="text-xs text-zinc-400 uppercase tracking-wide mb-1.5">Documents</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Passport number"
                      value={getContactValue(c, 'passport_number')}
                      onChange={v => setContactValue(c.id, 'passport_number', v)}
                    />
                    <Field
                      label="Passport expiry"
                      type="date"
                      value={getContactValue(c, 'passport_expiry_date')}
                      onChange={v => setContactValue(c.id, 'passport_expiry_date', v)}
                    />
                    <Field
                      label="ITIN"
                      value={getContactValue(c, 'itin_number')}
                      onChange={v => setContactValue(c.id, 'itin_number', v)}
                    />
                    <div className="flex items-end gap-3 text-xs">
                      <span className={cn(
                        'px-2 py-1 rounded',
                        c.passport_on_file
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-zinc-100 text-zinc-500'
                      )}>
                        Passport on file: {c.passport_on_file ? 'yes' : 'no'}
                      </span>
                      {c.kyc_status && (
                        <span className="px-2 py-1 rounded bg-zinc-100 text-zinc-700">
                          KYC: {c.kyc_status}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Address */}
                <div>
                  <p className="text-xs text-zinc-400 uppercase tracking-wide mb-1.5">Address</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <Field
                        label="Street address"
                        value={getContactValue(c, 'address_line1')}
                        onChange={v => setContactValue(c.id, 'address_line1', v)}
                      />
                    </div>
                    <Field
                      label="City"
                      value={getContactValue(c, 'address_city')}
                      onChange={v => setContactValue(c.id, 'address_city', v)}
                    />
                    <Field
                      label="State / Province"
                      value={getContactValue(c, 'address_state')}
                      onChange={v => setContactValue(c.id, 'address_state', v)}
                    />
                    <Field
                      label="ZIP / Postal"
                      value={getContactValue(c, 'address_zip')}
                      onChange={v => setContactValue(c.id, 'address_zip', v)}
                    />
                    <Field
                      label="Country"
                      value={getContactValue(c, 'address_country')}
                      onChange={v => setContactValue(c.id, 'address_country', v)}
                    />
                  </div>
                </div>

              </div>
            )
          })}

          {/* Contact search / link / create */}
          <div className={cn('pt-3 space-y-2', localContacts.length > 0 && 'border-t')}>
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
              {localContacts.length === 0 ? 'Link or create contact' : 'Add another contact'}
            </p>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search by name, email, or phone…"
                value={contactSearch}
                onChange={e => handleContactSearchChange(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {contactSearching && <Loader2 className="absolute right-2.5 top-2.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>

            {contactResults.length > 0 && (
              <div className="border rounded-md divide-y overflow-hidden">
                {contactResults.map(r => (
                  <button
                    key={r.id}
                    onClick={() => handleLinkContact(r.id)}
                    disabled={linkingContact || localContacts.some(c => c.id === r.id)}
                    className="w-full text-left px-3 py-2 hover:bg-blue-50 disabled:opacity-50 flex items-center justify-between gap-2"
                  >
                    <div>
                      <p className="text-sm font-medium">{r.full_name}</p>
                      {r.email && <p className="text-xs text-zinc-500">{r.email}</p>}
                      {r.phone && <p className="text-xs text-zinc-500">{r.phone}</p>}
                    </div>
                    {localContacts.some(c => c.id === r.id)
                      ? <span className="text-xs text-zinc-400">Already linked</span>
                      : <span className="text-xs text-blue-600 font-medium">Link</span>
                    }
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={() => setShowCreateContact(v => !v)}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {showCreateContact ? 'Cancel new contact' : 'Create new contact'}
            </button>

            {showCreateContact && (
              <div className="border rounded-md p-3 space-y-2 bg-zinc-50">
                <div className="grid grid-cols-2 gap-2">
                  {(['full_name', 'email', 'phone', 'language', 'citizenship'] as const).map(f => (
                    <div key={f} className={f === 'full_name' ? 'col-span-2' : ''}>
                      <label className="text-xs font-medium text-zinc-500 capitalize">{f.replace('_', ' ')}</label>
                      <input
                        type="text"
                        value={newContact[f]}
                        onChange={e => setNewContact(prev => ({ ...prev, [f]: e.target.value }))}
                        className="w-full mt-0.5 px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder={f === 'full_name' ? 'Required' : ''}
                      />
                    </div>
                  ))}
                </div>
                <button
                  onClick={handleCreateContact}
                  disabled={linkingContact || !newContact.full_name.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                >
                  {linkingContact ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
                  Create & link
                </button>
              </div>
            )}
          </div>

          {/* Members (for MMLLC) */}
          {!dbLoading && (dbData?.members.length ?? 0) > 0 && (
            <div className="pt-3 border-t">
              <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-2">
                Members table ({dbData!.members.length})
              </p>
              <div className="space-y-3">
                {dbData!.members.map(m => {
                  const isCompanyMember = m.member_type?.toLowerCase().includes('company') || !!m.company_name
                  const memberMissing: string[] = []
                  if (!m.full_name && !m.company_name) memberMissing.push('name')
                  if (!m.email) memberMissing.push('email')
                  if (m.ownership_pct == null) memberMissing.push('ownership %')
                  if (!m.address_street) memberMissing.push('street')
                  if (!m.address_city) memberMissing.push('city')
                  if (!m.address_state) memberMissing.push('state')
                  if (!m.address_zip) memberMissing.push('ZIP')
                  if (!m.address_country) memberMissing.push('country')
                  if (isCompanyMember) {
                    if (!m.ein) memberMissing.push('EIN')
                    if (!m.representative_name) memberMissing.push('representative')
                  }
                  return (
                    <div key={m.id} className="border rounded-md p-3 space-y-2 bg-zinc-50/50">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn(
                            'text-xs px-2 py-0.5 rounded',
                            m.is_primary ? 'bg-blue-100 text-blue-700' : 'bg-zinc-100 text-zinc-600'
                          )}>
                            {m.is_primary ? 'Primary' : m.member_type ?? 'Member'}
                          </span>
                          {m.is_signer && (
                            <span className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700">Signer</span>
                          )}
                          {isCompanyMember && (
                            <span className="text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">Company</span>
                          )}
                          <span className="font-medium text-sm">
                            {m.company_name || m.full_name || '(no name)'}
                          </span>
                          {m.ownership_pct != null && (
                            <span className="text-xs text-zinc-500">{m.ownership_pct}%</span>
                          )}
                        </div>
                        {memberMissing.length > 0 ? (
                          <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded inline-flex items-center gap-1.5">
                            <AlertCircle className="h-3 w-3" />
                            Missing: {memberMissing.join(', ')}
                          </span>
                        ) : (
                          <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded inline-flex items-center gap-1.5">
                            <CheckCircle2 className="h-3 w-3" />
                            Complete
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        {isCompanyMember && (
                          <>
                            <div><span className="text-zinc-400">Company:</span> {m.company_name ?? <em className="text-amber-600">missing</em>}</div>
                            <div><span className="text-zinc-400">EIN:</span> {m.ein ?? <em className="text-amber-600">missing</em>}</div>
                          </>
                        )}
                        {!isCompanyMember && (
                          <div className="col-span-2"><span className="text-zinc-400">Name:</span> {m.full_name ?? <em className="text-amber-600">missing</em>}</div>
                        )}
                        <div><span className="text-zinc-400">Email:</span> {m.email ?? <em className="text-amber-600">missing</em>}</div>
                        <div><span className="text-zinc-400">Phone:</span> {m.phone ?? <em className="text-zinc-400">—</em>}</div>
                      </div>

                      <div>
                        <p className="text-xs text-zinc-400 uppercase tracking-wide mb-0.5">Address</p>
                        <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-0.5">
                          <div className="col-span-2">
                            <span className="text-zinc-400">Street:</span> {m.address_street ?? <em className="text-amber-600">missing</em>}
                          </div>
                          <div><span className="text-zinc-400">City:</span> {m.address_city ?? <em className="text-amber-600">missing</em>}</div>
                          <div><span className="text-zinc-400">State:</span> {m.address_state ?? <em className="text-amber-600">missing</em>}</div>
                          <div><span className="text-zinc-400">ZIP:</span> {m.address_zip ?? <em className="text-amber-600">missing</em>}</div>
                          <div><span className="text-zinc-400">Country:</span> {m.address_country ?? <em className="text-amber-600">missing</em>}</div>
                        </div>
                      </div>

                      {isCompanyMember && (
                        <div>
                          <p className="text-xs text-zinc-400 uppercase tracking-wide mb-0.5">Representative</p>
                          <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-0.5">
                            <div><span className="text-zinc-400">Name:</span> {m.representative_name ?? <em className="text-amber-600">missing</em>}</div>
                            <div><span className="text-zinc-400">Email:</span> {m.representative_email ?? <em className="text-amber-600">missing</em>}</div>
                            <div><span className="text-zinc-400">Phone:</span> {m.representative_phone ?? <em className="text-zinc-400">—</em>}</div>
                            <div className="col-span-2">
                              <span className="text-zinc-400">Address:</span>{' '}
                              {[m.representative_address_street, m.representative_address_city, m.representative_address_state, m.representative_address_zip, m.representative_address_country]
                                .filter(Boolean).join(', ') || <em className="text-amber-600">missing</em>}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </Section>

        {/* S2 — Type & Company */}
        <Section
          icon={Building2}
          title="Type & Company"
          done={sectionsDone['type']}
          onToggleDone={() => toggleSection('type')}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Account type</label>
              <select
                value={accountType}
                onChange={e => setAccountType(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select —</option>
                {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">DB: {account.account_type ?? '—'}</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Entity type</label>
              <select
                value={entityType}
                onChange={e => setEntityType(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select —</option>
                {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">DB: {account.entity_type ?? '—'}</p>
            </div>
            <Field
              label="State of formation"
              value={stateOfFormation}
              onChange={setStateOfFormation}
              hint={`DB: ${account.state_of_formation ?? '—'}`}
            />
            <Field
              label="EIN"
              value={ein}
              onChange={setEin}
              hint={`DB: ${account.ein_number ?? '—'}`}
            />
            <Field
              label="State Filing ID"
              value={filingId}
              onChange={setFilingId}
              hint={`From Articles of Organization · DB: ${account.filing_id ?? '—'}`}
            />
            <div className="col-span-2">
              <Field
                label="Business / CMRA address"
                value={address}
                onChange={setAddress}
              />
            </div>
          </div>

        </Section>

        {/* S_legal — Legal Address */}
        <Section
          icon={MapPin}
          title="Legal Address"
          done={sectionsDone['legal_address']}
          onToggleDone={() => toggleSection('legal_address')}
        >
          <AddressPicker
            accountId={account.id}
            accountUpdatedAt={acctUpdatedAt}
            kind="business_legal"
            value={legalAddressId}
            verified={legalVerified}
            onChange={refreshAddressData}
          />
        </Section>

        {/* S_mailing — Mailing Address */}
        <Section
          icon={MapPin}
          title="Mailing Address"
          done={sectionsDone['mailing_address']}
          onToggleDone={() => toggleSection('mailing_address')}
        >
          <AddressPicker
            accountId={account.id}
            accountUpdatedAt={acctUpdatedAt}
            kind="business_mailing"
            value={mailingAddressId}
            verified={mailingVerified}
            onChange={refreshAddressData}
          />
        </Section>

        {/* S_ra — Registered Agent */}
        <Section
          icon={MapPin}
          title="Registered Agent"
          done={sectionsDone['registered_agent']}
          onToggleDone={() => toggleSection('registered_agent')}
        >
          <RAPicker
            accountId={account.id}
            accountUpdatedAt={acctUpdatedAt}
            value={raId}
            verified={raVerified}
            onChange={refreshAddressData}
          />
        </Section>

        {/* S_ss4 — SS-4 Readiness (C6) */}
        {!dbLoading && (() => {
          const formationActive = services['company_formation'] === 'active'
          const hasEin = !!ein

          // Is the company older than 2 months? (IRS max processing window)
          const twoMonthsAgo = new Date()
          twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2)
          const olderThan2Months = formationDate ? new Date(formationDate) < twoMonthsAgo : false

          // Case 1: EIN present — SS-4 already done
          if (hasEin) {
            return (
              <Section icon={FileText} title="SS-4 Readiness" done={sectionsDone['ss4_readiness']} onToggleDone={() => toggleSection('ss4_readiness')}>
                <div className="flex items-center gap-2 py-1">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <span className="text-sm text-emerald-700 font-medium">EIN on file — SS-4 already processed</span>
                </div>
              </Section>
            )
          }

          // Case 2: Company Formation not active — EIN missing is a data gap, not an SS-4 action
          if (!formationActive) {
            return (
              <Section icon={FileText} title="SS-4 Readiness" done={sectionsDone['ss4_readiness']} onToggleDone={() => toggleSection('ss4_readiness')}>
                <div className="flex items-start gap-2 px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-md">
                  <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-xs text-amber-700">
                    {olderThan2Months
                      ? 'Company is older than 2 months — EIN should already exist. Enter the EIN number in Company Info.'
                      : 'Company Formation not active — EIN missing is a data entry gap, not an SS-4 action.'}
                  </span>
                </div>
              </Section>
            )
          }

          // Case 3: Company Formation active + no EIN — SS-4 readiness applies
          const isMMLC = entityType?.toLowerCase().includes('multi') || entityType?.toLowerCase().includes('mmllc') || entityType?.toLowerCase().includes('multi-member')
          const primaryContact = localContacts[0] ?? null

          const blockers: { key: string; label: string }[] = []
          if (localContacts.length === 0) blockers.push({ key: 'no_contacts', label: 'No contacts linked to this account' })
          if (!stateOfFormation) blockers.push({ key: 'no_sof', label: 'State of formation is missing' })
          if (!raId) blockers.push({ key: 'no_ra', label: 'Registered Agent not linked' })
          if (raId && raCounty === null) blockers.push({ key: 'ra_no_county', label: 'Registered Agent row is missing the county field' })

          const warnings: { key: string; label: string }[] = []
          if (olderThan2Months) warnings.push({ key: 'overdue_ein', label: 'Company is older than 2 months — EIN should have arrived already. Check with IRS or enter if received.' })
          if (!formationDate) warnings.push({ key: 'no_formation_date', label: 'Formation date missing (used in SS-4 header)' })
          if (primaryContact && !getContactValue(primaryContact, 'itin_number')) warnings.push({ key: 'no_itin', label: 'Primary contact has no ITIN — will default to "Foreigner" on form' })
          if (!entityType) warnings.push({ key: 'no_entity_type', label: 'Entity type unknown — will default to SMLLC' })
          if (isMMLC && localContacts.length < 2) warnings.push({ key: 'mmllc_contacts', label: `MMLLC has only ${localContacts.length} contact(s) — typically needs 2+ members` })

          const ready = blockers.length === 0

          return (
            <Section
              icon={FileText}
              title="SS-4 Readiness"
              done={sectionsDone['ss4_readiness']}
              onToggleDone={() => toggleSection('ss4_readiness')}
            >
              {ready && warnings.length === 0 ? (
                <div className="flex items-center gap-2 py-1">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <span className="text-sm text-emerald-700 font-medium">Ready — all required fields are present</span>
                </div>
              ) : ready ? (
                <div className="flex items-center gap-2 py-0.5 mb-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <span className="text-sm text-emerald-700 font-medium">No blockers — can generate SS-4</span>
                </div>
              ) : null}

              {blockers.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-red-600 uppercase tracking-wide">Blockers — generation will fail</p>
                  {blockers.map(b => (
                    <div key={b.key} className="flex items-start gap-2 px-2.5 py-1.5 bg-red-50 border border-red-200 rounded-md">
                      <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                      <span className="text-xs text-red-700">{b.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {warnings.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-amber-600 uppercase tracking-wide">Warnings — generation proceeds but check these</p>
                  {warnings.map(w => (
                    <div key={w.key} className="flex items-start gap-2 px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-md">
                      <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                      <span className="text-xs text-amber-700">{w.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )
        })()}

        {/* S3 — Dates */}
        <Section
          icon={Calendar}
          title="Dates"
          done={sectionsDone['dates']}
          onToggleDone={() => toggleSection('dates')}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="LLC formation date"
              value={formationDate}
              onChange={setFormationDate}
              type="date"
              hint={`DB: ${account.formation_date ?? '—'}`}
            />
            <Field
              label="TD start date (onboarding_date) ★"
              value={onboardingDate}
              onChange={setOnboardingDate}
              type="date"
              hint="Check signed MSA or SOP date in Drive / Gmail"
            />
          </div>
          {!onboardingDate && (
            <p className="text-xs text-amber-600 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              Required — look up signed agreement date from Drive or Gmail
            </p>
          )}
          {onboardingDate && (
            <div className="pt-2 border-t grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">September rule</p>
                <p className={cn('text-sm font-medium mt-0.5', septemberRule.skip ? 'text-amber-600' : 'text-zinc-700')}>
                  {septemberRule.label}
                </p>
              </div>
              {septemberRule.yearNum && (
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">Current billing year</p>
                  <p className="text-sm font-medium mt-0.5">Year {septemberRule.yearNum}</p>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* S4 — Billing */}
        <Section
          icon={DollarSign}
          title="Billing"
          badge={
            dbLoading ? 'Loading…' :
            billingStatus?.isNA ? 'N/A' :
            billingStatus?.hasGap ? '⚠ Gap detected' :
            billingStatus ? '✓ Complete' :
            undefined
          }
          done={sectionsDone['billing']}
          onToggleDone={() => toggleSection('billing')}
        >
          {/* Billing status checklist */}
          {!dbLoading && billingStatus && (
            <div className="space-y-1">
              {billingStatus.checks.map(chk => (
                <BillingCheckRow
                  key={chk.key}
                  status={chk.status}
                  label={chk.label}
                  context={chk.context}
                  paymentId={chk.paymentId ?? null}
                  invoiceNumber={chk.invoiceNumber ?? null}
                />
              ))}
            </div>
          )}
          {dbLoading && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading billing data…
            </div>
          )}

          <div className="pt-3 border-t grid grid-cols-3 gap-3">
            <Field
              label="Jan installment"
              value={inst1}
              onChange={setInst1}
              hint={`DB: ${account.installment_1_amount ?? '—'}`}
            />
            <Field
              label="Jun installment"
              value={inst2}
              onChange={setInst2}
              hint={`DB: ${account.installment_2_amount ?? '—'}`}
            />
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Currency</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 pt-1">
            <Field
              label="Setup fee amount"
              value={setupAmount}
              onChange={setSetupAmount}
              hint={`DB: ${account.setup_fee_amount ?? '—'}`}
            />
            <Field
              label="Setup fee invoice #"
              value={setupInvoice}
              onChange={setSetupInvoice}
              hint={`DB: ${account.setup_fee_invoice ?? '—'}`}
            />
            <Field
              label="Setup fee date"
              value={setupDate}
              onChange={setSetupDate}
              type="date"
              hint={`DB: ${account.setup_fee_date ?? '—'}`}
            />
          </div>
          {/* Payment history */}
          {!dbLoading && (dbData?.payments.length ?? 0) > 0 && (
            <div className="pt-2 border-t">
              <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-1.5">
                Payments (last 20)
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-zinc-400 border-b">
                      <th className="text-left py-1 pr-2 font-medium">Invoice</th>
                      <th className="text-left py-1 pr-2 font-medium">Description</th>
                      <th className="text-right py-1 pr-2 font-medium">Amount</th>
                      <th className="text-left py-1 pr-2 font-medium">Due</th>
                      <th className="text-left py-1 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dbData!.payments.map(p => (
                      <tr key={p.id} className="border-b border-zinc-50">
                        <td className="py-1.5 pr-2 font-mono">
                          {p.invoice_number ? (
                            <a
                              href={`/api/invoices/${p.id}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                              title="Open invoice PDF"
                            >
                              {p.invoice_number}
                            </a>
                          ) : '—'}
                        </td>
                        <td className="py-1.5 pr-2 max-w-[160px] truncate">
                          {p.description ?? p.installment ?? p.period ?? '—'}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {fmtAmt(p.amount, p.amount_currency)}
                        </td>
                        <td className="py-1.5 pr-2">{fmt(p.due_date)}</td>
                        <td className="py-1.5">
                          <span className={cn(
                            'px-1.5 py-0.5 rounded',
                            p.status === 'Paid' || p.invoice_status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
                            p.status === 'Overdue' ? 'bg-red-100 text-red-700' :
                            p.status === 'Pending' ? 'bg-amber-100 text-amber-700' :
                            'bg-zinc-100 text-zinc-600'
                          )}>
                            {p.invoice_status ?? p.status ?? '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Step 13 — Other paid services & feed cleanup */}
          <FeedCleanupSubsection
            accountId={account.id}
            orphanFeeds={dbData?.orphan_feeds ?? []}
            mercuryDuplicates={dbData?.mercury_duplicates ?? []}
            loading={dbLoading}
            refetchDbData={async () => {
              const r = await fetch(`/api/clients/audit/${account.id}/data`, { cache: 'no-store' })
              if (r.ok) setDbData(await r.json() as AccountData)
            }}
          />
        </Section>

        {/* S5 — Services */}
        <Section
          icon={Briefcase}
          title="Services"
          badge={dbLoading ? 'Loading…' : `${dbData?.service_deliveries.length ?? 0} SDs in DB`}
          done={sectionsDone['services']}
          onToggleDone={() => toggleSection('services')}
        >
          <p className="text-xs text-muted-foreground -mt-1">
            Confirm what each client actually has. Annual Renewal is now tracked separately (below).
          </p>
          {SERVICES.map(s => (
            <ServiceRadio
              key={s.key}
              label={s.label}
              value={services[s.key]}
              onChange={v => setServices(prev => ({ ...prev, [s.key]: v }))}
              sds={getSdsForService(s.serviceType)}
            />
          ))}
        </Section>

        {/* S6 — Tax Returns */}
        <Section
          icon={FileText}
          title="Tax Returns"
          badge={dbLoading ? 'Loading…' : `${dbData?.tax_returns.length ?? 0} rows`}
          done={sectionsDone['tax']}
          onToggleDone={() => toggleSection('tax')}
        >
          {dbLoading && <p className="text-xs text-zinc-400">Loading…</p>}
          {!dbLoading && (dbData?.tax_returns.length ?? 0) === 0 && (
            <p className="text-xs text-zinc-400 italic">No tax returns in DB</p>
          )}
          {!dbLoading && (dbData?.tax_returns.length ?? 0) > 0 && (
            <div className="space-y-3">
              {dbData!.tax_returns.map(tr => {
                const submission = dbData!.tax_return_submissions.find(s => s.tax_year === tr.tax_year)
                const anomaly = tr.data_received && (!submission || !submission.completed_at)
                const editedStatus = taxEdits[tr.id]?.status ?? tr.status ?? ''
                const editedDataReceived = taxEdits[tr.id]?.data_received ?? tr.data_received ?? false

                return (
                  <div
                    key={tr.id}
                    className={cn(
                      'border rounded-lg p-3 space-y-2',
                      anomaly && 'border-amber-200 bg-amber-50'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{tr.tax_year}</span>
                      <span className="text-xs text-zinc-500">{tr.return_type}</span>
                      {anomaly && (
                        <span className="text-xs text-amber-700 flex items-center gap-0.5 ml-auto">
                          <AlertCircle className="h-3 w-3" /> data_received=true but no submission
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-0.5">
                        <p className="text-xs text-zinc-500 font-medium">Status</p>
                        <select
                          value={editedStatus}
                          onChange={e => setTaxEdits(prev => ({
                            ...prev,
                            [tr.id]: { ...(prev[tr.id] ?? {}), status: e.target.value }
                          }))}
                          className="w-full px-1.5 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="">—</option>
                          {TAX_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        {(taxEdits[tr.id]?.status !== undefined && taxEdits[tr.id]?.status !== tr.status) && (
                          <p className="text-xs text-orange-600">DB: {tr.status ?? '—'}</p>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-xs text-zinc-500 font-medium">Data received</p>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editedDataReceived}
                            onChange={e => setTaxEdits(prev => ({
                              ...prev,
                              [tr.id]: { ...(prev[tr.id] ?? {}), data_received: e.target.checked }
                            }))}
                            className="rounded border-zinc-300"
                          />
                          <span className="text-xs">{editedDataReceived ? 'Yes' : 'No'}</span>
                        </label>
                        {tr.data_received_date && (
                          <p className="text-xs text-zinc-400">{fmt(tr.data_received_date)}</p>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-xs text-zinc-500 font-medium">Submission</p>
                        <p className="text-xs">
                          {submission
                            ? submission.completed_at
                              ? <span className="text-emerald-600">✓ {fmt(submission.completed_at)}</span>
                              : <span className="text-amber-600">Opened, not submitted</span>
                            : <span className="text-zinc-400">No row</span>
                          }
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-4 text-xs text-zinc-500">
                      <span>Paid: {tr.paid ? <span className="text-emerald-600">✓</span> : '—'}</span>
                      <span>India: {tr.india_status ?? '—'}</span>
                      <span>Extension: {tr.extension_filed ? `Filed → ${fmt(tr.extension_deadline)}` : '—'}</span>
                      <span>Link sent: {tr.link_sent ? '✓' : '—'}</span>
                      <span>Deadline: {fmt(tr.deadline)}</span>
                    </div>
                    {tr.notes && (
                      <p className="text-xs text-zinc-500 italic">{tr.notes}</p>
                    )}
                  </div>
                )
              })}
              {Object.keys(taxEdits).length > 0 && (
                <button
                  onClick={async () => {
                    for (const [trId, edits] of Object.entries(taxEdits)) {
                      if (!edits || Object.keys(edits).length === 0) continue
                      await fetch(`/api/tax-returns/${trId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(edits),
                      }).catch(() => null)
                    }
                    toast.success('Tax return edits saved')
                    setTaxEdits({})
                  }}
                  className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded-md hover:bg-amber-700"
                >
                  Save tax return edits
                </button>
              )}
            </div>
          )}
        </Section>

        {/* S7 — Portal visibility */}
        <Section
          icon={Globe}
          title="Portal visibility"
          done={sectionsDone['portal']}
          onToggleDone={() => toggleSection('portal')}
        >
          {dbLoading && <p className="text-xs text-zinc-400">Loading…</p>}
          {!dbLoading && dbData && (
            <div className="space-y-3">
              {/* Per-contact portal status */}
              {dbData.contacts_with_tier.map(c => {
                const banned = !!(c.email && dbData.auth_banned_map?.[c.email])
                return (
                  <div key={c.id} className="flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{c.full_name}</span>
                      {c.email && <span className="text-xs text-zinc-400 ml-2">{c.email}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs">
                      {c.email && dbData.auth_user_map[c.email] && (
                        <span className={cn(
                          'px-1.5 py-0.5 rounded',
                          banned
                            ? 'bg-red-100 text-red-700'
                            : 'bg-emerald-100 text-emerald-700'
                        )}>
                          {banned ? '⛔ Login blocked' : '✓ Can log in'}
                        </span>
                      )}
                      {c.email && !dbData.auth_user_map[c.email] && (
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">No auth user</span>
                      )}
                      <span className={cn(
                        'px-1.5 py-0.5 rounded capitalize',
                        c.portal_tier === 'active' ? 'bg-blue-100 text-blue-700' :
                        c.portal_tier === 'onboarding' ? 'bg-purple-100 text-purple-700' :
                        c.portal_tier === 'formation' ? 'bg-orange-100 text-orange-700' :
                        c.portal_tier === 'lead' ? 'bg-zinc-100 text-zinc-600' :
                        'bg-zinc-100 text-zinc-400'
                      )}>
                        {c.portal_tier ?? 'no tier'}
                      </span>
                    </div>
                  </div>
                )
              })}

              {/* Block / Restore portal login */}
              {(() => {
                // Determine current state from auth-user banned map (not tier)
                const contactsWithAuth = dbData.contacts_with_tier.filter(c => c.email && dbData.auth_user_map[c.email])
                const allBanned = contactsWithAuth.length > 0 && contactsWithAuth.every(c => !!dbData.auth_banned_map?.[c.email!])
                const anyCanLogIn = contactsWithAuth.some(c => !dbData.auth_banned_map?.[c.email!])
                const noContacts = dbData.contacts_with_tier.length === 0
                // For accounts with no contacts, fall back to account.portal_tier as the activity indicator
                const showDeactivate = anyCanLogIn || (noContacts && portalTierLocal === 'active')
                const showActivate = (allBanned && contactsWithAuth.length > 0) || (noContacts && portalTierLocal !== 'active')

                return (
                  <div className="pt-2 border-t flex items-center justify-between gap-3">
                    <div className="text-xs space-y-0.5">
                      <div>
                        <span className="text-zinc-500 font-medium uppercase tracking-wide">Account tier:</span>{' '}
                        <span className={cn(
                          'px-1.5 py-0.5 rounded capitalize',
                          portalTierLocal === 'active' ? 'bg-blue-100 text-blue-700' :
                          portalTierLocal === 'onboarding' ? 'bg-purple-100 text-purple-700' :
                          portalTierLocal === 'formation' ? 'bg-orange-100 text-orange-700' :
                          portalTierLocal === 'lead' ? 'bg-zinc-100 text-zinc-600' :
                          'bg-zinc-100 text-zinc-400'
                        )}>
                          {portalTierLocal ?? 'no tier'}
                        </span>
                        <span className="text-zinc-400 ml-2">(unchanged by toggle)</span>
                      </div>
                      {!noContacts && (
                        <div className="text-zinc-500">
                          {anyCanLogIn ? 'At least one contact can currently log in' : allBanned ? 'All contacts blocked from login' : 'No auth users to evaluate'}
                        </div>
                      )}
                    </div>
                    {showDeactivate ? (
                      <button
                        onClick={() => handlePortalAccessToggle('deactivate')}
                        disabled={portalToggling}
                        className="px-3 py-1.5 text-xs font-medium border border-red-200 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {portalToggling ? <Loader2 className="h-3 w-3 animate-spin" /> : <AlertCircle className="h-3 w-3" />}
                        Block Portal Login
                      </button>
                    ) : showActivate ? (
                      <button
                        onClick={() => handlePortalAccessToggle('activate')}
                        disabled={portalToggling}
                        className="px-3 py-1.5 text-xs font-medium border border-emerald-200 text-emerald-700 rounded-md hover:bg-emerald-50 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {portalToggling ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                        Restore Portal Login
                      </button>
                    ) : null}
                  </div>
                )
              })()}

              {/* What they see */}
              <div className="pt-2 border-t">
                <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-1.5">What this client sees</p>
                <div className="space-y-1 text-xs">
                  {portalTierLocal === 'active' && (
                    <>
                      <div className="flex items-center gap-1.5 text-emerald-600">
                        <CheckCircle2 className="h-3 w-3" /> Full portal (services, documents, invoices, chat)
                      </div>
                      <div className="flex items-center gap-1.5 text-zinc-500">
                        <CheckCircle2 className="h-3 w-3" />
                        {dbData.service_deliveries.filter(sd => sd.status === 'Active').length} active services visible
                      </div>
                      {dbData.tax_returns.length > 0 && (
                        <div className="flex items-center gap-1.5 text-zinc-500">
                          <CheckCircle2 className="h-3 w-3" />
                          {dbData.tax_returns.length} tax return(s) in tax portal
                        </div>
                      )}
                      {dbData.annual_agreements.length > 0 && (
                        <div className="flex items-center gap-1.5 text-zinc-500">
                          <CheckCircle2 className="h-3 w-3" />
                          Annual agreement {dbData.annual_agreements[0].agreement_year}: {dbData.annual_agreements[0].status ?? '—'}
                        </div>
                      )}
                    </>
                  )}
                  {portalTierLocal === 'onboarding' && (
                    <div className="flex items-center gap-1.5 text-purple-600">
                      <CheckCircle2 className="h-3 w-3" /> Onboarding wizard only
                    </div>
                  )}
                  {portalTierLocal === 'formation' && (
                    <div className="flex items-center gap-1.5 text-orange-600">
                      <CheckCircle2 className="h-3 w-3" /> Formation status page only
                    </div>
                  )}
                  {portalTierLocal === 'lead' && (
                    <div className="flex items-center gap-1.5 text-zinc-500">
                      <CheckCircle2 className="h-3 w-3" /> Lead landing page only
                    </div>
                  )}
                  {!portalTierLocal && (
                    <div className="text-zinc-400 italic">No portal tier — not accessible</div>
                  )}
                </div>
              </div>

              {/* Annual agreements */}
              {dbData.annual_agreements.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-1.5">Annual agreements</p>
                  <div className="space-y-1">
                    {dbData.annual_agreements.map(ag => (
                      <div key={ag.id} className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{ag.agreement_year}</span>
                        <span className={cn(
                          'px-1.5 py-0.5 rounded',
                          ag.status === 'signed' ? 'bg-emerald-100 text-emerald-700' :
                          ag.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                          'bg-zinc-100 text-zinc-600'
                        )}>
                          {ag.status ?? '—'}
                        </span>
                        {ag.skip_january && <span className="text-amber-600">skip Jan</span>}
                        <span className="text-zinc-400 ml-auto">{fmt(ag.created_at)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* S8 — Status & Notes */}
        <Section
          icon={FileText}
          title="Status & Notes"
          done={sectionsDone['status']}
          onToggleDone={() => toggleSection('status')}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Account status</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {ACCOUNT_STATUSES.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">DB: {account.status ?? '—'}</p>
            </div>
            <div className="flex items-end pb-5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flagged}
                  onChange={e => setFlagged(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                <div className="flex items-center gap-1 text-sm">
                  <Flag className="h-3.5 w-3.5 text-amber-500" />
                  Flag for follow-up
                </div>
              </label>
            </div>
          </div>
          {account.notes && (
            <div className="space-y-1">
              <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide">Existing notes (read-only)</p>
              <p className="text-xs text-zinc-600 bg-zinc-50 rounded p-2 whitespace-pre-wrap">{account.notes}</p>
            </div>
          )}
          <Field
            label={account.notes ? 'Append to notes' : 'Notes'}
            value={notes}
            onChange={setNotes}
            type="textarea"
          />
        </Section>
      </div>

      {/* Bottom navigation — fixed */}
      <div className="fixed bottom-0 right-0 left-72 bg-white border-t px-6 py-3 flex items-center gap-3 z-10">
        <button
          onClick={onPrev}
          disabled={!hasPrev}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </button>

        <div className="flex-1" />

        <button
          onClick={handleFlag}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 text-sm border rounded-md transition-colors',
            flagged
              ? 'bg-amber-50 border-amber-300 text-amber-700'
              : 'hover:bg-zinc-50 text-zinc-600'
          )}
        >
          <Flag className="h-4 w-4" />
          {flagged ? 'Flagged' : 'Flag'}
        </button>

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>

        <button
          onClick={handleConfirm}
          disabled={confirming}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-colors',
            'bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50'
          )}
        >
          {confirming
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <CheckCircle2 className="h-4 w-4" />
          }
          Confirm & Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {showPostConfirm && (
        <PostConfirmPanel onClose={handlePostConfirmClose} />
      )}
    </>
  )
}
