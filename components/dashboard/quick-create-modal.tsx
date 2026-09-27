'use client'

/**
 * "Create Task / Service / Invoice" from a chat message — extracted from Portal Chats'
 * per-message menu (dev job 907b2535, 2026-09-27) so the WhatsApp thread's own "three dots"
 * menu can raise the SAME dialog rather than a second, drifting copy. Pure extraction: no
 * behavior change for Portal Chats, which now imports this instead of its own private copy.
 */

import { useState } from 'react'
import { ClipboardList, Truck, Receipt, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createInvoice } from '@/app/(dashboard)/shared/invoice-actions'

const SERVICE_TYPES = [
  'Company Formation', 'Tax Return', 'EIN', 'ITIN',
  'Banking Fintech', 'Annual Renewal', 'CMRA Mailing Address',
]

const TASK_CATEGORIES = [
  'Client Response', 'Document', 'Filing', 'Follow-up',
  'Payment', 'CRM Update', 'Internal', 'KYC',
  'Shipping', 'Notarization', 'Client Communication',
]

export function QuickCreateModal({ type, messageText, accountId, companyName, onClose }: {
  type: 'task' | 'sd' | 'invoice'
  messageText: string
  accountId: string
  companyName: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  // Task fields
  const [taskTitle, setTaskTitle] = useState(messageText.slice(0, 200))
  const [taskDescription, setTaskDescription] = useState(messageText.length > 200 ? messageText : '')
  const [taskPriority, setTaskPriority] = useState('Normal')
  const [taskCategory, setTaskCategory] = useState('Client Communication')
  const [taskAssignedTo, setTaskAssignedTo] = useState('Luca')
  const [taskDueDate, setTaskDueDate] = useState('')
  // SD fields
  const [sdServiceType, setSdServiceType] = useState('Company Formation')
  const [sdNotes, setSdNotes] = useState(messageText.slice(0, 500))
  const [sdAssignedTo, setSdAssignedTo] = useState('Luca')
  // Invoice fields
  const [invDescription, setInvDescription] = useState(messageText.slice(0, 200))
  const [invAmount, setInvAmount] = useState('')
  const [invMemo, setInvMemo] = useState('')

  const handleSubmit = async () => {
    setLoading(true)
    try {
      if (type === 'task') {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_title: taskTitle,
            description: taskDescription || undefined,
            priority: taskPriority,
            category: taskCategory,
            assigned_to: taskAssignedTo,
            due_date: taskDueDate || undefined,
            account_id: accountId,
            status: 'To Do',
          }),
        })
        if (!res.ok) throw new Error('Failed to create task')
        toast.success('Task created')
      } else if (type === 'sd') {
        const res = await fetch('/api/service-deliveries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service_type: sdServiceType,
            account_id: accountId,
            assigned_to: sdAssignedTo,
            notes: sdNotes || undefined,
          }),
        })
        if (!res.ok) throw new Error('Failed to create service delivery')
        toast.success('Service delivery created')
      } else if (type === 'invoice') {
        // Create a TD invoice in our system (Supabase) — NOT QuickBooks. QB is
        // decommissioned; this is the canonical path used by the account page and
        // the Notification Center card button (createInvoice → createTDInvoice,
        // content-idempotent). Creates a Draft; staff "Send" separately.
        const amount = Number(invAmount) || 0
        const today = new Date().toISOString().split('T')[0]
        const r = await createInvoice({
          account_id: accountId,
          description: invDescription || 'Invoice',
          amount_currency: 'USD',
          issue_date: today,
          discount: 0,
          items: [{ description: invDescription || 'Invoice', quantity: 1, unit_price: amount, amount, sort_order: 0 }],
          message: invMemo || undefined,
        })
        if (!r.success) throw new Error(r.error || 'Failed to create invoice')
        toast.success('Invoice created (Draft)')
      }
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Creation failed')
    } finally {
      setLoading(false)
    }
  }

  const titles = { task: 'Create Task', sd: 'Create Service Delivery', invoice: 'Create Invoice' }
  const icons = { task: ClipboardList, sd: Truck, invoice: Receipt }
  const Icon = icons[type]

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div className="flex items-center gap-2.5">
              <Icon className="h-5 w-5 text-blue-600" />
              <h2 className="text-base font-semibold">{titles[type]}</h2>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-4 w-4" /></button>
          </div>

          {/* Context */}
          <div className="px-5 py-3 bg-zinc-50 border-b">
            <p className="text-xs text-zinc-500">From chat with <span className="font-medium text-zinc-700">{companyName}</span></p>
            <p className="text-xs text-zinc-400 mt-1 line-clamp-2">&ldquo;{messageText.slice(0, 150)}{messageText.length > 150 ? '...' : ''}&rdquo;</p>
          </div>

          {/* Form */}
          <div className="px-5 py-4 space-y-3">
            {type === 'task' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Title *</label>
                  <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Description</label>
                  <textarea value={taskDescription} onChange={e => setTaskDescription(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Priority</label>
                    <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {['Urgent', 'High', 'Normal', 'Low'].map(p => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Assigned to</label>
                    <select value={taskAssignedTo} onChange={e => setTaskAssignedTo(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option>Luca</option>
                      <option>Antonio</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Category</label>
                    <select value={taskCategory} onChange={e => setTaskCategory(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {TASK_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Due date</label>
                    <input type="date" value={taskDueDate} onChange={e => setTaskDueDate(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              </>
            )}

            {type === 'sd' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Service Type *</label>
                  <select value={sdServiceType} onChange={e => setSdServiceType(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {SERVICE_TYPES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Assigned to</label>
                  <select value={sdAssignedTo} onChange={e => setSdAssignedTo(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option>Luca</option>
                    <option>Antonio</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Notes</label>
                  <textarea value={sdNotes} onChange={e => setSdNotes(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
                </div>
              </>
            )}

            {type === 'invoice' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Customer</label>
                  <input value={companyName} disabled className="w-full px-3 py-2 text-sm border rounded-lg bg-zinc-50 text-zinc-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Description *</label>
                  <input value={invDescription} onChange={e => setInvDescription(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Amount ($) *</label>
                  <input type="number" value={invAmount} onChange={e => setInvAmount(e.target.value)} placeholder="0.00" step="0.01" className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Memo</label>
                  <input value={invMemo} onChange={e => setInvMemo(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-5 py-4 border-t">
            <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={loading || (type === 'task' && !taskTitle.trim()) || (type === 'invoice' && (!invDescription.trim() || !invAmount))}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
