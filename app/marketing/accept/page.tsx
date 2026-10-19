'use client'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

function AcceptForm() {
  const token = useSearchParams().get('token') ?? ''
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/marketing/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password, fullName: name }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'This invitation could not be used. Please try again.')
      const { error: signErr } = await createClient().auth.signInWithPassword({ email: d.email, password })
      if (signErr) throw new Error('Your login was created. Please sign in from the login page.')
      window.location.href = '/marketing'
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold">Join TD Marketing</h1>
      <p className="mt-2 text-sm text-slate-600">Choose a password to finish creating your login. You will set up a second step on your next screen.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm font-medium">Your name
          <input id="accept-name" className="mt-1 w-full rounded-lg border px-3 py-2" value={name} onChange={e => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="block text-sm font-medium">Password (at least 12 characters)
          <input id="accept-password" type="password" className="mt-1 w-full rounded-lg border px-3 py-2" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button id="accept-submit" disabled={busy || !token} className="w-full rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? 'Creating…' : 'Create my login'}</button>
      </form>
    </main>
  )
}

export default function AcceptPage() {
  return <Suspense><AcceptForm /></Suspense>
}
