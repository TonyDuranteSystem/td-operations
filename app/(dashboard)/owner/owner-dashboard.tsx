'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { DashboardTab } from './dashboard-tab'
import { TransactionsTab } from './transactions-tab'
import { PnLTab } from './pnl-tab'
import { CashFlowTab } from './cashflow-tab'
import { TaxTab } from './tax-tab'
import { BookkeeperTab } from './bookkeeper-tab'
import type { OwnerTransaction, OwnerPnL, CashPosition } from '@/lib/owner-finance'

const TABS = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'pnl', label: 'P&L' },
  { id: 'cashflow', label: 'Cash Flow' },
  { id: 'tax', label: 'Tax' },
  { id: 'bookkeeper', label: 'Bookkeeper' },
]

interface OwnerDashboardProps {
  year: number
  activeTab: string
  pnl: OwnerPnL
  cash: CashPosition
  uncategorizedCount: number
  initialTransactions: OwnerTransaction[]
  initialTransactionTotal: number
  taxEstimate: { annual: number; quarterly: number }
}

export function OwnerDashboard({
  year,
  activeTab,
  pnl,
  cash,
  uncategorizedCount,
  initialTransactions,
  initialTransactionTotal,
  taxEstimate,
}: OwnerDashboardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [currentTab, setCurrentTab] = useState(activeTab)

  function switchTab(id: string) {
    setCurrentTab(id)
    router.push(`${pathname}?tab=${id}&year=${year}`, { scroll: false })
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">My Finances</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Tony Durante LLC — {year}</p>
        </div>
        <select
          value={year}
          onChange={e => router.push(`${pathname}?tab=${currentTab}&year=${e.target.value}`)}
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700"
        >
          {[2025, 2024, 2023].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {uncategorizedCount > 0 && (
        <div
          className="mb-4 flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm text-orange-800 cursor-pointer"
          onClick={() => switchTab('transactions')}
        >
          <span className="font-semibold">{uncategorizedCount} uncategorized transactions</span>
          <span>— click to review →</span>
        </div>
      )}

      <div className="mb-6 border-b border-zinc-200">
        <nav className="-mb-px flex gap-6">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={cn(
                'pb-3 text-sm font-medium border-b-2 transition-colors',
                currentTab === tab.id
                  ? 'border-zinc-900 text-zinc-900'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700'
              )}
            >
              {tab.label}
              {tab.id === 'transactions' && uncategorizedCount > 0 && (
                <span className="ml-1.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700">
                  {uncategorizedCount}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {currentTab === 'dashboard' && (
        <DashboardTab pnl={pnl} cash={cash} uncategorizedCount={uncategorizedCount} taxEstimate={taxEstimate} year={year} onTabSwitch={switchTab} />
      )}
      {currentTab === 'transactions' && (
        <TransactionsTab year={year} initialRows={initialTransactions} initialTotal={initialTransactionTotal} />
      )}
      {currentTab === 'pnl' && (
        <PnLTab year={year} pnl={pnl} />
      )}
      {currentTab === 'cashflow' && (
        <CashFlowTab year={year} monthly={pnl.monthly} cash={cash} />
      )}
      {currentTab === 'tax' && (
        <TaxTab year={year} netProfit={pnl.net_profit} />
      )}
      {currentTab === 'bookkeeper' && (
        <BookkeeperTab year={year} />
      )}
    </div>
  )
}
