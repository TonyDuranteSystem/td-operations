'use client'

/**
 * Staff MFA self-service (dev job de4564ee follow-up, Antonio 2026-08-07).
 * Two things the shipped MFA had no user-facing path for:
 *
 *  1. REPLACE AUTHENTICATOR — the planned phone change, while the OLD phone
 *     still works. Remove-then-add, in ONE uninterrupted flow: measured on
 *     sandbox that a client-side `mfa.unenroll` at aal2 keeps every session
 *     alive and keeps the session's own aal2, so the user never loses their
 *     footing mid-swap. Ends by issuing a FRESH set of backup codes (the old
 *     set is invalidated — codes belong to the authenticator they were
 *     minted alongside).
 *     Residual, stated not hidden: if the browser dies between the removal
 *     and the verify, the account is left with NO authenticator. That is
 *     self-correcting — the next login pushes them through setup — and their
 *     password still works, but it is a real (small) window.
 *
 *  2. REGENERATE BACKUP CODES — a new set, old set invalidated, shown once
 *     with a download.
 *
 * BOTH require a session that has just passed a code (aal2). A stolen
 * password alone can reach neither: the middleware gate stops an aal1 staff
 * session before this screen, and the server routes re-check aal2 anyway.
 */

import { useCallback, useEffect, useState } from 'react'
import { X, ShieldCheck, Smartphone, KeyRound, Loader2, Download, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type Mode = 'loading' | 'needs-verify' | 'menu' | 'replace-scan' | 'codes'

export function MfaSettingsDialog({ onClose }: { onClose: () => void }) {
  const supabase = createClient()
  const [mode, setMode] = useState<Mode>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasFactor, setHasFactor] = useState(false)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const verified = (factors?.totp ?? []).filter(f => (f as { status?: string }).status === 'verified')
      setHasFactor(verified.length > 0)
      setMode(aal?.currentLevel === 'aal2' ? 'menu' : 'needs-verify')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Remove the current authenticator, then immediately enroll the new one. */
  const startReplace = useCallback(async () => {
    if (!confirm('Replace your authenticator?\n\nThe current one stops working immediately, and you set up the new one on the next screen. Have the new phone ready.')) return
    setBusy(true)
    setError(null)
    try {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      for (const f of factors?.all ?? []) {
        const { error: unErr } = await supabase.auth.mfa.unenroll({ factorId: f.id })
        if (unErr) throw new Error(unErr.message)
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
      setHasFactor(false)
      setMode('replace-scan')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the replacement')
    } finally {
      setBusy(false)
    }
  }, [supabase])

  const activate = useCallback(async () => {
    if (!factorId || code.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId })
      if (chErr || !challenge) throw new Error(chErr?.message || 'Challenge failed')
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
      if (vErr) throw new Error('Wrong code — check the new app and try again.')
      const res = await fetch('/api/mfa/backup-codes', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not create backup codes.')
      setCodes(d.codes)
      setHasFactor(true)
      setMode('codes')
      toast.success('New authenticator active — old one no longer works')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed')
    } finally {
      setBusy(false)
    }
  }, [factorId, code, supabase])

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
      [`TD Operations — MFA backup codes (${new Date().toISOString().slice(0, 10)})\nEach code works once. Any previous set is now invalid.\n\n${codes.join('\n')}\n`],
      { type: 'text/plain' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'td-mfa-backup-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }, [codes])

  const copySecret = useCallback(async () => {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    } catch { /* the secret is on screen anyway */ }
  }, [secret])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
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

          {mode === 'needs-verify' && (
            <>
              <p className="text-sm text-zinc-600">
                For security, these actions need a fresh code. Sign out and back in,
                enter your 6-digit code, then reopen this panel.
              </p>
              <a href="/mfa/verify" className="mt-4 block rounded-lg bg-red-600 px-4 py-2.5 text-center text-sm font-semibold text-white">
                Enter a code now
              </a>
            </>
          )}

          {mode === 'menu' && (
            <div className="space-y-3">
              <button
                onClick={startReplace}
                disabled={busy || !hasFactor}
                className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-zinc-50 disabled:opacity-50"
              >
                <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                <span>
                  <span className="block text-sm font-medium">Replace my authenticator</span>
                  <span className="block text-xs text-zinc-500">
                    Changing phone? Set up the new one — the old stops working right away.
                  </span>
                </span>
              </button>
              <button
                onClick={regenerate}
                disabled={busy || !hasFactor}
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
              {!hasFactor && (
                <p className="text-xs text-amber-700">
                  No authenticator set up on this account yet — use the setup page first.
                </p>
              )}
            </div>
          )}

          {mode === 'replace-scan' && (
            <>
              <p className="text-sm font-medium text-zinc-900">Add TD Operations to your new authenticator</p>
              {qr && (
                <div className="mx-auto mt-3 h-[180px] w-[180px] overflow-hidden rounded-lg border">
                  {/* GoTrue returns the QR as a data URI; next/image cannot
                      optimize it and must never proxy an MFA secret. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="Setup QR code" className="h-full w-full" />
                </div>
              )}
              <div className="mt-3 space-y-2">
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
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter') activate() }}
                className="mt-4 w-full rounded-xl border py-3 text-center font-mono text-2xl tracking-[0.5em]"
                placeholder="••••••"
              />
              <button
                onClick={activate}
                disabled={busy || code.length !== 6}
                className="mt-3 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="inline h-4 w-4 animate-spin" /> : 'Activate new authenticator'}
              </button>
              <p className="mt-2 text-[11px] text-zinc-400">
                Your old authenticator has already been removed — finish this step to stay protected.
              </p>
            </>
          )}

          {mode === 'codes' && codes && (
            <>
              <p className="text-sm font-medium text-zinc-900">Your new backup codes</p>
              <p className="text-xs text-zinc-500">Shown once. Any previous set is now invalid.</p>
              <div className="mt-3 grid gap-1 rounded-xl bg-zinc-50 p-3 font-mono text-[11px]">
                {codes.map(c => <div key={c}>{c}</div>)}
              </div>
              <button onClick={download} className="mt-3 w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white">
                <Download className="mr-1 inline h-4 w-4" />
                Download codes
              </button>
              <button onClick={onClose} className="mt-2 w-full rounded-lg border px-4 py-2.5 text-sm">
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
