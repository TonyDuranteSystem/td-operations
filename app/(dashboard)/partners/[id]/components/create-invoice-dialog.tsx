'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { callPartnerAction, type PartnerData, type ManagedAccount } from './partner-actions'

interface Props {
  open: boolean
  onClose: () => void
  partner: PartnerData
  accounts: ManagedAccount[]
}

export function CreateInvoiceDialog({ open, onClose, partner, accounts }: Props) {
  const [isPending, startTransition] = useTransition()
  const [accountId, setAccountId] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('EUR')

  if (!open) return null

  const resetForm = () => { setAccountId(''); setDescription(''); setAmount(''); setCurrency('EUR') }
  const handleClose = () => { resetForm(); onClose() }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      toast.error('Enter a valid amount')
      return
    }

    startTransition(async () => {
      const data = await callPartnerAction({
        action: 'create_invoice',
        partner_id: partner.id,
        account_id: accountId || undefined,
        description: description.trim() || undefined,
        amount: Number(amount),
        currency,
      })
      if (data.success) {
        toast.success(`Invoice ${data.invoiceNumber ?? ''} created`)
        resetForm()
        onClose()
      } else {
        toast.error(data.detail ?? 'Failed to create invoice')
      }
    })
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">Invoice Partner</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">For Account (optional)</label>
              <select value={accountId} onChange={e => setAccountId(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">General (no specific account)</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.company_name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                placeholder="e.g. CMRA service - March 2026"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Amount *</label>
                <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
                  min="0" step="0.01" placeholder="0.00" autoFocus
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Currency</label>
                <select value={currency} onChange={e => setCurrency(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={handleClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
              <button type="submit" disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2">
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Create Invoice
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
