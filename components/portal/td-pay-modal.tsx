'use client'

import { useEffect, useRef, useState } from 'react'
import { CreditCard, Building2, Copy, Check, X, Loader2, ExternalLink, ChevronDown, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/portal/use-locale'
import { useAppMode } from '@/lib/app-mode/app-mode-context'
import { FastTooltip } from '@/components/ui/fast-tooltip'

interface TdPayModalProps {
  paymentId: string
  invoiceNumber: string
  amount: number
  currency: string
  onClose: () => void
}

/** GET /api/workflows/create-invoice-checkout — the card price for this invoice. */
interface CardQuoteView {
  /** Still owed on the invoice (card fee excluded). */
  amount: number
  /** Card fee on that balance (0 when the global fee switch is off). */
  fee: number
  /** The rate applied, e.g. 0.05. */
  cardFeeRate: number
  /** What the card page will ask for: balance + fee. */
  cardAmount: number
}

/** The popup's own wording for a refused card payment (falls back to the server's text). */
function refusalText(r: { reason: string | null; error: string }, t: (k: string) => string): string {
  switch (r.reason) {
    case 'closed': return t('tdPayModal.refusedClosed')
    case 'nothing_owed': return t('tdPayModal.refusedNothingOwed')
    case 'paid': return t('tdPayModal.refusedPaid')
    case 'too_small': return t('tdPayModal.refusedTooSmall')
    default: return r.error
  }
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
    <FastTooltip label="Copy">
      <button
        type="button"
        onClick={handleCopy}
        className="p-1 rounded hover:bg-zinc-100 transition-colors"
        aria-label="Copy"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-zinc-400" />}
      </button>
    </FastTooltip>
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
  // Inside the client iPhone app the card page opens in the app's own window (a new window needs the phone shell to catch it).
  // The app asks the checkout to send the client back to its TD Billing screen when they are done or cancel (`return_to`), so they never
  // end up on a plain page outside the app. See docs/systems/client-app.md (Step 3c). On the website it is a new tab, as before.
  const appMode = useAppMode()
  const router = useRouter()
  // Read inside the mount-only effect below without retriggering it \u2014 t() is
  // a fresh closure every render, and this fetch must only run once.
  const tRef = useRef(t)
  tRef.current = t
  const csym = currency === 'EUR' ? '\u20AC' : '$'

  // The card price comes from the SERVER (lib/payments/card-quote.ts): what is still
  // owed on the invoice plus the card fee on it, at the rate pinned on that invoice.
  // The popup used to work out its own "+5%, rounded up" and could disagree with what
  // Stripe was then asked to charge \u2014 the number shown here is now the number charged.
  const [quote, setQuote] = useState<CardQuoteView | null>(null)
  const [quoteState, setQuoteState] = useState<'loading' | 'ready' | 'refused' | 'failed'>('loading')
  // Why the card cannot be used: the server's reason code (translated here) + its own text as a fallback.
  const [quoteRefusal, setQuoteRefusal] = useState<{ reason: string | null; error: string } | null>(null)
  // What is still owed: the server's number once we have it, the list's balance until then.
  const owed = quote ? quote.amount : amount

  const [bankDetails, setBankDetails] = useState<BankDetails | null>(null)
  const [bankLoading, setBankLoading] = useState(true)
  const [bankError, setBankError] = useState<string | null>(null)
  const [stripeLoading, setStripeLoading] = useState(false)
  const [wireExpanded, setWireExpanded] = useState(false)
  const [autopayAccountId, setAutopayAccountId] = useState<string | null>(null)
  const [autopayLoading, setAutopayLoading] = useState(false)

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

  // Ask the server for the card price (read-only — starts no payment).
  useEffect(() => {
    let cancelled = false
    fetch(`/api/workflows/create-invoice-checkout?payment_id=${encodeURIComponent(paymentId)}`)
      .then(async res => ({ ok: res.ok, data: await res.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (cancelled) return
        if (ok && typeof data.cardAmount === 'number' && typeof data.amount === 'number') {
          setQuote({ amount: data.amount, fee: Number(data.fee) || 0, cardFeeRate: Number(data.cardFeeRate) || 0, cardAmount: data.cardAmount })
          setQuoteState('ready')
        } else if (data?.reason === 'unavailable' || data?.reason === 'not_found' || data?.reason === 'currency') {
          // The price could not be worked out (lookup failed, invoice not found, a currency
          // the card cannot take): translated "could not load the card price, pay by bank
          // transfer" text — not the server's English sentence.
          setQuoteState('failed')
        } else if (data?.error) {
          // R099: show the server's real reason (closed invoice, nothing owed, ...).
          setQuoteRefusal({ reason: typeof data.reason === 'string' ? data.reason : null, error: String(data.error) })
          setQuoteState('refused')
        } else {
          setQuoteState('failed')
        }
      })
      .catch(() => { if (!cancelled) setQuoteState('failed') })
    return () => { cancelled = true }
  }, [paymentId])

  // Should we nudge this client to activate autopay? Only when the feature
  // is live and this invoice's account isn't already enrolled.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/portal/autopay/eligibility?payment_id=${encodeURIComponent(paymentId)}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        if (data.showPrompt && data.accountId) setAutopayAccountId(data.accountId)
      })
      .catch(() => { /* nudge is a nice-to-have — a lookup failure just hides it */ })
    return () => { cancelled = true }
  }, [paymentId])

  const handleActivateAutopay = async () => {
    if (autopayLoading || !autopayAccountId) return
    setAutopayLoading(true)
    try {
      const res = await fetch('/api/portal/autopay/setup-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: autopayAccountId }),
      })
      const data = await res.json()
      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error || t('autopay.startFailed'))
      }
      window.location.href = data.checkoutUrl
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('autopay.startFailed'))
      setAutopayLoading(false)
    }
  }

  // Coming back from the card page (Back, or the app returning to the front after the phone handed the page to another app), the phone can
  // bring this screen back exactly as it was left, buttons still spinning and the invoice list still saying "Pay". Unlock the buttons and
  // ask the page for fresh data. A normal load starts fresh anyway.
  useEffect(() => {
    if (!appMode) return
    const comeBack = () => {
      setStripeLoading(false)
      setAutopayLoading(false)
      router.refresh()
    }
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) comeBack() }
    const onVisible = () => { if (document.visibilityState === 'visible') comeBack() }
    window.addEventListener('pageshow', onShow)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('pageshow', onShow)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [appMode, router])

  const handlePayByCard = async () => {
    if (stripeLoading) return
    setStripeLoading(true)
    let leaving = false
    try {
      const res = await fetch('/api/workflows/create-invoice-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appMode ? { payment_id: paymentId, return_to: 'client_app' } : { payment_id: paymentId }),
      })
      const data = await res.json()
      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error || t('tdPayModal.checkoutFailed'))
      }
      if (appMode) {
        // Keep the button locked while the page leaves: a second tap would start a second live card session for the same invoice.
        leaving = true
        window.location.assign(data.checkoutUrl)
      } else {
        window.open(data.checkoutUrl, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('tdPayModal.cardPaymentFailed'))
    } finally {
      if (!leaving) setStripeLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        // In the app the pop-up never grows taller than the screen: with the bank details open it is taller than a small phone, so it scrolls.
        className={cn('bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden', appMode && 'max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain')}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-gradient-to-r from-blue-600 to-blue-700 flex items-center justify-between">
          <div>
            <h3 className="text-white font-semibold text-base">
              {t('tdPayModal.title')}
            </h3>
            <p className="text-blue-100 text-sm mt-0.5">
              {invoiceNumber} — {csym}{owed.toFixed(2)} {currency}
            </p>
          </div>
          <FastTooltip label={t('tdPayModal.close')}>
            <button
              type="button"
              onClick={onClose}
              className="text-white/70 hover:text-white p-1"
              aria-label={t('tdPayModal.close')}
            >
              <X className="h-5 w-5" />
            </button>
          </FastTooltip>
        </div>

        {autopayAccountId && (
          <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5">
            <Zap className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-900 leading-snug flex-1">{t('autopay.payModalNudge')}</p>
            <button
              type="button"
              onClick={handleActivateAutopay}
              disabled={autopayLoading}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-60"
            >
              {autopayLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : t('autopay.payModalCta')}
            </button>
          </div>
        )}

        <div className="divide-y">
          {/* Card payment — Stripe */}
          <div className="px-5 py-4">
            <button
              type="button"
              onClick={handlePayByCard}
              disabled={stripeLoading || quoteState === 'loading' || quoteState === 'refused' || quoteState === 'failed'}
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
                  {quoteState === 'ready' && quote && (
                    <p className="text-xs text-zinc-500">
                      {csym}{quote.cardAmount.toFixed(2)} {currency}
                      {quote.fee > 0 && (
                        <span className="text-zinc-400"> ({t('tdPayModal.feeRate').replace('{rate}', String(Math.round(quote.cardFeeRate * 10000) / 100))})</span>
                      )}
                    </p>
                  )}
                  {quoteState === 'loading' && <p className="text-xs text-zinc-400">…</p>}
                  {quoteState === 'refused' && quoteRefusal && (
                    <p className="text-xs text-red-600">{refusalText(quoteRefusal, t)}</p>
                  )}
                  {quoteState === 'failed' && <p className="text-xs text-red-600">{t('tdPayModal.priceFailed')}</p>}
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
                  <p className="text-xs text-zinc-500">{csym}{owed.toFixed(2)} {currency}</p>
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
