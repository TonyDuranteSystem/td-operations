'use client'

import { useState } from 'react'
import { CreditCard, Smartphone, Building2, ChevronDown, Copy, Check, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t, type Locale } from '@/lib/portal/i18n'

interface PaymentMethod {
  name: string
  currency: string
  active: boolean
  type: 'zelle' | 'ach' | 'wire'
  email?: string
  bank_name?: string
  account_number?: string
  routing_number?: string
  account_holder?: string
  iban?: string
  swift?: string
}

interface PayNowProps {
  invoiceNumber: string
  total: number
  currency: string
  paymentMethods: PaymentMethod[]
  whopCheckoutUrl: string | null
  locale: Locale
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={handleCopy} className="p-1 rounded hover:bg-zinc-100 transition-colors" title="Copy">
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

export function PayNow({ invoiceNumber, total, currency, paymentMethods, whopCheckoutUrl, locale }: PayNowProps) {
  const [expandedMethod, setExpandedMethod] = useState<string | null>(null)
  const csym = currency === 'EUR' ? '\u20AC' : '$'
  const cardTotal = Math.ceil(total * 1.05)

  // Filter methods by currency: USD invoices get Zelle + ACH, EUR get Wire
  const relevantMethods = paymentMethods.filter(m => {
    if (!m.active) return false
    if (currency === 'EUR') return m.type === 'wire' && m.currency === 'EUR'
    return m.type === 'zelle' || (m.type === 'ach' && m.currency === 'USD')
  })

  const toggle = (type: string) => {
    setExpandedMethod(prev => prev === type ? null : type)
  }

  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-gradient-to-r from-blue-600 to-blue-700">
        <h3 className="text-white font-semibold text-base">{t('pay.title', locale)}</h3>
        <p className="text-blue-100 text-sm mt-0.5">
          {csym}{total.toFixed(2)} {currency}
        </p>
      </div>

      <div className="divide-y">
        {/* Card payment — always first if available */}
        {whopCheckoutUrl && (
          <div className="px-5 py-4">
            <a
              href={whopCheckoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between w-full group"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                  <CreditCard className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-900 group-hover:text-blue-600 transition-colors">
                    {t('pay.card', locale)}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {csym}{cardTotal.toFixed(2)} {currency} <span className="text-zinc-400">({t('pay.cardFee', locale)})</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg group-hover:bg-blue-700 transition-colors">
                {t('pay.payNow', locale)}
                <ExternalLink className="h-4 w-4" />
              </div>
            </a>
          </div>
        )}

        {/* Zelle */}
        {relevantMethods.filter(m => m.type === 'zelle').map(method => (
          <div key="zelle" className="px-5">
            <button
              onClick={() => toggle('zelle')}
              className="flex items-center justify-between w-full py-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
                  <Smartphone className="h-5 w-5 text-purple-600" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-zinc-900">Zelle</p>
                  <p className="text-xs text-zinc-500">{csym}{total.toFixed(2)} {currency}</p>
                </div>
              </div>
              <ChevronDown className={cn('h-5 w-5 text-zinc-400 transition-transform', expandedMethod === 'zelle' && 'rotate-180')} />
            </button>
            {expandedMethod === 'zelle' && (
              <div className="pb-4 pl-13 space-y-1 ml-[52px]">
                <DetailRow label={t('pay.sendTo', locale)} value={method.email!} />
                <DetailRow label={t('pay.amount', locale)} value={`${csym}${total.toFixed(2)}`} />
                <DetailRow label={t('pay.reference', locale)} value={invoiceNumber} />
              </div>
            )}
          </div>
        ))}

        {/* ACH / Wire */}
        {relevantMethods.filter(m => m.type === 'ach' || m.type === 'wire').map(method => (
          <div key={method.type} className="px-5">
            <button
              onClick={() => toggle(method.type)}
              className="flex items-center justify-between w-full py-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <Building2 className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-zinc-900">{method.name}</p>
                  <p className="text-xs text-zinc-500">{csym}{total.toFixed(2)} {currency}</p>
                </div>
              </div>
              <ChevronDown className={cn('h-5 w-5 text-zinc-400 transition-transform', expandedMethod === method.type && 'rotate-180')} />
            </button>
            {expandedMethod === method.type && (
              <div className="pb-4 ml-[52px] space-y-1">
                {method.bank_name && <DetailRow label={t('pay.bank', locale)} value={method.bank_name} />}
                {method.account_holder && <DetailRow label={t('pay.beneficiary', locale)} value={method.account_holder} />}
                {method.routing_number && <DetailRow label={t('pay.routing', locale)} value={method.routing_number} />}
                {method.account_number && <DetailRow label={t('pay.accountNo', locale)} value={method.account_number} />}
                {method.iban && <DetailRow label="IBAN" value={method.iban} />}
                {method.swift && <DetailRow label="SWIFT/BIC" value={method.swift} />}
                <DetailRow label={t('pay.reference', locale)} value={invoiceNumber} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
