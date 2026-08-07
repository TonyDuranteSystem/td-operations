'use client'

/**
 * /mfa/verify — staff TOTP challenge (dev job de4564ee).
 *
 * Reached when the middleware gate returns 'verify' (enrolled staff at
 * aal1 with no valid remember-device cookie). Exempt from the gate's own
 * redirect (session still required — clients/partners are bounced by the
 * middleware role branches before ever seeing this).
 *
 * Flow: 6-digit code → challenge+verify straight against GoTrue (the
 * browser client rotates the session cookies to aal2 on success) →
 * optionally mint the 30-day remember-device cookie → hard navigate home
 * (full reload so every layout re-reads the upgraded session).
 * Backup-code fallback is ONE-SHOT recovery: valid code deletes the
 * factors and signs out everywhere → login → forced re-enrollment.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ShieldCheck, KeyRound, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export default function MfaVerifyPage() {
  const supabase = createClient()
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showBackup, setShowBackup] = useState(false)
  const [backupCode, setBackupCode] = useState('')
  const [backupDone, setBackupDone] = useState(false)
  const factorIdRef = useRef<string | null>(null)

  useEffect(() => {
    // Resolve the verified TOTP factor once. No factor → the gate would have
    // sent 'enroll'; being here without one means a race — go enroll.
    supabase.auth.mfa.listFactors().then(({ data }) => {
      const verified = data?.totp?.find(f => (f as { status?: string }).status === 'verified') ?? data?.totp?.[0]
      if (!verified) { window.location.assign('/mfa/enroll'); return }
      factorIdRef.current = verified.id
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleVerify = useCallback(async () => {
    if (!factorIdRef.current || code.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
        factorId: factorIdRef.current,
      })
      if (chErr || !challenge) throw new Error(chErr?.message || 'Challenge failed')
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: factorIdRef.current,
        challengeId: challenge.id,
        code,
      })
      if (vErr) throw new Error('Wrong code — check your authenticator and try again.')
      if (remember) {
        // Best-effort: device trust is a convenience; verification succeeded.
        await fetch('/api/mfa/remember', { method: 'POST' }).catch(() => {})
      }
      window.location.assign('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
      setBusy(false)
    }
  }, [code, remember, supabase])

  const handleBackup = useCallback(async () => {
    if (!backupCode.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/mfa/backup-verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: backupCode }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Invalid code.')
      // Factors are gone and every session is being revoked — tell the user
      // what happens next before the redirect to login.
      setBackupDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code.')
      setBusy(false)
    }
  }, [backupCode])

  if (backupDone) {
    return (
      <Shell>
        <ShieldCheck className="h-10 w-10 text-green-600 mx-auto mb-3" />
        <h1 className="text-lg font-semibold text-center">Backup code accepted</h1>
        <p className="text-sm text-zinc-600 text-center mt-2">
          For security, your authenticator was removed and all sessions signed
          out. Log in again with your password — you&apos;ll set up a new
          authenticator and get fresh backup codes.
        </p>
        <a href="/login" className="block text-center mt-4 px-4 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg">
          Go to login
        </a>
      </Shell>
    )
  }

  return (
    <Shell>
      <ShieldCheck className="h-10 w-10 text-red-600 mx-auto mb-3" />
      <h1 className="text-lg font-semibold text-center">Two-factor verification</h1>
      {!showBackup ? (
        <>
          <p className="text-sm text-zinc-600 text-center mt-1">
            Enter the 6-digit code from your authenticator app.
          </p>
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={e => { if (e.key === 'Enter') handleVerify() }}
            className="mt-4 w-full text-center text-2xl tracking-[0.5em] font-mono border rounded-xl py-3"
            placeholder="••••••"
          />
          <label className="flex items-center gap-2 mt-4 text-sm text-zinc-600">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Remember this device for 30 days
          </label>
          <button
            onClick={handleVerify}
            disabled={busy || code.length !== 6}
            className="mt-4 w-full px-4 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin inline" /> : 'Verify'}
          </button>
          <button onClick={() => { setShowBackup(true); setError(null) }} className="mt-3 w-full text-xs text-zinc-500 underline">
            <KeyRound className="h-3 w-3 inline mr-1" />
            Lost your phone? Use a backup code
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600 text-center mt-1">
            Enter one of your backup codes. Using it removes your current
            authenticator — you&apos;ll set up a new one right after.
          </p>
          <input
            autoFocus
            value={backupCode}
            onChange={e => setBackupCode(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleBackup() }}
            className="mt-4 w-full text-center font-mono border rounded-xl py-3 text-sm"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X"
          />
          <button
            onClick={handleBackup}
            disabled={busy || !backupCode.trim()}
            className="mt-4 w-full px-4 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin inline" /> : 'Use backup code'}
          </button>
          <button onClick={() => { setShowBackup(false); setError(null) }} className="mt-3 w-full text-xs text-zinc-500 underline">
            Back to authenticator code
          </button>
        </>
      )}
      {error && <p className="mt-3 text-sm text-red-600 text-center">{error}</p>}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50/30 flex items-center justify-center px-5">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-zinc-200 p-6">
        {children}
      </div>
    </div>
  )
}
