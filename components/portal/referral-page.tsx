'use client'

import { useState } from 'react'
import { Copy, Check, Share2, Gift } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t, type Locale } from '@/lib/portal/i18n'

interface ReferralRow {
  id: string
  referred_name: string
  company_name: string | null
  status: string
  commission_amount: number | null
  commission_currency: string
  credited_amount: number | null
  paid_amount: number | null
  created_at: string
}

interface Props {
  referralLink: string | null
  referrals: ReferralRow[]
  locale: Locale
}

const statusConfig: Record<string, { label_en: string; label_it: string; color: string }> = {
  pending: { label_en: 'Pending', label_it: 'In attesa', color: 'bg-yellow-100 text-yellow-800' },
  converted: { label_en: 'Converted', label_it: 'Convertito', color: 'bg-blue-100 text-blue-800' },
  credited: { label_en: 'Credited', label_it: 'Accreditato', color: 'bg-green-100 text-green-800' },
  paid: { label_en: 'Paid', label_it: 'Pagato', color: 'bg-emerald-100 text-emerald-800' },
  cancelled: { label_en: 'Cancelled', label_it: 'Annullato', color: 'bg-red-100 text-red-800' },
}

export function ReferralPage({ referralLink, referrals, locale }: Props) {
  const [copied, setCopied] = useState(false)

  const copyLink = () => {
    if (!referralLink) return
    navigator.clipboard.writeText(referralLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Referral Link Card */}
      {referralLink ? (
        <div className="bg-gradient-to-r from-violet-50 to-indigo-50 rounded-xl border border-violet-200 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
              <Share2 className="h-5 w-5 text-violet-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-zinc-900">{t('referrals.yourLink', locale)}</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                {t('referrals.shareLinkDesc', locale)}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <div className="flex-1 bg-white rounded-lg border px-3 py-2 text-sm text-zinc-700 truncate font-mono">
                  {referralLink}
                </div>
                <button
                  onClick={copyLink}
                  className={cn(
                    'shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    copied
                      ? 'bg-emerald-500 text-white'
                      : 'bg-violet-600 text-white hover:bg-violet-700'
                  )}
                >
                  {copied ? (
                    <span className="flex items-center gap-1.5"><Check className="h-4 w-4" />{t('referrals.copied', locale)}</span>
                  ) : (
                    <span className="flex items-center gap-1.5"><Copy className="h-4 w-4" />{t('referrals.copyLink', locale)}</span>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-zinc-50 rounded-xl border p-5 text-center">
          <Gift className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">{t('referrals.noLinkYet', locale)}</p>
        </div>
      )}

      {/* Referral List */}
      {referrals.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <Share2 className="h-8 w-8 text-zinc-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-zinc-600">{t('referrals.noReferrals', locale)}</p>
          <p className="text-xs text-zinc-400 mt-1">{t('referrals.noReferralsDesc', locale)}</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="divide-y">
            {referrals.map((r) => {
              const s = statusConfig[r.status] || { label_en: r.status, label_it: r.status, color: 'bg-zinc-100 text-zinc-700' }
              const label = locale === 'it' ? s.label_it : s.label_en
              const displayName = r.company_name || r.referred_name
              const totalPaid = (Number(r.credited_amount) || 0) + (Number(r.paid_amount) || 0)

              return (
                <div key={r.id} className="flex items-center justify-between px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900 truncate">{displayName}</p>
                    <p className="text-xs text-zinc-400 mt-0.5">{r.created_at?.slice(0, 10)}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {totalPaid > 0 && (
                      <span className="text-sm font-medium text-emerald-600">€{totalPaid.toLocaleString()}</span>
                    )}
                    <span className={cn('text-xs px-2.5 py-1 rounded-full font-medium', s.color)}>
                      {label}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
