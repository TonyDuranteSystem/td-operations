'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Loader2, UserPlus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { callPartnerAction } from './partner-actions'

interface Props {
  open: boolean
  onClose: () => void
  partnerId: string
  existingAccountIds: string[]
}

interface AccountOption {
  id: string
  company_name: string
  status: string | null
}

export function AddClientDialog({ open, onClose, partnerId, existingAccountIds }: Props) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<AccountOption[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<AccountOption | null>(null)
  const [adding, setAdding] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  useEffect(() => {
    if (query.length < 2) { setOptions([]); return }
    const controller = new AbortController()
    setLoading(true)
    fetch(`/api/accounts?q=${encodeURIComponent(query)}&limit=10`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        const filtered = (data.accounts ?? []).filter((a: AccountOption) => !existingAccountIds.includes(a.id))
        setOptions(filtered)
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => controller.abort()
  }, [query, existingAccountIds])

  if (!open) return null

  const handleAdd = async () => {
    if (!selected) return
    setAdding(true)
    const data = await callPartnerAction({ action: 'add_client', partner_id: partnerId, account_id: selected.id })
    setAdding(false)
    if (data.success) {
      toast.success(`${selected.company_name} added`)
      setSelected(null)
      setQuery('')
      onClose()
    } else {
      toast.error(data.detail ?? 'Failed to add client')
    }
  }

  const handleClose = () => { setSelected(null); setQuery(''); onClose() }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">Add Client</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>

          <div className="px-6 py-4 space-y-3">
            {selected ? (
              <div className="flex items-center justify-between bg-zinc-50 rounded-md p-3">
                <div>
                  <div className="text-sm font-medium">{selected.company_name}</div>
                  <div className="text-xs text-muted-foreground">{selected.status ?? ''}</div>
                </div>
                <button onClick={() => setSelected(null)} className="text-zinc-400 hover:text-zinc-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)}
                    placeholder="Search accounts..." className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                {query.length >= 2 && (
                  <div className="max-h-48 overflow-y-auto border rounded-md">
                    {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>}
                    {!loading && options.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No accounts found</div>}
                    {options.map(a => (
                      <button key={a.id} onClick={() => { setSelected(a); setQuery('') }}
                        className="w-full text-left px-3 py-2 hover:bg-zinc-50 border-b last:border-b-0">
                        <div className="text-sm font-medium">{a.company_name}</div>
                        <div className="text-xs text-muted-foreground">{a.status ?? ''}</div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={handleClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
              <button onClick={handleAdd} disabled={!selected || adding}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2">
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Add
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
