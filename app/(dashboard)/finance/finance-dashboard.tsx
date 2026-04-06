'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Users, Landmark, BarChart3 } from 'lucide-react'
import { ClientsInvoicesTab } from './clients-invoices-tab'
import { OverviewTab } from './overview-tab'
import { BankFeedTab, type BankFeedRecord, type OpenInvoice } from './bank-feed-tab'
import { AllInvoicesTab, type InvoiceRecord } from './all-invoices-tab'

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
}

const tabs = [
  { id: 'clients', label: 'Clients & Invoices', icon: Users, tooltip: 'Create and manage invoices for each client. Track payments, credits, and balances.' },
  { id: 'bank', label: 'Bank Feed', icon: Landmark, tooltip: 'Match incoming bank transactions to open invoices. Auto-reconcile payments.' },
  { id: 'overview', label: 'Overview', icon: BarChart3, tooltip: 'Financial summary — aging buckets, outstanding totals, and recent activity.' },
]

export function FinanceDashboard({
  activeTab, clientList, selectedClientId,
  clientInvoices, clientCreditNotes, clientAuditLog, clientPaymentHistory,
  stats, agingBuckets, recentAuditLog, bankFeeds, bankOpenInvoices, bankFeedTotalCount,
  allInvoicesFlat,
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

        {/* Tabs */}
        <div className="flex gap-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              title={t.tooltip}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-blue-600 text-white'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'clients' && (
          <div className="h-full flex flex-col">
            <div className="flex gap-2 px-6 pt-4">
              <button
                onClick={() => setClientsView('all')}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  clientsView === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                All Invoices
              </button>
              <button
                onClick={() => setClientsView('by-client')}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
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
                <AllInvoicesTab invoices={allInvoicesFlat} />
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
        {tab === 'bank' && (
          <BankFeedTab
            bankFeeds={bankFeeds}
            openInvoices={bankOpenInvoices}
            totalCount={bankFeedTotalCount}
          />
        )}
        {tab === 'overview' && (
          <OverviewTab stats={stats} clientList={clientList} agingBuckets={agingBuckets} recentAuditLog={recentAuditLog} />
        )}
      </div>
    </div>
  )
}
