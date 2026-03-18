'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortalAccount } from '@/lib/types'

interface CompanySwitcherProps {
  accounts: PortalAccount[]
  selectedAccountId: string
}

/**
 * Company switcher for multi-LLC clients.
 * Persists selection in sessionStorage (cleared on tab close — better for shared devices).
 */
export function CompanySwitcher({ accounts, selectedAccountId }: CompanySwitcherProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const selected = accounts.find(a => a.id === selectedAccountId)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (accounts.length <= 1) {
    // Single account — just show the name, no dropdown
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        <Building2 className="h-4 w-4 text-blue-600 shrink-0" />
        <span className="text-sm font-medium text-zinc-900 truncate">
          {selected?.company_name ?? 'No Company'}
        </span>
      </div>
    )
  }

  const handleSelect = (accountId: string) => {
    sessionStorage.setItem('portal_account_id', accountId)
    setOpen(false)
    router.refresh()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg hover:bg-zinc-50 transition-colors"
      >
        <Building2 className="h-4 w-4 text-blue-600 shrink-0" />
        <span className="text-sm font-medium text-zinc-900 truncate flex-1 text-left">
          {selected?.company_name ?? 'Select Company'}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg z-10 py-1">
          {accounts.map(account => (
            <button
              key={account.id}
              onClick={() => handleSelect(account.id)}
              className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 transition-colors"
            >
              <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
              <span className="truncate flex-1">{account.company_name}</span>
              {account.id === selectedAccountId && (
                <Check className="h-4 w-4 text-blue-600 shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
