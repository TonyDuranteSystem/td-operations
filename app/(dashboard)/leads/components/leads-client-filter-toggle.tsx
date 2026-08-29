'use client'

import type { ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Target, UserCheck, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type ClientFilter = 'leads' | 'clients' | 'converted'

interface LeadsClientFilterToggleProps {
  currentFilter: ClientFilter
  leadsCount: number
  clientsCount: number
  convertedCount: number
}

// A real 3-way switch (dev job 93580372) between the open sales pipeline,
// bookings from people who are already clients, and leads that actually
// converted — not a "reveal on top of" text link. Mirrors LeadsViewToggle's
// exact look for a consistent control language on this page.
export function LeadsClientFilterToggle({ currentFilter, leadsCount, clientsCount, convertedCount }: LeadsClientFilterToggleProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const setFilter = (filter: ClientFilter) => {
    const params = new URLSearchParams(searchParams.toString())
    if (filter === 'leads') {
      params.delete('client')
    } else {
      params.set('client', filter)
    }
    // A different group is a different row count — the current page number
    // may no longer exist (matches the table/kanban toggle's own reset).
    params.delete('page')
    router.push(`/leads?${params.toString()}`)
  }

  const tab = (filter: ClientFilter, icon: ReactNode, label: string, count: number) => (
    <button
      onClick={() => setFilter(filter)}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors',
        currentFilter === filter
          ? 'bg-zinc-900 text-white'
          : 'bg-white text-zinc-600 hover:bg-zinc-50'
      )}
    >
      {icon}
      {label} ({count})
    </button>
  )

  return (
    <div className="flex items-center border rounded-lg overflow-hidden w-fit">
      {tab('leads', <Target className="h-4 w-4" />, 'New Leads', leadsCount)}
      {tab('clients', <UserCheck className="h-4 w-4" />, 'Existing Clients', clientsCount)}
      {tab('converted', <CheckCircle2 className="h-4 w-4" />, 'Converted', convertedCount)}
    </div>
  )
}
