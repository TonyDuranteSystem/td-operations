'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

// Default service types based on existing payment descriptions
const DEFAULT_SERVICES = [
  'First Installment',
  'Second Installment',
  'LLC Formation',
  'LLC Formation + ITIN',
  'ITIN Application',
  'Tax Return',
  'Consulting Service',
  'Banking Setup',
  'Shipping Service',
  'Account Closure',
  'Service Fee',
  'Additional Service',
]

interface ServiceTypeSelectProps {
  value: string
  onChange: (value: string) => void
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
  const [addingCustom, setAddingCustom] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const [customServices, setCustomServices] = useState<string[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const customInputRef = useRef<HTMLInputElement>(null)

  const allServices = [...DEFAULT_SERVICES, ...customServices]

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setAddingCustom(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Focus custom input when adding
  useEffect(() => {
    if (addingCustom && customInputRef.current) {
      customInputRef.current.focus()
    }
  }, [addingCustom])

  const handleSelect = (service: string) => {
    onChange(service)
    setOpen(false)
    setAddingCustom(false)
  }

  const handleAddCustom = () => {
    const trimmed = customValue.trim()
    if (!trimmed) return
    if (!allServices.includes(trimmed)) {
      setCustomServices(prev => [...prev, trimmed])
    }
    onChange(trimmed)
    setCustomValue('')
    setAddingCustom(false)
    setOpen(false)
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
        <div className="absolute z-50 mt-1 w-full bg-white border rounded-md shadow-lg max-h-64 overflow-y-auto">
          {allServices.map(service => (
            <button
              key={service}
              type="button"
              onClick={() => handleSelect(service)}
              className={cn(
                'w-full px-3 py-2 text-sm text-left hover:bg-zinc-50 transition-colors',
                value === service && 'bg-blue-50 text-blue-700 font-medium'
              )}
            >
              {service}
            </button>
          ))}

          {/* Add custom service */}
          <div className="border-t">
            {addingCustom ? (
              <div className="flex items-center gap-1 px-2 py-2">
                <input
                  ref={customInputRef}
                  type="text"
                  value={customValue}
                  onChange={e => setCustomValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleAddCustom() }
                    if (e.key === 'Escape') { setAddingCustom(false); setCustomValue('') }
                  }}
                  placeholder="Type service name..."
                  className="flex-1 px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={handleAddCustom}
                  disabled={!customValue.trim()}
                  className="px-2 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingCustom(true)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add custom service
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
