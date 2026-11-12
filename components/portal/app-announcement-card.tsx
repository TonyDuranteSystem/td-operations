'use client'

// One announcement card drawn for the CLIENT iPhone app (dev job 056a70d0; docs/systems/client-app.md), inside the News sheet.
// The website's banners put the icon, the words, a button and the X in ONE row; on a phone that leaves the words a thin column
// (one word per line). Here the words get the whole width: icon + title + X on the top row, the words under them, the button
// full width at the bottom. The button and the X are optional: an announcement the team wrote in the CRM has no link, and one
// that cannot be closed has no X. Only the app uses this; the website banners are exactly as they were.
import Link from 'next/link'
import { ArrowRight, X, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NewsTone } from '@/lib/portal-app/news'

const TONES: Record<NewsTone, { box: string; icon: string; title: string; desc: string; btn: string; x: string }> = {
  blue: { box: 'bg-blue-50 border-blue-200', icon: 'bg-blue-100 text-blue-600', title: 'text-blue-900', desc: 'text-blue-700', btn: 'bg-blue-600', x: 'text-blue-400' },
  violet: { box: 'bg-violet-50 border-violet-200', icon: 'bg-violet-100 text-violet-600', title: 'text-violet-900', desc: 'text-violet-700', btn: 'bg-violet-600', x: 'text-violet-400' },
  amber: { box: 'bg-amber-50 border-amber-200', icon: 'bg-amber-100 text-amber-600', title: 'text-amber-900', desc: 'text-amber-700', btn: 'bg-amber-600', x: 'text-amber-400' },
  green: { box: 'bg-green-50 border-green-200', icon: 'bg-green-100 text-green-600', title: 'text-green-900', desc: 'text-green-700', btn: 'bg-green-600', x: 'text-green-400' },
}

export function AppAnnouncementCard({ tone, icon: Icon, title, desc, cta, href, dismissLabel, onDismiss, onNavigate }: {
  tone: NewsTone
  icon: LucideIcon
  title: string
  desc: string
  cta?: string | null
  href?: string | null
  dismissLabel: string
  /** Null/absent = the announcement cannot be closed (no X). */
  onDismiss?: (() => void) | null
  /** Runs when the button is tapped, after the announcement is closed (the sheet closes itself with it). */
  onNavigate?: () => void
}) {
  const c = TONES[tone]
  return (
    <div data-testid="app-announcement-card" className={cn('relative rounded-xl border px-4 py-3.5', c.box)}>
      <div className={cn('flex items-start gap-3', onDismiss && 'pr-9')}>
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', c.icon)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn('text-[15px] font-semibold leading-snug', c.title)}>{title}</p>
          <p className={cn('mt-1 whitespace-pre-line text-[13px] leading-snug', c.desc)}>{desc}</p>
        </div>
      </div>
      {cta && href && (
        <Link
          href={href}
          onClick={() => { onDismiss?.(); onNavigate?.() }}
          className={cn('mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium text-white', c.btn)}
        >
          {cta}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className={cn('absolute right-1 top-1 p-1', c.x)}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
