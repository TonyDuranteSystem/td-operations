'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, ChevronDown, Check, Sparkles, Share2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortalAccount } from '@/lib/types'
import type { InProgressFormation } from '@/lib/portal/queries'

interface CompanySwitcherProps {
  accounts: PortalAccount[]
  selectedAccountId: string
  /** Companies being formed that have no account yet (no Articles). Selectable. */
  inProgress?: InProgressFormation[]
  /** Set when an in-progress formation is the current selection. */
  selectedFormationId?: string
  userName?: string
  /** When the viewer is ALSO a partner — adds a "Partner" entry to this switcher. */
  dualRole?: boolean
  /** True when the partner view is the current selection. */
  partnerMode?: boolean
  /** Where the partner entry navigates (default: the partner home). */
  partnerHref?: string
}

/**
 * Company switcher for multi-entity clients. Lists real companies (accounts) AND
 * in-progress formations (paid, being formed, not yet a company). Selecting an
 * account sets `portal_account_id` and clears `portal_formation`; selecting a
 * formation sets `portal_formation` (the server resolver gives it precedence).
 * Tier-independent: the parent renders this whenever there is more than one
 * entity, so a client viewing a formation can always switch back.
 */
export function CompanySwitcher({ accounts, selectedAccountId, inProgress = [], selectedFormationId, userName, dualRole = false, partnerMode = false, partnerHref = '/portal/partner/clients' }: CompanySwitcherProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const totalEntities = accounts.length + inProgress.length
  const selectedAccount = accounts.find(a => a.id === selectedAccountId)
  const selectedFormation = inProgress.find(f => f.id === selectedFormationId)
  const selectedLabel = partnerMode
    ? 'Partner — My Referrals'
    : (selectedFormation?.label ?? selectedAccount?.company_name ?? userName ?? 'My Account')

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

  // Selecting any company/formation also drops out of partner mode.
  const exitPartnerMode = () => {
    if (dualRole) document.cookie = `portal_mode=client; path=/portal; max-age=31536000; SameSite=Lax`
  }

  const selectAccount = (accountId: string) => {
    document.cookie = `portal_account_id=${accountId}; path=/portal; max-age=31536000; SameSite=Lax`
    // Clear any in-progress-formation selection so the account view takes over.
    document.cookie = `portal_formation=; path=/portal; max-age=0; SameSite=Lax`
    exitPartnerMode()
    setOpen(false)
    if (partnerMode) router.push('/portal')
    else router.refresh()
  }

  const selectFormation = (formationId: string) => {
    document.cookie = `portal_formation=${formationId}; path=/portal; max-age=31536000; SameSite=Lax`
    exitPartnerMode()
    setOpen(false)
    if (partnerMode) router.push('/portal')
    else router.refresh()
  }

  const selectPartner = () => {
    document.cookie = `portal_mode=partner; path=/portal; max-age=31536000; SameSite=Lax`
    setOpen(false)
    router.push(partnerHref)
  }

  if (totalEntities <= 1 && !dualRole) {
    // Single entity, not a partner — just show the name, no dropdown.
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        {selectedFormation
          ? <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
          : <Building2 className="h-4 w-4 text-blue-600 shrink-0" />}
        <span className="text-sm font-medium text-zinc-900 truncate">{selectedLabel}</span>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg hover:bg-zinc-50 transition-colors"
      >
        {partnerMode
          ? <Share2 className="h-4 w-4 text-violet-600 shrink-0" />
          : selectedFormation
            ? <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
            : <Building2 className="h-4 w-4 text-blue-600 shrink-0" />}
        <span className="text-sm font-medium text-zinc-900 truncate flex-1 text-left">
          {selectedLabel}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg z-10 py-1">
          {accounts.map(account => (
            <button
              key={account.id}
              onClick={() => selectAccount(account.id)}
              className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 transition-colors"
            >
              <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
              <span className="truncate flex-1">{account.company_name}</span>
              {!selectedFormationId && account.id === selectedAccountId && (
                <Check className="h-4 w-4 text-blue-600 shrink-0" />
              )}
            </button>
          ))}
          {inProgress.map(f => (
            <button
              key={f.id}
              onClick={() => selectFormation(f.id)}
              className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 transition-colors"
            >
              <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
              <span className="truncate flex-1">{f.label}</span>
              <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-px shrink-0">
                in formation
              </span>
              {f.id === selectedFormationId && (
                <Check className="h-4 w-4 text-blue-600 shrink-0" />
              )}
            </button>
          ))}
          {dualRole && (
            <>
              <div className="my-1 border-t border-zinc-100" />
              <button
                onClick={selectPartner}
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 transition-colors"
              >
                <Share2 className="h-4 w-4 text-violet-600 shrink-0" />
                <span className="truncate flex-1">Partner — My Referrals</span>
                {partnerMode && <Check className="h-4 w-4 text-blue-600 shrink-0" />}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
