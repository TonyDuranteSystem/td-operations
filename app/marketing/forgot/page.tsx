'use client'
import { useEffect, useState } from 'react'
import { LangProvider, useT } from '@/components/marketing/lang-provider'
import type { Lang } from '@/lib/marketing/templates'

function ForgotForm({ lang }: { lang: Lang }) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null); setAnswer(null)
    try {
      const res = await fetch('/api/marketing/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, lang }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error ? t(d.error) : t('Something went wrong. Please try again.'))
      setAnswer(t(d.message || 'If this email belongs to a TD Marketing login, a link to choose a new password is on its way. It works once and expires in one hour.'))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('Something went wrong. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold">{t('Forgot your password?')}</h1>
      <p className="mt-2 text-sm text-slate-600">{t('Write the email of your TD Marketing login. If it exists, we send you a link to choose a new password.')}</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm font-medium">{t('Email')}
          <input id="forgot-email" type="email" required className="mt-1 w-full rounded-lg border px-3 py-2" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
        </label>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {answer && <p id="forgot-answer" role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{answer}</p>}
        <button id="forgot-submit" disabled={busy || !email.trim()} className="w-full rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? t('Sending…') : t('Send me the link')}</button>
      </form>
      <p className="mt-6 text-sm"><a href="/login" className="text-slate-600 underline">{t('Back to sign in')}</a></p>
    </main>
  )
}

export default function ForgotPage() {
  // outside the workspace frame: Italian unless this browser chose English
  const [lang, setLang] = useState<Lang>('it')
  useEffect(() => { if (/(?:^|; )tdm_lang=en/.test(document.cookie)) setLang('en') }, [])
  return <LangProvider lang={lang}><ForgotForm lang={lang} /></LangProvider>
}
