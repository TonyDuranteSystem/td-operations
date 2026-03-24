'use client'

import { useState } from 'react'
import { Loader2, Save, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

const GATEWAYS = [
  { value: 'whop', label: 'Whop', recommended: true, placeholder: 'https://whop.com/checkout/your-link' },
  { value: 'stripe', label: 'Stripe', recommended: false, placeholder: 'https://buy.stripe.com/your-link' },
  { value: 'paypal', label: 'PayPal', recommended: false, placeholder: 'https://paypal.me/your-username' },
]

interface PaymentSettingsProps {
  accountId: string
  currentGateway: string | null
  currentLink: string | null
}

export function PaymentSettings({ accountId, currentGateway, currentLink }: PaymentSettingsProps) {
  const router = useRouter()
  const [gateway, setGateway] = useState(currentGateway ?? '')
  const [link, setLink] = useState(currentLink ?? '')
  const [saving, setSaving] = useState(false)

  const selectedGateway = GATEWAYS.find(g => g.value === gateway)

  const handleSave = async () => {
    if (gateway && !link.trim()) {
      toast.error('Please enter your payment link')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/portal/payment-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          payment_gateway: gateway || null,
          payment_link: link.trim() || null,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success('Payment settings saved')
      router.refresh()
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Gateway selection */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-zinc-600">Payment Platform</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {GATEWAYS.map(g => (
            <button
              key={g.value}
              type="button"
              onClick={() => setGateway(g.value)}
              className={`relative px-4 py-3 text-sm border rounded-lg text-left transition-colors ${
                gateway === g.value
                  ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                  : 'border-zinc-200 hover:border-zinc-300'
              }`}
            >
              <span className="font-medium">{g.label}</span>
              {g.recommended && (
                <span className="ml-2 text-xs text-blue-600 font-medium">Recommended</span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setGateway(''); setLink('') }}
            className={`px-4 py-3 text-sm border rounded-lg text-left transition-colors ${
              !gateway ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : 'border-zinc-200 hover:border-zinc-300'
            }`}
          >
            <span className="font-medium text-zinc-500">None</span>
          </button>
        </div>
      </div>

      {/* Payment link input */}
      {gateway && (
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">Payment Link</label>
          <input
            type="url"
            value={link}
            onChange={e => setLink(e.target.value)}
            placeholder={selectedGateway?.placeholder ?? 'https://...'}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-zinc-400 mt-1">This link will appear as a &ldquo;Pay Now&rdquo; button on your invoices.</p>
        </div>
      )}

      {/* Whop recommendation when nothing selected */}
      {!gateway && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-sm text-blue-800 font-medium mb-1">We strongly recommend Whop</p>
          <p className="text-xs text-blue-700 mb-3">
            Low fees, instant payouts, and simple setup. The recommended payment platform for Tony Durante clients.
          </p>
          <a
            href="https://whop.com/tony-durante-llc?a=myllcexpert"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Get Started with Whop
          </a>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-5 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save Payment Settings
      </button>
    </div>
  )
}
