'use client'

import { useState } from 'react'
import { Share2, Users, TrendingUp, Wallet, Copy, Check, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { ReferralRow } from './page'

interface Props {
  referrals: ReferralRow[]
  stats: {
    totalReferrals: number
    pendingCommission: number
    totalPaidOut: number
    conversionRate: number
  }
  referrers: Array<{
    id: string
    name: string
    code: string | null
    count: number
    commission: number
  }>
}

const statusConfig: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-yellow-100 text-yellow-800' },
  converted: { label: 'Converted', color: 'bg-blue-100 text-blue-800' },
  credited: { label: 'Credited', color: 'bg-green-100 text-green-800' },
  paid: { label: 'Paid', color: 'bg-emerald-100 text-emerald-800' },
  cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
}

const typeConfig: Record<string, { label: string; color: string }> = {
  client: { label: 'Client', color: 'bg-zinc-100 text-zinc-700' },
  partner: { label: 'Partner', color: 'bg-violet-100 text-violet-700' },
}

export function ReferralsDashboard({ referrals, stats, referrers }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filtered = referrals.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (typeFilter !== 'all' && r.referrer_type !== typeFilter) return false
    return true
  })

  const copyLink = (code: string) => {
    navigator.clipboard.writeText(`https://tonydurante.us/r/${code}`)
    setCopiedCode(code)
    toast.success('Referral link copied')
    setTimeout(() => setCopiedCode(null), 2000)
  }

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Share2 className="h-6 w-6 text-zinc-600" />
          <div>
            <h1 className="text-xl font-semibold">Referrals</h1>
            <p className="text-sm text-zinc-500">Track referrals, commissions, and payouts</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard icon={Users} label="Total Referrals" value={String(stats.totalReferrals)} />
        <StatCard icon={TrendingUp} label="Conversion Rate" value={`${stats.conversionRate}%`} />
        <StatCard icon={Wallet} label="Pending Commission" value={`€${stats.pendingCommission.toLocaleString()}`} color="text-amber-600" />
        <StatCard icon={Wallet} label="Total Paid Out" value={`€${stats.totalPaidOut.toLocaleString()}`} color="text-emerald-600" />
      </div>

      {/* Top Referrers */}
      {referrers.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-5">
          <h2 className="text-sm font-semibold text-zinc-700 mb-3">Top Referrers</h2>
          <div className="divide-y">
            {referrers.slice(0, 10).map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-violet-100 flex items-center justify-center text-violet-700 text-xs font-semibold">
                    {r.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <span className="text-sm font-medium">{r.name}</span>
                    {r.code && (
                      <span className="ml-2 text-xs text-zinc-400">{r.code}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-zinc-600">{r.count} referral{r.count !== 1 ? 's' : ''}</span>
                  <span className="text-sm font-medium">€{r.commission.toLocaleString()}</span>
                  {r.code && (
                    <button
                      onClick={() => copyLink(r.code!)}
                      className="p-1.5 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600"
                      title="Copy referral link"
                    >
                      {copiedCode === r.code ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters + Table */}
      <div className="bg-white rounded-xl border shadow-sm">
        <div className="flex items-center gap-3 px-5 py-3 border-b">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="text-sm border rounded-md px-2 py-1.5 bg-white"
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="converted">Converted</option>
            <option value="credited">Credited</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="text-sm border rounded-md px-2 py-1.5 bg-white"
          >
            <option value="all">All Types</option>
            <option value="client">Client</option>
            <option value="partner">Partner</option>
          </select>
          <span className="text-xs text-zinc-400 ml-auto">{filtered.length} referral{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        {filtered.length === 0 ? (
          <div className="p-12 text-center text-zinc-400 text-sm">
            No referrals match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-zinc-50/50">
                  <th className="w-8 px-2 py-2.5" />
                  <th className="text-left px-5 py-2.5 font-medium text-zinc-500">Referrer</th>
                  <th className="text-left px-5 py-2.5 font-medium text-zinc-500">Referred</th>
                  <th className="text-left px-5 py-2.5 font-medium text-zinc-500">Type</th>
                  <th className="text-left px-5 py-2.5 font-medium text-zinc-500">Status</th>
                  <th className="text-right px-5 py-2.5 font-medium text-zinc-500">Commission</th>
                  <th className="text-right px-5 py-2.5 font-medium text-zinc-500">Paid</th>
                  <th className="text-left px-5 py-2.5 font-medium text-zinc-500">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((r) => {
                  const s = statusConfig[r.status] || { label: r.status, color: 'bg-zinc-100 text-zinc-700' }
                  const tp = r.referrer_type ? typeConfig[r.referrer_type] : null
                  const displayReferred = r.referred_company || r.referred_name
                  const totalPaid = (Number(r.credited_amount) || 0) + (Number(r.paid_amount) || 0)
                  const isExpanded = expandedId === r.id

                  return (
                    <>
                      <tr
                        key={r.id}
                        className={cn('cursor-pointer transition-colors', isExpanded ? 'bg-zinc-50' : 'hover:bg-zinc-50/50')}
                        onClick={() => toggleExpand(r.id)}
                      >
                        <td className="px-2 py-3 text-zinc-400">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="px-5 py-3">
                          <div className="font-medium text-zinc-900">{r.referrer_name || '—'}</div>
                          {r.referrer_code && <div className="text-xs text-zinc-400">{r.referrer_code}</div>}
                        </td>
                        <td className="px-5 py-3">
                          <div className="text-zinc-900">{displayReferred}</div>
                        </td>
                        <td className="px-5 py-3">
                          {tp ? (
                            <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', tp.color)}>
                              {tp.label}
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', s.color)}>
                            {s.label}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          {r.commission_amount
                            ? <span className="font-medium">€{Number(r.commission_amount).toLocaleString()}</span>
                            : <span className="text-zinc-400">TBD</span>
                          }
                        </td>
                        <td className="px-5 py-3 text-right">
                          {totalPaid > 0
                            ? <span className="font-medium text-emerald-600">€{totalPaid.toLocaleString()}</span>
                            : <span className="text-zinc-400">€0</span>
                          }
                        </td>
                        <td className="px-5 py-3 text-zinc-500">
                          {r.created_at?.slice(0, 10)}
                        </td>
                      </tr>

                      {/* Expanded Detail Row */}
                      {isExpanded && (
                        <tr key={`${r.id}-detail`} className="bg-zinc-50/80">
                          <td colSpan={8} className="px-8 py-4">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
                              {/* Commission Details */}
                              <div>
                                <h4 className="font-semibold text-zinc-700 mb-2">Commission Details</h4>
                                <div className="space-y-1.5">
                                  <DetailRow label="Type" value={r.commission_type || 'Not set'} />
                                  {r.commission_pct != null && <DetailRow label="Percentage" value={`${r.commission_pct}%`} />}
                                  <DetailRow label="Amount" value={r.commission_amount ? `€${Number(r.commission_amount).toLocaleString()}` : 'TBD'} />
                                  <DetailRow label="Credited" value={`€${Number(r.credited_amount || 0).toLocaleString()}`} />
                                  <DetailRow label="Paid Out" value={`€${Number(r.paid_amount || 0).toLocaleString()}`} />
                                  <DetailRow
                                    label="Remaining"
                                    value={r.commission_amount
                                      ? `€${(Number(r.commission_amount) - totalPaid).toLocaleString()}`
                                      : '—'
                                    }
                                  />
                                </div>
                              </div>

                              {/* Referral Info */}
                              <div>
                                <h4 className="font-semibold text-zinc-700 mb-2">Referral Info</h4>
                                <div className="space-y-1.5">
                                  <DetailRow label="Referrer" value={r.referrer_name || '—'} />
                                  <DetailRow label="Referred" value={r.referred_name} />
                                  {r.referred_company && <DetailRow label="Company" value={r.referred_company} />}
                                  <DetailRow label="Referrer Type" value={r.referrer_type || 'Not set'} />
                                  <DetailRow label="Status" value={s.label} />
                                </div>
                              </div>

                              {/* Links & Notes */}
                              <div>
                                <h4 className="font-semibold text-zinc-700 mb-2">Links & Notes</h4>
                                <div className="space-y-1.5">
                                  {r.offer_token && (
                                    <div className="flex items-center gap-1">
                                      <span className="text-zinc-500">Offer:</span>
                                      <a
                                        href={`/offer/${r.offer_token}?preview=1`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-500 hover:underline inline-flex items-center gap-0.5"
                                        onClick={e => e.stopPropagation()}
                                      >
                                        {r.offer_token} <ExternalLink className="h-3 w-3" />
                                      </a>
                                    </div>
                                  )}
                                  {r.referrer_code && (
                                    <div className="flex items-center gap-1">
                                      <span className="text-zinc-500">Referral Link:</span>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); copyLink(r.referrer_code!) }}
                                        className="text-blue-500 hover:underline inline-flex items-center gap-1 text-sm"
                                      >
                                        tonydurante.us/r/{r.referrer_code}
                                        {copiedCode === r.referrer_code
                                          ? <Check className="h-3 w-3 text-emerald-500" />
                                          : <Copy className="h-3 w-3" />
                                        }
                                      </button>
                                    </div>
                                  )}
                                  <DetailRow label="ID" value={r.id.slice(0, 8) + '...'} />
                                  {r.notes && (
                                    <div className="mt-2">
                                      <span className="text-zinc-500">Notes:</span>
                                      <p className="text-zinc-700 mt-0.5 text-xs bg-white rounded border px-2 py-1.5">
                                        {r.notes}
                                      </p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-zinc-500 shrink-0">{label}:</span>
      <span className="text-zinc-900">{value}</span>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType
  label: string
  value: string
  color?: string
}) {
  return (
    <div className="bg-white rounded-xl border shadow-sm p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-4 w-4 text-zinc-400" />
        <p className="text-xs text-zinc-500 uppercase tracking-wide">{label}</p>
      </div>
      <p className={cn('text-xl font-semibold', color || 'text-zinc-900')}>{value}</p>
    </div>
  )
}
