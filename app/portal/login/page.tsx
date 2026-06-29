'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { teammateLogin, partnerLoginAllowed } from './actions'
import Link from 'next/link'

// Shown both when a suspended client attempts to log in (auth returns
// 'user_banned') and when middleware bounces an active suspended session here
// with ?reason=suspended.
const SUSPENDED_MESSAGE = 'Your login has been suspended by the administrator.'

export default function PortalLoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  // Middleware redirects a suspended-but-still-logged-in client here with
  // ?reason=suspended — surface the message immediately (read client-side to
  // avoid the useSearchParams Suspense requirement).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('reason') === 'suspended') {
      setError(SUSPENDED_MESSAGE)
    }
  }, [])

  const finishLogin = (destination = '/portal') => {
    // Audit log login (fire-and-forget)
    fetch('/api/portal/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login' }),
    }).catch(() => {})
    router.push(destination)
    router.refresh()
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const value = identifier.trim()

    // Username (no '@') → teammate login via server action (resolves the hidden
    // email server-side and signs in). Email (has '@') → normal client login.
    if (!value.includes('@')) {
      const res = await teammateLogin(value, password)
      if (!res.ok) {
        setError(res.error || 'Invalid username or password')
        setLoading(false)
        return
      }
      finishLogin()
      return
    }

    const supabase = createClient()
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email: value, password })

    if (authError) {
      // A login suspended by an admin is banned at the auth layer. Supabase
      // returns code 'user_banned' (verified in sandbox: fires on both correct
      // and wrong password). Surface a clear suspension message instead of the
      // generic credential error so the client knows why they can't get in.
      if (authError.code === 'user_banned') {
        setError(SUSPENDED_MESSAGE)
      } else {
        setError('Invalid email or password')
      }
      setLoading(false)
      return
    }

    // Verify the user may use a client-facing surface. Clients use the portal;
    // partners (role='partner', e.g. Cris) are confined by middleware to /collab
    // and gated there by their td_communication scope. Any other role has no
    // client-facing access.
    const role = data.user?.app_metadata?.role
    if (role !== 'client' && role !== 'partner') {
      await supabase.auth.signOut()
      setError('This account does not have portal access')
      setLoading(false)
      return
    }

    // A partner must additionally have a non-empty scope. The scope lives in the
    // RLS-protected client_partners table, so this is a server-side check — a
    // scopeless / unlinked partner is rejected here so they never hold a session.
    if (role === 'partner') {
      const allowed = await partnerLoginAllowed()
      if (!allowed) {
        await supabase.auth.signOut()
        setError('This account does not have portal access')
        setLoading(false)
        return
      }
    }

    finishLogin(role === 'partner' ? '/collab' : '/portal')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50">
      <div className="w-full max-w-sm mx-4">
        <div className="bg-white rounded-2xl border shadow-lg p-8">
          {/* Logo / Branding */}
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-blue-600 text-white text-2xl font-bold mb-4">
              TD
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Client Portal</h1>
            <p className="text-sm text-zinc-500 mt-1">Tony Durante LLC</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium text-zinc-700">
                Email or username
              </label>
              <input
                id="email"
                type="text"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="your@email.com or username"
                required
                autoFocus
                className="flex h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium text-zinc-700">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="flex h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 pr-10 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-400 hover:text-zinc-600"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-100">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <Link
              href="/portal/forgot-password"
              className="text-sm text-blue-600 hover:text-blue-700 hover:underline"
            >
              Forgot your password?
            </Link>
          </div>
        </div>

        <div className="text-center text-xs text-zinc-400 mt-6 space-y-1">
          <p>&copy; {new Date().getFullYear()} Tony Durante LLC</p>
          <div className="flex items-center justify-center gap-3">
            <a
              href="https://www.iubenda.com/privacy-policy/51522422"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-600 underline"
            >
              Privacy Policy
            </a>
            <span>·</span>
            <a
              href="https://www.iubenda.com/privacy-policy/51522422/cookie-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-600 underline"
            >
              Cookie Policy
            </a>
            <span>·</span>
            <a
              href="https://www.iubenda.com/terms-and-conditions/51522422"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-600 underline"
            >
              Terms
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
