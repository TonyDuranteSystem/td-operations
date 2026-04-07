'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { ContactCombobox } from './contact-combobox'

interface CreatePartnerDialogProps {
  open: boolean
  onClose: () => void
}

const COMMISSION_MODELS = ['percentage', 'price_difference', 'flat_fee']
const AVAILABLE_SERVICES = ['LLC Formation', 'Tax Return', 'ITIN', 'EIN', 'Banking', 'CMRA', 'Annual Renewal']

export function CreatePartnerDialog({ open, onClose }: CreatePartnerDialogProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const [contactId, setContactId] = useState('')
  const [partnerName, setPartnerName] = useState('')
  const [partnerEmail, setPartnerEmail] = useState('')
  const [commissionModel, setCommissionModel] = useState('')
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  const resetForm = () => {
    setContactId('')
    setPartnerName('')
    setPartnerEmail('')
    setCommissionModel('')
    setSelectedServices([])
    setNotes('')
    setErrors({})
  }

  const handleContactChange = (id: string, contact: { full_name: string; email: string | null } | null) => {
    setContactId(id)
    if (contact) {
      if (!partnerName) setPartnerName(contact.full_name)
      if (!partnerEmail && contact.email) setPartnerEmail(contact.email)
    }
  }

  const toggleService = (svc: string) => {
    setSelectedServices(prev => prev.includes(svc) ? prev.filter(s => s !== svc) : [...prev, svc])
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    if (!contactId) { setErrors({ contact: 'Contact is required' }); return }
    if (!partnerName.trim()) { setErrors({ name: 'Partner name is required' }); return }

    startTransition(async () => {
      const res = await fetch('/api/crm/admin-actions/partner-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_partner',
          contact_id: contactId,
          partner_name: partnerName.trim(),
          partner_email: partnerEmail.trim() || undefined,
          commission_model: commissionModel || undefined,
          agreed_services: selectedServices.length > 0 ? selectedServices : undefined,
          notes: notes.trim() || undefined,
        }),
      })
      const data = await res.json()

      if (data.success) {
        toast.success('Partner created')
        resetForm()
        onClose()
        if (data.data?.id) router.push(`/partners/${data.data.id}`)
      } else {
        toast.error(data.detail ?? data.error ?? 'Failed to create partner')
      }
    })
  }

  const handleClose = () => { resetForm(); onClose() }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">New Partner</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Contact *</label>
              <ContactCombobox value={contactId} onChange={handleContactChange} placeholder="Search by name or email..." />
              {errors.contact && <p className="text-xs text-red-600 mt-1">{errors.contact}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Partner Name *</label>
                <input type="text" value={partnerName} onChange={e => setPartnerName(e.target.value)}
                  placeholder="e.g. Maxscale" className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {errors.name && <p className="text-xs text-red-600 mt-1">{errors.name}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input type="email" value={partnerEmail} onChange={e => setPartnerEmail(e.target.value)}
                  placeholder="partner@example.com" className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                placeholder="Internal notes about this partnership..." className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={handleClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
              <button type="submit" disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2">
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create Partner
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
