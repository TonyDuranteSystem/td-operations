'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

interface CreateLeadDialogProps {
  open: boolean
  onClose: () => void
}

const SOURCES = ['Referral', 'Website', 'Social', 'Calendly', 'WhatsApp', 'Other']
const CHANNELS = ['WhatsApp', 'Email', 'Phone', 'Calendly', 'Telegram']
const LANGUAGES = ['English', 'Italian']
const STATUSES = ['New', 'Call Scheduled', 'Call Done']

export function CreateLeadDialog({ open, onClose }: CreateLeadDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [source, setSource] = useState('Referral')
  const [channel, setChannel] = useState('WhatsApp')
  const [language, setLanguage] = useState('Italian')
  const [status, setStatus] = useState('New')
  const [reason, setReason] = useState('')
  const [referrerName, setReferrerName] = useState('')
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  const resetForm = () => {
    setFullName('')
    setEmail('')
    setPhone('')
    setSource('Referral')
    setChannel('WhatsApp')
    setLanguage('Italian')
    setStatus('New')
    setReason('')
    setReferrerName('')
    setNotes('')
    setErrors({})
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    const newErrors: Record<string, string> = {}
    if (!fullName.trim()) newErrors.full_name = 'Name is required'
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/create-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name: fullName.trim(),
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
            source,
            channel,
            language,
            status,
            reason: reason.trim() || undefined,
            referrer_name: referrerName.trim() || undefined,
            notes: notes.trim() || undefined,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to create lead')
          return
        }

        toast.success(`Lead "${fullName}" created`)
        resetForm()
        onClose()
        // Navigate to the new lead detail page
        if (data.lead_id) {
          router.push(`/leads/${data.lead_id}`)
        } else {
          router.refresh()
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">New Lead</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Full Name */}
            <div>
              <label className="block text-sm font-medium mb-1">Full Name *</label>
              <input
                type="text"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                autoFocus
                placeholder="Mario Rossi"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {errors.full_name && (
                <p className="text-xs text-red-600 mt-1">{errors.full_name}</p>
              )}
            </div>

            {/* Email + Phone */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="mario@example.com"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Phone</label>
                <input
                  type="text"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="+39 333 123 4567"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Source + Channel */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Source</label>
                <select
                  value={source}
                  onChange={e => setSource(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SOURCES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Channel</label>
                <select
                  value={channel}
                  onChange={e => setChannel(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CHANNELS.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Language + Status */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Language</label>
                <select
                  value={language}
                  onChange={e => setLanguage(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {LANGUAGES.map(l => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Initial Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {STATUSES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Reason */}
            <div>
              <label className="block text-sm font-medium mb-1">Reason</label>
              <input
                type="text"
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. Apertura LLC, Tax Return, ITIN..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Referrer */}
            <div>
              <label className="block text-sm font-medium mb-1">Referrer</label>
              <input
                type="text"
                value={referrerName}
                onChange={e => setReferrerName(e.target.value)}
                placeholder="Who referred them?"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="Any additional notes..."
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
                Create Lead
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
