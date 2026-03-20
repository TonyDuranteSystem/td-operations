'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import {
  Save,
  Loader2,
  Building2,
  Landmark,
  CreditCard,
  FileText,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Upload,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface BankAccount {
  name: string
  currency: string
  bank_name: string
  account_number: string
  routing_number: string
  swift: string
  iban: string
  active: boolean
}

interface PaymentGateway {
  name: string
  type: string
  active: boolean
  url: string
}

interface ServiceItem {
  id: string
  name: string
  default_price: number | null
  default_currency: string | null
  sort_order: number
}

interface InvoiceSettings {
  id: string
  company_name: string
  company_address: string
  company_email: string
  company_phone: string | null
  tax_id: string
  logo_url: string | null
  invoice_prefix: string
  invoice_footer: string | null
  default_payment_terms: string
  bank_accounts: BankAccount[]
  payment_gateways: PaymentGateway[]
}

export default function InvoiceSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<InvoiceSettings | null>(null)
  const [services, setServices] = useState<ServiceItem[]>([])
  const [editingService, setEditingService] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editCurrency, setEditCurrency] = useState('USD')
  const [addingService, setAddingService] = useState(false)
  const [newServiceName, setNewServiceName] = useState('')
  const [newServicePrice, setNewServicePrice] = useState('')
  const [newServiceCurrency, setNewServiceCurrency] = useState('USD')
  const [addingBank, setAddingBank] = useState(false)
  const [activeTab, setActiveTab] = useState<'company' | 'services' | 'banks' | 'gateways'>('company')

  useEffect(() => {
    Promise.all([
      fetch('/api/invoice-settings').then(r => r.json()),
      fetch('/api/service-catalog').then(r => r.json()),
    ]).then(([settingsData, servicesData]) => {
      setSettings(settingsData.settings)
      setServices(servicesData.services ?? [])
      setLoading(false)
    }).catch(() => {
      toast.error('Failed to load settings')
      setLoading(false)
    })
  }, [])

  const saveSettings = async (updates: Partial<InvoiceSettings>) => {
    setSaving(true)
    try {
      const res = await fetch('/api/invoice-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSettings(data.settings)
      toast.success('Settings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const saveService = async (id: string) => {
    try {
      const res = await fetch('/api/service-catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: editName.trim(),
          default_price: editPrice ? Number(editPrice) : null,
          default_currency: editCurrency,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setServices(prev => prev.map(s => s.id === id ? { ...s, ...data.service } : s))
      setEditingService(null)
      toast.success('Service updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    }
  }

  const addService = async () => {
    if (!newServiceName.trim()) return
    try {
      const res = await fetch('/api/service-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newServiceName.trim(),
          default_price: newServicePrice ? Number(newServicePrice) : null,
          default_currency: newServiceCurrency,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setServices(prev => [...prev, data.service])
      setNewServiceName('')
      setNewServicePrice('')
      setAddingService(false)
      toast.success(`Service "${data.service.name}" added`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add')
    }
  }

  const deactivateService = async (id: string) => {
    try {
      const res = await fetch('/api/service-catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active: false }),
      })
      if (!res.ok) throw new Error('Failed')
      setServices(prev => prev.filter(s => s.id !== id))
      toast.success('Service removed')
    } catch {
      toast.error('Failed to remove service')
    }
  }

  const updateBankAccount = (index: number, field: keyof BankAccount, value: string | boolean) => {
    if (!settings) return
    const updated = [...settings.bank_accounts]
    updated[index] = { ...updated[index], [field]: value }
    setSettings({ ...settings, bank_accounts: updated })
  }

  const addBankAccount = () => {
    if (!settings) return
    const newBank: BankAccount = {
      name: '',
      currency: 'USD',
      bank_name: '',
      account_number: '',
      routing_number: '',
      swift: '',
      iban: '',
      active: true,
    }
    setSettings({ ...settings, bank_accounts: [...settings.bank_accounts, newBank] })
    setAddingBank(true)
  }

  const removeBankAccount = (index: number) => {
    if (!settings) return
    const updated = settings.bank_accounts.filter((_, i) => i !== index)
    setSettings({ ...settings, bank_accounts: updated })
  }

  const updateGateway = (index: number, field: keyof PaymentGateway, value: string | boolean) => {
    if (!settings) return
    const updated = [...settings.payment_gateways]
    updated[index] = { ...updated[index], [field]: value }
    setSettings({ ...settings, payment_gateways: updated })
  }

  const addGateway = () => {
    if (!settings) return
    const newGw: PaymentGateway = { name: '', type: 'card', active: true, url: '' }
    setSettings({ ...settings, payment_gateways: [...settings.payment_gateways, newGw] })
  }

  const removeGateway = (index: number) => {
    if (!settings) return
    const updated = settings.payment_gateways.filter((_, i) => i !== index)
    setSettings({ ...settings, payment_gateways: updated })
  }

  if (loading) {
    return (
      <div className="p-6 lg:p-8 flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="p-6 lg:p-8">
        <p className="text-red-600">Failed to load invoice settings.</p>
      </div>
    )
  }

  const tabs = [
    { key: 'company' as const, label: 'Company Info', icon: Building2 },
    { key: 'services' as const, label: 'Services', icon: FileText },
    { key: 'banks' as const, label: 'Bank Accounts', icon: Landmark },
    { key: 'gateways' as const, label: 'Payment Gateways', icon: CreditCard },
  ]

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Invoice Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure your company info, services, bank accounts, and payment gateways for invoices.
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b mb-6 overflow-x-auto">
        <div className="flex gap-1 -mb-px min-w-max">
          {tabs.map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                  activeTab === tab.key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-zinc-300'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Company Info ── */}
      {activeTab === 'company' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border p-6 space-y-4">
            <h2 className="text-lg font-medium flex items-center gap-2">
              <Building2 className="h-5 w-5 text-zinc-500" />
              Company Details
            </h2>

            {/* Logo */}
            <div>
              <label className="block text-sm font-medium mb-1">Company Logo</label>
              <div className="flex items-center gap-4">
                {settings.logo_url ? (
                  <img src={settings.logo_url} alt="Logo" className="h-16 w-auto border rounded" />
                ) : (
                  <div className="h-16 w-16 bg-zinc-100 border rounded flex items-center justify-center text-zinc-400">
                    <Upload className="h-6 w-6" />
                  </div>
                )}
                <div>
                  <input
                    type="text"
                    value={settings.logo_url ?? ''}
                    onChange={e => setSettings({ ...settings, logo_url: e.target.value || null })}
                    placeholder="Logo URL (e.g. https://...)"
                    className="w-80 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Enter a URL to your company logo. Appears on invoice PDFs.</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Company Name</label>
                <input type="text" value={settings.company_name}
                  onChange={e => setSettings({ ...settings, company_name: e.target.value })}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Tax ID / EIN</label>
                <input type="text" value={settings.tax_id}
                  onChange={e => setSettings({ ...settings, tax_id: e.target.value })}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Address</label>
              <input type="text" value={settings.company_address}
                onChange={e => setSettings({ ...settings, company_address: e.target.value })}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input type="email" value={settings.company_email}
                  onChange={e => setSettings({ ...settings, company_email: e.target.value })}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Phone</label>
                <input type="text" value={settings.company_phone ?? ''}
                  onChange={e => setSettings({ ...settings, company_phone: e.target.value || null })}
                  placeholder="Optional"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <h2 className="text-lg font-medium flex items-center gap-2 pt-4 border-t">
              <FileText className="h-5 w-5 text-zinc-500" />
              Invoice Format
            </h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Invoice Number Prefix</label>
                <input type="text" value={settings.invoice_prefix}
                  onChange={e => setSettings({ ...settings, invoice_prefix: e.target.value })}
                  placeholder="TD"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="text-xs text-muted-foreground mt-1">Format: {settings.invoice_prefix}-2026-001</p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Default Payment Terms</label>
              <textarea value={settings.default_payment_terms}
                onChange={e => setSettings({ ...settings, default_payment_terms: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Invoice Footer</label>
              <textarea value={settings.invoice_footer ?? ''}
                onChange={e => setSettings({ ...settings, invoice_footer: e.target.value || null })}
                rows={2} placeholder="Optional footer text (e.g. thank you message)"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={() => saveSettings(settings)} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-zinc-900 hover:bg-zinc-800 rounded-md disabled:opacity-50 flex items-center gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Company Info
            </button>
          </div>
        </div>
      )}

      {/* ── Services ── */}
      {activeTab === 'services' && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg border overflow-hidden">
            <div className="px-4 py-3 border-b bg-zinc-50 flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-600 uppercase tracking-wider">Service Catalog</h2>
              <button onClick={() => setAddingService(true)}
                className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1">
                <Plus className="h-3.5 w-3.5" /> Add Service
              </button>
            </div>

            {/* Header */}
            <div className="grid grid-cols-[1fr_100px_80px_60px] gap-3 px-4 py-2 text-xs font-medium text-zinc-400 uppercase border-b">
              <span>Service Name</span>
              <span className="text-right">Default Price</span>
              <span className="text-center">Currency</span>
              <span></span>
            </div>

            {services.map(svc => (
              editingService === svc.id ? (
                <div key={svc.id} className="grid grid-cols-[1fr_100px_80px_60px] gap-3 px-4 py-2.5 border-b bg-blue-50/50 items-center">
                  <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                    className="px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <input type="number" step="0.01" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                    placeholder="—" className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <select value={editCurrency} onChange={e => setEditCurrency(e.target.value)}
                    className="px-1 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                  <div className="flex gap-1">
                    <button onClick={() => saveService(svc.id)} className="p-1 rounded bg-blue-600 text-white hover:bg-blue-700">
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => setEditingService(null)} className="p-1 rounded hover:bg-zinc-200">
                      <X className="h-3.5 w-3.5 text-zinc-400" />
                    </button>
                  </div>
                </div>
              ) : (
                <div key={svc.id} className="grid grid-cols-[1fr_100px_80px_60px] gap-3 px-4 py-2.5 border-b items-center text-sm hover:bg-zinc-50/50 group">
                  <span className="font-medium">{svc.name}</span>
                  <span className="text-right text-zinc-500">
                    {svc.default_price != null
                      ? `${svc.default_currency === 'EUR' ? '\u20AC' : '$'}${svc.default_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                      : '\u2014'}
                  </span>
                  <span className="text-center text-xs text-zinc-400">{svc.default_currency ?? 'USD'}</span>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setEditingService(svc.id); setEditName(svc.name); setEditPrice(svc.default_price != null ? String(svc.default_price) : ''); setEditCurrency(svc.default_currency ?? 'USD') }}
                      className="p-1 rounded hover:bg-zinc-200" title="Edit">
                      <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                    </button>
                    <button onClick={() => deactivateService(svc.id)}
                      className="p-1 rounded hover:bg-red-50" title="Remove">
                      <Trash2 className="h-3.5 w-3.5 text-red-400" />
                    </button>
                  </div>
                </div>
              )
            ))}

            {/* Add new service row */}
            {addingService && (
              <div className="grid grid-cols-[1fr_100px_80px_60px] gap-3 px-4 py-2.5 border-b bg-emerald-50/50 items-center">
                <input type="text" value={newServiceName} onChange={e => setNewServiceName(e.target.value)}
                  placeholder="Service name" autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') addService(); if (e.key === 'Escape') { setAddingService(false); setNewServiceName(''); setNewServicePrice('') } }}
                  className="px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <input type="number" step="0.01" value={newServicePrice} onChange={e => setNewServicePrice(e.target.value)}
                  placeholder="Price"
                  onKeyDown={e => { if (e.key === 'Enter') addService() }}
                  className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <select value={newServiceCurrency} onChange={e => setNewServiceCurrency(e.target.value)}
                  className="px-1 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
                <div className="flex gap-1">
                  <button onClick={addService} disabled={!newServiceName.trim()} className="p-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => { setAddingService(false); setNewServiceName(''); setNewServicePrice('') }} className="p-1 rounded hover:bg-zinc-200">
                    <X className="h-3.5 w-3.5 text-zinc-400" />
                  </button>
                </div>
              </div>
            )}

            {services.length === 0 && !addingService && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">No services configured</div>
            )}
          </div>
        </div>
      )}

      {/* ── Bank Accounts ── */}
      {activeTab === 'banks' && (
        <div className="space-y-4">
          {settings.bank_accounts.map((bank, i) => (
            <div key={i} className="bg-white rounded-lg border p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-zinc-500" />
                  <input type="text" value={bank.name} onChange={e => updateBankAccount(i, 'name', e.target.value)}
                    placeholder="Account name (e.g. Relay USD)"
                    className="text-sm font-medium border-0 border-b border-transparent hover:border-zinc-300 focus:border-blue-500 focus:outline-none px-0 py-0.5" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={bank.active} onChange={e => updateBankAccount(i, 'active', e.target.checked)}
                      className="rounded" />
                    Active
                  </label>
                  <button onClick={() => removeBankAccount(i)} className="p-1 rounded hover:bg-red-50 text-red-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Bank Name</label>
                  <input type="text" value={bank.bank_name} onChange={e => updateBankAccount(i, 'bank_name', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Currency</label>
                  <select value={bank.currency} onChange={e => updateBankAccount(i, 'currency', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Account Number</label>
                  <input type="text" value={bank.account_number} onChange={e => updateBankAccount(i, 'account_number', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Routing Number</label>
                  <input type="text" value={bank.routing_number} onChange={e => updateBankAccount(i, 'routing_number', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">IBAN</label>
                  <input type="text" value={bank.iban} onChange={e => updateBankAccount(i, 'iban', e.target.value)}
                    placeholder="For EUR accounts"
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">SWIFT / BIC</label>
                  <input type="text" value={bank.swift} onChange={e => updateBankAccount(i, 'swift', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
              </div>
            </div>
          ))}

          <button onClick={addBankAccount}
            className="w-full py-3 border-2 border-dashed rounded-lg text-sm text-zinc-500 hover:text-zinc-700 hover:border-zinc-400 flex items-center justify-center gap-1.5 transition-colors">
            <Plus className="h-4 w-4" /> Add Bank Account
          </button>

          <div className="flex justify-end">
            <button onClick={() => saveSettings({ bank_accounts: settings.bank_accounts })} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-zinc-900 hover:bg-zinc-800 rounded-md disabled:opacity-50 flex items-center gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Bank Accounts
            </button>
          </div>
        </div>
      )}

      {/* ── Payment Gateways ── */}
      {activeTab === 'gateways' && (
        <div className="space-y-4">
          {settings.payment_gateways.map((gw, i) => (
            <div key={i} className="bg-white rounded-lg border p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-zinc-500" />
                  <input type="text" value={gw.name} onChange={e => updateGateway(i, 'name', e.target.value)}
                    placeholder="Gateway name (e.g. Stripe)"
                    className="text-sm font-medium border-0 border-b border-transparent hover:border-zinc-300 focus:border-blue-500 focus:outline-none px-0 py-0.5" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={gw.active} onChange={e => updateGateway(i, 'active', e.target.checked)}
                      className="rounded" />
                    Active
                  </label>
                  <button onClick={() => removeGateway(i)} className="p-1 rounded hover:bg-red-50 text-red-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Type</label>
                  <select value={gw.type} onChange={e => updateGateway(i, 'type', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="card">Card (Stripe, Whop)</option>
                    <option value="bank">Bank Transfer</option>
                    <option value="crypto">Crypto</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Payment URL</label>
                  <input type="text" value={gw.url} onChange={e => updateGateway(i, 'url', e.target.value)}
                    placeholder="https://..."
                    className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
              </div>
            </div>
          ))}

          <button onClick={addGateway}
            className="w-full py-3 border-2 border-dashed rounded-lg text-sm text-zinc-500 hover:text-zinc-700 hover:border-zinc-400 flex items-center justify-center gap-1.5 transition-colors">
            <Plus className="h-4 w-4" /> Add Payment Gateway
          </button>

          <div className="flex justify-end">
            <button onClick={() => saveSettings({ payment_gateways: settings.payment_gateways })} disabled={saving}
              className="px-4 py-2 text-sm text-white bg-zinc-900 hover:bg-zinc-800 rounded-md disabled:opacity-50 flex items-center gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Payment Gateways
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
