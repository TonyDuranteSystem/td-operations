'use client'

import { FileText, CreditCard, PenLine, CheckCircle2 } from 'lucide-react'
import type { ActionItem, ActionItemsResult } from '@/lib/portal/queries'
import { useLocale } from '@/lib/portal/use-locale'
import { interpolateString } from '@/lib/template-interpolation'

interface ActionItemsProps {
  data: ActionItemsResult
}

const PRIORITY_STYLES = {
  red: {
    border: 'border-l-red-500',
    bg: 'bg-red-50',
    badge: 'bg-red-100 text-red-700',
    dot: 'bg-red-500',
  },
  orange: {
    border: 'border-l-orange-500',
    bg: 'bg-orange-50',
    badge: 'bg-orange-100 text-orange-700',
    dot: 'bg-orange-500',
  },
  blue: {
    border: 'border-l-blue-500',
    bg: 'bg-blue-50',
    badge: 'bg-blue-100 text-blue-700',
    dot: 'bg-blue-500',
  },
}

const TYPE_ICONS = {
  form: FileText,
  invoice: CreditCard,
  signature: PenLine,
  wizard: FileText,
}

function timeAgo(dateStr: string, t: (key: string) => string): string {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  if (days === 0) return t('actionItems.today')
  if (days === 1) return t('actionItems.yesterday')
  if (days < 7) return interpolateString(t('actionItems.daysAgo'), { days: String(days) })
  if (days < 30) {
    const weeks = Math.floor(days / 7)
    return interpolateString(t('actionItems.weeksAgo'), { weeks: String(weeks) })
  }
  const months = Math.floor(days / 30)
  return interpolateString(t('actionItems.monthsAgo'), { months: String(months) })
}

export function ActionItems({ data }: ActionItemsProps) {
  const { items, counts } = data
  const { t } = useLocale()

  // Empty state
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-6 mb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <p className="font-medium text-green-800">
              {t('actionItems.allCaughtUp')}
            </p>
            <p className="text-sm text-green-600">
              {t('actionItems.noPendingActions')}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-6">
      {/* Header with counts */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-zinc-800">
          {t('actionItems.title')}
        </h2>
        <div className="flex items-center gap-2">
          {counts.red > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              {counts.red}
            </span>
          )}
          {counts.orange > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-medium text-orange-700">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              {counts.orange}
            </span>
          )}
          {counts.blue > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
              {counts.blue}
            </span>
          )}
        </div>
      </div>

      {/* Action items list */}
      <div className="space-y-2">
        {items.map((item, idx) => (
          <ActionItemCard key={idx} item={item} />
        ))}
      </div>
    </div>
  )
}

function ActionItemCard({ item }: { item: ActionItem }) {
  const { locale, t } = useLocale()
  const styles = PRIORITY_STYLES[item.priority]
  const Icon = TYPE_ICONS[item.type]
  // item.title/titleIt (and description) are generated per-instance on the
  // server (e.g. "Sign your Operating Agreement") — hand-written en/it
  // pairs, not app-text, so they're outside the shared any-language
  // dictionary the same way pipeline_stages client_label/client_label_it
  // are. Falls back to English for any locale beyond en/it, same as before.
  const title = locale === 'it' ? item.titleIt : item.title
  const description = locale === 'it' ? item.descriptionIt : item.description

  return (
    <a
      href={item.href}
      className={`block rounded-lg border border-l-4 ${styles.border} ${styles.bg} p-4 transition-all hover:shadow-sm hover:brightness-95`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/80">
          <Icon className="h-4 w-4 text-zinc-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-sm text-zinc-800 truncate">{title}</p>
            <span className="shrink-0 text-xs text-zinc-400">
              {timeAgo(item.createdAt, t)}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
        </div>
      </div>
    </a>
  )
}
