'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import type { FeedItem } from '@/components/marketing/news-feed'

/**
 * The news card on a seller's Home (TD Marketing, dev job 9aec66fa, Addendum H): the news he has not opened yet, each with the button that opens the screen it is about and "Mark as read". Opening the
 * screen counts as reading it. Gone when there is nothing unread.
 */
export function NewsHomeCard({ items }: { items: FeedItem[] }) {
  const t = useT()
  const router = useRouter()
  const [gone, setGone] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const shown = items.filter(i => !gone.includes(i.id)).slice(0, 3)
  async function read(id: string) {
    setError(null)
    try {
      const res = await fetch(`/api/marketing/news/${id}/read`, { method: 'POST' })
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; throw new Error(d.error || t('Could not save. Please try again.')) }
      setGone(g => [...g, id]); router.refresh()
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.')) }
  }
  if (shown.length === 0) return null
  return (
    <section className="rounded-xl border border-teal-300 bg-teal-50 p-5" aria-label={t("What's New")} data-testid="home-news-member">
      <h2 className="text-sm font-semibold text-teal-900">{t("What's New")}</h2>
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      <ul className="mt-2 space-y-3">
        {shown.map(n => (
          <li key={n.id} className="rounded-lg border border-teal-200 bg-white p-3 text-sm" data-testid="home-news-item">
            <p className="font-medium">{n.title}</p>
            <p className="mt-1 whitespace-pre-line text-slate-700">{n.body}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {n.href && n.linkLabel && <Link href={n.href} onClick={() => { void fetch(`/api/marketing/news/${n.id}/read`, { method: 'POST', keepalive: true }) }} className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800" data-testid="home-news-open">{t('Open {screen}', { screen: n.linkLabel })}</Link>}
              <button type="button" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50" onClick={() => read(n.id)} data-testid="home-news-read">{t('Mark as read')}</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
