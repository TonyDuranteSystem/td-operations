'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus, Pencil, Check, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

interface ServiceCatalogItem {
  id: string
  name: string
  default_price: number | null
  default_currency: string | null
  sort_order: number
}

interface ServiceTypeSelectProps {
  value: string
  onChange: (value: string, defaultPrice?: number | null, defaultCurrency?: string | null) => void
  placeholder?: string
  className?: string
}

export function ServiceTypeSelect({
  value,
  onChange,
  placeholder = 'Select service type...',
  className,
}: ServiceTypeSelectProps) {
  const [open, setOpen] = useState(false)
  const [services, setServices] = useState<ServiceCatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Add new service state
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newCurrency, setNewCurrency] = useState<'USD' | 'EUR'>('USD')
  const [saving, setSaving] = useState(false)

  // Edit service state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editCurrency, setEditCurrency] = useState<'USD' | 'EUR'>('USD')

  const containerRef = useRef<HTMLDivElement>(null)
  const addNameRef = useRef<HTMLInputElement>(null)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setAdding(false)
        setEditingId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Fetch services when opened
  useEffect(() => {
    if (open && !loaded) {
      setLoading(true)
      fetch('/api/service-catalog')
        .then(res => res.json())
        .then(data => {
          setServices(data.services ?? [])
          setLoaded(true)
        })
        .catch(() => toast.error('Failed to load services'))
        .finally(() => setLoading(false))
    }
  }, [open, loaded])

  // Focus add input
  useEffect(() => {
    if (adding && addNameRef.current) addNameRef.current.focus()
  }, [adding])

  const handleSelect = (svc: ServiceCatalogItem) => {
    onChange(svc.name, svc.default_price, svc.default_currency)
    setOpen(false)
    setAdding(false)
    setEditingId(null)
  }

  const handleAdd = async () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const res = await fetch('/api/service-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          default_price: newPrice ? Number(newPrice) : null,
          default_currency: newCurrency,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setServices(prev => [...prev, data.service])
      onChange(data.service.name, data.service.default_price, data.service.default_currency)
      setNewName('')
      setNewPrice('')
      setAdding(false)
      setOpen(false)
      toast.success(`Service "${trimmed}" added`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add service')
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (svc: ServiceCatalogItem, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(svc.id)
    setEditName(svc.name)
    setEditPrice(svc.default_price != null ? String(svc.default_price) : '')
    setEditCurrency((svc.default_currency as 'USD' | 'EUR') ?? 'USD')
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return
    setSaving(true)
    try {
      const res = await fetch('/api/service-catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId,
          name: editName.trim(),
          default_price: editPrice ? Number(editPrice) : null,
          default_currency: editCurrency,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setServices(prev => prev.map(s => s.id === editingId ? { ...s, ...data.service } : s))
      setEditingId(null)
      toast.success('Service updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update service')
    } finally {
      setSaving(false)
    }
  }

  const formatPrice = (price: number | null, currency: string | null) => {
    if (price == null) return ''
    const sym = currency === 'EUR' ? '\u20AC' : '$'
    return `${sym}${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500',
          !value && 'text-muted-foreground'
        )}
      >
        <span className="truncate">{value || placeholder}</span>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border rounded-md shadow-lg max-h-80 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            </div>
          )}

          {!loading && services.map(svc => (
            editingId === svc.id ? (
              /* Edit mode */
              <div key={svc.id} className="px-3 py-2 border-b bg-blue-50/50 space-y-2">
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="Service name"
                />
                <div className="flex items-center gap-2">
                  <select value={editCurrency} onChange={e => setEditCurrency(e.target.value as 'USD' | 'EUR')}
                    className="px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={editPrice}
                    onChange={e => setEditPrice(e.target.value)}
                    placeholder="Default price (optional)"
                    className="flex-1 px-2 py-1 text-xs border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button onClick={handleSaveEdit} disabled={saving}
                    className="p-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button onClick={() => setEditingId(null)} className="p-1 rounded hover:bg-zinc-100">
                    <X className="h-3.5 w-3.5 text-zinc-400" />
                  </button>
                </div>
              </div>
            ) : (
              /* Normal row */
              <button
                key={svc.id}
                type="button"
                onClick={() => handleSelect(svc)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-zinc-50 transition-colors group',
                  value === svc.name && 'bg-blue-50'
                )}
              >
                <div className="flex-1 min-w-0">
                  <span className={cn('block truncate', value === svc.name && 'text-blue-700 font-medium')}>
                    {svc.name}
                  </span>
                </div>
                {svc.default_price != null && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatPrice(svc.default_price, svc.default_currency)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => startEdit(svc, e)}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-200 transition-opacity"
                  title="Edit service"
                >
                  <Pencil className="h-3 w-3 text-zinc-400" />
                </button>
              </button>
            )
          ))}

          {/* Add new service */}
          <div className="border-t">
            {adding ? (
              <div className="px-3 py-2 space-y-2">
                <input
                  ref={addNameRef}
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd() } if (e.key === 'Escape') { setAdding(false); setNewName(''); setNewPrice('') } }}
                  placeholder="Service name *"
                  className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <div className="flex items-center gap-2">
                  <select value={newCurrency} onChange={e => setNewCurrency(e.target.value as 'USD' | 'EUR')}
                    className="px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={newPrice}
                    onChange={e => setNewPrice(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd() } }}
                    placeholder="Default price (optional)"
                    className="flex-1 px-2 py-1 text-xs border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button onClick={handleAdd} disabled={saving || !newName.trim()}
                    className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40 flex items-center gap-1">
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Add
                  </button>
                  <button onClick={() => { setAdding(false); setNewName(''); setNewPrice('') }}
                    className="p-1 rounded hover:bg-zinc-100">
                    <X className="h-3.5 w-3.5 text-zinc-400" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full flex items-center gap-1.5 px-3 py-2.5 text-sm text-blue-600 hover:bg-blue-50 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add new service
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
