'use client'

import { useState, useEffect } from 'react'
import {
  X, Loader2, CheckCircle2, AlertCircle, XCircle, Info,
  RefreshCw, Wrench, Stethoscope, ChevronDown, ChevronRight,
  ShieldAlert, ShieldCheck, Shield,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface DiagnosticFix {
  action: string
  label: string
  params: Record<string, unknown>
  description?: string
  impact?: string[]
  risk?: 'safe' | 'moderate' | 'high'
}

interface DiagnosticCheck {
  id: string
  category: string
  label: string
  status: 'ok' | 'warning' | 'error' | 'info'
  detail: string
  fix?: DiagnosticFix
}

interface DiagnosticResult {
  contact: { id: string; full_name: string; portal_tier: string | null; email: string | null }
  checks: DiagnosticCheck[]
  summary: { ok: number; warning: number; error: number; info: number; total: number }
}

interface Props {
  open: boolean
  onClose: () => void
  contactId: string
  contactName: string
}

const STATUS_ICON = {
  ok: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
  info: Info,
}

const STATUS_COLOR = {
  ok: 'text-green-600',
  warning: 'text-amber-500',
  error: 'text-red-600',
  info: 'text-blue-500',
}

const STATUS_BG = {
  ok: 'bg-green-50',
  warning: 'bg-amber-50',
  error: 'bg-red-50',
  info: 'bg-blue-50',
}

const RISK_CONFIG = {
  safe: { icon: ShieldCheck, color: 'text-green-600', bg: 'bg-green-50', label: 'Safe — internal change only' },
  moderate: { icon: Shield, color: 'text-amber-600', bg: 'bg-amber-50', label: 'Moderate — changes visible data' },
  high: { icon: ShieldAlert, color: 'text-red-600', bg: 'bg-red-50', label: 'High — visible to client' },
}

const CATEGORY_ORDER = ['Contact Profile', 'Lead & Offer', 'Payments', 'Services', 'Wizard & Forms', 'Portal Access', 'Linked Accounts', 'Documents']

const FORM_ACTIONS = new Set(['record_payment'])

export function ContactDiagnosticDialog({ open, onClose, contactId, contactName }: Props) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DiagnosticResult | null>(null)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [paymentForm, setPaymentForm] = useState({
    amount: '',
    currency: 'EUR',
    payment_method: 'Wire Transfer',
    bank_name: '',
    paid_date: new Date().toISOString().split('T')[0],
  })

  useEffect(() => {
    if (open) {
      runDiagnostic()
    } else {
      setResult(null)
      setError(null)
      setExpandedId(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!expandedId || !result) return
    const check = result.checks.find(c => c.id === expandedId)
    if (check?.fix?.action === 'record_payment') {
      const p = check.fix.params
      setPaymentForm(prev => ({
        ...prev,
        amount: p.amount ? String(p.amount) : '',
        currency: (p.currency as string) || 'EUR',
        payment_method: (p.payment_method as string) || 'Wire Transfer',
      }))
    }
  }, [expandedId, result])

  async function runDiagnostic() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/crm/admin-actions/diagnose-contact?contact_id=${contactId}`)
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function executeFix(check: DiagnosticCheck, overrideParams?: Record<string, unknown>) {
    if (!check.fix) return
    setFixingId(check.id)
    try {
      const params = overrideParams
        ? { ...check.fix.params, ...overrideParams }
        : check.fix.params

      const res = await fetch('/api/crm/admin-actions/diagnose-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          action: check.fix.action,
          params,
        }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
        setExpandedId(null)
        await runDiagnostic()
      } else {
        toast.error(data.detail || 'Fix failed')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fix failed')
    } finally {
      setFixingId(null)
    }
  }

  if (!open) return null

  const grouped: Record<string, DiagnosticCheck[]> = {}
  if (result) {
    for (const check of result.checks) {
      if (!grouped[check.category]) grouped[check.category] = []
      grouped[check.category].push(check)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Stethoscope className="h-5 w-5 text-amber-600" />
            <div>
              <h2 className="text-lg font-semibold">Contact Diagnostic</h2>
              <p className="text-sm text-zinc-500">{contactName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {result && !loading && (
              <button
                onClick={runDiagnostic}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-100 hover:bg-zinc-200 transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-run
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-100">
              <X className="h-5 w-5 text-zinc-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
              <p className="text-sm text-zinc-500">Running diagnostic...</p>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-4 bg-red-50 rounded-lg text-sm text-red-700">
              <XCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {result && !loading && (
            <>
              {/* Summary bar */}
              <div className="flex items-center gap-4 mb-6 p-3 bg-zinc-50 rounded-lg text-sm">
                <span className="flex items-center gap-1.5 text-green-700">
                  <CheckCircle2 className="h-4 w-4" /> {result.summary.ok} OK
                </span>
                <span className="flex items-center gap-1.5 text-amber-600">
                  <AlertCircle className="h-4 w-4" /> {result.summary.warning} Warning
                </span>
                <span className="flex items-center gap-1.5 text-red-600">
                  <XCircle className="h-4 w-4" /> {result.summary.error} Error
                </span>
                {result.summary.info > 0 && (
                  <span className="flex items-center gap-1.5 text-blue-500">
                    <Info className="h-4 w-4" /> {result.summary.info} Info
                  </span>
                )}
              </div>

              {/* Checks by category */}
              <div className="space-y-6">
                {CATEGORY_ORDER.filter(cat => grouped[cat]?.length).map(category => (
                  <div key={category}>
                    <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      {category}
                    </h3>
                    <div className="space-y-1.5">
                      {grouped[category].map(check => {
                        const Icon = STATUS_ICON[check.status]
                        const hasFix = !!check.fix
                        const isExpanded = expandedId === check.id
                        const isClickable = hasFix || check.status === 'error' || check.status === 'warning'
                        const needsForm = hasFix && FORM_ACTIONS.has(check.fix!.action)

                        return (
                          <div key={check.id}>
                            <div
                              className={cn(
                                'flex items-start gap-3 p-3 rounded-lg text-sm transition-colors',
                                STATUS_BG[check.status],
                                isClickable && 'cursor-pointer hover:opacity-80',
                                isExpanded && 'rounded-b-none',
                              )}
                              onClick={() => isClickable ? setExpandedId(isExpanded ? null : check.id) : undefined}
                            >
                              {isClickable ? (
                                <div className="mt-0.5 shrink-0">
                                  {isExpanded
                                    ? <ChevronDown className={cn('h-4 w-4', STATUS_COLOR[check.status])} />
                                    : <ChevronRight className={cn('h-4 w-4', STATUS_COLOR[check.status])} />
                                  }
                                </div>
                              ) : (
                                <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', STATUS_COLOR[check.status])} />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-zinc-800">{check.label}</p>
                                <p className="text-xs text-zinc-600 mt-0.5">{check.detail}</p>
                              </div>
                              {hasFix && !isExpanded && (
                                <span className="text-xs text-zinc-400 shrink-0 mt-0.5">Click to fix</span>
                              )}
                            </div>

                            {/* Expanded Fix Panel */}
                            {isExpanded && (
                              <div className={cn(
                                'border-t p-4 rounded-b-lg space-y-3',
                                STATUS_BG[check.status],
                              )}>
                                {hasFix ? (
                                  <>
                                    <div>
                                      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">What this fix does</p>
                                      <p className="text-sm text-zinc-700">
                                        {check.fix!.description || check.fix!.label}
                                      </p>
                                    </div>

                                    {check.fix!.impact && check.fix!.impact.length > 0 && (
                                      <div>
                                        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">What happens next</p>
                                        <ul className="space-y-1">
                                          {check.fix!.impact.map((line, i) => (
                                            <li key={i} className="text-xs text-zinc-600 flex items-start gap-1.5">
                                              <span className="text-zinc-400 mt-0.5">&bull;</span>
                                              {line}
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}

                                    {check.fix!.risk && (
                                      <div>
                                        {(() => {
                                          const rc = RISK_CONFIG[check.fix!.risk!]
                                          const RiskIcon = rc.icon
                                          return (
                                            <div className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium', rc.bg, rc.color)}>
                                              <RiskIcon className="h-3.5 w-3.5" />
                                              {rc.label}
                                            </div>
                                          )
                                        })()}
                                      </div>
                                    )}

                                    {/* Payment Form */}
                                    {needsForm && check.fix!.action === 'record_payment' && (
                                      <div className="bg-white rounded-lg border p-4 space-y-3" onClick={e => e.stopPropagation()}>
                                        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Payment details</p>
                                        <div className="grid grid-cols-2 gap-3">
                                          <div>
                                            <label className="block text-xs font-medium text-zinc-600 mb-1">Amount</label>
                                            <input
                                              type="number"
                                              step="0.01"
                                              value={paymentForm.amount}
                                              onChange={e => setPaymentForm(p => ({ ...p, amount: e.target.value }))}
                                              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                                              placeholder="3000"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-xs font-medium text-zinc-600 mb-1">Currency</label>
                                            <select
                                              value={paymentForm.currency}
                                              onChange={e => setPaymentForm(p => ({ ...p, currency: e.target.value }))}
                                              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
                                            >
                                              <option value="EUR">EUR</option>
                                              <option value="USD">USD</option>
                                            </select>
                                          </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                          <div>
                                            <label className="block text-xs font-medium text-zinc-600 mb-1">Payment method</label>
                                            <select
                                              value={paymentForm.payment_method}
                                              onChange={e => setPaymentForm(p => ({ ...p, payment_method: e.target.value, bank_name: e.target.value === 'Card' ? '' : p.bank_name }))}
                                              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
                                            >
                                              <option value="Wire Transfer">Wire Transfer</option>
                                              <option value="Card">Card (Stripe/Whop)</option>
                                            </select>
                                          </div>
                                          <div>
                                            <label className="block text-xs font-medium text-zinc-600 mb-1">
                                              {paymentForm.payment_method === 'Wire Transfer' ? 'Bank used' : 'Gateway'}
                                            </label>
                                            {paymentForm.payment_method === 'Wire Transfer' ? (
                                              <select
                                                value={paymentForm.bank_name}
                                                onChange={e => setPaymentForm(p => ({ ...p, bank_name: e.target.value }))}
                                                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
                                              >
                                                <option value="">Select bank...</option>
                                                <option value="Airwallex">Airwallex (EUR)</option>
                                                <option value="Relay">Relay (USD)</option>
                                                <option value="Mercury">Mercury (USD)</option>
                                                <option value="Revolut">Revolut</option>
                                              </select>
                                            ) : (
                                              <select
                                                value={paymentForm.bank_name}
                                                onChange={e => setPaymentForm(p => ({ ...p, bank_name: e.target.value }))}
                                                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
                                              >
                                                <option value="">Select gateway...</option>
                                                <option value="Stripe">Stripe</option>
                                                <option value="Whop">Whop</option>
                                              </select>
                                            )}
                                          </div>
                                        </div>
                                        <div>
                                          <label className="block text-xs font-medium text-zinc-600 mb-1">Date paid</label>
                                          <input
                                            type="date"
                                            value={paymentForm.paid_date}
                                            onChange={e => setPaymentForm(p => ({ ...p, paid_date: e.target.value }))}
                                            className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                                          />
                                        </div>
                                      </div>
                                    )}

                                    {/* Action button */}
                                    <div className="pt-1">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          if (needsForm && check.fix!.action === 'record_payment') {
                                            if (!paymentForm.amount || parseFloat(paymentForm.amount) <= 0) {
                                              toast.error('Enter a valid amount')
                                              return
                                            }
                                            executeFix(check, {
                                              amount: parseFloat(paymentForm.amount),
                                              currency: paymentForm.currency,
                                              payment_method: paymentForm.payment_method,
                                              bank_name: paymentForm.bank_name || undefined,
                                              paid_date: paymentForm.paid_date,
                                            })
                                          } else {
                                            executeFix(check)
                                          }
                                        }}
                                        disabled={fixingId === check.id}
                                        className={cn(
                                          'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50',
                                          check.fix!.risk === 'high'
                                            ? 'bg-red-600 text-white hover:bg-red-700'
                                            : check.fix!.risk === 'moderate'
                                              ? 'bg-amber-600 text-white hover:bg-amber-700'
                                              : 'bg-zinc-800 text-white hover:bg-zinc-900'
                                        )}
                                      >
                                        {fixingId === check.id ? (
                                          <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                          <Wrench className="h-4 w-4" />
                                        )}
                                        {needsForm ? 'Confirm payment' : check.fix!.label}
                                      </button>
                                    </div>
                                  </>
                                ) : (
                                  <p className="text-sm text-zinc-600">
                                    No automatic fix available. Use Claude or MCP tools to resolve this manually.
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
