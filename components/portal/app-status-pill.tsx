// A small status pill in the client iPhone app's gray look (dev job 056a70d0): paid green, still owed amber, overdue red, draft gray.
import { cn } from '@/lib/utils'
import type { StatusTone } from '@/lib/portal-app/invoices'

const TONE_PILL: Record<StatusTone, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  warn: 'bg-amber-100 text-amber-700',
  bad: 'bg-red-100 text-red-700',
  draft: 'bg-zinc-200 text-zinc-600',
}

export function AppStatusPill({ tone, children, className }: { tone: StatusTone; children: React.ReactNode; className?: string }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', TONE_PILL[tone], className)}>{children}</span>
}
