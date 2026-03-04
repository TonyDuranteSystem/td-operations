'use client'

import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  Send,
  Loader2,
  Calendar,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TaxCard } from './tax-card'
import type { TaxSection } from '@/lib/types'

const ICON_MAP: Record<string, React.ReactNode> = {
  clipboard: <ClipboardList className="h-4 w-4" />,
  clock: <Clock className="h-4 w-4" />,
  send: <Send className="h-4 w-4" />,
  loader: <Loader2 className="h-4 w-4" />,
  calendar: <Calendar className="h-4 w-4" />,
  check: <CheckCircle2 className="h-4 w-4" />,
  alert: <AlertTriangle className="h-4 w-4" />,
}

const COLOR_MAP: Record<string, { badge: string; icon: string }> = {
  amber: { badge: 'bg-amber-100 text-amber-700', icon: 'text-amber-500' },
  orange: { badge: 'bg-orange-100 text-orange-700', icon: 'text-orange-500' },
  blue: { badge: 'bg-blue-100 text-blue-700', icon: 'text-blue-500' },
  indigo: { badge: 'bg-indigo-100 text-indigo-700', icon: 'text-indigo-500' },
  purple: { badge: 'bg-purple-100 text-purple-700', icon: 'text-purple-500' },
  emerald: { badge: 'bg-emerald-100 text-emerald-700', icon: 'text-emerald-500' },
  rose: { badge: 'bg-rose-100 text-rose-700', icon: 'text-rose-500' },
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex-1 min-w-[100px]">
      <p className={cn('text-2xl font-semibold', color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  )
}

function Section({
  section,
  today,
  defaultOpen = true,
}: {
  section: TaxSection
  today: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const colors = COLOR_MAP[section.color] ?? COLOR_MAP.amber

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full py-3 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className={cn('flex items-center gap-2', colors.icon)}>
          {ICON_MAP[section.icon]}
        </span>
        <span className="font-semibold text-sm uppercase tracking-wide">{section.title}</span>
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full ml-1', colors.badge)}>
          {section.items.length}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 pb-4">
          {section.items.length === 0 ? (
            <p className="text-sm text-muted-foreground col-span-full pl-6">Nessun elemento</p>
          ) : (
            section.items.map(tr => (
              <TaxCard key={tr.id} taxReturn={tr} today={today} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

interface TaxStats {
  total: number
  mmllc: number
  smllc: number
  paid: number
  dataReceived: number
  extensionFiled: number
}

export function TaxBoard({
  sections,
  stats,
  today,
}: {
  sections: TaxSection[]
  stats: TaxStats
  today: string
}) {
  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex gap-3 flex-wrap">
        <StatCard label="Totale" value={stats.total} color="text-foreground" />
        <StatCard label="MMLLC" value={stats.mmllc} color="text-indigo-600" />
        <StatCard label="SMLLC" value={stats.smllc} color="text-blue-600" />
        <StatCard label="Pagati" value={stats.paid} color="text-emerald-600" />
        <StatCard label="Dati Ricevuti" value={stats.dataReceived} color="text-blue-600" />
        <StatCard label="Extension" value={stats.extensionFiled} color="text-purple-600" />
      </div>

      {/* Sections */}
      <div className="space-y-2">
        {sections.map((section) => (
          <Section
            key={section.key}
            section={section}
            today={today}
            defaultOpen={section.key !== 'completati'}
          />
        ))}
      </div>
    </div>
  )
}
