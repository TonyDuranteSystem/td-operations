'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

/**
 * Copy for this page cannot come from LocaleProvider: the client arrives here
 * LOGGED OUT, and getLocale() needs a session. The language rides on the link
 * instead — lib/portal/password-reset.ts appends ?lang= when it mints it.
 * Anything arriving without the marker falls back to English, as before.
 */
const COPY = {
  en: {
    title: 'New Password',
    newPassword: 'New Password',
    confirmPassword: 'Confirm Password',
    minChars: 'Minimum 8 characters',
    update: 'Update Password',
    updating: 'Updating...',
    verifying: 'Verifying reset link...',
    mismatch: 'Passwords do not match',
    tooShort: 'Password must be at least 8 characters',
    success: 'Password updated successfully',
    expired: 'Reset link expired or already used. Please request a new one.',
    noCode: 'This reset link is no longer valid. Please request a new one.',
    requestNew: 'Request new reset link',
  },
  it: {
    title: 'Nuova Password',
    newPassword: 'Nuova password',
    confirmPassword: 'Conferma password',
    minChars: 'Minimo 8 caratteri',
    update: 'Aggiorna password',
    updating: 'Aggiornamento...',
    verifying: 'Verifica del link in corso...',
    mismatch: 'Le password non coincidono',
    tooShort: 'La password deve avere almeno 8 caratteri',
    success: 'Password aggiornata correttamente',
    expired: 'Link scaduto o gia’ utilizzato. Richiedine uno nuovo.',
    noCode: 'Questo link non e’ piu’ valido. Richiedine uno nuovo.',
    requestNew: 'Richiedi un nuovo link',
  },
} as const

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [sessionError, setSessionError] = useState('')
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = COPY[searchParams.get('lang') === 'it' ? 'it' : 'en']

  useEffect(() => {
    const code = searchParams.get('code')

    // ─── PKCE flow: exchange code for session (legacy, kept as fallback) ───
    if (code) {
      const supabase = createClient()
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) {
          setSessionError(t.expired)
        } else {
          setSessionReady(true)
          window.history.replaceState({}, '', '/portal/reset-password')
        }
      })
      return
    }

    // ─── Implicit flow: Supabase sends #access_token&type=recovery in hash ───
    // Use a vanilla Supabase client that auto-detects hash fragments.
    // The @supabase/ssr client stores auth in cookies; the vanilla client
    // processes hash fragments and fires onAuthStateChange events.
    const implicitClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true } }
    )

    const { data: { subscription } } = implicitClient.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
        setSessionReady(true)
      }
    })

    // Also check via SSR client if session already exists (e.g. came through auth callback)
    const ssrClient = createClient()
    ssrClient.auth.getSession().then(({ data }) => {
      if (data.session) {
        setSessionReady(true)
      }
    })

    // Timeout: if no session after 8 seconds, show error
    const timeout = setTimeout(() => {
      setSessionReady(prev => {
        if (!prev) {
          setSessionError(t.noCode)
        }
        return prev
      })
    }, 8000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [searchParams, t.expired, t.noCode])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      toast.error(t.mismatch)
      return
    }
    if (password.length < 8) {
      toast.error(t.tooShort)
      return
    }

    setLoading(true)

    // Try our own server first (not supabase.auth.updateUser() from the
    // browser) so the View-as read-only lock in middleware.ts can actually see
    // and block this if a staff member is viewing a client's account and
    // lands here (dev job 3d47f472) — that lock only ever sees requests that
    // reach our server. Only fall back to the client-side implicit-flow call
    // on a 401 — that specifically means our server found no session at all,
    // which is the genuine case for the hash-fragment recovery flow (that
    // session lives in the browser only and never reaches us via cookies).
    // Any OTHER failure (blocked read-only view, validation, etc.) must NOT
    // fall back, or the fallback would silently reopen the exact bypass this
    // fix exists to close.
    const res = await fetch('/api/portal/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      // The server-side password update invalidates the current session as a
      // side effect — re-authenticate with the password just set so the client
      // lands in the portal instead of bouncing back to login right after success.
      if (data.email) {
        const ssrClient = createClient()
        await ssrClient.auth.signInWithPassword({ email: data.email, password })
      }
      setLoading(false)
      toast.success(t.success)
      router.push('/portal')
      return
    }

    if (res.status === 401) {
      const implicitClient = createSupabaseClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { flowType: 'implicit', persistSession: true } }
      )
      const result = await implicitClient.auth.updateUser({ password })
      setLoading(false)
      if (result.error) {
        toast.error(result.error.message)
      } else {
        await fetch('/api/portal/onboarding-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear_password_flag: true }),
        })
        toast.success(t.success)
        router.push('/portal')
      }
      return
    }

    setLoading(false)
    const data = await res.json().catch(() => ({}))
    toast.error(data.error || 'Could not update your password — please try again.')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 p-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border shadow-lg p-8">
          <div className="mb-6 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-blue-600 text-white text-2xl font-bold mb-4">TD</div>
            <h1 className="text-xl font-semibold text-zinc-900">{t.title}</h1>
          </div>

          {sessionError ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-red-600">{sessionError}</p>
              <a href="/portal/forgot-password" className="text-sm text-blue-600 hover:underline">
                {t.requestNew}
              </a>
            </div>
          ) : !sessionReady ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600 mr-2" />
              <span className="text-sm text-zinc-500">{t.verifying}</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-zinc-700 mb-1.5">{t.newPassword}</label>
                <input id="new-password" name="new-password" autoComplete="new-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoFocus className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="text-xs text-zinc-500 mt-1">{t.minChars}</p>
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-zinc-700 mb-1.5">{t.confirmPassword}</label>
                <input id="confirm-password" name="confirm-password" autoComplete="new-password" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <button type="submit" disabled={loading} className="w-full h-11 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {loading ? t.updating : t.update}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
