'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Loader2, Lock } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { MustReadBlock } from '@/components/portal/must-read-block'
import { cn } from '@/lib/utils'

/**
 * "Change your login email" — the client's own three steps (dev job beb43385, step 2):
 *   1. the new email + their password (and the big red "Read well before proceeding." block, ticked);
 *   2. the 6-digit code that was sent to the NEW address;
 *   3. done — what changed, what did not, and that the old address was told.
 * Used from the profile page and from the formation / onboarding form (the locked Email box). Nothing changes
 * until the code is entered, so a typo can never lock anyone out. The server holds every rule and limit
 * (app/api/portal/login-email/*); this file only draws the steps and shows the server's answer in the client's language.
 */
type Step = 'form' | 'code' | 'done'

interface Props {
  /** The login email today (shown locked in step 1). */
  currentEmail: string
  onClose: () => void
  /** Called once the login moved, with the new email, so the page behind can follow it. */
  onChanged?: (newEmail: string) => void
}

interface ApiAnswer {
  ok?: boolean
  code?: string
  error?: string
  retryAfterSeconds?: number
  attemptsLeft?: number
  [k: string]: unknown
}

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: ApiAnswer }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data: ApiAnswer = await res.json().catch(() => ({}))
  return { ok: res.ok && data.ok !== false, data }
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export function ChangeLoginEmailDialog({ currentEmail, onClose, onChanged }: Props) {
  const { t } = useLocale()
  const router = useRouter()
  const [step, setStep] = useState<Step>('form')
  const [newEmail, setNewEmail] = useState('')
  const [password, setPassword] = useState('')
  const [read, setRead] = useState(false)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [validMinutes, setValidMinutes] = useState(15)
  const [resendLeft, setResendLeft] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [result, setResult] = useState<{ oldEmail: string; newEmail: string; noticeSent: boolean } | null>(null)
  const codeInput = useRef<HTMLInputElement>(null)

  const fill = (text: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), text)

  // the server's answer, in the client's language: its code first, its own words second, a plain fallback last (R099)
  const errorText = useCallback((a: ApiAnswer): string => {
    const key = a.code ? `loginEmail.err.${a.code}` : ''
    const own = key ? t(key) : ''
    if (own && own !== key) return own
    return a.error || t('loginEmail.err.failed')
  }, [t])

  useEffect(() => {
    if (resendLeft <= 0) return
    const id = setInterval(() => setResendLeft((n) => (n > 0 ? n - 1 : 0)), 1000)
    return () => clearInterval(id)
  }, [resendLeft])

  useEffect(() => {
    if (step === 'code') codeInput.current?.focus()
  }, [step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const sendCode = async () => {
    setTried(true)
    setError(null)
    if (!newEmail.trim() || !password) { setError(t('loginEmail.err.fillAll')); return }
    if (!read) return // the grey button is still clickable: it rings the red block and says why (below)
    setBusy(true)
    try {
      const { ok, data } = await post('/api/portal/login-email/start', { newEmail, password })
      if (!ok) { setError(errorText(data)); return }
      setRequestId(String(data.requestId))
      setValidMinutes(Number(data.codeValidMinutes) || 15)
      setResendLeft(Number(data.resendAfterSeconds) || 60)
      setCode('')
      setNotice(null)
      setStep('code')
    } catch {
      setError(t('loginEmail.err.failed'))
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    if (!requestId || resendLeft > 0) return
    setBusy(true)
    setError(null)
    try {
      const { ok, data } = await post('/api/portal/login-email/resend', { requestId })
      if (!ok) {
        setError(errorText(data))
        if (data.retryAfterSeconds && data.code === 'wait') setResendLeft(data.retryAfterSeconds)
        return
      }
      setResendLeft(Number(data.resendAfterSeconds) || 60)
      setNotice(t('loginEmail.resent'))
      setCode('')
    } catch {
      setError(t('loginEmail.err.failed'))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    setError(null)
    setNotice(null)
    if (code.length !== 6) { setError(t('loginEmail.err.sixDigits')); return }
    setBusy(true)
    try {
      const { ok, data } = await post('/api/portal/login-email/confirm', { requestId, code })
      if (!ok) { setError(errorText(data)); setCode(''); return }
      const done = { oldEmail: String(data.oldEmail), newEmail: String(data.newEmail), noticeSent: data.noticeSent !== false }
      setResult(done)
      setStep('done')
      onChanged?.(done.newEmail)
    } catch {
      setError(t('loginEmail.err.failed'))
    } finally {
      setBusy(false)
    }
  }

  const finish = () => {
    onClose()
    router.refresh() // the page behind shows the new login email
  }

  const stepNumber = step === 'form' ? 1 : step === 'code' ? 2 : 3
  const inputClass = 'w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label={t('loginEmail.dialogTitle')} data-testid="change-login-email-dialog">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl my-auto">
        <p className="text-[11.5px] font-semibold uppercase tracking-wider text-blue-600">{fill(t('loginEmail.step'), { n: stepNumber })}</p>

        {step === 'form' && (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-zinc-900 mt-0.5">{t('loginEmail.dialogTitle')}</h2>
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">{t('loginEmail.today')}</label>
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-zinc-50 px-3 py-2 text-sm text-zinc-500 break-all">
                <span>{currentEmail}</span>
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </div>
            </div>
            <div>
              <label htmlFor="cle-new" className="block text-sm font-medium text-zinc-700 mb-1">{t('loginEmail.newEmail')}</label>
              <input id="cle-new" type="email" autoComplete="off" value={newEmail} onChange={(e) => { setNewEmail(e.target.value); setError(null) }} className={inputClass} data-testid="cle-new-email" />
            </div>
            <div>
              <label htmlFor="cle-pw" className="block text-sm font-medium text-zinc-700 mb-1">{t('loginEmail.password')}</label>
              <input id="cle-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null) }} className={inputClass} data-testid="cle-password" />
              <p className="mt-1 text-xs text-zinc-500">{t('loginEmail.passwordHint')}</p>
            </div>
            <MustReadBlock
              title={t('loginEmail.readTitle')}
              ackLabel={t('loginEmail.iReadIt')}
              checked={read}
              onCheckedChange={(v) => { setRead(v); setError(null) }}
              invalid={tried}
            >
              <p>{t('loginEmail.readBody')} <strong>{t('loginEmail.readStrong')}</strong></p>
            </MustReadBlock>
            {error && <p role="alert" className="text-sm font-semibold text-red-700" data-testid="cle-error">{error}</p>}
            <div className="flex items-center justify-end gap-3 pt-1 flex-wrap">
              {!read && tried && <span className="text-sm text-red-700">{t('loginEmail.tickToContinue')}</span>}
              <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50 disabled:opacity-50">{t('loginEmail.cancel')}</button>
              <button
                type="button"
                onClick={sendCode}
                disabled={busy}
                data-testid="cle-send-code"
                className={cn('flex items-center gap-2 px-4 py-2 text-sm rounded-lg font-medium', read ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-zinc-200 text-zinc-500', busy && 'opacity-60')}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('loginEmail.sendCode')}
              </button>
            </div>
          </div>
        )}

        {step === 'code' && (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-zinc-900 mt-0.5">{t('loginEmail.codeTitle')}</h2>
            <p className="text-sm text-zinc-700">
              {fill(t('loginEmail.codeSent'), { email: newEmail.trim().toLowerCase(), minutes: validMinutes })}
            </p>
            <div className="relative" onClick={() => codeInput.current?.focus()}>
              <div className="flex gap-2" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <span key={i} className={cn('flex h-12 flex-1 max-w-[52px] items-center justify-center rounded-lg border bg-white text-xl font-semibold tabular-nums', i === Math.min(code.length, 5) && 'border-blue-600 ring-2 ring-blue-200', error && 'border-red-500')}>
                    {code[i] ?? ''}
                  </span>
                ))}
              </div>
              <input
                ref={codeInput}
                value={code}
                onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null) }}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label={t('loginEmail.codeLabel')}
                maxLength={12}
                data-testid="cle-code"
                className="absolute inset-0 h-full w-full opacity-0 cursor-text"
              />
            </div>
            <p className="text-xs text-zinc-500">{t('loginEmail.noEmail')}</p>
            {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
            {error && <p role="alert" className="text-sm font-semibold text-red-700" data-testid="cle-error">{error}</p>}
            <div className="flex items-start justify-between gap-3 pt-1">
              <div className="grid gap-1 text-sm">
                <button type="button" onClick={resend} disabled={busy || resendLeft > 0} data-testid="cle-resend" className={cn('text-left font-medium', resendLeft > 0 ? 'text-zinc-400' : 'text-blue-600 hover:underline')}>
                  {resendLeft > 0 ? fill(t('loginEmail.resendIn'), { time: mmss(resendLeft) }) : t('loginEmail.resend')}
                </button>
                <button type="button" onClick={() => { setStep('form'); setError(null); setNotice(null); setRead(false); setTried(false) }} disabled={busy} className="text-left font-medium text-blue-600 hover:underline">
                  {t('loginEmail.goBack')}
                </button>
              </div>
              <button type="button" onClick={confirm} disabled={busy || code.length !== 6} data-testid="cle-confirm" className={cn('flex items-center gap-2 px-4 py-2 text-sm rounded-lg font-medium', code.length === 6 ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-zinc-200 text-zinc-500', busy && 'opacity-60')}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('loginEmail.confirm')}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && result && (
          <div className="space-y-3">
            <span className="mt-1 flex h-11 w-11 items-center justify-center rounded-full bg-green-50 text-green-600"><CheckCircle className="h-6 w-6" aria-hidden="true" /></span>
            <h2 className="text-lg font-semibold text-zinc-900 break-words" data-testid="cle-done-title">{fill(t('loginEmail.doneTitle'), { email: result.newEmail })}</h2>
            <ul className="space-y-1.5 text-sm text-zinc-700 list-disc pl-5">
              <li className="font-bold text-zinc-900 text-[15px]">{fill(t('loginEmail.doneLogin'), { email: result.newEmail })}</li>
              <li>{t('loginEmail.donePassword')}</li>
              {result.noticeSent && <li>{fill(t('loginEmail.doneNote'), { email: result.oldEmail })}</li>}
            </ul>
            <div className="flex justify-end pt-1">
              <button type="button" onClick={finish} data-testid="cle-done" className="px-4 py-2 text-sm rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700">{t('loginEmail.done')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
