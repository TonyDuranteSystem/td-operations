'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { NEWS_AUDIENCES, type NewsAudience } from '@/lib/marketing/news'

export interface DraftView { key: string; menuKey: string; audience: NewsAudience; title: string; body: string; titleIt: string; bodyIt: string }
export interface PostView {
  id: string; title: string; body: string; titleIt: string | null; bodyIt: string | null; linkKey: string | null; audience: NewsAudience; status: 'posted' | 'withdrawn'
  postedAt: string | null; editedAt: string | null; read: number; total: number; unreadNames: string[]; readers: Array<{ name: string; at: string }>
}
export interface TargetView { key: string; label: string }

const AUDIENCE_LABEL: Record<NewsAudience, string> = { everyone: 'Everyone', sellers: 'Sellers', setters: 'Setters' }
const input = 'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm'
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Rome' }) : '')

interface FormState { title: string; body: string; titleIt: string; bodyIt: string; linkKey: string; audience: NewsAudience; featureKey?: string; editId?: string }
const EMPTY: FormState = { title: '', body: '', titleIt: '', bodyIt: '', linkKey: '', audience: 'everyone' }

async function send(url: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; throw new Error(d.error || 'Could not save. Please try again.') }
}

/**
 * Antonio's What's New page (TD Marketing, dev job 9aec66fa, Addendum H): post news, approve or discard the drafts the system prepared for new screens, and see who read each post.
 * Nothing reaches the team until he presses Post or Approve. The server's answer, including a refusal, is shown as written (R099).
 */
export function NewsAdmin({ drafts, posts, targets, available }: { drafts: DraftView[]; posts: PostView[]; targets: TargetView[]; available: boolean }) {
  const router = useRouter()
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const set = (patch: Partial<FormState>) => setForm(f => (f ? { ...f, ...patch } : f))

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id); setError(null)
    try { await fn(); setForm(null); router.refresh() } catch (e) { setError(e instanceof Error && e.message ? e.message : 'Could not save. Please try again.') } finally { setBusy(null) }
  }
  const payload = (f: FormState) => ({ title: f.title, body: f.body, titleIt: f.titleIt, bodyIt: f.bodyIt, linkKey: f.linkKey, audience: f.audience, ...(f.featureKey ? { featureKey: f.featureKey } : {}) })
  const targetLabel = (k: string | null) => targets.find(t => t.key === k)?.label ?? null

  if (!available) return <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="news-unavailable">What&apos;s New is not switched on in this database yet (its two tables are missing). Run the What&apos;s New database step first.</p>

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="news-error">{error}</p>}

      {drafts.length > 0 && (
        <section aria-label="Waiting for your OK" className="rounded-xl border border-teal-300 bg-teal-50 p-4" data-testid="news-drafts">
          <h2 className="text-sm font-semibold text-teal-900">Waiting for your OK ({drafts.length})</h2>
          <p className="mt-1 text-xs text-teal-900/80">The system prepared these when a screen went live. Nothing reaches the team until you approve it.</p>
          <ul className="mt-3 space-y-3">
            {drafts.map(d => (
              <li key={d.key} className="rounded-lg border border-teal-200 bg-white p-3 text-sm" data-testid="news-draft" data-draft={d.key}>
                <p className="font-medium">{d.title}</p>
                <p className="mt-1 whitespace-pre-line text-slate-700">{d.body}</p>
                <p className="mt-1 text-xs text-slate-500">Italian: {d.titleIt} — for {AUDIENCE_LABEL[d.audience].toLowerCase()}{targetLabel(d.menuKey) ? ` — links to ${targetLabel(d.menuKey)}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50" disabled={busy !== null} data-testid="draft-approve"
                    onClick={() => run(d.key, () => send('/api/marketing-admin/news', 'POST', { title: d.title, body: d.body, titleIt: d.titleIt, bodyIt: d.bodyIt, linkKey: d.menuKey, audience: d.audience, featureKey: d.key }))}>{busy === d.key ? 'Posting…' : 'Approve and post'}</button>
                  <button type="button" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={busy !== null} data-testid="draft-edit"
                    onClick={() => setForm({ title: d.title, body: d.body, titleIt: d.titleIt, bodyIt: d.bodyIt, linkKey: d.menuKey, audience: d.audience, featureKey: d.key })}>Edit first</button>
                  <button type="button" className="rounded-lg border px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50" disabled={busy !== null} data-testid="draft-discard"
                    onClick={() => run(d.key, () => send('/api/marketing-admin/news/discard', 'POST', { featureKey: d.key }))}>Discard</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {form === null ? (
        <button type="button" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white" onClick={() => setForm({ ...EMPTY })} data-testid="news-new">Post news</button>
      ) : (
        <form className="rounded-xl border bg-white p-4" data-testid="news-form" onSubmit={e => { e.preventDefault(); run('form', () => (form.editId ? send(`/api/marketing-admin/news/${form.editId}`, 'PATCH', payload(form)) : send('/api/marketing-admin/news', 'POST', payload(form)))) }}>
          <h2 className="text-sm font-semibold text-slate-600">{form.editId ? 'Edit news' : form.featureKey ? 'Edit the draft, then post it' : 'New post'}</h2>
          <label className="mt-3 block text-sm">Title<input className={input} value={form.title} maxLength={120} onChange={e => set({ title: e.target.value })} data-testid="news-title" /></label>
          <label className="mt-3 block text-sm">Text<textarea className={`${input} min-h-[6rem]`} value={form.body} maxLength={2000} onChange={e => set({ body: e.target.value })} data-testid="news-body" /></label>
          <details className="mt-3 text-sm" open={!!form.titleIt || !!form.bodyIt}>
            <summary className="cursor-pointer text-slate-600">Italian version (the team works in Italian; empty = they read the English)</summary>
            <label className="mt-2 block">Italian title<input className={input} value={form.titleIt} maxLength={120} onChange={e => set({ titleIt: e.target.value })} data-testid="news-title-it" /></label>
            <label className="mt-2 block">Italian text<textarea className={`${input} min-h-[5rem]`} value={form.bodyIt} maxLength={2000} onChange={e => set({ bodyIt: e.target.value })} data-testid="news-body-it" /></label>
          </details>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">Link to a screen<select className={input} value={form.linkKey} onChange={e => set({ linkKey: e.target.value })} data-testid="news-link"><option value="">No link</option>{targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
            <label className="block text-sm">Who sees it<select className={input} value={form.audience} onChange={e => set({ audience: e.target.value as NewsAudience })} data-testid="news-audience">{NEWS_AUDIENCES.map(a => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</select></label>
          </div>
          <div className="mt-4 flex gap-2">
            <button type="submit" className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50" disabled={busy !== null} data-testid="news-post">{busy === 'form' ? 'Saving…' : form.editId ? 'Save' : 'Post'}</button>
            <button type="button" className="rounded-lg border px-4 py-2 text-sm hover:bg-slate-50" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      <section aria-label="Posted news" data-testid="news-posts">
        <h2 className="text-sm font-semibold text-slate-600">Posted</h2>
        {posts.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nothing posted yet.</p> : (
          <ul className="mt-2 space-y-3">
            {posts.map(p => (
              <li key={p.id} className={`rounded-xl border bg-white p-4 text-sm ${p.status === 'withdrawn' ? 'opacity-60' : ''}`} data-testid="news-post-row" data-status={p.status}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">{p.title}{p.editedAt && <span className="ml-2 text-xs font-normal text-slate-500">edited</span>}{p.status === 'withdrawn' && <span className="ml-2 rounded-full bg-slate-100 px-2 text-xs font-normal">withdrawn</span>}</p>
                  <p className="text-xs text-slate-500">{when(p.postedAt)} · for {AUDIENCE_LABEL[p.audience].toLowerCase()}{targetLabel(p.linkKey) ? ` · links to ${targetLabel(p.linkKey)}` : ''}</p>
                </div>
                <p className="mt-1 whitespace-pre-line text-slate-700">{p.body}</p>
                {p.status === 'posted' && (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <button type="button" className="text-teal-800 underline" onClick={() => setOpen(open === p.id ? null : p.id)} data-testid="news-read-by">Read by {p.read} of {p.total}</button>
                    <button type="button" className="text-slate-600 underline" onClick={() => setForm({ title: p.title, body: p.body, titleIt: p.titleIt ?? '', bodyIt: p.bodyIt ?? '', linkKey: p.linkKey ?? '', audience: p.audience, editId: p.id })} data-testid="news-edit">Edit</button>
                    <button type="button" className="text-rose-700 underline disabled:opacity-50" disabled={busy !== null} data-testid="news-withdraw" onClick={() => run(p.id, () => send(`/api/marketing-admin/news/${p.id}`, 'DELETE'))}>Withdraw</button>
                  </div>
                )}
                {open === p.id && (
                  <div className="mt-2 rounded-lg bg-slate-50 p-3 text-xs" data-testid="news-readers">
                    {p.readers.length > 0 && <p><b>Read:</b> {p.readers.map(r => `${r.name} (${when(r.at)})`).join(', ')}</p>}
                    {p.unreadNames.length > 0 && <p className="mt-1"><b>Not yet:</b> {p.unreadNames.join(', ')}</p>}
                    {p.total === 0 && <p>Nobody is in this audience yet.</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
