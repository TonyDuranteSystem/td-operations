'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PrincipalOfficeDraft } from '@/lib/principal-office-draft'

interface Props {
  accountId: string
  value: PrincipalOfficeDraft
  onChange: (v: PrincipalOfficeDraft) => void
  disabled?: boolean
}

/**
 * Annual Report only — "did the principal address change on the filed report?" (Antonio 2026-10-01).
 * Shows the Principal Office saved on the account (the address on the Articles of Organization) and requires an
 * answer: unchanged, or the new address from the filed report, which then replaces the saved one.
 * Server errors are shown verbatim (R099).
 */
export function PrincipalOfficeCheck({ accountId, value, onChange, disabled }: Props) {
  const [current, setCurrent] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/calendar/principal-office?account_id=${encodeURIComponent(accountId)}`, { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Could not read the saved principal office.')
        if (!cancelled) setCurrent((data.address as string | null) ?? null)
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error && err.message ? err.message : 'Could not read the saved principal office.')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [accountId])

  const set = (patch: Partial<PrincipalOfficeDraft>) => onChange({ ...value, ...patch })
  const inputCls = 'w-full px-2 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50'

  return (
    <div className="rounded-md border border-purple-200 bg-purple-50/40 p-3 space-y-2">
      <p className="text-xs font-medium text-zinc-700">
        Address on the filed annual report <span className="text-red-500">*</span>
      </p>
      <p className="text-[11px] text-zinc-600">
        Saved address on the Articles:{' '}
        {!loaded ? (
          <Loader2 className="inline h-3 w-3 animate-spin" />
        ) : loadError ? (
          <span className="text-red-600">{loadError}</span>
        ) : current ? (
          <span className="font-medium text-zinc-800">{current}</span>
        ) : (
          <em className="text-zinc-400">none on file</em>
        )}
      </p>
      <label className="flex items-center gap-2 text-xs text-zinc-700">
        <input
          type="radio"
          name={`po-${accountId}`}
          checked={value.choice === 'unchanged'}
          onChange={() => set({ choice: 'unchanged' })}
          disabled={disabled}
        />
        Unchanged — the filed report shows the same address
      </label>
      <label className="flex items-center gap-2 text-xs text-zinc-700">
        <input
          type="radio"
          name={`po-${accountId}`}
          checked={value.choice === 'changed'}
          onChange={() => set({ choice: 'changed' })}
          disabled={disabled}
        />
        Changed — enter the new address from the filed report
      </label>
      {value.choice === 'changed' && (
        <div className="grid grid-cols-2 gap-1.5 pt-1">
          <input className={`${inputCls} col-span-2`} placeholder="Street *" value={value.address_line1} onChange={e => set({ address_line1: e.target.value })} disabled={disabled} />
          <input className={`${inputCls} col-span-2`} placeholder="Suite / unit (optional)" value={value.address_line2} onChange={e => set({ address_line2: e.target.value })} disabled={disabled} />
          <input className={inputCls} placeholder="City *" value={value.city} onChange={e => set({ city: e.target.value })} disabled={disabled} />
          <div className="grid grid-cols-2 gap-1.5">
            <input className={inputCls} placeholder="State *" value={value.state} onChange={e => set({ state: e.target.value })} disabled={disabled} />
            <input className={inputCls} placeholder="ZIP *" value={value.zip} onChange={e => set({ zip: e.target.value })} disabled={disabled} />
          </div>
        </div>
      )}
    </div>
  )
}
