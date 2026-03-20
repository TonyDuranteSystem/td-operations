'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { ACCOUNT_STATUS, COMPANY_TYPE } from '@/lib/constants'
import { createAccount } from '@/app/(dashboard)/accounts/actions'
import type { CreateAccountInput } from '@/lib/schemas/account-create'
import { useRouter } from 'next/navigation'

interface CreateAccountDialogProps {
  open: boolean
  onClose: () => void
}

const US_STATES = ['Wyoming', 'Delaware', 'Florida', 'New Mexico', 'Texas', 'California', 'New York']

export function CreateAccountDialog({ open, onClose }: CreateAccountDialogProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const [companyName, setCompanyName] = useState('')
  const [entityType, setEntityType] = useState('')
  const [stateOfFormation, setStateOfFormation] = useState('')
  const [status, setStatus] = useState('Pending Formation')
  const [einNumber, setEinNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  const resetForm = () => {
    setCompanyName('')
    setEntityType('')
    setStateOfFormation('')
    setStatus('Pending Formation')
    setEinNumber('')
    setNotes('')
    setErrors({})
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    if (!companyName.trim()) {
      setErrors({ company_name: 'Company name is required' })
      return
    }

    startTransition(async () => {
      const input: CreateAccountInput = {
        company_name: companyName.trim(),
        entity_type: entityType ? (entityType as CreateAccountInput['entity_type']) : undefined,
        state_of_formation: stateOfFormation.trim() || undefined,
        status: status as CreateAccountInput['status'],
        ein_number: einNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      }

      const result = await createAccount(input)

      if (result.success) {
        toast.success('Account created')
        resetForm()
        onClose()
        if (result.data?.id) {
          router.push(`/accounts/${result.data.id}`)
        }
      } else {
        toast.error(result.error ?? 'Failed to create account')
      }
    })
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">New Account</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Company Name */}
            <div>
              <label className="block text-sm font-medium mb-1">Company Name *</label>
              <input
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                autoFocus
                placeholder="e.g. Smith Holdings LLC"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {errors.company_name && (
                <p className="text-xs text-red-600 mt-1">{errors.company_name}</p>
              )}
            </div>

            {/* Entity Type + Status (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Entity Type</label>
                <select
                  value={entityType}
                  onChange={e => setEntityType(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select...</option>
                  {COMPANY_TYPE.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {ACCOUNT_STATUS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* State of Formation + EIN (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">State of Formation</label>
                <input
                  type="text"
                  value={stateOfFormation}
                  onChange={e => setStateOfFormation(e.target.value)}
                  list="us-states"
                  placeholder="e.g. Wyoming"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id="us-states">
                  {US_STATES.map(s => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">EIN Number</label>
                <input
                  type="text"
                  value={einNumber}
                  onChange={e => setEinNumber(e.target.value)}
                  placeholder="XX-XXXXXXX"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="Additional notes..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
