'use client'

// One dismissible announcement card drawn for the CLIENT iPhone app (dev job 056a70d0; docs/systems/client-app.md).
// The website's banners put the icon, the words, a button and the X in ONE row; on a phone that leaves the words a thin column
// (one word per line). Here the words get the whole width: icon + title + X on the top row, the words under them, the button
// full width at the bottom. Only the app uses this; the website banners are exactly as they were.
import Link from 'next/link'
import { ArrowRight, X, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const TONES = {
  blue: { box: 'bg-blue-50 border-blue-200', icon: 'bg-blue-100 text-blue-600', title: 'text-blue-900', desc: 'text-blue-700', btn: 'bg-blue-600', x: 'text-blue-400' },
  violet: { box: 'bg-violet-50 border-violet-200', icon: 'bg-violet-100 text-violet-600', title: 'text-violet-900', desc: 'text-violet-700', btn: 'bg-violet-600', x: 'text-violet-400' },
} as const

export function AppAnnouncementCard({ tone, icon: Icon, title, desc, cta, href, dismissLabel, onDismiss }: {
  tone: keyof typeof TONES
  icon: LucideIcon
  title: string
  desc: string
  cta: string
  href: string
  dismissLabel: string
  onDismiss: () => void
}) {
  const c = TONES[tone]
  return (
    <div data-testid="app-announcement-card" className={cn('relative rounded-xl border px-4 py-3.5', c.box)}>
      <div className="flex items-start gap-3 pr-9">
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', c.icon)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn('text-[15px] font-semibold leading-snug', c.title)}>{title}</p>
          <p className={cn('mt-1 text-[13px] leading-snug', c.desc)}>{desc}</p>
        </div>
      </div>
      <Link
        href={href}
        onClick={onDismiss}
        className={cn('mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium text-white', c.btn)}
      >
        {cta}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className={cn('absolute right-1 top-1 p-1', c.x)}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}
