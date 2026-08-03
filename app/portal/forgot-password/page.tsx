'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

// This page no longer talks to the auth provider from the browser.
// It POSTs to /api/portal/password-reset, which mints the link server-side and
// sends a TD-branded, bilingual email through our own Gmail — and records the
// attempt in action_log so staff can answer "did the client actually try?".
// See lib/portal/password-reset.ts for the full why.

export default function ForgotPasswordPage() {
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState(
    searchParams.get('error') === 'expired'
      ? 'Reset link expired or already used. Please request a new one.'
      : ''
  )
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const submitted = email.trim().toLowerCase()

    // Hard timeout: without this a request that never settles leaves the button
    // stuck on "Sending..." forever with no message — the exact silent dead end
    // a client reported on 2026-08-02.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const res = await fetch('/api/portal/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: submitted }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // R099: surface the server's own message, never a generic swallow.
        const data = await res.json().catch(() => ({}))
        throw new Error(
          data.error || 'Could not send the reset email — please try again.'
        )
      }
      setSentTo(submitted)
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'AbortError'
          ? 'The request timed out. Please check your connection and try again.'
          : err instanceof Error && err.message
            ? err.message
            : 'Could not send the reset email — please try again.'
      )
    } finally {
      clearTimeout(timeout)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 p-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border shadow-lg p-8">
          <div className="mb-6 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-blue-600 text-white text-2xl font-bold mb-4">TD</div>
            <h1 className="text-xl font-semibold text-zinc-900">Reset Password</h1>
          </div>

          {sentTo ? (
            <div className="text-center space-y-3">
              {/* Echo the exact address we used. The old page said "check your
                  email" without ever showing WHICH address — so a client who
                  mistyped, or who has a second login, waited forever for an
                  email that was never going to arrive. */}
              <p className="text-sm text-zinc-600">
                If <strong className="text-zinc-900">{sentTo}</strong> has a portal
                account, a reset link is on its way from Tony Durante LLC.
              </p>
              <p className="text-xs text-zinc-500">
                It can take a few minutes. Check your spam folder, and make sure
                this is the address you use to sign in.
              </p>
              <Link href="/portal/login" className="inline-block text-sm text-blue-600 hover:underline">Back to login</Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="reset-email" className="block text-sm font-medium text-zinc-700 mb-1.5">Email</label>
                <input
                  id="reset-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
              <button type="submit" disabled={loading} className="w-full h-11 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>
              <Link href="/portal/login" className="block text-center text-sm text-blue-600 hover:underline">Back to login</Link>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
