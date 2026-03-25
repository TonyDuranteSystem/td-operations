'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { List, LayoutGrid } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LeadsViewToggleProps {
  currentView: string
}

export function LeadsViewToggle({ currentView }: LeadsViewToggleProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const setView = (view: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (view === 'table') {
      params.delete('view')
    } else {
      params.set('view', view)
    }
    // Reset page when switching views
    params.delete('page')
    router.push(`/leads?${params.toString()}`)
  }

  return (
    <div className="flex items-center border rounded-lg overflow-hidden">
      <button
        onClick={() => setView('table')}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors',
          currentView === 'table'
            ? 'bg-zinc-900 text-white'
            : 'bg-white text-zinc-600 hover:bg-zinc-50'
        )}
      >
        <List className="h-4 w-4" />
        Table
      </button>
      <button
        onClick={() => setView('kanban')}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors',
          currentView === 'kanban'
            ? 'bg-zinc-900 text-white'
            : 'bg-white text-zinc-600 hover:bg-zinc-50'
        )}
      >
        <LayoutGrid className="h-4 w-4" />
        Kanban
      </button>
    </div>
  )
}
