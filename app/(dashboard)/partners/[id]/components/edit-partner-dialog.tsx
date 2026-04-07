'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { callPartnerAction, type PartnerData } from './partner-actions'

const COMMISSION_MODELS = ['percentage', 'price_difference', 'flat_fee']
const AVAILABLE_SERVICES = ['LLC Formation', 'Tax Return', 'ITIN', 'EIN', 'Banking', 'CMRA', 'Annual Renewal']

interface Props {
  open: boolean
  onClose: () => void
  partner: PartnerData
}

export function EditPartnerDialog({ open, onClose, partner }: Props) {
  const [isPending, startTransition] = useTransition()
  const [partnerName, setPartnerName] = useState(partner.partner_name)
  const [partnerEmail, setPartnerEmail] = useState(partner.partner_email ?? '')
  const [commissionModel, setCommissionModel] = useState(partner.commission_model ?? '')
  const [selectedServices, setSelectedServices] = useState<string[]>(partner.agreed_services ?? [])
  const [notes, setNotes] = useState(partner.notes ?? '')
  const [priceListJson, setPriceListJson] = useState(
    partner.price_list ? JSON.stringify(partner.price_list, null, 2) : ''
  )

  if (!open) return null

  const toggleService = (svc: string) => {
    setSelectedServices(prev => prev.includes(svc) ? prev.filter(s => s !== svc) : [...prev, svc])
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    let priceList: Record<string, number> | undefined
    if (priceListJson.trim()) {
      try {
        priceList = JSON.parse(priceListJson.trim())
      } catch {
        toast.error('Invalid price list JSON')
        return
      }
    }

    startTransition(async () => {
      const updates: Record<string, unknown> = {}
      if (partnerName !== partner.partner_name) updates.partner_name = partnerName.trim()
      if (partnerEmail !== (partner.partner_email ?? '')) updates.partner_email = partnerEmail.trim() || null
      if (commissionModel !== (partner.commission_model ?? '')) updates.commission_model = commissionModel || null
      if (JSON.stringify(selectedServices) !== JSON.stringify(partner.agreed_services ?? [])) updates.agreed_services = selectedServices
      if (notes !== (partner.notes ?? '')) updates.notes = notes.trim() || null
      if (priceList !== undefined) updates.price_list = priceList

      if (Object.keys(updates).length === 0) {
        toast.info('No changes')
        onClose()
        return
      }

      const data = await callPartnerAction({ action: 'update_partner', partner_id: partner.id, updates })
      if (data.success) {
        toast.success('Partner updated')
        onClose()
      } else {
        toast.error(data.detail ?? 'Failed to update partner')
      }
    })
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">Edit Partner</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Partner Name</label>
                <input type="text" value={partnerName} onChange={e => setPartnerName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input type="email" value={partnerEmail} onChange={e => setPartnerEmail(e.target.value)}
                  placeholder="partner@example.com"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Commission Model</label>
              <select value={commissionModel} onChange={e => setCommissionModel(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select...</option>
                {COMMISSION_MODELS.map(m => (
                  <option key={m} value={m}>{m.replace('_', ' ')}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Agreed Services</label>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_SERVICES.map(svc => (
                  <button key={svc} type="button" onClick={() => toggleService(svc)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      selectedServices.includes(svc)
                        ? 'bg-blue-50 border-blue-300 text-blue-700'
                        : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300'
                    }`}>
                    {svc}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Price List (JSON)</label>
              <textarea value={priceListJson} onChange={e => setPriceListJson(e.target.value)} rows={3}
                placeholder='{"llc_formation": 500, "tax_return": 300}'
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono" />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
              <button type="submit" disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2">
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
