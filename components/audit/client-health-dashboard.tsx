'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Unlink, Building2, User, ExternalLink,
  Loader2, Link2, CheckCircle2, RotateCcw, Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { retryActivation, repairSdContactId, repairAllSdContactIds, type BatchRepairResult } from '@/app/(dashboard)/client-health/actions'
import { useRouter } from 'next/navigation'

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
  wizard_status: string | null
}

interface SdMissingContact {
  account_id: string
  company_name: string
  missing_count: number
}

interface Stats {
  stuck_activations: number
  orphan_accounts: number
  wrong_type: number
  orphan_contacts: number
  orphan_contacts_with_offers: number
  sd_missing_contact: number
}

interface Props {
  stuckActivations: StuckActivation[]
  orphanAccounts: OrphanAccount[]
  wrongTypeAccounts: WrongTypeAccount[]
  orphanContacts: OrphanContact[]
  sdMissingContact: SdMissingContact[]
  stats: Stats
}

// ─── Component ───

export function ClientHealthDashboard({
  stuckActivations,
  orphanAccounts,
  wrongTypeAccounts,
  sdMissingContact,
  orphanContacts,
  stats,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'stuck' | 'orphan_accounts' | 'wrong_type' | 'orphan_contacts' | 'sd_contact'>('stuck')
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchConfirm, setBatchConfirm] = useState(false)
  const [batchResult, setBatchResult] = useState<BatchRepairResult | null>(null)

  const tabs = [
    { key: 'stuck' as const, label: 'Stuck Activations', count: stats.stuck_activations, color: 'text-red-600' },
    { key: 'wrong_type' as const, label: 'Wrong Account Type', count: stats.wrong_type, color: 'text-amber-600' },
    { key: 'sd_contact' as const, label: 'SD Missing Contact', count: stats.sd_missing_contact, color: 'text-purple-600' },
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
                    <button
                      onClick={async () => {
                        setFixingId(item.id)
                        const result = await retryActivation(item.offer_token)
                        if (result.success) {
                          toast.success(`Activation retried for ${item.client_name}`)
                          router.refresh()
                        } else {
                          toast.error(result.error || 'Retry failed')
                        }
                        setFixingId(null)
                      }}
                      disabled={fixingId === item.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50 transition-colors"
                    >
                      {fixingId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Retry
                    </button>
                    {item.contact ? (
                      <Link
                        href={`/contacts/${item.contact.id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-100 text-violet-700 hover:bg-violet-200 transition-colors"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        Audit
                      </Link>
                    ) : (
                      <span className="text-xs text-zinc-400">No contact</span>
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

      {/* ─── SD Missing Contact ─── */}
      {activeTab === 'sd_contact' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
              <Wrench className="h-4 w-4 text-purple-500" />
              Active SDs with missing contact_id — need repair
            </h2>
            {sdMissingContact.length > 0 && !batchResult && (
              <button
                onClick={() => setBatchConfirm(true)}
                disabled={batchRunning}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                {batchRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                {batchRunning ? 'Repairing...' : 'Repair All'}
              </button>
            )}
          </div>

          {/* Batch confirmation */}
          {batchConfirm && !batchRunning && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-sm font-medium text-amber-900 mb-2">Confirm batch repair</p>
              <p className="text-xs text-amber-800 mb-3">
                This will set contact_id on ~{sdMissingContact.reduce((sum, i) => sum + i.missing_count, 0)} active SDs across {sdMissingContact.length} accounts.
                Each account&apos;s SDs will be linked to its primary contact from account_contacts.
                Accounts without a linked contact will be skipped.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setBatchConfirm(false)
                    setBatchRunning(true)
                    try {
                      const result = await repairAllSdContactIds()
                      setBatchResult(result)
                      toast.success(`Fixed ${result.totalFixed} SDs across ${result.accountsProcessed} accounts`)
                      router.refresh()
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Batch repair failed')
                    } finally {
                      setBatchRunning(false)
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700"
                >
                  Confirm: Repair All
                </button>
                <button
                  onClick={() => setBatchConfirm(false)}
                  className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Batch result summary */}
          {batchResult && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-sm font-medium text-green-900 mb-2">Batch repair complete</p>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-lg font-bold text-green-700">{batchResult.totalFixed}</div>
                  <div className="text-[10px] text-green-600">SDs fixed</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-green-700">{batchResult.accountsProcessed}</div>
                  <div className="text-[10px] text-green-600">accounts processed</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-amber-600">{batchResult.accountsSkipped}</div>
                  <div className="text-[10px] text-amber-600">skipped (no contact)</div>
                </div>
              </div>
              {batchResult.errors.length > 0 && (
                <div className="mt-3 text-xs text-red-700">
                  {batchResult.errors.length} error(s): {batchResult.errors.map(e => e.accountId.slice(0, 8)).join(', ')}
                </div>
              )}
            </div>
          )}

          {sdMissingContact.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-400 bg-zinc-50 rounded-lg">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-400" />
              All active SDs have contact_id set
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {sdMissingContact.map(item => (
                <div key={item.account_id} className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <Link href={`/accounts/${item.account_id}`} className="font-medium text-sm hover:underline">
                      {item.company_name}
                    </Link>
                    <div className="text-xs text-zinc-500 mt-1">
                      {item.missing_count} active SD{item.missing_count > 1 ? 's' : ''} missing contact_id
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      setFixingId(item.account_id)
                      const result = await repairSdContactId(item.account_id)
                      if (result.success) {
                        toast.success(`Fixed ${result.fixed} SD${result.fixed !== 1 ? 's' : ''} for ${item.company_name}`)
                        router.refresh()
                      } else {
                        toast.error(result.error || 'Repair failed')
                      }
                      setFixingId(null)
                    }}
                    disabled={fixingId === item.account_id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200 disabled:opacity-50 transition-colors shrink-0"
                  >
                    {fixingId === item.account_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                    Repair
                  </button>
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
                        {item.wizard_status === 'completed' && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 inline-flex items-center gap-0.5">
                            <CheckCircle2 className="h-2.5 w-2.5" /> Wizard Done
                          </span>
                        )}
                        {item.wizard_status && item.wizard_status.startsWith('step_') && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                            Wizard {item.wizard_status.replace('step_', 'Step ')}
                          </span>
                        )}
                        {item.has_offers && !item.wizard_status && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">
                            No Wizard
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
