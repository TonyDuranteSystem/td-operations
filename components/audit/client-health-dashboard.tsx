'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Unlink, Building2, User, ExternalLink,
  Loader2, Link2, CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// ─── Types ───

interface StuckActivation {
  id: string
  offer_token: string
  lead_id: string | null
  client_name: string
  client_email: string
  amount: number | null
  currency: string | null
  payment_method: string | null
  status: string
  signed_at: string | null
  payment_confirmed_at: string | null
  activated_at: string | null
  contact: { id: string; full_name: string } | null
}

interface OrphanAccount {
  id: string
  company_name: string
  status: string | null
  account_type: string | null
  entity_type: string | null
  state_of_formation: string | null
  created_at: string
}

interface WrongTypeAccount {
  id: string
  company_name: string
  status: string | null
  entity_type: string | null
  active_sd_count: number
}

interface OrphanContact {
  id: string
  full_name: string
  email: string | null
  portal_tier: string | null
  status: string | null
  created_at: string
  has_offers: boolean
}

interface Stats {
  stuck_activations: number
  orphan_accounts: number
  wrong_type: number
  orphan_contacts: number
  orphan_contacts_with_offers: number
}

interface Props {
  stuckActivations: StuckActivation[]
  orphanAccounts: OrphanAccount[]
  wrongTypeAccounts: WrongTypeAccount[]
  orphanContacts: OrphanContact[]
  stats: Stats
}

// ─── Component ───

export function ClientHealthDashboard({
  stuckActivations,
  orphanAccounts,
  wrongTypeAccounts,
  orphanContacts,
  stats,
}: Props) {
  const [activeTab, setActiveTab] = useState<'stuck' | 'orphan_accounts' | 'wrong_type' | 'orphan_contacts'>('stuck')
  const [fixingId, setFixingId] = useState<string | null>(null)

  const tabs = [
    { key: 'stuck' as const, label: 'Stuck Activations', count: stats.stuck_activations, color: 'text-red-600' },
    { key: 'wrong_type' as const, label: 'Wrong Account Type', count: stats.wrong_type, color: 'text-amber-600' },
    { key: 'orphan_accounts' as const, label: 'Orphan Accounts', count: stats.orphan_accounts, color: 'text-orange-600' },
    { key: 'orphan_contacts' as const, label: 'Orphan Contacts', count: stats.orphan_contacts, color: 'text-blue-600' },
  ]

  async function fixAccountType(accountId: string) {
    setFixingId(accountId)
    try {
      const res = await fetch('/api/crm/admin-actions/audit-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: 'system', // Not contact-specific
          action: 'set_account_type',
          params: { account_id: accountId, account_type: 'Client' },
        }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
      } else {
        toast.error(data.error || 'Failed')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setFixingId(null)
    }
  }

  return (
    <div>
      {/* Stats overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'p-4 rounded-lg border text-left transition-colors',
              activeTab === tab.key ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 hover:border-zinc-300',
            )}
          >
            <p className={cn('text-2xl font-bold', tab.count > 0 ? tab.color : 'text-green-600')}>
              {tab.count}
            </p>
            <p className="text-xs text-zinc-500 mt-1">{tab.label}</p>
          </button>
        ))}
      </div>

      {/* ─── Stuck Activations ─── */}
      {activeTab === 'stuck' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            Stuck Activations — Payment confirmed but never activated
          </h2>
          {stuckActivations.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-400 bg-zinc-50 rounded-lg">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-400" />
              No stuck activations
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {stuckActivations.map(item => (
                <div key={item.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{item.client_name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                        {item.status}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-1 space-x-2">
                      <span>{item.client_email}</span>
                      <span>·</span>
                      <span>{item.currency ?? ''} {item.amount?.toLocaleString() ?? '?'}</span>
                      <span>·</span>
                      <span>Confirmed: {item.payment_confirmed_at?.split('T')[0] ?? '?'}</span>
                      <span>·</span>
                      <span>{item.offer_token}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {item.contact ? (
                      <Link
                        href={`/contacts/${item.contact.id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-100 text-violet-700 hover:bg-violet-200 transition-colors"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        Audit {item.contact.full_name}
                      </Link>
                    ) : (
                      <span className="text-xs text-zinc-400">No contact linked</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Wrong Account Type ─── */}
      {activeTab === 'wrong_type' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            One-Time accounts with active service deliveries — should be Client
          </h2>
          {wrongTypeAccounts.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-400 bg-zinc-50 rounded-lg">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-400" />
              No wrong account types
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {wrongTypeAccounts.map(item => (
                <div key={item.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <Link href={`/accounts/${item.id}`} className="font-medium text-sm hover:underline">
                      {item.company_name}
                    </Link>
                    <div className="text-xs text-zinc-500 mt-1">
                      {item.entity_type ?? ''} · {item.status ?? ''} · {item.active_sd_count} active SDs
                    </div>
                  </div>
                  <button
                    onClick={() => fixAccountType(item.id)}
                    disabled={fixingId === item.id}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                      'bg-amber-100 text-amber-700 hover:bg-amber-200',
                      fixingId === item.id && 'opacity-50 cursor-not-allowed',
                    )}
                  >
                    {fixingId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Change to Client
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Orphan Accounts ─── */}
      {activeTab === 'orphan_accounts' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
            <Unlink className="h-4 w-4 text-orange-500" />
            Orphan Accounts — No contact linked via account_contacts
          </h2>
          {orphanAccounts.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-400 bg-zinc-50 rounded-lg">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-400" />
              No orphan accounts
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {orphanAccounts.map(item => (
                <div key={item.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <Link href={`/accounts/${item.id}`} className="font-medium text-sm hover:underline flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5 text-zinc-400" />
                      {item.company_name}
                    </Link>
                    <div className="text-xs text-zinc-500 mt-1">
                      {item.entity_type ?? ''} · {item.status ?? ''} · {item.account_type ?? ''} · Created {item.created_at?.split('T')[0]}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      href={`/accounts/${item.id}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Orphan Contacts ─── */}
      {activeTab === 'orphan_contacts' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
            <User className="h-4 w-4 text-blue-500" />
            Contacts without linked accounts ({orphanContacts.length} total, {orphanContacts.filter(c => c.has_offers).length} with offers)
          </h2>
          <p className="text-xs text-zinc-400">
            Showing contacts with offers/leads first. Many of these may be legitimate early-stage contacts.
          </p>
          {orphanContacts.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-400 bg-zinc-50 rounded-lg">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-400" />
              No orphan contacts
            </div>
          ) : (
            <div className="border rounded-lg divide-y max-h-[600px] overflow-y-auto">
              {/* Sort: has_offers first */}
              {[...orphanContacts]
                .sort((a, b) => (b.has_offers ? 1 : 0) - (a.has_offers ? 1 : 0))
                .map(item => (
                  <div key={item.id} className="p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link href={`/contacts/${item.id}`} className="font-medium text-sm hover:underline">
                          {item.full_name}
                        </Link>
                        {item.has_offers && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                            HAS OFFERS
                          </span>
                        )}
                        {item.portal_tier && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">
                            {item.portal_tier}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">
                        {item.email ?? 'No email'} · Created {item.created_at?.split('T')[0]}
                      </div>
                    </div>
                    <Link
                      href={`/contacts/${item.id}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-100 text-violet-700 hover:bg-violet-200 transition-colors shrink-0"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      Audit
                    </Link>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
