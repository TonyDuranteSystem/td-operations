'use client'

/**
 * "Referrals" card for account/contact detail — everyone this client brought
 * us, in one place (fed by GET /api/referral/by-actor, which matches referral
 * rows across contact/account scoping and de-duplicates them). Self-contained:
 * fetches on mount, renders nothing while loading and nothing when the client
 * has no referrals, so it can sit on every account/contact page harmlessly.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Share2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface GivenReferral {
  id: string
  referred_name: string | null
  referred_company: string | null
  status: string
  commission_amount: number | null
  commission_currency: string | null
  credited_amount: number | null
  paid_amount: number | null
  created_at: string
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  converted: 'bg-blue-100 text-blue-800',
  credited: 'bg-green-100 text-green-800',
  paid: 'bg-emerald-100 text-emerald-800',
}

export function ReferralsGivenCard({ accountId, contactId }: { accountId?: string; contactId?: string }) {
  const [referrals, setReferrals] = useState<GivenReferral[] | null>(null)

  useEffect(() => {
    if (!accountId && !contactId) return
    const params = accountId ? `accountId=${accountId}` : `contactId=${contactId}`
    let cancelled = false
    fetch(`/api/referral/by-actor?${params}`)
      .then(res => (res.ok ? res.json() : { referrals: [] }))
      .then(data => { if (!cancelled) setReferrals(data.referrals ?? []) })
      .catch(() => { if (!cancelled) setReferrals([]) })
    return () => { cancelled = true }
  }, [accountId, contactId])

  if (!referrals || referrals.length === 0) return null

  return (
    <div className="bg-white rounded-xl border shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
          <Share2 className="h-4 w-4 text-zinc-400" />
          Referrals given ({referrals.length})
        </h3>
        <Link href="/referrals" className="text-xs text-blue-600 hover:underline">All referrals →</Link>
      </div>
      <div className="divide-y">
        {referrals.map(r => {
          const cur = r.commission_currency === 'EUR' ? '€' : '$'
          const earned = (Number(r.credited_amount) || 0) + (Number(r.paid_amount) || 0)
          return (
            <div key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium text-zinc-900">{r.referred_company || r.referred_name || '—'}</span>
                {r.referred_company && r.referred_name && (
                  <span className="ml-1.5 text-xs text-zinc-400">{r.referred_name}</span>
                )}
                <span className="ml-2 text-xs text-zinc-400">{r.created_at?.slice(0, 10)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-zinc-600">
                  {earned > 0
                    ? <span className="font-medium text-emerald-600">{cur}{earned.toLocaleString()}</span>
                    : r.commission_amount
                      ? `${cur}${Number(r.commission_amount).toLocaleString()}`
                      : ''}
                </span>
                <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium capitalize', STATUS_STYLE[r.status] ?? 'bg-zinc-100 text-zinc-600')}>
                  {r.status}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
