'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useT } from '@/components/marketing/lang-provider'

export interface FeedItem { id: string; title: string; body: string; href: string | null; linkLabel: string | null; unread: boolean; postedAt: string | null; edited: boolean }

/**
 * TD Marketing — the team's What's New list (dev job 9aec66fa, Addendum H). Showing a post counts as opening it: the new ones are marked read as soon as the page is on screen (they keep their
 * "New" tag until the page is left, so the person sees which ones were new). "View as" records nothing (the server ignores it).
 */
export function NewsFeed({ items, locale }: { items: FeedItem[]; locale: string }) {
  const t = useT()
  useEffect(() => {
    for (const n of items.filter(i => i.unread).slice(0, 20)) fetch(`/api/marketing/news/${n.id}/read`, { method: 'POST' }).catch(() => { /* the mark is retried the next time the page opens */ })
  }, [items])
  if (items.length === 0) return <p className="rounded-xl border bg-white p-5 text-sm text-slate-500" data-testid="news-empty">{t('Nothing new yet.')}</p>
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Rome' }) : '')
  return (
    <ul className="space-y-3" data-testid="news-feed">
      {items.map(n => (
        <li key={n.id} className={`rounded-xl border bg-white p-5 ${n.unread ? 'border-teal-400' : ''}`} data-testid="news-item" data-unread={n.unread ? 'true' : 'false'}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="font-semibold">{n.unread && <span className="mr-2 rounded-full bg-teal-700 px-2 py-0.5 text-[11px] font-medium text-white">{t('New')}</span>}{n.title}</h2>
            <p className="text-xs text-slate-500">{t('Posted {when}', { when: when(n.postedAt) })}{n.edited ? ` · ${t('edited')}` : ''}</p>
          </div>
          <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{n.body}</p>
          {n.href && n.linkLabel && <Link href={n.href} className="mt-3 inline-block rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800" data-testid="news-open">{t('Open {screen}', { screen: n.linkLabel })}</Link>}
        </li>
      ))}
    </ul>
  )
}
