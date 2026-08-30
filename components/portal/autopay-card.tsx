'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CreditCard, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'

interface AutopayCardProps {
  accountId: string
  enabled: boolean
  last4: string | null
}

export function AutopayCard({ accountId, enabled, last4 }: AutopayCardProps) {
  const { t } = useLocale()
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const autopayResult = searchParams.get('autopay')
    if (!autopayResult) return
    if (autopayResult === 'success') toast.success(t('autopay.setupSuccess'))
    if (autopayResult === 'cancelled') toast.info(t('autopay.setupCancelled'))
    const params = new URLSearchParams(searchParams.toString())
    params.delete('autopay')
    router.replace(`/portal/invoices?${params.toString()}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleEnable = async () => {
    if (loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/portal/autopay/setup-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      })
      const data = await res.json()
      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error || t('autopay.startFailed'))
      }
      window.location.href = data.checkoutUrl
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('autopay.startFailed'))
      setLoading(false)
    }
  }

  const handleDisable = async () => {
    if (loading) return
    if (!window.confirm(t('autopay.disableConfirm'))) return
    setLoading(true)
    try {
      const res = await fetch('/api/portal/autopay/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || t('autopay.disableFailed'))
      }
      toast.success(t('autopay.disabledSuccess'))
      window.location.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('autopay.disableFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border shadow-sm p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <CreditCard className="h-4.5 w-4.5 text-blue-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-900">{t('autopay.title')}</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {enabled
              ? t('autopay.enabledDesc').replace('{last4}', last4 || '••••')
              : t('autopay.notEnabledDesc')}
          </p>
        </div>
      </div>
      <button
        onClick={enabled ? handleDisable : handleEnable}
        disabled={loading}
        className={`flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors w-full sm:w-auto shrink-0 ${
          enabled
            ? 'border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
            : 'bg-blue-600 text-white hover:bg-blue-700'
        }`}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {enabled ? t('autopay.disableButton') : t('autopay.enableButton')}
      </button>
    </div>
  )
}
