'use client'

import { useState, useEffect, useTransition } from 'react'
import { X, Loader2, ClipboardList, Cog, Receipt, Search, Building2, User } from 'lucide-react'
import { toast } from 'sonner'
import { TASK_PRIORITY, TASK_CATEGORY } from '@/lib/constants'
import type { InboxConversation } from '@/lib/types'

interface CreateFromEmailDialogProps {
  type: 'task' | 'service' | 'invoice'
  conversation: InboxConversation
  onClose: () => void
}

const typeConfig = {
  task: { title: 'Create Task', icon: ClipboardList, color: 'text-orange-500' },
  service: { title: 'Create Service', icon: Cog, color: 'text-emerald-500' },
  invoice: { title: 'Create Invoice', icon: Receipt, color: 'text-blue-500' },
}

const SERVICE_TYPES = [
  'Company Formation', 'ITIN', 'Tax Return', 'EIN', 'Banking Fintech',
  'Banking Physical', 'CMRA Mailing Address', 'Annual Renewal',
  'Company Closure', 'Public Notary', 'Shipping', 'Support',
]

interface AccountResult {
  id: string
  company_name: string
  contact_name?: string
  status: string
}

export function CreateFromEmailDialog({ type, conversation, onClose }: CreateFromEmailDialogProps) {
  const [isPending, startTransition] = useTransition()
  const config = typeConfig[type]
  const Icon = config.icon

  // Account search
  const [accountQuery, setAccountQuery] = useState('')
  const [accountResults, setAccountResults] = useState<AccountResult[]>([])
  const [selectedAccount, setSelectedAccount] = useState<AccountResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [autoMatched, setAutoMatched] = useState(false)

  // Task fields
  const [title, setTitle] = useState(conversation.subject || conversation.name || '')
  const [description, setDescription] = useState(conversation.preview || '')
  const [priority, setPriority] = useState('Normal')
  const [category, setCategory] = useState('')
  const [assignedTo, setAssignedTo] = useState('Luca')

  // Service fields
  const [serviceType, setServiceType] = useState('')

  // Auto-match sender email to account on mount
  useEffect(() => {
    if (!conversation.name) return
    const searchName = conversation.name.split('<')[0].trim() // Remove email part
    if (!searchName || searchName.length < 2) return

    fetch(`/api/accounts?q=${encodeURIComponent(searchName)}&limit=5`)
      .then(r => r.json())
      .then(data => {
        if (data.accounts?.length > 0) {
          setAccountResults(data.accounts)
          // Auto-select if exactly 1 match
          if (data.accounts.length === 1) {
            setSelectedAccount(data.accounts[0])
            setAutoMatched(true)
          }
        }
      })
      .catch(() => {})
  }, [conversation.name])

  // Search accounts
  useEffect(() => {
    if (accountQuery.length < 2) { setAccountResults([]); return }
    setSearching(true)
    const timeout = setTimeout(() => {
      fetch(`/api/accounts?q=${encodeURIComponent(accountQuery)}&limit=8`)
        .then(r => r.json())
        .then(data => {
          setAccountResults(data.accounts || [])
          setSearching(false)
        })
        .catch(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timeout)
  }, [accountQuery])

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        if (type === 'task') {
          const res = await fetch('/api/inbox/create-from-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'task',
              accountId: selectedAccount?.id,
              title: title.trim(),
              description: description.trim(),
              priority,
              category: category || undefined,
              assignedTo,
              threadId: conversation.id.replace('gmail:', ''),
            }),
          })
          if (!res.ok) throw new Error('Failed to create task')
          toast.success('Task created from email')
        } else if (type === 'service') {
          if (!serviceType) { toast.error('Select a service type'); return }
          if (!selectedAccount) { toast.error('Select a client account'); return }
          const res = await fetch('/api/inbox/create-from-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'service',
              accountId: selectedAccount.id,
              serviceType,
              notes: `Created from email: ${conversation.subject || conversation.name}`,
              threadId: conversation.id.replace('gmail:', ''),
            }),
          })
          if (!res.ok) throw new Error('Failed to create service')
          toast.success('Service delivery created from email')
        } else if (type === 'invoice') {
          if (!selectedAccount) { toast.error('Select a client account'); return }
          // Redirect to payments page with account pre-selected
          window.location.href = `/payments?tab=invoices&accountId=${selectedAccount.id}&accountName=${encodeURIComponent(selectedAccount.company_name)}`
          return
        }
        onClose()
      } catch {
        toast.error(`Failed to create ${type}`)
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto pointer-events-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <div className="flex items-center gap-2">
              <Icon className={`h-5 w-5 ${config.color}`} />
              <h2 className="text-lg font-semibold">{config.title}</h2>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Source info */}
          <div className="px-6 pt-3 pb-2 bg-zinc-50 border-b">
            <p className="text-xs text-zinc-500">From email</p>
            <p className="text-sm font-medium text-zinc-700 truncate">{conversation.name}</p>
            {conversation.subject && (
              <p className="text-xs text-zinc-500 truncate">{conversation.subject}</p>
            )}
          </div>

          <div className="px-6 py-4 space-y-4">
            {/* Account Search */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Client Account {type !== 'task' && '*'}
              </label>
              {selectedAccount ? (
                <div className="flex items-center gap-2 px-3 py-2 border rounded-md bg-blue-50">
                  <Building2 className="h-4 w-4 text-blue-500" />
                  <span className="text-sm font-medium">{selectedAccount.company_name}</span>
                  {autoMatched && (
                    <span className="text-xs text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">Auto-matched</span>
                  )}
                  <button
                    onClick={() => { setSelectedAccount(null); setAutoMatched(false); setAccountQuery('') }}
                    className="ml-auto p-0.5 rounded hover:bg-blue-100"
                  >
                    <X className="h-3.5 w-3.5 text-blue-500" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    type="text"
                    value={accountQuery}
                    onChange={e => setAccountQuery(e.target.value)}
                    placeholder="Search by company, first name, or last name..."
                    className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {(accountResults.length > 0 || searching) && accountQuery.length >= 2 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-md shadow-lg z-10 max-h-48 overflow-y-auto">
                      {searching ? (
                        <div className="px-3 py-2 text-sm text-zinc-400">Searching...</div>
                      ) : (
                        accountResults.map(acc => (
                          <button
                            key={acc.id}
                            onClick={() => {
                              setSelectedAccount(acc)
                              setAccountQuery('')
                              setAccountResults([])
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-zinc-50 flex items-center gap-2 text-sm"
                          >
                            <Building2 className="h-4 w-4 text-zinc-400" />
                            <span className="font-medium">{acc.company_name}</span>
                            {acc.contact_name && (
                              <>
                                <User className="h-3 w-3 text-zinc-300 ml-1" />
                                <span className="text-zinc-500 text-xs">{acc.contact_name}</span>
                              </>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Type-specific fields */}
            {type === 'task' && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1">Title *</label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Priority</label>
                    <select
                      value={priority}
                      onChange={e => setPriority(e.target.value)}
                      className="w-full px-3 py-2 text-sm border rounded-md"
                    >
                      {TASK_PRIORITY.map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Assigned To</label>
                    <select
                      value={assignedTo}
                      onChange={e => setAssignedTo(e.target.value)}
                      className="w-full px-3 py-2 text-sm border rounded-md"
                    >
                      <option value="Luca">Luca</option>
                      <option value="Antonio">Antonio</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Category</label>
                  <select
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md"
                  >
                    <option value="">None</option>
                    {TASK_CATEGORY.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {type === 'service' && (
              <div>
                <label className="block text-sm font-medium mb-1">Service Type *</label>
                <select
                  value={serviceType}
                  onChange={e => setServiceType(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select service...</option>
                  {SERVICE_TYPES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}

            {type === 'invoice' && (
              <p className="text-sm text-zinc-500">
                You will be redirected to the Payments page with the client account pre-selected to create the invoice.
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 px-6 py-4 border-t">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isPending || (type !== 'task' && !selectedAccount)}
              className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {type === 'invoice' ? 'Go to Invoice' : `Create ${type === 'task' ? 'Task' : 'Service'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
