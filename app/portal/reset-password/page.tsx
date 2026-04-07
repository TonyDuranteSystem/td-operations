'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [sessionError, setSessionError] = useState('')
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const code = searchParams.get('code')

    // ─── PKCE flow: exchange code for session (legacy, kept as fallback) ───
    if (code) {
      const supabase = createClient()
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) {
          setSessionError('Reset link expired or already used. Please request a new one.')
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
          setSessionError('No reset code found. Please request a new password reset link.')
        }
        return prev
      })
    }, 8000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [searchParams])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      toast.error('Passwords do not match')
      return
    }
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    // Try updating via both clients — one will have the session
    const ssrClient = createClient()
    const implicitClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { flowType: 'implicit', persistSession: true } }
    )

    // Try SSR client first (has session from auth callback), then implicit
    let result = await ssrClient.auth.updateUser({ password })
    if (result.error) {
      result = await implicitClient.auth.updateUser({ password })
    }

    setLoading(false)

    if (result.error) {
      toast.error(result.error.message)
    } else {
      // Clear must_change_password flag if it was set
      await fetch('/api/portal/onboarding-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear_password_flag: true }),
      })
      toast.success('Password updated successfully')
      router.push('/portal')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 p-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border shadow-lg p-8">
          <div className="mb-6 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-blue-600 text-white text-2xl font-bold mb-4">TD</div>
            <h1 className="text-xl font-semibold text-zinc-900">New Password</h1>
          </div>

          {sessionError ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-red-600">{sessionError}</p>
              <a href="/portal/forgot-password" className="text-sm text-blue-600 hover:underline">
                Request new reset link
              </a>
            </div>
          ) : !sessionReady ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600 mr-2" />
              <span className="text-sm text-zinc-500">Verifying reset link...</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1.5">New Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoFocus className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="text-xs text-zinc-500 mt-1">Minimum 8 characters</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1.5">Confirm Password</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <button type="submit" disabled={loading} className="w-full h-11 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {loading ? 'Updating...' : 'Update Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
