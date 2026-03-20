'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, Loader2, CheckCircle2, Circle, Landmark, DollarSign, Euro } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'

interface BankAccount {
  id: string
  label: string
  currency: string
  account_holder: string | null
  bank_name: string | null
  iban: string | null
  swift_bic: string | null
  account_number: string | null
  routing_number: string | null
  notes: string | null
  show_on_invoice: boolean
}

export function BankAccounts({ accountId }: { accountId: string }) {
  const { t } = useLocale()
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)

  // New account form
  const [currency, setCurrency] = useState<'USD' | 'EUR'>('USD')
  const [label, setLabel] = useState('')
  const [holder, setHolder] = useState('')
  const [bankName, setBankName] = useState('')
  const [iban, setIban] = useState('')
  const [swift, setSwift] = useState('')
  const [accNum, setAccNum] = useState('')
  const [routing, setRouting] = useState('')
  const [notes, setNotes] = useState('')
  const [showOnInvoice, setShowOnInvoice] = useState(false)

  useEffect(() => {
    fetch(`/api/portal/bank-accounts?account_id=${accountId}`)
      .then(r => r.json())
      .then(data => { setAccounts(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [accountId])

  const resetForm = () => {
    setCurrency('USD'); setLabel(''); setHolder(''); setBankName('')
    setIban(''); setSwift(''); setAccNum(''); setRouting(''); setNotes('')
    setShowOnInvoice(false)
  }

  const handleAdd = async () => {
    if (!label.trim()) { toast.error(t('bank.labelRequired')); return }
    setSaving(true)
    try {
      const res = await fetch('/api/portal/bank-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId, label: label.trim(), currency,
          account_holder: holder, bank_name: bankName, iban, swift_bic: swift,
          account_number: accNum, routing_number: routing, notes,
          show_on_invoice: showOnInvoice || accounts.length === 0, // First account auto-selected
        }),
      })
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      // If new one is show_on_invoice, update local state
      if (data.show_on_invoice) {
        setAccounts(prev => [...prev.map(a => ({ ...a, show_on_invoice: false })), data])
      } else {
        setAccounts(prev => [...prev, data])
      }
      resetForm(); setShowAdd(false)
      toast.success(t('bank.saved'))
    } catch { toast.error(t('bank.failed')) }
    finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/portal/bank-accounts?id=${id}&account_id=${accountId}`, { method: 'DELETE' })
      setAccounts(prev => prev.filter(a => a.id !== id))
      toast.success(t('bank.removed'))
    } catch { toast.error(t('bank.failed')) }
  }

  const handleSetInvoice = async (id: string) => {
    try {
      await fetch('/api/portal/bank-accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, account_id: accountId, show_on_invoice: true }),
      })
      setAccounts(prev => prev.map(a => ({ ...a, show_on_invoice: a.id === id })))
      toast.success(t('bank.invoiceUpdated'))
    } catch { toast.error(t('bank.failed')) }
  }

  if (loading) return <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />

  return (
    <div className="space-y-4">
      {/* Existing accounts */}
      {accounts.length > 0 && (
        <div className="space-y-3">
          {accounts.map(acc => (
            <div key={acc.id} className={`border rounded-xl p-4 transition-colors ${acc.show_on_invoice ? 'border-blue-300 bg-blue-50/50' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {acc.currency === 'EUR'
                    ? <Euro className="h-4 w-4 text-blue-600" />
                    : <DollarSign className="h-4 w-4 text-emerald-600" />
                  }
                  <span className="text-sm font-semibold text-zinc-900">{acc.label}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{acc.currency}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleSetInvoice(acc.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors ${
                      acc.show_on_invoice
                        ? 'bg-blue-100 text-blue-700 font-medium'
                        : 'text-zinc-400 hover:text-blue-600 hover:bg-blue-50'
                    }`}
                    title={t('bank.showOnInvoices')}
                  >
                    {acc.show_on_invoice
                      ? <><CheckCircle2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t('bank.onInvoice')}</span></>
                      : <><Circle className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t('bank.useOnInvoice')}</span></>
                    }
                  </button>
                  <button onClick={() => handleDelete(acc.id)} className="p-1.5 text-zinc-400 hover:text-red-600 rounded">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-zinc-600">
                {acc.account_holder && <div><span className="text-zinc-400">{t('bank.holder')}:</span> {acc.account_holder}</div>}
                {acc.bank_name && <div><span className="text-zinc-400">{t('bank.bank')}:</span> {acc.bank_name}</div>}
                {acc.iban && <div><span className="text-zinc-400">{t('bank.iban')}:</span> {acc.iban}</div>}
                {acc.swift_bic && <div><span className="text-zinc-400">{t('bank.swiftBic')}:</span> {acc.swift_bic}</div>}
                {acc.account_number && <div><span className="text-zinc-400">{t('bank.acctNum')}:</span> {acc.account_number}</div>}
                {acc.routing_number && <div><span className="text-zinc-400">{t('bank.routingNum')}:</span> {acc.routing_number}</div>}
                {acc.notes && <div className="sm:col-span-2 mt-1 text-zinc-400 italic">{acc.notes}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new account form */}
      {showAdd ? (
        <div className="border rounded-xl p-4 space-y-3 bg-zinc-50">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-sm font-medium text-zinc-700">{t('bank.newAccount')}</span>
          </div>

          {/* Currency toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setCurrency('USD')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 text-sm rounded-lg border transition-colors ${
                currency === 'USD' ? 'bg-emerald-50 border-emerald-300 text-emerald-700 font-medium' : 'hover:bg-zinc-100'
              }`}>
              <DollarSign className="h-4 w-4" /> {t('bank.usdAccount')}
            </button>
            <button type="button" onClick={() => setCurrency('EUR')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 text-sm rounded-lg border transition-colors ${
                currency === 'EUR' ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium' : 'hover:bg-zinc-100'
              }`}>
              <Euro className="h-4 w-4" /> {t('bank.eurAccount')}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-600 mb-1">{t('bank.label')} *</label>
              <input type="text" value={label} onChange={e => setLabel(e.target.value)}
                placeholder={currency === 'USD' ? 'e.g., Chase USD' : 'e.g., Deutsche Bank EUR'}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-zinc-600 mb-1">{t('bank.accountHolder')}</label>
              <input type="text" value={holder} onChange={e => setHolder(e.target.value)} placeholder="Company or person name"
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-600 mb-1">{t('bank.bankName')}</label>
            <input type="text" value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Chase, Deutsche Bank..."
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          {/* Currency-specific fields */}
          {currency === 'EUR' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-600 mb-1">{t('bank.iban')}</label>
                <input type="text" value={iban} onChange={e => setIban(e.target.value)} placeholder="DE89 3704 0044 0532 0130 00"
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-zinc-600 mb-1">{t('bank.swiftBic')}</label>
                <input type="text" value={swift} onChange={e => setSwift(e.target.value)} placeholder="COBADEFFXXX"
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-600 mb-1">{t('bank.accountNumber')}</label>
                <input type="text" value={accNum} onChange={e => setAccNum(e.target.value)} placeholder="987654321"
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-zinc-600 mb-1">{t('bank.routingNumber')}</label>
                <input type="text" value={routing} onChange={e => setRouting(e.target.value)} placeholder="021000021"
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-zinc-600 mb-1">{t('bank.swiftBic')} (optional)</label>
                <input type="text" value={swift} onChange={e => setSwift(e.target.value)} placeholder="CHASUS33"
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs text-zinc-600 mb-1">{t('bank.notes')}</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Wire transfer only, payment reference..."
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={showOnInvoice} onChange={e => setShowOnInvoice(e.target.checked)}
              className="rounded border-zinc-300 text-blue-600 focus:ring-blue-500" />
            <span className="text-sm text-zinc-700">{t('bank.showOnInvoices')}</span>
          </label>

          <div className="flex gap-2 pt-1">
            <button onClick={handleAdd} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {t('bank.addAccount')}
            </button>
            <button onClick={() => { setShowAdd(false); resetForm() }}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">{t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => { setShowAdd(true); setShowOnInvoice(accounts.length === 0) }}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700">
          <Plus className="h-4 w-4" /> {t('bank.addBankAccount')}
        </button>
      )}

      <p className="text-xs text-zinc-400">{t('bank.autoNote')}</p>
    </div>
  )
}
