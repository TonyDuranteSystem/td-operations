'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, Save, Loader2, ExternalLink, Star, CreditCard } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { useLocale } from '@/lib/portal/use-locale'

interface PaymentLink {
  id: string
  label: string
  url: string
  gateway: string
  amount: number | null
  currency: string
  is_default: boolean
}

const GATEWAYS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'whop', label: 'Whop' },
  { value: 'other', label: 'Other' },
]

export function PaymentLinks({ accountId }: { accountId: string }) {
  const router = useRouter()
  const { t } = useLocale()
  const [links, setLinks] = useState<PaymentLink[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)

  // New link form
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newGateway, setNewGateway] = useState('stripe')
  const [newAmount, setNewAmount] = useState('')
  const [newCurrency, setNewCurrency] = useState('USD')

  useEffect(() => {
    fetch(`/api/portal/payment-links?account_id=${accountId}`)
      .then(r => r.json())
      .then(data => { setLinks(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [accountId])

  const handleAdd = async () => {
    if (!newLabel.trim() || !newUrl.trim()) {
      toast.error('Label and URL are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/portal/payment-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          label: newLabel.trim(),
          url: newUrl.trim(),
          gateway: newGateway,
          amount: newAmount ? parseFloat(newAmount) : null,
          currency: newCurrency,
          is_default: links.length === 0,
        }),
      })
      if (!res.ok) throw new Error('Failed to add')
      const data = await res.json()
      setLinks(prev => [...prev, data])
      setShowAdd(false)
      setNewLabel(''); setNewUrl(''); setNewAmount('')
      toast.success(t('payment.added'))
    } catch {
      toast.error('Failed to add payment link')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/portal/payment-links?id=${id}&account_id=${accountId}`, { method: 'DELETE' })
      setLinks(prev => prev.filter(l => l.id !== id))
      toast.success(t('payment.removed'))
    } catch {
      toast.error('Failed to remove')
    }
  }

  const handleSetDefault = async (id: string) => {
    try {
      await fetch('/api/portal/payment-links', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, account_id: accountId, is_default: true }),
      })
      setLinks(prev => prev.map(l => ({ ...l, is_default: l.id === id })))
      toast.success(t('payment.defaultUpdated'))
    } catch {
      toast.error('Failed to update')
    }
  }

  if (loading) return <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />

  return (
    <div className="space-y-4">
      {/* Existing links */}
      {links.length > 0 && (
        <div className="space-y-2">
          {links.map(link => (
            <div key={link.id} className="flex items-center justify-between p-3 border rounded-lg">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
                  <CreditCard className="h-4 w-4 text-zinc-500" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-zinc-900">{link.label}</p>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{link.gateway}</span>
                    {link.is_default && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Default</span>}
                  </div>
                  <p className="text-xs text-zinc-400 truncate">{link.url}</p>
                  {link.amount && <p className="text-xs text-zinc-500">{link.currency === 'EUR' ? '\u20AC' : '$'}{link.amount}</p>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!link.is_default && (
                  <button onClick={() => handleSetDefault(link.id)} className="p-1.5 text-zinc-400 hover:text-blue-600 rounded" title="Set as default">
                    <Star className="h-3.5 w-3.5" />
                  </button>
                )}
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="p-1.5 text-zinc-400 hover:text-blue-600 rounded">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button onClick={() => handleDelete(link.id)} className="p-1.5 text-zinc-400 hover:text-red-600 rounded">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new link form */}
      {showAdd ? (
        <div className="border rounded-lg p-4 space-y-3 bg-zinc-50">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-600 mb-1">{t('payment.label')} *</label>
              <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="e.g., Monthly Service"
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-zinc-600 mb-1">{t('payment.gateway')}</label>
              <select value={newGateway} onChange={e => setNewGateway(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                {GATEWAYS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">{t('payment.paymentUrl')} *</label>
            <input type="url" value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://buy.stripe.com/..."
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-600 mb-1">{t('payment.amount')}</label>
              <input type="number" value={newAmount} onChange={e => setNewAmount(e.target.value)} placeholder="100.00" step="0.01"
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-zinc-600 mb-1">{t('payment.currency')}</label>
              <select value={newCurrency} onChange={e => setNewCurrency(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {t('payment.addLink')}
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">{t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700">
          <Plus className="h-4 w-4" /> {t('payment.addLink')}
        </button>
      )}

      {/* Whop recommendation */}
      {links.length === 0 && !showAdd && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-sm text-blue-800 font-medium mb-1">{t('payment.whopTitle')}</p>
          <p className="text-xs text-blue-700 mb-3">{t('payment.whopDesc')}</p>
          <a href="https://whop.com/tony-durante-llc?a=myllcexpert" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <ExternalLink className="h-3.5 w-3.5" /> {t('payment.whopCta')}
          </a>
        </div>
      )}

      <p className="text-xs text-zinc-400">{t('payment.invoiceNote')}</p>
      <p className="text-xs text-zinc-400 italic">{t('payment.stripeNote')}</p>
    </div>
  )
}
