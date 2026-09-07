'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { DashboardTab } from './dashboard-tab'
import { TransactionsTab } from './transactions-tab'
import { PnLTab } from './pnl-tab'
import { CashFlowTab } from './cashflow-tab'
import { TaxTab } from './tax-tab'
import { BookkeeperTab } from './bookkeeper-tab'
import { BalanceSheetTab } from './balance-sheet-tab'
import { AccountsTab } from './accounts-tab'
import type { OwnerTransaction, OwnerPnL, CashPosition, FilingSummary, OwnerAccount, BalanceSheet } from '@/lib/owner-finance'

const TABS = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'pnl', label: 'P&L' },
  { id: 'balance', label: 'Balance Sheet' },
  { id: 'accounts', label: 'Accounts' },
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
  filing: FilingSummary
  accounts: OwnerAccount[]
  balanceSheet: BalanceSheet
  /** A drill-down carried in the address bar, so the browser's back gesture can restore it. */
  initialFocus: { category: string; subcategory: string } | null
}

export function OwnerDashboard({
  year,
  activeTab,
  pnl,
  cash,
  uncategorizedCount,
  initialTransactions,
  initialTransactionTotal,
  filing,
  accounts,
  balanceSheet,
  initialFocus,
}: OwnerDashboardProps) {
  const usd = pnl.blocks.find(b => b.currency === 'USD')
  const router = useRouter()
  const pathname = usePathname()
  const [currentTab, setCurrentTab] = useState(activeTab)

  /** A line on the P&L that the Transactions tab opens pre-filtered — Antonio could read a
   *  total but never the rows inside it, so every figure had to be taken on trust.
   *
   *  IT LIVES IN THE URL. It was deliberately kept out, on the reasoning that a filtered
   *  view would get bookmarked and later mistaken for the whole year. The cost of that was
   *  worse and showed up the first time the back gesture was tried: drill into Rent, press
   *  back, and the address bar returns to the Transactions tab while the filter — which was
   *  only ever in React state — is gone. What lands is the tab's default view, uncategorised,
   *  which for a finished year is EMPTY. Twenty-one rent payments read as none. The
   *  bookmarking worry is already answered on screen by the "showing only Rent ×" chip. */
  const [focus, setFocus] = useState(initialFocus)

  /** The phone's back gesture changes the URL but does NOT remount this component, so the
   *  tab state has to follow the address bar or the page renders one tab while the URL
   *  claims another — and the year selector then pushes the stale value forward. Antonio's
   *  first instinct on a PWA is the system back gesture; it used to do visibly nothing. */
  useEffect(() => { setCurrentTab(activeTab) }, [activeTab])

  /* Adjusted DURING render, not in an effect: the server hands down a brand-new object on
   * every render, so an effect keyed on it would fire every time and race the optimistic
   * set in switchTab. Compare the value, not the identity. */
  const focusKey = initialFocus ? `${initialFocus.category}:${initialFocus.subcategory}` : ''
  const [seenFocusKey, setSeenFocusKey] = useState(focusKey)
  if (focusKey !== seenFocusKey) {
    setSeenFocusKey(focusKey)
    setFocus(initialFocus)
  }

  function switchTab(id: string, nextFocus?: { category: string; subcategory: string }) {
    setCurrentTab(id)
    setFocus(nextFocus ?? null)
    const q = nextFocus
      ? `?tab=${id}&year=${year}&focus=${encodeURIComponent(`${nextFocus.category}:${nextFocus.subcategory}`)}`
      : `?tab=${id}&year=${year}`
    router.push(`${pathname}${q}`, { scroll: false })
    // Opening a drill-down kept the P&L's scroll position, which dropped the reader into
    // the middle of the transaction list with the way back off-screen ABOVE them.
    /* The dashboard shell is height-locked (`h-screen`) and <main> is what scrolls, so the
     * page body never exceeds the viewport and window.scrollTo is a no-op here. Drilling
     * from a category deep in the P&L landed mid-list with the "Back to the P&L" button
     * above the fold — the same "another page opened and there's no way back" that this
     * button was added to answer. Scroll the real container. */
    if (nextFocus) {
      const scroller = document.querySelector('main')
      if (scroller) scroller.scrollTo({ top: 0 })
      else window.scrollTo({ top: 0 })
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">My Finances</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Tony Durante LLC — {year}</p>
        </div>
        <select
          value={year}
          /* The drill-down travels with the year. Dropping it here left the URL saying
             "no filter" while the list still showed "showing only Rent" and nothing in
             it — the filter was in the tab's own state and the year change did not
             clear it, so an empty screen had no explanation on it. Switching year while
             reading rent asks for rent in that year, which is also the honest reading. */
          onChange={e => router.push(
            `${pathname}?tab=${currentTab}&year=${e.target.value}` +
            (focus ? `&focus=${encodeURIComponent(`${focus.category}:${focus.subcategory}`)}` : ''),
          )}
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700"
        >
          {[2026, 2025, 2024, 2023].map(y => (
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
        {/* Antonio runs this as a phone app at ~380px. Eight tabs cannot fit on one line,
            so the strip scrolls sideways rather than wrapping into a second row that
            pushes the content down or overflowing the page and dragging the whole
            layout with it. */}
        <nav className="-mb-px flex gap-5 overflow-x-auto whitespace-nowrap sm:gap-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={cn(
                'shrink-0 pb-3 text-sm font-medium border-b-2 transition-colors',
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
        <DashboardTab pnl={pnl} cash={cash} uncategorizedCount={uncategorizedCount} year={year} onTabSwitch={switchTab} />
      )}
      {currentTab === 'transactions' && (
        <TransactionsTab year={year} initialRows={initialTransactions} initialTotal={initialTransactionTotal} focus={focus} onBack={() => switchTab('pnl')} onClearFocus={() => switchTab('transactions')} />
      )}
      {currentTab === 'pnl' && (
        <PnLTab year={year} pnl={pnl} onDrillDown={(category, subcategory) => switchTab('transactions', { category, subcategory })} />
      )}
      {currentTab === 'balance' && (
        <BalanceSheetTab bs={balanceSheet} />
      )}
      {currentTab === 'accounts' && (
        <AccountsTab accounts={accounts} year={year} />
      )}
      {currentTab === 'cashflow' && (
        <CashFlowTab year={year} monthly={usd?.monthly ?? []} cash={cash} />
      )}
      {currentTab === 'tax' && (
        <TaxTab year={year} pnl={pnl} filing={filing} />
      )}
      {currentTab === 'bookkeeper' && (
        <BookkeeperTab year={year} />
      )}
    </div>
  )
}
