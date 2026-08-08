'use client'

/**
 * Staff two-factor panel — the ONE place staff manage their authenticator
 * (dev job de4564ee follow-up; Antonio 2026-08-07: "a toggle to activate the
 * MFA — click it and a QR appears, like any other website").
 *
 * States:
 *   OFF  (no authenticator) → the toggle turns it ON: QR + manual key inline,
 *        enter the 6-digit code, backup codes shown once with a download.
 *        Works from a normal (aal1) session — there is no factor to prove yet.
 *   ON   (authenticator active) → the toggle is locked ON. Staff MFA is
 *        mandatory (FTC Safeguards / IRS Pub 4557), so self-disabling would
 *        undo the reason it exists. Removing an authenticator is an admin
 *        reset or the documented break-glass. Two actions sit below it:
 *          • Replace — the planned phone change (removes old, sets up new,
 *            issues fresh backup codes). Requires a just-passed code.
 *          • New backup codes — invalidates the old set. Requires the same.
 *
 * The Supabase browser client is created ON DEMAND (inside effects and
 * handlers), NEVER in the render path — createBrowserClient throws when the
 * public URL/anon key are absent, which is exactly a preview build. Creating
 * it during render broke every preview build of the repo (2026-08-07).
 */

import { useCallback, useEffect, useState } from 'react'
import { X, ShieldCheck, Smartphone, KeyRound, Loader2, Download, Copy, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type Mode = 'loading' | 'menu' | 'scan' | 'codes'
/** What the current scan flow is for — first setup, or swapping phones. */
type ScanIntent = 'enroll' | 'replace'

export function MfaSettingsDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('loading')
  const [enabled, setEnabled] = useState(false)
  const [verifiedSession, setVerifiedSession] = useState(false)
  const [intent, setIntent] = useState<ScanIntent>('enroll')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    const supabase = createClient()
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    setEnabled((factors?.totp ?? []).some(f => (f as { status?: string }).status === 'verified'))
    setVerifiedSession(aal?.currentLevel === 'aal2')
    setMode('menu')
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /** Begin a QR flow. For 'replace' the old authenticator is removed first —
   *  proven safe as one flow: unenroll at aal2 keeps every session alive. */
  const startScan = useCallback(async (why: ScanIntent) => {
    if (why === 'replace' && !confirm('Replace your authenticator?\n\nThe current one stops working immediately and you set up the new one on the next screen. Have the new phone ready.')) return
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data: existing } = await supabase.auth.mfa.listFactors()
      for (const f of existing?.all ?? []) {
        // Clears the old authenticator on a replace, and any abandoned
        // half-finished attempt on a first setup.
        const { error: unErr } = await supabase.auth.mfa.unenroll({ factorId: f.id })
        if (unErr && why === 'replace') throw new Error(unErr.message)
      }
      const { data: enrolled, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'TD Operations',
        friendlyName: `staff-${Date.now()}`,
      })
      if (enrollErr || !enrolled) throw new Error(enrollErr?.message || 'Could not start setup')
      setFactorId(enrolled.id)
      setQr(enrolled.totp?.qr_code ?? null)
      setUri(enrolled.totp?.uri ?? null)
      setSecret(enrolled.totp?.secret ?? null)
      setIntent(why)
      setEnabled(false)
      setCode('')
      setMode('scan')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start setup')
    } finally {
      setBusy(false)
    }
  }, [])

  const activate = useCallback(async () => {
    if (!factorId || code.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId })
      if (chErr || !challenge) throw new Error(chErr?.message || 'Challenge failed')
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
      if (vErr) throw new Error('Wrong code — check the app and try again.')
      const res = await fetch('/api/mfa/backup-codes', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create backup codes.')
      setCodes(d.codes)
      setEnabled(true)
      setVerifiedSession(true)
      setMode('codes')
      toast.success(intent === 'replace'
        ? 'New authenticator active — the old one no longer works'
        : 'Two-factor login is on')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed')
    } finally {
      setBusy(false)
    }
  }, [factorId, code, intent])

  const regenerate = useCallback(async () => {
    if (!confirm('Generate a new set of backup codes?\n\nYour previous codes stop working immediately.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/mfa/backup-codes', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create backup codes.')
      setCodes(d.codes)
      setMode('codes')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate codes')
    } finally {
      setBusy(false)
    }
  }, [])

  const download = useCallback(() => {
    if (!codes) return
    const blob = new Blob(
      [`TD Operations — two-factor backup codes (${new Date().toISOString().slice(0, 10)})\nEach code works once. Any previous set is now invalid.\n\n${codes.join('\n')}\n`],
      { type: 'text/plain' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'td-two-factor-backup-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }, [codes])

  const copySecret = useCallback(async () => {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    } catch { /* the key is on screen anyway */ }
  }, [secret])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck className="h-4 w-4 text-red-600" />
            Two-factor security
          </h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5">
          {mode === 'loading' && <Loader2 className="mx-auto h-5 w-5 animate-spin text-zinc-400" />}

          {mode === 'menu' && (
            <>
              {/* THE TOGGLE */}
              <div className="flex items-start gap-3 rounded-lg border p-4">
                <button
                  role="switch"
                  aria-checked={enabled}
                  aria-label="Two-factor login"
                  disabled={busy || enabled}
                  onClick={() => { if (!enabled) startScan('enroll') }}
                  className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
                    enabled ? 'bg-green-600' : 'bg-zinc-300 hover:bg-zinc-400'
                  } ${enabled ? 'cursor-default' : 'cursor-pointer'} disabled:opacity-100`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    Two-factor login {enabled ? 'is on' : 'is off'}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {enabled
                      ? 'Your account asks for a 6-digit code at sign-in.'
                      : 'Turn it on to protect this account with an authenticator app.'}
                  </p>
                  {enabled && (
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] text-zinc-500">
                      <Lock className="mt-0.5 h-3 w-3 shrink-0" />
                      Required for staff accounts, so it can&apos;t be switched off here.
                      Changing phone? Use Replace below.
                    </p>
                  )}
                </div>
              </div>

              {enabled && (
                <div className="mt-4 space-y-3">
                  <button
                    onClick={() => startScan('replace')}
                    disabled={busy || !verifiedSession}
                    className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-zinc-50 disabled:opacity-50"
                  >
                    <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                    <span>
                      <span className="block text-sm font-medium">Replace my authenticator</span>
                      <span className="block text-xs text-zinc-500">
                        New phone? Set it up — the old one stops working right away.
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={regenerate}
                    disabled={busy || !verifiedSession}
                    className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-zinc-50 disabled:opacity-50"
                  >
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                    <span>
                      <span className="block text-sm font-medium">New backup codes</span>
                      <span className="block text-xs text-zinc-500">
                        Issues a fresh set and invalidates the old one.
                      </span>
                    </span>
                  </button>
                  {!verifiedSession && (
                    <p className="text-xs text-amber-700">
                      These two need a fresh code. Sign out and back in, enter your
                      6-digit code, then reopen this panel.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {mode === 'scan' && (
            <>
              <p className="text-sm font-medium text-zinc-900">
                {intent === 'replace' ? 'Add TD Operations to your NEW authenticator' : 'Scan this with your authenticator app'}
              </p>
              {qr && (
                <div className="mx-auto mt-3 h-[180px] w-[180px] overflow-hidden rounded-lg border">
                  {/* The QR arrives as a data URI; next/image cannot optimize it
                      and must never proxy a two-factor secret. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="Two-factor setup QR code" className="h-full w-full" />
                </div>
              )}
              <p className="mt-3 text-center text-xs text-zinc-500">On this phone instead:</p>
              <div className="mt-2 space-y-2">
                {uri && (
                  <a href={uri} className="block rounded-lg bg-zinc-100 px-3 py-2 text-center text-xs font-medium">
                    Open in authenticator app
                  </a>
                )}
                {secret && (
                  <button onClick={copySecret} className="w-full break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs">
                    <Copy className="mr-1 inline h-3 w-3" />
                    {copied ? 'Copied' : secret}
                  </button>
                )}
              </div>
              <p className="mt-4 text-sm text-zinc-600">Enter the 6-digit code it shows:</p>
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter') activate() }}
                className="mt-2 w-full rounded-xl border py-3 text-center font-mono text-2xl tracking-[0.5em]"
                placeholder="••••••"
              />
              <button
                onClick={activate}
                disabled={busy || code.length !== 6}
                className="mt-3 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="inline h-4 w-4 animate-spin" /> : 'Activate'}
              </button>
              <p className="mt-2 text-[11px] text-zinc-400">
                {intent === 'replace'
                  ? 'Your old authenticator has already been removed — finish this step to stay protected.'
                  : 'Activating signs you out on your other devices once. Log back in there with your password and a code.'}
              </p>
            </>
          )}

          {mode === 'codes' && codes && (
            <>
              <p className="text-sm font-medium text-zinc-900">Save your backup codes</p>
              <p className="text-xs text-zinc-500">
                Shown once. Each works one time if you lose your phone. Any previous set is now invalid.
              </p>
              <div className="mt-3 grid gap-1 rounded-xl bg-zinc-50 p-3 font-mono text-[11px]">
                {codes.map(c => <div key={c}>{c}</div>)}
              </div>
              <button onClick={download} className="mt-3 w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white">
                <Download className="mr-1 inline h-4 w-4" />
                Download codes
              </button>
              <button
                onClick={() => { setCodes(null); refresh() }}
                className="mt-2 w-full rounded-lg border px-4 py-2.5 text-sm"
              >
                Done
              </button>
            </>
          )}

          {error && <p className="mt-3 text-center text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
