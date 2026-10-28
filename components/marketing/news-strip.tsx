import Link from 'next/link'
import type { TFn } from '@/lib/marketing/i18n'

/** TD Marketing — the line at the top of every workspace screen while there is news the person has not opened (dev job 9aec66fa, Addendum H). Server component; it goes away once the news is opened. */
export function NewsStrip({ title, more, t }: { title: string; more: number; t: TFn }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-300 bg-teal-50 px-6 py-2 text-sm text-teal-900" role="status" data-testid="news-strip">
      <span className="min-w-0 truncate"><b>{t('New: {title}', { title })}</b>{more > 0 && <span className="ml-2 text-xs text-teal-800">{t('and {n} more', { n: more })}</span>}</span>
      <Link href="/marketing/news" className="shrink-0 font-medium underline" data-testid="news-strip-open">{t("See what's new")}</Link>
    </div>
  )
}
