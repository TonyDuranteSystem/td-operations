'use client'
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LangProvider, useT } from '@/components/marketing/lang-provider'
import type { Lang } from '@/lib/marketing/templates'

function ResetForm() {
  const t = useT()
  const token = useSearchParams().get('token') ?? ''
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== again) { setError(t('The two passwords are not the same.')); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/marketing/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('This link could not be used. Ask for a new one.'))
      const { error: signErr } = await createClient().auth.signInWithPassword({ email: d.email, password })
      if (signErr) throw new Error(t('Your password was changed. Please sign in from the login page.'))
      window.location.href = '/marketing'
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('Something went wrong. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold">{t('Choose a new password')}</h1>
      <p className="mt-2 text-sm text-slate-600">{t('Choose a new password for your TD Marketing login. You will still be asked for your second step.')}</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm font-medium">{t('New password (at least 12 characters)')}
          <input id="reset-password" type="password" className="mt-1 w-full rounded-lg border px-3 py-2" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="block text-sm font-medium">{t('Repeat the new password')}
          <input id="reset-again" type="password" className="mt-1 w-full rounded-lg border px-3 py-2" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button id="reset-submit" disabled={busy || !token} className="w-full rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? t('Saving…') : t('Save the new password')}</button>
      </form>
      <p className="mt-6 text-sm"><a href="/marketing/forgot" className="text-slate-600 underline">{t('Ask for a new link')}</a></p>
    </main>
  )
}

export default function ResetPage() {
  // outside the workspace frame: Italian unless this browser chose English
  const [lang, setLang] = useState<Lang>('it')
  useEffect(() => { if (/(?:^|; )tdm_lang=en/.test(document.cookie)) setLang('en') }, [])
  return <LangProvider lang={lang}><Suspense><ResetForm /></Suspense></LangProvider>
}
