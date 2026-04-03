'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Users, Landmark, BarChart3 } from 'lucide-react'
import { ClientsInvoicesTab } from './clients-invoices-tab'
import { OverviewTab } from './overview-tab'

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
  stats: { totalOutstanding: number; totalOverdue: number; overdueCount: number; clientCount: number }
}

const tabs = [
  { id: 'clients', label: 'Clients & Invoices', icon: Users },
  { id: 'bank', label: 'Bank Feed', icon: Landmark },
  { id: 'overview', label: 'Overview', icon: BarChart3 },
]

export function FinanceDashboard({
  activeTab, clientList, selectedClientId,
  clientInvoices, clientCreditNotes, clientAuditLog, clientPaymentHistory,
  stats,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState(activeTab)

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
          <ClientsInvoicesTab
            clientList={clientList}
            selectedClientId={selectedClientId}
            invoices={clientInvoices}
            creditNotes={clientCreditNotes}
            auditLog={clientAuditLog}
            paymentHistory={clientPaymentHistory}
          />
        )}
        {tab === 'bank' && (
          <div className="p-6 text-muted-foreground text-center">
            <Landmark className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p className="text-lg font-medium">Bank Feed</p>
            <p className="text-sm">Coming in Sprint B</p>
          </div>
        )}
        {tab === 'overview' && (
          <OverviewTab stats={stats} clientList={clientList} />
        )}
      </div>
    </div>
  )
}
