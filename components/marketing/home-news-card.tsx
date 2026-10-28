import Link from 'next/link'
import type { NewsAdminView } from '@/lib/marketing/news-server'

/** The What's New card on Antonio's Home (TD Marketing, dev job 9aec66fa, Addendum H): the drafts waiting for his OK, the latest posts with how many people read them, and the way to post. English: his own screen. */
export function HomeNewsCard({ news }: { news: NewsAdminView }) {
  const posts = news.posts.filter(p => p.status === 'posted').slice(0, 3)
  return (
    <section className="rounded-xl border bg-white p-5" aria-label="What's New" data-testid="home-news">
      <h2 className="text-sm font-semibold text-slate-600">What&apos;s New</h2>
      {!news.available && <p className="mt-2 text-sm text-amber-800">Not switched on in this database yet.</p>}
      {news.drafts.length > 0 && <p className="mt-2 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-900" data-testid="home-news-drafts">{news.drafts.length} draft{news.drafts.length === 1 ? '' : 's'} waiting for your OK: {news.drafts.map(d => d.title).join(', ')}</p>}
      {news.available && posts.length === 0 && news.drafts.length === 0 && <p className="mt-2 text-sm text-slate-500">Nothing posted yet.</p>}
      <ul className="mt-2 space-y-2 text-sm">
        {posts.map(p => (
          <li key={p.id} className="rounded-lg border border-teal-200 bg-teal-50/50 px-3 py-2" data-testid="home-news-post">
            <b>{p.title}</b>
            <p className="text-xs text-slate-500">Posted {p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Rome' }) : ''} · read by {p.read} of {p.total}</p>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href="/marketing-leads/news" className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white" data-testid="home-news-post-btn">Post news</Link>
        <Link href="/marketing-leads/news" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">See who read it</Link>
      </div>
    </section>
  )
}
