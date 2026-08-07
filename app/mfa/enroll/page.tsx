'use client'

/**
 * /mfa/enroll — staff TOTP enrollment (dev job de4564ee).
 *
 * Flow (council-fixed):
 *  1. Pre-clean stale UNVERIFIED factors (abandoned enrollments — the SDK
 *     allows unenrolling unverified factors at aal1), THEN refuse outright
 *     if a VERIFIED factor already exists and the session is aal1: adding
 *     a second authenticator requires passing the first (Security blocker;
 *     the page sends that case to /mfa/verify).
 *  2. Enroll (issuer set explicitly — the probe showed 'localhost:3000'
 *     otherwise) → show QR for cross-device scanning PLUS a tappable
 *     otpauth:// link + copyable secret (Antonio enrolls ON the phone,
 *     where a QR on the same screen is unscannable).
 *  3. First challenge+verify activates the factor (session → aal2). NOTE:
 *     verifying logs out this user's OTHER sessions — SDK behavior, in the
 *     rollout note.
 *  4. Generate + show backup codes ONCE, with a download button. Done.
 *  5. Grace window: while MFA_GRACE_UNTIL is in the future the gate lets
 *     un-enrolled staff through, so this page is reachable via the nudge
 *     and offers "later"; after the deadline there is no skip.
 */

import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, Copy, Download, Loader2, Smartphone } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type Step = 'loading' | 'intro' | 'scan' | 'codes' | 'blocked'

export default function MfaEnrollPage() {
  const supabase = createClient()
  const [step, setStep] = useState<Step>('loading')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const totp = factors?.totp ?? []
      const verified = totp.filter(f => (f as { status?: string }).status === 'verified')
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (verified.length > 0 && aal?.currentLevel !== 'aal2') {
        // Enrolled but unverified session: adding another factor at aal1 is
        // exactly what a stolen password would do. Go verify instead.
        setStep('blocked')
        return
      }
      // Clean abandoned enrollments so re-enroll never 422s.
      const { data: all } = await supabase.auth.mfa.listFactors()
      for (const f of all?.all ?? []) {
        if ((f as { status?: string }).status === 'unverified') {
          await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {})
        }
      }
      setStep('intro')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStart = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { data, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'TD Operations',
        friendlyName: `staff-${Date.now()}`,
      })
      if (enrollErr || !data) throw new Error(enrollErr?.message || 'Enrollment failed')
      setFactorId(data.id)
      setQrSvg(data.totp?.qr_code ?? null)
      setOtpauthUri(data.totp?.uri ?? null)
      setSecret(data.totp?.secret ?? null)
      setStep('scan')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enrollment failed')
    } finally {
      setBusy(false)
    }
  }, [supabase])

  const handleActivate = useCallback(async () => {
    if (!factorId || code.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId })
      if (chErr || !challenge) throw new Error(chErr?.message || 'Challenge failed')
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      })
      if (vErr) throw new Error('Wrong code — check the app and try again.')
      // Session is aal2 now; generate the one-time backup codes.
      const res = await fetch('/api/mfa/backup-codes', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create backup codes.')
      setBackupCodes(d.codes)
      setStep('codes')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed')
    } finally {
      setBusy(false)
    }
  }, [factorId, code, supabase])

  const handleCopySecret = useCallback(async () => {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    } catch { /* secret is displayed as text anyway */ }
  }, [secret])

  const handleDownloadCodes = useCallback(() => {
    if (!backupCodes) return
    const blob = new Blob(
      [`TD Operations — MFA backup codes (${new Date().toISOString().slice(0, 10)})\nEach code works once. Store safely.\n\n${backupCodes.join('\n')}\n`],
      { type: 'text/plain' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'td-mfa-backup-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }, [backupCodes])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50/30 flex items-center justify-center px-5 py-8">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-zinc-200 p-6">
        <ShieldCheck className="h-10 w-10 text-red-600 mx-auto mb-3" />

        {step === 'loading' && <Loader2 className="h-5 w-5 animate-spin mx-auto" />}

        {step === 'blocked' && (
          <>
            <h1 className="text-lg font-semibold text-center">Verification required</h1>
            <p className="text-sm text-zinc-600 text-center mt-2">
              This account already has an authenticator. Verify with it before
              changing your setup.
            </p>
            <a href="/mfa/verify" className="block text-center mt-4 px-4 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg">
              Go to verification
            </a>
          </>
        )}

        {step === 'intro' && (
          <>
            <h1 className="text-lg font-semibold text-center">Set up two-factor login</h1>
            <p className="text-sm text-zinc-600 text-center mt-2">
              Staff accounts require an authenticator app (Google
              Authenticator, 1Password, Apple Passwords…). It takes two
              minutes and you&apos;ll get backup codes for emergencies.
            </p>
            <button
              onClick={handleStart}
              disabled={busy}
              className="mt-5 w-full px-4 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin inline" /> : 'Start setup'}
            </button>
          </>
        )}

        {step === 'scan' && (
          <>
            <h1 className="text-lg font-semibold text-center">Add to your authenticator</h1>
            {qrSvg && (
              <div className="mx-auto mt-4 w-[190px] h-[190px] rounded-xl border overflow-hidden">
                {/* GoTrue returns the QR as a data URI — next/image cannot
                    optimize it and must not proxy an MFA secret anyway. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrSvg} alt="TOTP enrollment QR" className="w-full h-full" />
              </div>
            )}
            <p className="text-xs text-zinc-500 text-center mt-2">
              Scan with another device — or, on this phone:
            </p>
            <div className="mt-2 space-y-2">
              {otpauthUri && (
                <a
                  href={otpauthUri}
                  className="block text-center px-3 py-2 bg-zinc-100 rounded-lg text-xs font-medium text-zinc-800"
                >
                  <Smartphone className="h-3.5 w-3.5 inline mr-1" />
                  Open in authenticator app
                </a>
              )}
              {secret && (
                <button onClick={handleCopySecret} className="w-full px-3 py-2 bg-zinc-100 rounded-lg text-xs font-mono break-all">
                  <Copy className="h-3 w-3 inline mr-1" />
                  {copied ? 'Copied' : secret}
                </button>
              )}
            </div>
            <p className="text-sm text-zinc-600 text-center mt-4">Enter the app&apos;s 6-digit code to activate:</p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter') handleActivate() }}
              className="mt-2 w-full text-center text-2xl tracking-[0.5em] font-mono border rounded-xl py-3"
              placeholder="••••••"
            />
            <button
              onClick={handleActivate}
              disabled={busy || code.length !== 6}
              className="mt-3 w-full px-4 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin inline" /> : 'Activate'}
            </button>
            <p className="text-[11px] text-zinc-400 text-center mt-3">
              Note: activating signs you out of other devices — log in there again once.
            </p>
          </>
        )}

        {step === 'codes' && backupCodes && (
          <>
            <h1 className="text-lg font-semibold text-center">Save your backup codes</h1>
            <p className="text-sm text-zinc-600 text-center mt-1">
              Shown ONCE. Each works one time if you lose your phone.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-1 bg-zinc-50 rounded-xl p-3 font-mono text-[11px]">
              {backupCodes.map(c => <div key={c}>{c}</div>)}
            </div>
            <button
              onClick={handleDownloadCodes}
              className="mt-3 w-full px-4 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg"
            >
              <Download className="h-4 w-4 inline mr-1" />
              Download codes
            </button>
            <a href="/" className="block text-center mt-3 px-4 py-2.5 bg-red-600 text-white text-sm font-semibold rounded-lg">
              Done — go to dashboard
            </a>
          </>
        )}

        {error && <p className="mt-3 text-sm text-red-600 text-center">{error}</p>}
      </div>
    </div>
  )
}
