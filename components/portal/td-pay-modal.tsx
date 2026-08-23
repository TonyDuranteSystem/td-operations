'use client'

import { useEffect, useRef, useState } from 'react'
import { CreditCard, Building2, Copy, Check, X, Loader2, ExternalLink, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/portal/use-locale'

interface TdPayModalProps {
  paymentId: string
  invoiceNumber: string
  amount: number
  currency: string
  onClose: () => void
}

interface BankDetails {
  beneficiary: string | null
  bank: string | null
  account: string | null
  routing: string | null
  type: string | null
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1 rounded hover:bg-zinc-100 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-zinc-400" />}
    </button>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-mono text-zinc-900">{value}</span>
        <CopyButton text={value} />
      </div>
    </div>
  )
}

export function TdPayModal({ paymentId, invoiceNumber, amount, currency, onClose }: TdPayModalProps) {
  const { t } = useLocale()
  // Read inside the mount-only effect below without retriggering it \u2014 t() is
  // a fresh closure every render, and this fetch must only run once.
  const tRef = useRef(t)
  tRef.current = t
  const csym = currency === 'EUR' ? '\u20AC' : '$'
  const cardTotal = Math.ceil(amount * 1.05)

  const [bankDetails, setBankDetails] = useState<BankDetails | null>(null)
  const [bankLoading, setBankLoading] = useState(true)
  const [bankError, setBankError] = useState<string | null>(null)
  const [stripeLoading, setStripeLoading] = useState(false)
  const [wireExpanded, setWireExpanded] = useState(false)

  // Fetch bank details on mount
  useEffect(() => {
    let cancelled = false
    fetch('/api/workflows/td-bank-details')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        if (data.error) {
          setBankError(data.error)
        } else {
          setBankDetails(data.details)
        }
        setBankLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setBankError(err instanceof Error ? err.message : tRef.current('tdPayModal.bankDetailsFailed'))
        setBankLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const handlePayByCard = async () => {
    if (stripeLoading) return
    setStripeLoading(true)
    try {
      const res = await fetch('/api/workflows/create-invoice-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_id: paymentId }),
      })
      const data = await res.json()
      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error || t('tdPayModal.checkoutFailed'))
      }
      window.open(data.checkoutUrl, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('tdPayModal.cardPaymentFailed'))
    } finally {
      setStripeLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-gradient-to-r from-blue-600 to-blue-700 flex items-center justify-between">
          <div>
            <h3 className="text-white font-semibold text-base">
              {t('tdPayModal.title')}
            </h3>
            <p className="text-blue-100 text-sm mt-0.5">
              {invoiceNumber} — {csym}{amount.toFixed(2)} {currency}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-white/70 hover:text-white p-1"
            title={t('tdPayModal.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="divide-y">
          {/* Card payment — Stripe */}
          <div className="px-5 py-4">
            <button
              type="button"
              onClick={handlePayByCard}
              disabled={stripeLoading}
              className="flex items-center justify-between w-full group disabled:opacity-60"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                  <CreditCard className="h-5 w-5 text-blue-600" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-zinc-900 group-hover:text-blue-600 transition-colors">
                    {t('tdPayModal.creditCard')}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {csym}{cardTotal.toFixed(2)} {currency}
                    <span className="text-zinc-400"> ({t('tdPayModal.fee')})</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg group-hover:bg-blue-700 transition-colors">
                {stripeLoading
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <>
                      {t('tdPayModal.payNow')}
                      <ExternalLink className="h-4 w-4" />
                    </>
                }
              </div>
            </button>
          </div>

          {/* Wire / ACH — fetched */}
          <div className="px-5">
            <button
              type="button"
              onClick={() => setWireExpanded(prev => !prev)}
              className="flex items-center justify-between w-full py-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <Building2 className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-zinc-900">
                    {t('tdPayModal.bankTransfer')}
                  </p>
                  <p className="text-xs text-zinc-500">{csym}{amount.toFixed(2)} {currency}</p>
                </div>
              </div>
              <ChevronDown className={cn('h-5 w-5 text-zinc-400 transition-transform', wireExpanded && 'rotate-180')} />
            </button>
            {wireExpanded && (
              <div className="pb-4 ml-[52px] space-y-1">
                {bankLoading && (
                  <div className="py-2 text-xs text-zinc-500 flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('tdPayModal.loadingDetails')}
                  </div>
                )}
                {bankError && (
                  <div className="py-2 text-xs text-red-600">
                    {t('tdPayModal.errorPrefix')}{bankError}
                  </div>
                )}
                {bankDetails && (
                  <>
                    {invoiceNumber && (
                      <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                        <p className="text-[11px] font-semibold text-amber-900">
                          {t('tdPayModal.referenceRequired')}
                        </p>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span className="text-base font-mono font-bold text-amber-900">{invoiceNumber}</span>
                          <CopyButton text={invoiceNumber} />
                        </div>
                        <p className="mt-1 text-[11px] leading-snug text-amber-800">
                          {t('tdPayModal.referenceNote')}
                        </p>
                      </div>
                    )}
                    {bankDetails.beneficiary && (
                      <DetailRow label={t('tdPayModal.beneficiary')} value={bankDetails.beneficiary} />
                    )}
                    {bankDetails.bank && (
                      <DetailRow label={t('tdPayModal.bank')} value={bankDetails.bank} />
                    )}
                    {bankDetails.account && (
                      <DetailRow label={t('tdPayModal.accountNumber')} value={bankDetails.account} />
                    )}
                    {bankDetails.routing && (
                      <DetailRow label={t('tdPayModal.routing')} value={bankDetails.routing} />
                    )}
                    {bankDetails.type && (
                      <DetailRow label={t('tdPayModal.type')} value={bankDetails.type} />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
