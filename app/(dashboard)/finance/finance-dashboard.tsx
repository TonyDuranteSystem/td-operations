'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Users, Landmark, BarChart3, Receipt, Repeat } from 'lucide-react'
import { ClientsInvoicesTab } from './clients-invoices-tab'
import { OverviewTab } from './overview-tab'
import { BankFeedTab, type BankFeedRecord, type OpenInvoice } from './bank-feed-tab'
import { AllInvoicesTab, type InvoiceRecord } from './all-invoices-tab'
import { ExpensesTab, type TDExpenseRecord } from './expenses-tab'
import { RecurringTab } from './recurring-tab'
import type { RecurringTemplateListRow } from '@/app/(dashboard)/payments/recurring-invoice-actions'
import { FastTooltip } from '@/components/ui/fast-tooltip'

interface ClientSummary {
  id: string
  company_name: string
  total_invoiced: number
  total_paid: number
  outstanding: number
  overdue: number
  invoice_count: number
  overdue_count: number
  has_partial: boolean
}

interface Props {
  activeTab: string
  clientList: ClientSummary[]
  selectedClientId: string | null
  clientInvoices: Array<Record<string, unknown>>
  clientCreditNotes: Array<Record<string, unknown>>
  clientAuditLog: Array<Record<string, unknown>>
  clientPaymentHistory: Array<Record<string, unknown>>
  stats: { totalOutstanding: number; totalOverdue: number; overdueCount: number; clientCount: number; cashThisMonth: number; avgDaysToPay: number }
  agingBuckets: { current: { amount: number; count: number }; d1_30: { amount: number; count: number }; d31_60: { amount: number; count: number }; d60plus: { amount: number; count: number } }
  recentAuditLog: Array<Record<string, unknown>>
  bankFeeds: BankFeedRecord[]
  bankOpenInvoices: OpenInvoice[]
  bankFeedTotalCount: number
  allInvoicesFlat: InvoiceRecord[]
  tdExpenses: TDExpenseRecord[]
  isAdmin: boolean
  /**
   * True only for the code-level owner account. The Expenses tab holds TD's own
   * outgoing money, which is owner-private like the rest of My Finances — and the
   * write actions behind it already refuse anyone else (expense-actions.ts). Before
   * this, the tab was merely `adminOnly`, so a non-owner admin could READ the
   * vendor bills and then hit a raw "Forbidden" on any edit.
   */
  isOwner: boolean
  /** Card-fee master switch state — null for non-admins (hides the card). */
  cardFee?: { enabled: boolean; ratePercent: number } | null
  recurringTemplates: RecurringTemplateListRow[]
}

const allTabs = [
  { id: 'clients', label: 'Clients & Invoices', icon: Users, tooltip: 'Create and manage invoices for each client. Track payments, credits, and balances.', adminOnly: false, ownerOnly: false },
  { id: 'recurring', label: 'Recurring', icon: Repeat, tooltip: 'Every recurring invoice schedule — turn one on or off.', adminOnly: false, ownerOnly: false },
  { id: 'expenses', label: 'Expenses', icon: Receipt, tooltip: 'TD operating expenses — vendor bills, filing fees, software, services.', adminOnly: false, ownerOnly: true },
  { id: 'bank', label: 'Bank Feed', icon: Landmark, tooltip: 'Match incoming bank transactions to open invoices. Auto-reconcile payments.', adminOnly: false, ownerOnly: false },
  { id: 'overview', label: 'Overview', icon: BarChart3, tooltip: 'Financial summary — aging buckets, outstanding totals, and recent activity.', adminOnly: false, ownerOnly: false },
]

export function FinanceDashboard({
  activeTab, clientList, selectedClientId,
  clientInvoices, clientCreditNotes, clientAuditLog, clientPaymentHistory,
  stats, agingBuckets, recentAuditLog, bankFeeds, bankOpenInvoices, bankFeedTotalCount,
  allInvoicesFlat, tdExpenses, isAdmin, isOwner, cardFee, recurringTemplates,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState(activeTab)
  const [clientsView, setClientsView] = useState<'all' | 'by-client'>('all')

  function switchTab(newTab: string) {
    setTab(newTab)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', newTab)
    if (newTab !== 'clients') params.delete('client')
    router.push(`/finance?${params.toString()}`)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Finance</h1>
            <p className="text-muted-foreground text-sm mt-1">
              ${stats.totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })} outstanding
              {stats.overdueCount > 0 && (
                <span className="text-red-600 font-medium"> &middot; {stats.overdueCount} overdue (${stats.totalOverdue.toLocaleString(undefined, { minimumFractionDigits: 2 })})</span>
              )}
            </p>
          </div>
        </div>

        {/* Tabs — horizontally scrollable on mobile so all tabs stay reachable */}
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1">
          {allTabs.filter(t => (!t.adminOnly || isAdmin) && (!t.ownerOnly || isOwner)).map(t => (
            <FastTooltip key={t.id} label={t.tooltip}>
              <button
                onClick={() => switchTab(t.id)}
                aria-label={t.tooltip}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors shrink-0 whitespace-nowrap ${
                  tab === t.id
                    ? 'bg-blue-600 text-white'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <t.icon className="w-4 h-4" />
                {t.label}
              </button>
            </FastTooltip>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'clients' && (
          <div className="h-full flex flex-col">
            <div className="flex gap-2 px-6 pt-4 overflow-x-auto">
              <button
                onClick={() => setClientsView('all')}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors shrink-0 whitespace-nowrap ${
                  clientsView === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                All Invoices
              </button>
              <button
                onClick={() => setClientsView('by-client')}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors shrink-0 whitespace-nowrap ${
                  clientsView === 'by-client'
                    ? 'bg-blue-600 text-white'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                By Client
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              {clientsView === 'all' ? (
                <AllInvoicesTab invoices={allInvoicesFlat} isAdmin={isAdmin} />
              ) : (
                <ClientsInvoicesTab
                  clientList={clientList}
                  selectedClientId={selectedClientId}
                  invoices={clientInvoices}
                  creditNotes={clientCreditNotes}
                  auditLog={clientAuditLog}
                  paymentHistory={clientPaymentHistory}
                />
              )}
            </div>
          </div>
        )}
        {tab === 'recurring' && (
          <RecurringTab templates={recurringTemplates} />
        )}
        {/* isOwner re-checked here, not just on the tab strip: `tab` seeds from the
            URL (?tab=expenses), so hiding the button alone would still render this
            for a non-owner who types the address. The server sends them an empty
            list regardless — this stops the bare panel showing at all. */}
        {tab === 'expenses' && isOwner && (
          <ExpensesTab expenses={tdExpenses} />
        )}
        {tab === 'bank' && (
          <BankFeedTab
            bankFeeds={bankFeeds}
            openInvoices={bankOpenInvoices}
            totalCount={bankFeedTotalCount}
            isAdmin={isAdmin}
          />
        )}
        {tab === 'overview' && (
          <OverviewTab stats={stats} clientList={clientList} agingBuckets={agingBuckets} recentAuditLog={recentAuditLog} cardFee={cardFee} />
        )}
      </div>
    </div>
  )
}
