'use client'

import { useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'

interface Check { name: string; ok: boolean; detail: string }

/** Antonio's "Test Zoom" box on the Team page: makes one test meeting for a person's Zoom login, deletes it, and says whether recordings can be read. The server's answer is shown as written (R099). */
export function ZoomTestBox({ emails }: { emails: string[] }) {
  const t = useT()
  const [host, setHost] = useState(emails[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checks, setChecks] = useState<Check[] | null>(null)
  async function run() {
    setBusy(true); setError(null); setChecks(null)
    try {
      const res = await fetch('/api/marketing/team/zoom-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host }) })
      const d = await res.json().catch(() => ({})) as { error?: string; checks?: Check[] }
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('The test could not run. Please try again.'))
      setChecks(d.checks ?? [])
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('The test could not run. Please try again.')) }
    setBusy(false)
  }
  return (
    <section className="rounded-xl border bg-white p-5" data-testid="zoom-test" aria-label={t('Test Zoom')}>
      <h2 className="text-sm font-semibold text-slate-600">{t('Test Zoom')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('Makes one test meeting for this Zoom login, deletes it at once, and checks that recordings can be read.')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" list="zoom-test-emails" value={host} onChange={e => setHost(e.target.value)} placeholder="name@company.com" aria-label={t('Zoom login email')} data-testid="zoom-test-host" />
        <datalist id="zoom-test-emails">{emails.map(e => <option key={e} value={e} />)}</datalist>
        <button type="button" className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !host.trim()} onClick={run} data-testid="zoom-test-run">{busy ? t('Testing…') : t('Test Zoom')}</button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-rose-700" data-testid="zoom-test-error">{error}</p>}
      {checks && (
        <ul className="mt-3 space-y-1 text-sm" data-testid="zoom-test-result">
          {checks.map((c, i) => <li key={i} className={c.ok ? 'text-emerald-800' : 'text-rose-700'}><b>{c.ok ? '✓' : '✗'} {c.name}</b>: {c.detail}</li>)}
        </ul>
      )}
    </section>
  )
}
